// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { App } from "../src/App.js";
import { routes } from "../src/routes.js";

const PAGES: Array<{ id: string; visualiser: RegExp; next: string }> = [
  { id: "tutorial-first-query", visualiser: /SWR & Query Lifecycle Playground/, next: "#/tutorial-freshness" },
  { id: "tutorial-freshness", visualiser: /Observer Timing & UI Render Suppression/, next: "#/tutorial-durable-cache" },
  { id: "tutorial-durable-cache", visualiser: /SQLite WAL Storage Visualiser/, next: "#/tutorial-outbox" },
  { id: "tutorial-outbox", visualiser: /Offline Mutation Outbox & Conflict Resolution/, next: "#/tutorial-ucb1" },
  { id: "tutorial-ucb1", visualiser: /Compose frame/, next: "#/parity" },
];

describe("tutorial path", () => {
  beforeEach(() => {
    window.scrollTo = (() => undefined) as typeof window.scrollTo;
  });
  afterEach(() => cleanup());

  it("registers five Tutorial routes right after Start and the matrix under Guides", () => {
    const groupsInOrder = [...new Set(routes.map((r) => r.group))];
    expect(groupsInOrder.slice(0, 2)).toEqual(["Start", "Tutorial"]);
    expect(routes.filter((r) => r.group === "Tutorial").map((r) => r.id)).toEqual(PAGES.map((p) => p.id));
    expect(routes.find((r) => r.id === "parity")?.group).toBe("Guides");
  });

  it("tutorial-freshness renders the stale/expiry timeline under an h2 section", () => {
    window.location.hash = "#/tutorial-freshness";
    render(<App />);
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 3, name: "Stale and expiry timeline" })).toBeDefined();
    expect(within(main).getByRole("heading", { level: 2, name: "Watch an entry go stale" })).toBeDefined();
  });

  for (const page of PAGES) {
    it(`${page.id} renders a heading, its visualiser and a link to the next page`, () => {
      window.location.hash = `#/${page.id}`;
      render(<App />);
      const main = screen.getByRole("main");
      expect(within(main).getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(within(main).getAllByText(page.visualiser).length).toBeGreaterThan(0);
      const next = main.querySelector<HTMLAnchorElement>("a[data-next]");
      expect(next?.getAttribute("href")).toBe(page.next);
    });
  }
});
