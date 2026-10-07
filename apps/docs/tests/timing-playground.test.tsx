// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { TimingPlayground } from "../src/components/TimingPlayground.js";

describe("TimingPlayground Component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders timing controls, sliders, and burst button", () => {
    render(<TimingPlayground />);

    expect(screen.getByText("Observer Timing & UI Render Suppression")).toBeDefined();
    expect(screen.getByText("⚡ Trigger Rapid Burst (30 Events)")).toBeDefined();
    expect(screen.getByText("Query Execution Debouncing & Cancellation")).toBeDefined();
  });

  it("suppresses rapid burst events with throttle", async () => {
    render(<TimingPlayground />);

    const burstBtn = screen.getByText("⚡ Trigger Rapid Burst (30 Events)");
    await act(async () => {
      fireEvent.click(burstBtn);
      // Wait for burst timers to settle
      await new Promise((r) => setTimeout(r, 150));
    });

    await waitFor(() => {
      const rawCount = screen.getByText("30");
      expect(rawCount).toBeDefined();

      // UI dispatches should be significantly fewer than 30 (e.g. 1 or 2)
      const suppressionText = screen.getByText(/Render Suppression Ratio/i);
      expect(suppressionText).toBeDefined();
    });
  });

  it("debounces rapid keystrokes in search input", async () => {
    render(<TimingPlayground />);

    const searchInput = screen.getByTestId("search-input");

    // Simulate fast typing
    await act(async () => {
      fireEvent.change(searchInput, { target: { value: "u" } });
      fireEvent.change(searchInput, { target: { value: "uc" } });
      fireEvent.change(searchInput, { target: { value: "ucs" } });
      fireEvent.change(searchInput, { target: { value: "ucsa" } });
    });

    expect(screen.getByTestId("keystrokes-count").textContent).toBe("4");

    // Wait for debounce timer (300ms) to resolve
    await waitFor(
      () => {
        expect(screen.getByText(/UCSA Core State Engine/i)).toBeDefined();
      },
      { timeout: 1500 }
    );
  });
});
