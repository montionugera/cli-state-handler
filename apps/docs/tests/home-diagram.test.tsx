// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Home } from "../src/pages/Home.js";
describe("Overview request-path diagram", () => {
  afterEach(() => cleanup());
  it("draws the cache, write-ahead log and outbox path as an svg", async () => {
    const { container } = render(<Home />);
    await waitFor(() => expect(container.querySelector(".home__diagram svg.joy-mermaid__svg")).not.toBeNull());
    const text = container.querySelector(".home__diagram svg.joy-mermaid__svg")?.textContent ?? "";
    for (const label of ["Memory cache", "Write-ahead log on disk", "Offline outbox"]) expect(text).toContain(label);
  });
});
