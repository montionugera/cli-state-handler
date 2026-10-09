// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { CasPlayground } from "../src/components/CasPlayground.js";

describe("CasPlayground Component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders CAS storage dashboard and object index table", () => {
    render(<CasPlayground />);

    expect(screen.getByText("Content-Addressable Storage (CAS) & LRU Pruning")).toBeDefined();
    expect(screen.getByText("💾 Store in CAS")).toBeDefined();
    expect(screen.getByText("🧹 Prune to 70% LRU")).toBeDefined();
  });

  it("stores a payload and computes SHA-256 hash", async () => {
    render(<CasPlayground />);

    const input = screen.getByTestId("cas-input");
    fireEvent.change(input, { target: { value: "Test package binary data 12345" } });

    const storeBtn = screen.getByText("💾 Store in CAS");
    await act(async () => {
      fireEvent.click(storeBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Inspected CAS Payload:")).toBeDefined();
    });
  });

  it("executes LRU pruning when requested", async () => {
    render(<CasPlayground />);

    const pruneBtn = screen.getByText("🧹 Prune to 70% LRU");
    await act(async () => {
      fireEvent.click(pruneBtn);
    });

    // Verify objects count or quota updated
    expect(screen.getByText(/Disk Quota Utilization/i)).toBeDefined();
  });

  async function store(text: string) {
    fireEvent.change(screen.getByTestId("cas-input"), { target: { value: text } });
    await act(async () => {
      fireEvent.click(screen.getByText("💾 Store in CAS"));
    });
  }
  const count = () => screen.getByTestId("cas-count").textContent;
  const logText = () => screen.getByTestId("cas-log").textContent ?? "";

  it("labels the page as a browser model hash-compatible with the real store", () => {
    render(<CasPlayground />);
    expect(screen.getByText("browser model, hash-compatible with the real store")).toBeDefined();
  });

  it("shows the real SHA-256 and key for a stored payload", async () => {
    render(<CasPlayground />);
    await store("hello world");
    const hash = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    await waitFor(() => expect(screen.getByText(hash)).toBeDefined());
    expect(screen.getByText(`objects/b9/${hash}`)).toBeDefined();
  });

  it("reports a dedupe and keeps one blob when identical content is stored twice", async () => {
    render(<CasPlayground />);
    await store("same payload");
    await waitFor(() => expect(count()).toBe("1"));
    await store("same payload");
    await waitFor(() => expect(logText()).toMatch(/Deduplicated/));
    expect(count()).toBe("1");
  });

  it("evicts the least recently used blob when over the byte budget", async () => {
    render(<CasPlayground />);
    fireEvent.change(screen.getByTestId("cas-budget"), { target: { value: "100" } });
    await store("a".repeat(40));
    await store("b".repeat(40));
    await waitFor(() => expect(count()).toBe("2"));
    await store("c".repeat(40)); // 120 > 100, prune to 70: evicts a then b
    await waitFor(() => expect(logText()).toMatch(/Evicted/));
    expect(count()).toBe("1");
    // a x40 = e33cdf9c, b x40 = e26d2da3, c x40 = 83ba021a. 120 > 100 prunes to 70: a (80 left), b (40 left); c stays.
    expect(screen.queryByTestId("cas-row-e33cdf9c")).toBeNull();
    expect(screen.queryByTestId("cas-row-e26d2da3")).toBeNull();
    expect(screen.getByTestId("cas-row-83ba021a")).toBeDefined();
  });

  it("shows the real pruning rules next to the budget input", () => {
    render(<CasPlayground />);
    expect(screen.getByTestId("cas-budget-note").textContent).toMatch(/70%.*own prune.*0 means unbounded/s);
  });

  it("logs a readable message without a secure context and keeps working afterwards", async () => {
    render(<CasPlayground />);
    vi.spyOn(globalThis.crypto, "subtle", "get").mockReturnValue(undefined as unknown as SubtleCrypto);
    await store("needs secure context");
    await waitFor(() => expect(logText()).toMatch(/SHA-256 needs a secure context \(https or localhost\)/));
    expect(count()).toBe("0");
    vi.restoreAllMocks();
    await store("works again");
    await waitFor(() => expect(count()).toBe("1"));
  });

  it("serialises rapid stores without losing updates", async () => {
    render(<CasPlayground />);
    fireEvent.change(screen.getByTestId("cas-input"), { target: { value: "one" } });
    const btn = screen.getByText("💾 Store in CAS");
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.change(screen.getByTestId("cas-input"), { target: { value: "two" } });
      fireEvent.click(btn);
    });
    await waitFor(() => expect(count()).toBe("2"));
  });
});
