// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
vi.mock("../src/components/rich-impl.js", () => {
  throw new Error("chunk failed to load");
});
import { Code } from "../src/components/rich.js";
describe("lazy chunk failure", () => {
  afterEach(() => cleanup());
  it("keeps the plain code on screen instead of unmounting the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<Code code="const a = 1;" language="typescript" className="x" />);
    await waitFor(() => expect(container.querySelector(".rich-fallback.x")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toContain("const a = 1;");
    expect(container.querySelector(".joy-code-block")).toBeNull();
  });
});
