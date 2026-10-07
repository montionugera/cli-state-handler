// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
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
    const csharpBtn = screen.getByText("🎮 C# Unity (.NET / IL2CPP)");
    fireEvent.click(csharpBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
  });

  it("switches concept tabs to Zero-Rebuild Observer", () => {
    render(<MultiPlatformDocs />);

    const observerTab = screen.getByText("🎯 2. Zero-Rebuild Observer");
    fireEvent.click(observerTab);

    expect(screen.getByText("Zero-Rebuild Selector Observer (React 19)")).toBeDefined();
  });

  it("copies code snippet to clipboard", async () => {
    render(<MultiPlatformDocs />);

    const copyBtn = screen.getByText("📋 Copy Code");
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(screen.getByText("✓ Copied to Clipboard")).toBeDefined();
  });

  it("renders through Storybook App tab navigation", () => {
    render(<App />);

    const docsNav = screen.getByText("🌐 TS / Dart / Unity C#");
    fireEvent.click(docsNav);

    expect(screen.getByText("Multi-Platform Code Reference & Tutorial")).toBeDefined();
  });
});
