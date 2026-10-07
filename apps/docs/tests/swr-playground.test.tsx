// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { SwrPlayground } from "../src/components/SwrPlayground.js";
import { App } from "../src/App.js";

describe("SwrPlayground Component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders playground header, inputs, and action buttons", () => {
    render(<SwrPlayground />);

    expect(screen.getByText("SWR & Query Lifecycle Playground")).toBeDefined();
    expect(screen.getByText("🚀 Fetch Query (SWR)")).toBeDefined();
    expect(screen.getByText("🔄 Background Refetch (Identical Payload)")).toBeDefined();
    expect(screen.getByText("⚡ Mutate Remote Data & Refetch")).toBeDefined();
  });

  it("executes fetch and displays data and cached timestamps", async () => {
    render(<SwrPlayground />);

    // Reduce latency to 20ms for fast test execution
    const latencyInput = screen.getByTestId("latency-input");
    fireEvent.change(latencyInput, { target: { value: "20" } });

    const fetchBtn = screen.getByText("🚀 Fetch Query (SWR)");
    await act(async () => {
      fireEvent.click(fetchBtn);
    });

    await waitFor(
      () => {
        expect(screen.getByText(/Status: success/i)).toBeDefined();
        expect(screen.getByText(/INITIAL LOAD|REFERENCE PRESERVED/i)).toBeDefined();
      },
      { timeout: 2000 }
    );
  });

  it("preserves reference identity on identical background refetch", async () => {
    render(<SwrPlayground />);

    // Reduce latency to 20ms
    const latencyInput = screen.getByTestId("latency-input");
    fireEvent.change(latencyInput, { target: { value: "20" } });

    const fetchBtn = screen.getByText("🚀 Fetch Query (SWR)");
    const refetchBtn = screen.getByText("🔄 Background Refetch (Identical Payload)");

    // Step 1: Initial fetch
    await act(async () => {
      fireEvent.click(fetchBtn);
    });
    await waitFor(() => {
      expect(screen.getByText(/INITIAL LOAD/i)).toBeDefined();
    });

    // Step 2: Background refetch identical payload
    await act(async () => {
      fireEvent.click(refetchBtn);
    });

    await waitFor(
      () => {
        expect(screen.getByText(/REFERENCE PRESERVED/i)).toBeDefined();
      },
      { timeout: 2000 }
    );
  });

  it("renders Storybook shell and switches tabs cleanly", () => {
    render(<App />);

    expect(screen.getByText("UCSA Studio")).toBeDefined();
    expect(screen.getByText("⚡ SWR & Lifecycle")).toBeDefined();

    // Click Overview story
    const overviewBtn = screen.getByText("📖 Architecture Overview");
    fireEvent.click(overviewBtn);

    expect(screen.getByText("Unified Client State Architecture (UCSA)")).toBeDefined();
    expect(screen.getByText("3 Native")).toBeDefined();
  });
});
