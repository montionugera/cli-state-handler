// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ThemeToggle } from "../src/components/ThemeToggle.js";
import { THEME_KEY } from "../src/theme.js";
const html = readFileSync(path.resolve(import.meta.dirname, "../index.html"), "utf8");
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const runInlineScript = () => new Function(inlineScript)();
const root = document.documentElement;
const checked = (name: string) => screen.getByRole("radio", { name }).getAttribute("aria-checked");
describe("theme toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute("data-theme");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("choosing Dark sets data-theme and saves the choice", () => {
    render(<ThemeToggle />);
    expect(checked("System")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(checked("Dark")).toBe("true");
  });
  it("choosing System removes the attribute and the saved key", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
  it("index.html no longer forces dark and runs its script inside head", () => {
    expect(html).not.toContain('data-theme="dark"');
    expect(inlineScript.trim()).not.toBe("");
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("</head>"));
  });
  it("applies a saved choice on load, and the toggle shows it", () => {
    localStorage.setItem(THEME_KEY, "light");
    runInlineScript();
    expect(root.getAttribute("data-theme")).toBe("light");
    render(<ThemeToggle />);
    expect(checked("Light")).toBe("true");
  });
  it("ignores a saved value that is neither light nor dark", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    runInlineScript();
    expect(root.hasAttribute("data-theme")).toBe(false);
    render(<ThemeToggle />);
    expect(checked("System")).toBe("true");
  });
  it("keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(runInlineScript).not.toThrow();
    render(<ThemeToggle />);
    expect(checked("System")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
