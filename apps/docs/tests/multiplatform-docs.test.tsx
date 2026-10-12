// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup, waitFor, configure } from "@testing-library/react";
import { MultiPlatformDocs } from "../src/components/MultiPlatformDocs.js";
import { App } from "../src/App.js";

// The lazy Joymify chunk can take over a second to load on a busy machine.
configure({ asyncUtilTimeout: 5000 });
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

  it("switches language tabs to Dart and C# Unity dynamically", async () => {
    render(<MultiPlatformDocs />);

    // Switch to Dart
    const dartBtn = await screen.findByText("🎯 Dart 3+ (Flutter)");
    fireEvent.click(dartBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (Dart / Flutter)")).toBeDefined();

    // Switch to C# Unity
    const csharpBtn = await screen.findByText("🎮 C# Unity (.NET)");
    fireEvent.click(csharpBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
  });

  it("switches concept tabs to the WAL and UCB1 guides", async () => {
    render(<MultiPlatformDocs />);

    fireEvent.click(screen.getByText("🪵 5. WAL Durability"));
    expect(screen.getByText("SQLite WAL and Checkpoints (TypeScript)")).toBeDefined();

    fireEvent.click(screen.getByText("🚌 6. UCB1 Event Bus"));
    fireEvent.click(await screen.findByText("🎮 C# Unity (.NET)"));
    expect(screen.getByText("UCB1 Frames and Hub Record (C# Unity)")).toBeDefined();
  });

  it("offers the three platforms as Joymify tabs and highlights the TypeScript snippet", async () => {
    const { container } = render(<MultiPlatformDocs />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "🟦 TypeScript (React / Node)",
      "🎯 Dart 3+ (Flutter)",
      "🎮 C# Unity (.NET)",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('.joy-code-block [class^="joy-syntax-"]')).not.toBeNull();
    expect(container.querySelector(".mp-code")).toBeNull();
    fireEvent.click(tabs[2]);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");
  });
  it("renders three Joymify code blocks in the side-by-side view", async () => {
    const { container } = render(<MultiPlatformDocs />);
    fireEvent.click(screen.getByText("Side by side"));
    await waitFor(() => expect(container.querySelectorAll(".mp-side .joy-code-block").length).toBe(3));
    expect(screen.queryByRole("tablist")).toBeNull();
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
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    afterEach(() => {
      vi.useRealTimers();
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    });

    const mockClipboard = (writeText = vi.fn().mockResolvedValue(undefined)) => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    };

    it("does not start a reset timer when the clipboard write settles after unmount", async () => {
      vi.useFakeTimers();
      let resolveWrite!: () => void;
      mockClipboard(vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; })));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { unmount } = render(<MultiPlatformDocs />);

      await act(async () => {
        fireEvent.click(screen.getByText("📋 Copy Code"));
      });
      unmount();
      await act(async () => {
        resolveWrite();
      });

      expect(vi.getTimerCount()).toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

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
