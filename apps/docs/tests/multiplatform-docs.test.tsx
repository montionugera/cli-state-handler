// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MultiPlatformDocs } from "../src/components/MultiPlatformDocs.js";
import { App } from "../src/App.js";

describe("MultiPlatformDocs Component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders multi-platform selector and initial TypeScript code snippet", () => {
    render(<MultiPlatformDocs />);

    expect(screen.getByText("Multi-Platform Code Reference & Tutorial")).toBeDefined();
    expect(screen.getByText(/3 Native Implementations/i)).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (TypeScript)")).toBeDefined();
  });

  it("switches language tabs to Dart and C# Unity dynamically", () => {
    render(<MultiPlatformDocs />);

    // Switch to Dart
    const dartBtn = screen.getByText("🎯 Dart 3+ (Flutter)");
    fireEvent.click(dartBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (Dart / Flutter)")).toBeDefined();

    // Switch to C# Unity
    const csharpBtn = screen.getByText("🎮 C# Unity (.NET)");
    fireEvent.click(csharpBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
  });

  it("switches concept tabs to the WAL and UCB1 guides", () => {
    render(<MultiPlatformDocs />);

    fireEvent.click(screen.getByText("🪵 5. WAL Durability"));
    expect(screen.getByText("SQLite WAL and Checkpoints (TypeScript)")).toBeDefined();

    fireEvent.click(screen.getByText("🚌 6. UCB1 Event Bus"));
    fireEvent.click(screen.getByText("🎮 C# Unity (.NET)"));
    expect(screen.getByText("UCB1 Frames and Hub Record (C# Unity)")).toBeDefined();
  });

  it("shows all three platforms at once in the side-by-side view", () => {
    render(<MultiPlatformDocs />);

    fireEvent.click(screen.getByText("Side by side"));
    expect(screen.getByText("QueryEngine & SWR Lifecycle (TypeScript)")).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (Dart / Flutter)")).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
    expect(screen.getAllByRole("region", { name: /code, scrollable$/ }).length).toBe(3);
  });

  it("copies code snippet to clipboard only after writeText resolves", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<MultiPlatformDocs />);

    await act(async () => {
      fireEvent.click(screen.getByText("📋 Copy Code"));
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByText("✓ Copied to Clipboard")).toBeDefined();
  });

  it("shows Copy failed when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<MultiPlatformDocs />);

    await act(async () => {
      fireEvent.click(screen.getByText("📋 Copy Code"));
    });

    expect(screen.getByText("Copy failed")).toBeDefined();
    expect(screen.queryByText("✓ Copied to Clipboard")).toBeNull();
  });

  it("shows Copy failed and never claims success when the clipboard is missing", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<MultiPlatformDocs />);

    await act(async () => {
      fireEvent.click(screen.getByText("📋 Copy Code"));
    });

    expect(screen.getByText("Copy failed")).toBeDefined();
    expect(screen.queryByText("✓ Copied to Clipboard")).toBeNull();
  });

  describe("Copied reset timer lifecycle", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const mockClipboard = () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    };

    it("clears the pending reset timer on unmount so nothing fires after teardown", async () => {
      vi.useFakeTimers();
      mockClipboard();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { unmount } = render(<MultiPlatformDocs />);

      await act(async () => {
        fireEvent.click(screen.getByText("📋 Copy Code"));
      });
      expect(screen.getByText("✓ Copied to Clipboard")).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("clears the earlier pending timer when a second copy starts", async () => {
      vi.useFakeTimers();
      mockClipboard();
      render(<MultiPlatformDocs />);

      await act(async () => {
        fireEvent.click(screen.getByText("📋 Copy Code"));
      });
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      await act(async () => {
        fireEvent.click(screen.getByText("✓ Copied to Clipboard"));
      });
      expect(vi.getTimerCount()).toBe(1);

      // The first timer would have fired at 2000ms; the second copy must have replaced it.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText("✓ Copied to Clipboard")).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText("📋 Copy Code")).toBeDefined();
    });
  });

  it("renders through Storybook App tab navigation", () => {
    render(<App />);

    const docsNav = screen.getByText("🌐 TS / Dart / Unity C#");
    fireEvent.click(docsNav);

    expect(screen.getByText("Multi-Platform Code Reference & Tutorial")).toBeDefined();
  });
});
