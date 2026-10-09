// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { WalVisualiser } from "../src/components/WalVisualiser.js";

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const panel = (name: string) => screen.getByRole("region", { name });

function writeAndCommit(value: string) {
  fireEvent.change(screen.getByLabelText("Value"), { target: { value } });
  click("Write");
  click("Commit");
}

describe("WalVisualiser", () => {
  afterEach(() => cleanup());

  it("says visibly that it is a simulation and names the adapter options it illustrates", () => {
    render(<WalVisualiser />);
    expect(screen.getByText(/simulation/i)).toBeDefined();
    expect(screen.getAllByText("journalMode").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/wal_checkpoint/).length).toBeGreaterThan(0);
  });

  it("shows a committed value in the WAL panel but not yet in the main-file panel", () => {
    render(<WalVisualiser />);
    expect(within(panel("Main file")).getByText("1")).toBeDefined();
    writeAndCommit("42");
    expect(within(panel("WAL")).getByText("42")).toBeDefined();
    expect(within(panel("Main file")).queryByText("42")).toBeNull();
  });

  it("a reader opened before the write still shows the old value", () => {
    render(<WalVisualiser />);
    click("Open reader");
    writeAndCommit("42");
    const readers = panel("Readers");
    expect(within(readers).getByText("counter = 1")).toBeDefined();
    expect(within(readers).queryByText("counter = 42")).toBeNull();
    click("Open reader");
    expect(within(readers).getByText("counter = 42")).toBeDefined();
  });

  it("checkpoint with no readers empties the WAL panel and shows the value in the main file", () => {
    render(<WalVisualiser />);
    writeAndCommit("42");
    click("Checkpoint");
    expect(within(panel("WAL")).queryByText("42")).toBeNull();
    expect(within(panel("WAL")).getByText(/empty/i)).toBeDefined();
    expect(within(panel("Main file")).getByText("42")).toBeDefined();
  });

  it("checkpoint is blocked by an old reader: value stays in the WAL and the log explains why", () => {
    render(<WalVisualiser />);
    click("Open reader");
    writeAndCommit("42");
    click("Checkpoint");
    expect(within(panel("WAL")).getByText("42")).toBeDefined();
    expect(within(panel("Main file")).queryByText("42")).toBeNull();
    expect(within(screen.getByRole("log")).getAllByText(/oldest reader/i).length).toBeGreaterThan(0);
  });

  it("crash then recover discards the uncommitted frame and keeps the committed one", () => {
    render(<WalVisualiser />);
    writeAndCommit("42");
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "99" } });
    click("Write");
    expect(within(panel("WAL")).getByText("99")).toBeDefined();
    click("Crash");
    click("Write"); // rejected while crashed
    expect(within(screen.getByRole("log")).getAllByText(/recovery first/i).length).toBeGreaterThan(0);
    click("Recover");
    expect(within(panel("WAL")).queryByText("99")).toBeNull();
    expect(within(panel("WAL")).getByText("42")).toBeDefined();
  });

  it("rollback-journal mode: an open reader blocks the writer and the log says so", () => {
    render(<WalVisualiser />);
    fireEvent.click(screen.getByRole("radio", { name: /DELETE/ }));
    click("Open reader");
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "7" } });
    click("Write");
    expect(within(screen.getByRole("log")).getAllByText(/blocked/i).length).toBeGreaterThan(0);
    expect(within(panel("Main file")).queryByText("7")).toBeNull();
  });

  it("rollback-journal mode: journal panel holds the original, main file holds the new value", () => {
    render(<WalVisualiser />);
    fireEvent.click(screen.getByRole("radio", { name: /DELETE/ }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "42" } });
    click("Write");
    const main = panel("Main file");
    expect(within(main).getByText("42")).toBeDefined();
    const journal = within(main).getByText(/Rollback journal/).parentElement as HTMLElement;
    expect(within(journal).getByText("counter = 1")).toBeDefined();
    expect(within(journal).queryByText("counter = 42")).toBeNull();
    click("Crash");
    click("Recover");
    expect(within(panel("Main file")).queryByText("42")).toBeNull();
    expect(within(panel("Main file")).getByText("1")).toBeDefined();
    expect(within(screen.getByRole("log")).getAllByText(/hot journal/i).length).toBeGreaterThan(0);
  });

  it("states that the simulated checkpoint behaves like TRUNCATE and flags the contrast as simplified", () => {
    render(<WalVisualiser />);
    expect(screen.getAllByText(/TRUNCATE/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/simplified/i).length).toBeGreaterThan(0);
  });

  it("35 actions produce unique log entries and no duplicate-key errors", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<WalVisualiser />);
    for (let i = 0; i < 35; i++) click("Write");
    const items = within(screen.getByRole("log")).getAllByRole("listitem");
    expect(items.length).toBe(30);
    const ids = items.map((li) => li.getAttribute("data-id"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((x) => x !== null)).toBe(true);
    const dup = err.mock.calls.filter((c) => String(c[0]).includes("same key"));
    err.mockRestore();
    expect(dup).toEqual([]);
  });

  it("the Reset button restores the initial state", () => {
    render(<WalVisualiser />);
    writeAndCommit("42");
    click("Reset");
    expect(within(panel("WAL")).queryByText("42")).toBeNull();
  });
});
