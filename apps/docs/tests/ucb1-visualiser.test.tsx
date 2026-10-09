// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import { Ucb1Visualiser } from "../src/components/Ucb1Visualiser.js";
import { encodeFrame, FrameType } from "../src/models/ucb1-codec.js";
import { hubPublish } from "../src/models/ucb1-hub.js";

const inbox = (name: string) => within(screen.getByTestId(`inbox-${name}`));

describe("Ucb1Visualiser", () => {
  afterEach(() => cleanup());

  it("labels the header field by field with UCB1 magic bytes", () => {
    render(<Ucb1Visualiser />);
    for (const f of ["Magic", "Type", "Flags", "Reserved", "Length"]) {
      expect(screen.getByRole("rowheader", { name: f })).toBeDefined();
    }
    expect(screen.getByText("55 43 42 31")).toBeDefined();
    expect(screen.getByText("UCB1")).toBeDefined();
  });

  const setFilter = (name: string, value: string) =>
    fireEvent.change(screen.getByLabelText(`Filter for ${name}`), {
      target: { value },
    });
  const publish = () =>
    fireEvent.click(screen.getByRole("button", { name: "Publish frame" }));

  it("a process with no filters receives everything; the publisher never receives its own event", () => {
    render(<Ucb1Visualiser />);
    publish();
    expect(screen.getByRole("status").textContent).toContain(
      "Delivered to 2 processes",
    );
    expect(inbox("Process A").getByText("Received: 0")).toBeDefined();
    expect(inbox("Process A").getByText(/publisher/i)).toBeDefined();
    expect(inbox("Process B").getByText("Received: 1")).toBeDefined();
    expect(inbox("Process B").getByText(/user:42/)).toBeDefined();
    expect(inbox("Process C").getByText("Received: 1")).toBeDefined();
  });

  it("a topic filter receives only matching events; * receives everything", () => {
    render(<Ucb1Visualiser />);
    setFilter("Process B", "other.topic");
    setFilter("Process C", "*");
    publish();
    expect(screen.getByRole("status").textContent).toContain(
      "Delivered to 1 process.",
    );
    expect(inbox("Process B").getByText("Received: 0")).toBeDefined();
    expect(inbox("Process C").getByText("Received: 1")).toBeDefined();
    setFilter("Process B", "cache.invalidate");
    publish();
    expect(inbox("Process B").getByText("Received: 1")).toBeDefined();
  });

  it("can grow to 4 processes; a mismatching filter on the fourth gets nothing", () => {
    render(<Ucb1Visualiser />);
    fireEvent.change(screen.getByLabelText("Number of processes"), {
      target: { value: "4" },
    });
    setFilter("Process D", "other.topic");
    publish();
    expect(inbox("Process D").getByText("Received: 0")).toBeDefined();
    expect(inbox("Process B").getByText("Received: 1")).toBeDefined();
  });

  it("status keeps the published frame's type when the select changes afterwards", () => {
    render(<Ucb1Visualiser />);
    publish();
    fireEvent.change(screen.getByLabelText("Frame type"), {
      target: { value: String(FrameType.PING) },
    });
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Delivered to 2 processes");
    expect(text).toContain("PUBLISH");
    expect(inbox("Process B").getByText("Received: 1")).toBeDefined();
  });

  it("a non-PUBLISH frame is accepted but delivers to nobody, and says which type", () => {
    render(<Ucb1Visualiser />);
    fireEvent.change(screen.getByLabelText("Frame type"), {
      target: { value: String(FrameType.PING) },
    });
    publish();
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("PING");
    expect(text).toContain("Delivered to 0 processes");
    expect(inbox("Process B").getByText("Received: 0")).toBeDefined();
  });

  it("an incomplete frame is not presented as a library error", () => {
    const bytes = encodeFrame(FrameType.PUBLISH, { a: 1 });
    const r = hubPublish(
      bytes.subarray(0, bytes.length - 1),
      [{ name: "B", filters: [] }],
      "A",
    );
    expect(r.waiting).toBe(true);
    expect(r.delivered).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("TruncatedFrameError");
  });

  it("bad magic drops the publisher connection; no ERROR reply, nobody receives", () => {
    render(<Ucb1Visualiser />);
    fireEvent.click(screen.getByRole("button", { name: "Inject bad magic" }));
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("InvalidMagicError");
    expect(status.textContent).toMatch(/connection dropped/i);
    expect(status.textContent).toMatch(/no ERROR frame/);
    expect(status.getAttribute("data-state")).toBe("rejected");
    expect(inbox("Process A").getByText(/connection dropped/i)).toBeDefined();
    for (const p of ["Process B", "Process C"]) {
      expect(inbox(p).getByText("Received: 0")).toBeDefined();
    }
  });

  it("non-zero flags and oversized length drop the connection too", () => {
    render(<Ucb1Visualiser />);
    fireEvent.click(
      screen.getByRole("button", { name: "Inject non-zero flags" }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "ReservedFlagsError",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inject oversized length" }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "FrameTooLargeError",
    );
    expect(inbox("Process B").getByText("Received: 0")).toBeDefined();
  });

  it("shows how the simulation differs from the real hub", () => {
    render(<Ucb1Visualiser />);
    const note = screen.getByTestId("ucb1-differs");
    expect(note.textContent).toMatch(/How this differs from the real hub/);
    expect(note.textContent).toMatch(/HELLO/);
    expect(note.textContent).toMatch(/INVALID_TOKEN/);
    expect(note.textContent).toMatch(/RESYNC/);
  });

  it("invalid JSON payload is reported and nothing is published", () => {
    render(<Ucb1Visualiser />);
    fireEvent.change(screen.getByLabelText("JSON payload"), {
      target: { value: "{nope" },
    });
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Publish frame" }));
    expect(inbox("Process B").getByText("Received: 0")).toBeDefined();
  });

  it("header reflects the chosen frame type and payload length", () => {
    render(<Ucb1Visualiser />);
    fireEvent.change(screen.getByLabelText("Frame type"), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText("JSON payload"), {
      target: { value: "{}" },
    });
    expect(screen.getByText("0f")).toBeDefined();
    expect(screen.getByText("00 00 00 02")).toBeDefined();
  });
});
