import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/models/changelog.js";

describe("parseChangelog", () => {
  it("returns entries newest first with their notes", () => {
    const text = "# Changelog\n\nIntro.\n\n## 0.2.0 - 2026-10-10\n\n- Docs sandbox (F-036)\n- fix: close handle\n\n## 0.1.1 - 2026-10-09\n\n- first\n";
    expect(parseChangelog(text)).toEqual([
      { version: "0.2.0", date: "2026-10-10", notes: ["Docs sandbox (F-036)", "fix: close handle"] },
      { version: "0.1.1", date: "2026-10-09", notes: ["first"] },
    ]);
  });
  it("returns an empty list when there are no entries", () => {
    expect(parseChangelog("# Changelog\n")).toEqual([]);
  });
  it("tolerates a heading without a date", () => {
    expect(parseChangelog("## 0.3.0\n\n- x\n")).toEqual([{ version: "0.3.0", date: "", notes: ["x"] }]);
  });
  it("parses the real repo CHANGELOG.md into at least one semver entry", () => {
    const text = readFileSync(resolve(process.cwd(), "../../CHANGELOG.md"), "utf8");
    const entries = parseChangelog(text);
    expect(entries.some((e) => /^\d+\.\d+\.\d+$/.test(e.version))).toBe(true);
  });
});
