// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { OutboxPlayground } from "../src/components/OutboxPlayground.js";

describe("OutboxPlayground Component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders offline mutation queue, toggles network status, and enqueues", async () => {
    render(<OutboxPlayground />);

    expect(screen.getByText("Offline Mutation Outbox & Conflict Resolution")).toBeDefined();
    expect(screen.getByText("🔴 Network: OFFLINE")).toBeDefined();

    // Toggle to Online
    const toggleBtn = screen.getByText("🔴 Network: OFFLINE");
    fireEvent.click(toggleBtn);
    expect(screen.getByText("🟢 Network: ONLINE")).toBeDefined();

    // Enqueue a new mutation
    const enqueueBtn = screen.getByText("📥 Enqueue");
    await act(async () => {
      fireEvent.click(enqueueBtn);
    });

    expect(screen.getByText("3")).toBeDefined(); // 2 initial + 1 new = 3
  });

  it("replays offline mutations when online with conflict policy", async () => {
    render(<OutboxPlayground />);

    // Must be online to replay
    const toggleBtn = screen.getByText("🔴 Network: OFFLINE");
    fireEvent.click(toggleBtn);

    const replayBtn = screen.getByText("🚀 Replay Outbox");
    await act(async () => {
      fireEvent.click(replayBtn);
      // Wait for replay pacing (rateLimitMs: 80ms)
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(
      () => {
        expect(screen.getByText(/Replay batch complete/i)).toBeDefined();
      },
      { timeout: 2000 }
    );
  });
});
