import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const src = path.resolve(import.meta.dirname, "../src");
const files = (readdirSync(src, { recursive: true }) as string[]).map((f) => path.join(src, f));
const read = (file: string) => readFileSync(file, "utf8");
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
describe("theme assets", () => {
  it("has no colour literal in any stylesheet", () => {
    const hits = files
      .filter((f) => f.endsWith(".css"))
      .flatMap((f) => read(f).split("\n").filter((l) => LITERAL.test(l)).map((l) => `${path.basename(f)}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
  it("has no colour literal in any inline style", () => {
    const hits = files
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) => read(f).split("\n").filter((l) => l.includes("style={{") && LITERAL.test(l)).map((l) => `${path.basename(f)}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
  it("forces a colour scheme only through data-theme", () => {
    const hits = files
      .filter((f) => f.endsWith(".css") && path.basename(f) !== "index.css")
      .filter((f) => /(?<![-\w])color-scheme\s*:/.test(read(f)))
      .map((f) => path.basename(f));
    expect(hits).toEqual([]);
    const index = read(path.join(src, "index.css"));
    expect(index).toMatch(/\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/);
    expect(index).toMatch(/\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/);
  });
  it("loads the self-hosted fonts and names them first", () => {
    const main = read(path.join(src, "main.tsx"));
    expect(main).toContain('import "@fontsource-variable/inter";');
    expect(main).toContain('import "@fontsource-variable/jetbrains-mono";');
    const index = read(path.join(src, "index.css"));
    expect(index).toMatch(/--joy-font-family-sans:\s*"Inter Variable"/);
    expect(index).toMatch(/--joy-font-family-mono:\s*"JetBrains Mono Variable"/);
  });
  it("colours syntax keywords, numbers and the active tab with the AA-safe accent text token", () => {
    const index = read(path.join(src, "index.css"));
    const block = index.match(/\.joy-syntax-keyword,[^{]*\{([^}]*)\}/);
    expect(block?.[0]).toContain(".joy-syntax-number");
    expect(block?.[0]).toContain('.joy-polyglot-tabs__tab[aria-selected="true"]');
    expect(block?.[1]).toContain("color: var(--joy-accent-text);");
  });
  it("does not draw a second border around the code block inside a platform snippet", () => {
    const css = read(path.join(src, "components", "multiplatform.css"));
    const rule = css.match(/\.mp-snippet \.mp-scroll\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/border:\s*none/);
  });
});
