// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LifecycleFSM } from "@montionugera/ucsa-core";
import type { QueryStatus } from "@montionugera/ucsa-core";
import { LifecycleGraph } from "../src/components/LifecycleGraph.js";
import { LIFECYCLE_EDGES, LIFECYCLE_STATES, applyEdge } from "../src/models/lifecycle-graph.js";

afterEach(cleanup);

/** Drive a fresh real FSM into `target` using only the real methods. */
function fsmAt(target: QueryStatus): LifecycleFSM {
  const fsm = new LifecycleFSM();
  if (target === "loading") fsm.startLoading();
  if (target === "success") fsm.recordSuccess({});
  if (target === "retrying") fsm.recordError(new Error("x"), 0);
  if (target === "error") fsm.recordError(new Error("x"), fsm.maxRetries);
  expect(fsm.state).toBe(target);
  return fsm;
}

describe("lifecycle graph model vs real LifecycleFSM", () => {
  it("has the five states of the real FSM", () => {
    expect([...LIFECYCLE_STATES].sort()).toEqual(["error", "idle", "loading", "retrying", "success"]);
  });

  it.each(LIFECYCLE_EDGES.map((e) => [`${e.from} -> ${e.to} via ${e.method}`, e] as const))(
    "edge %s lands in its target on the real FSM",
    (_name, edge) => {
      const fsm = fsmAt(edge.from);
      applyEdge(fsm, edge);
      expect(fsm.state).toBe(edge.to);
    }
  );

  it("has at most one edge per (from,to) pair and no self loops", () => {
    const keys = LIFECYCLE_EDGES.map((e) => `${e.from}>${e.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(LIFECYCLE_EDGES.every((e) => e.from !== e.to)).toBe(true);
  });
});

describe("LifecycleGraph component", () => {
  it("marks idle as current and moves aria-current after a transition", () => {
    render(<LifecycleGraph />);
    const nodes = () => screen.getAllByTestId("lifecycle-node");
    const current = () => nodes().filter((n) => n.getAttribute("aria-current") === "true");
    expect(current()).toHaveLength(1);
    expect(current()[0]?.getAttribute("data-state")).toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "Go to loading" }));
    expect(current()).toHaveLength(1);
    expect(current()[0]?.getAttribute("data-state")).toBe("loading");
  });

  it("disables every target that has no authored edge from the current state, and ignores clicks on it", () => {
    render(<LifecycleGraph />);
    for (const from of LIFECYCLE_STATES) {
      // walk to `from` by the shortest authored path is overkill: use reset-able fresh render per state
      cleanup();
      render(<LifecycleGraph initialState={from} />);
      for (const to of LIFECYCLE_STATES) {
        const btn = screen.getByRole("button", { name: `Go to ${to}` }) as HTMLButtonElement;
        const legal = LIFECYCLE_EDGES.some((e) => e.from === from && e.to === to);
        expect(btn.disabled).toBe(!legal);
        if (!legal) {
          fireEvent.click(btn);
          const cur = screen.getAllByTestId("lifecycle-node").find((n) => n.getAttribute("aria-current") === "true");
          expect(cur?.getAttribute("data-state")).toBe(from);
        }
      }
    }
  });

  it("logs each transition in an aria-live region", () => {
    render(<LifecycleGraph />);
    const log = screen.getByRole("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Go to loading" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to success" }));
    const items = within(log).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[1]?.textContent).toMatch(/loading.*success.*recordSuccess/);
  });

  it("walks the retry path through the real FSM: loading -> retrying -> error", () => {
    render(<LifecycleGraph />);
    fireEvent.click(screen.getByRole("button", { name: "Go to loading" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to retrying" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to error" }));
    const cur = screen.getAllByTestId("lifecycle-node").find((n) => n.getAttribute("aria-current") === "true");
    expect(cur?.getAttribute("data-state")).toBe("error");
  });

  it("states plainly that the edges are editorial and QueryEngine does not use the class", () => {
    render(<LifecycleGraph />);
    const note = document.querySelector(".lc-note")?.textContent ?? "";
    expect(note).toMatch(/intended lifecycle/i);
    expect(note).toMatch(/editorial/i);
    expect(note).toMatch(/any call from any state/i);
    expect(note).toMatch(/not enforcement/i);
    expect(note).toMatch(/QueryEngine does not use/i);
    expect(note).toMatch(/loading.*success.*error/i);
    expect(note).not.toMatch(/drift/i);
  });

  it("logs the attempt argument so retrying and error outcomes are distinguishable", () => {
    render(<LifecycleGraph />);
    fireEvent.click(screen.getByRole("button", { name: "Go to loading" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to retrying" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to loading" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to error" }));
    const items = within(screen.getByRole("log")).getAllByRole("listitem");
    expect(items[1]?.textContent).toMatch(/recordError\(attempt 0\)/);
    expect(items[3]?.textContent).toMatch(/recordError\(attempt [1-9]\d*\)/);
  });

  it("gives the SVG a text alternative", () => {
    render(<LifecycleGraph />);
    expect(screen.getByRole("img", { name: /lifecycle/i })).toBeDefined();
  });
});
