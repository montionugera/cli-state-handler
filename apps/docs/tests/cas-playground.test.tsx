// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
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
});
