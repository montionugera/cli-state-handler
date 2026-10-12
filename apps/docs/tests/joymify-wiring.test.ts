import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as joy from "@montionugera/joy-react";
const docs = path.resolve(import.meta.dirname, "..");
const root = path.resolve(docs, "../..");
const read = (file: string) => readFileSync(file, "utf8");
// Built from parts so this file never matches the repository-wide grep for the old alias names.
const ALIAS = "joy-" + "alias";
const SIBLING = new RegExp(`${ALIAS}|joy-` + "design");
// The working names the base branch used. They were never published.
const OLD_SCOPE = "@joy" + "mify/";
describe("Joymify packages come from the registry", () => {
  it("has no sibling-checkout alias left", () => {
    expect(existsSync(path.join(docs, `${ALIAS}.ts`))).toBe(false);
    for (const file of ["vite.config.ts", "vitest.config.ts", "tsconfig.json"]) {
      expect(read(path.join(docs, file)), file).not.toMatch(SIBLING);
      expect(read(path.join(docs, file)), file).not.toContain(OLD_SCOPE);
    }
    expect(read(path.join(root, "vitest.config.ts"))).not.toMatch(SIBLING);
  });
  it("depends on published version ranges", () => {
    const deps = JSON.parse(read(path.join(docs, "package.json"))).dependencies;
    expect(deps["@montionugera/joy-react"]).toBe("^0.2.0");
    expect(deps["@montionugera/joy-tokens"]).toBe("^0.2.0");
    expect(Object.keys(deps).filter((name) => name.startsWith(OLD_SCOPE))).toEqual([]);
  });
  it("maps the scope for pnpm only, so the npm release of the libraries is untouched", () => {
    const workspace = read(path.join(root, "pnpm-workspace.yaml"));
    expect(workspace).toMatch(/^registries:\n  default: https:\/\/registry\.npmjs\.org\/\n  '@montionugera': https:\/\/npm\.pkg\.github\.com\/$/m);
    // npm reads .npmrc. A registry line there would send npm view and npm publish
    // for @montionugera/ucsa-* to GitHub Packages. The file must not exist.
    expect(existsSync(path.join(root, ".npmrc"))).toBe(false);
  });
  it("exports the components the portal uses", () => {
    const names = ["Button", "Badge", "Input", "MetricTile", "CodeBlock", "PolyglotCodeTabs", "MermaidViewer", "MarkdownViewer", "Segmented", "Alert"] as const;
    for (const name of names) expect(joy[name], name).toBeDefined();
  });
});
