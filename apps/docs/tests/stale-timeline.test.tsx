// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { StaleTimeline } from "../src/components/StaleTimeline.js";
import { phaseAt, type TimelineState } from "../src/models/stale-timeline.js";

afterEach(cleanup);

const base: TimelineState = { fetchedAt: 0, staleTime: 1000, gcTime: 3000 };

describe("phaseAt", () => {
  it("is empty before any fetch", () => {
    expect(phaseAt({ ...base, fetchedAt: null }, 0)).toBe("empty");
  });
  it("is fresh strictly before fetchedAt + staleTime and stale from then on", () => {
    expect(phaseAt(base, 999)).toBe("fresh");
    expect(phaseAt(base, 1000)).toBe("stale");
  });
  it("is still stale exactly at fetchedAt + gcTime and expired strictly after", () => {
    expect(phaseAt(base, 3000)).toBe("stale");
    expect(phaseAt(base, 3001)).toBe("expired");
  });
  it("expires regardless of any reader: the rule takes only the clock and the fetch time", () => {
    expect(phaseAt(base, 10_000_000)).toBe("expired");
  });
  it("handles zero staleTime (immediately stale)", () => {
    expect(phaseAt({ ...base, staleTime: 0 }, 0)).toBe("stale");
  });
  it("expired wins when staleTime is greater than gcTime", () => {
    const s = { ...base, staleTime: 5000, gcTime: 2000 };
    expect(phaseAt(s, 1999)).toBe("fresh");
    expect(phaseAt(s, 2000)).toBe("fresh");
    expect(phaseAt(s, 2001)).toBe("expired");
  });
});

const phase = () => screen.getByTestId("timeline-phase").textContent;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const setNum = (label: RegExp, v: number) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: String(v) } });

describe("StaleTimeline component", () => {
  it("starts empty, becomes fresh after a fetch", () => {
    render(<StaleTimeline />);
    expect(phase()).toBe("empty");
    click("Fetch");
    expect(phase()).toBe("fresh");
  });

  it("marks the query stale once the clock passes staleTime", () => {
    render(<StaleTimeline />);
    setNum(/staleTime/, 2000);
    click("Fetch");
    click("Advance 1s");
    expect(phase()).toBe("fresh");
    click("Advance 1s");
    expect(phase()).toBe("stale");
  });

  it("expires after gcTime with no reader involved", () => {
    render(<StaleTimeline />);
    setNum(/staleTime/, 1000);
    setNum(/gcTime/, 3000);
    click("Fetch");
    click("Advance 1s");
    click("Advance 1s");
    click("Advance 1s");
    expect(phase()).toBe("stale");
    click("Advance 1s");
    expect(phase()).toBe("expired");
  });

  it("has no observer controls", () => {
    render(<StaleTimeline />);
    expect(screen.queryByRole("button", { name: /observer/i })).toBeNull();
    expect(document.querySelector(".st-readout")?.textContent).not.toMatch(/observers/i);
  });

  it("a fresh read is served from cache and changes nothing", () => {
    render(<StaleTimeline />);
    setNum(/staleTime/, 2000);
    click("Fetch");
    click("Read query");
    expect(screen.getByRole("log").textContent).toMatch(/served from cache/i);
    expect(screen.getByRole("log").textContent).not.toMatch(/revalidat/i);
    click("Advance 1s");
    click("Advance 1s");
    expect(phase()).toBe("stale");
  });

  it("a stale read is served from cache, revalidates in the background and resets both windows", () => {
    render(<StaleTimeline />);
    setNum(/staleTime/, 1000);
    setNum(/gcTime/, 3000);
    click("Fetch");
    click("Advance 1s");
    click("Advance 1s");
    expect(phase()).toBe("stale");
    click("Read query");
    expect(screen.getByRole("log").textContent).toMatch(/background revalidation/i);
    expect(phase()).toBe("fresh");
    // gc window was reset too: 3s after the read (t=5000) it is still stale, not expired
    click("Advance 1s");
    click("Advance 1s");
    click("Advance 1s");
    expect(phase()).toBe("stale");
    click("Advance 1s");
    expect(phase()).toBe("expired");
  });

  it("an expired read is a cold load, not a cache hit", () => {
    render(<StaleTimeline />);
    setNum(/gcTime/, 1000);
    click("Fetch");
    click("Advance 5s");
    expect(phase()).toBe("expired");
    click("Read query");
    expect(screen.getByRole("log").textContent).toMatch(/cold load/i);
    expect(phase()).not.toBe("expired");
  });

  it("explains that focus refetch is app wiring, not built in", () => {
    render(<StaleTimeline />);
    expect(document.querySelector(".st-note")?.textContent).toMatch(/app.*(wires|wire)/i);
  });

  it("labels phases and markers in the legend with text", () => {
    render(<StaleTimeline />);
    const legend = document.querySelector(".st-legend");
    expect(legend?.textContent).toMatch(/fresh/);
    expect(legend?.textContent).toMatch(/stale/);
    expect(legend?.textContent).toMatch(/expired/);
    expect(legend?.textContent).toMatch(/fetch/);
    expect(legend?.textContent).toMatch(/read/);
  });

  it("honours an injected start time", () => {
    render(<StaleTimeline startAt={5000} />);
    expect(screen.getByTestId("timeline-clock").textContent).toBe("5000");
  });

  it("exposes the timeline as a described image", () => {
    render(<StaleTimeline />);
    expect(screen.getByRole("img", { name: /timeline/i })).toBeDefined();
  });
});
