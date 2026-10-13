// @vitest-environment jsdom
import React from "react";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { guides, guideIds, platforms } from "../src/content/guides/index.js";
import { parity } from "../src/content/parity.js";
import { ParityMatrix } from "../src/components/ParityMatrix.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const SUBSYSTEMS = ["swr", "timing", "outbox", "cas", "wal", "ucb1"];

// Pinned expected levels (columns: ts, dart, csharp, godot).
const EXPECTED_LEVELS: Record<string, [string, string, string, string]> = {
  swr: ["full", "full", "full", "full"],
  timing: ["full", "full", "partial", "partial"],
  outbox: ["full", "partial", "partial", "partial"],
  cas: ["full", "full", "full", "full"],
  wal: ["full", "partial", "partial", "partial"],
  ucb1: ["full", "partial", "partial", "partial"],
};

describe("guide content", () => {
  it("covers the six subsystems in order", () => {
    expect(guideIds).toEqual(SUBSYSTEMS);
  });

  it("lists godot as the fourth platform", () => {
    expect(platforms).toEqual(["ts", "dart", "csharp", "godot"]);
  });

  for (const id of SUBSYSTEMS) {
    for (const p of platforms) {
      it(`${id}/${p} has a source-checked snippet or a not-available marker`, () => {
        const s = guides[id as keyof typeof guides][p];
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.notes.length).toBeGreaterThan(0);
        if (s.available) {
          expect(s.code.trim().length).toBeGreaterThan(0);
          expect(s.code).toContain("Checked against:");
          expect(s.code.length).toBeGreaterThan(40);
        } else {
          // A "not available" marker is only legitimate where the matrix says none.
          expect(parity.find((r) => r.id === id)?.cells[p].level).toBe("none");
          expect(s.code).toBe("");
          expect(s.notes.join(" ")).toMatch(/not available/i);
          expect(s.notes.join(" ")).toMatch(/searched/i);
        }
      });
      it(`${id}/${p} cites source files that exist`, () => {
        const s = guides[id as keyof typeof guides][p];
        expect(s.sources.length).toBeGreaterThan(0);
        for (const f of s.sources) {
          expect(fs.existsSync(path.join(repoRoot, f)), f).toBe(true);
        }
      });
    }
  }
});

describe("parity data", () => {
  it("has one row per subsystem and four platform cells each", () => {
    expect(parity.map((r) => r.id)).toEqual(SUBSYSTEMS);
    for (const r of parity) {
      for (const p of platforms) {
        expect(["full", "partial", "none"]).toContain(r.cells[p].level);
      }
    }
  });

  it("matches the pinned 6x4 level table", () => {
    for (const r of parity) {
      expect(platforms.map((p) => r.cells[p].level), r.id).toEqual(EXPECTED_LEVELS[r.id]);
    }
  });

  it("requires a reason for every partial cell", () => {
    for (const r of parity) {
      for (const p of platforms) {
        const c = r.cells[p];
        if (c.level === "partial") expect(c.reason?.length ?? 0).toBeGreaterThan(10);
      }
    }
  });

  it("only cites source paths that exist on disk", () => {
    let cited = 0;
    for (const r of parity) {
      for (const p of platforms) {
        for (const f of r.cells[p].sources) {
          cited++;
          expect(fs.existsSync(path.join(repoRoot, f)), `${r.id}/${p}: ${f}`).toBe(true);
        }
      }
    }
    expect(cited).toBeGreaterThan(10);
  });
});

describe("ParityMatrix", () => {
  afterEach(() => cleanup());

  it("renders one row per subsystem and four platform columns with text labels", () => {
    render(<ParityMatrix />);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Subsystem", "TypeScript", "Dart", "Unity C#", "Godot C#"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBe(6);
    rows.forEach((row, i) => {
      const cells = within(row).getAllByRole("cell");
      expect(cells.length).toBe(4);
      platforms.forEach((platform, j) => {
        expect(cells[j].textContent?.startsWith(parity[i].cells[platform].level), `${parity[i].id}/${platform}`).toBe(true);
      });
    });
  });

  it("puts the table in a focusable, named scroll region", () => {
    render(<ParityMatrix />);
    const region = screen.getByRole("region", { name: "Parity matrix, scrollable" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});
