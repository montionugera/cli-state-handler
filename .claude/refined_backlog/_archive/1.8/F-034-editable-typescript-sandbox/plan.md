# Editable TypeScript sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `#/sandbox` docs page where visitors edit TypeScript, press Run, and see console output from real `@ucsa/core`, executed in an isolated iframe.

**Architecture:** Pure modules in `apps/docs/src/sandbox/` (transpile, srcdoc/program builder, message validation, console formatting, presets) are unit-tested without a frame. `components/Sandbox.tsx` wires them to a textarea editor and a `sandbox="allow-scripts"` iframe. The core browser bundle is produced at build time by a small Vite plugin (`apps/docs/build/ucsa-core-iife.ts`) that runs a Vite library-mode IIFE build of `packages/core/src/browser.ts` and exposes it as the virtual module `virtual:ucsa-core-iife` (a string). It is loaded with dynamic `import()` on first Run, like `sucrase`, so neither is in the entry chunk. `packages/core/dist` is multi-file `tsc` output, so option (a) (`?raw` of a prebuilt bundle) does not apply.

**Tech Stack:** React 19, Vite 8, vitest + jsdom, `sucrase` (the one allowed new dependency).

**Spec:** `.claude/refined_backlog/F-034-editable-typescript-sandbox/spec.md`

## Global Constraints

- Only new dependency: `sucrase`, loaded via dynamic `import("sucrase")`; absent from the entry chunk.
- No editor library; plain `<textarea>`.
- Frame attribute exactly `sandbox="allow-scripts"`; never `allow-same-origin`.
- No `eval` / `new Function` anywhere in `apps/docs/src`.
- Do not modify `packages/`, `README.md`, `App.tsx`, `index.css`, `shell.css`, `router.ts`, other components, or any `_catalog.json`.
- One line added to `routes.ts`, new sidebar group "Sandbox".
- No `any`, no non-null assertions; monotonic ids as list keys.
- Docs text must describe only real behaviour; Dart/C# are read-only in this portal.

---

### Task 1: Pure sandbox modules (transpile, protocol, program builder, formatter)

**Files:**
- Create: `apps/docs/src/sandbox/transpile.ts`, `protocol.ts`, `program.ts`, `presets.ts`
- Create: `apps/docs/build/ucsa-core-iife.ts`; modify `apps/docs/vite.config.ts`, `apps/docs/vitest.config.ts`; create `apps/docs/src/virtual.d.ts`
- Test: `apps/docs/tests/sandbox.test.tsx`

**Interfaces:**
- `transpile(code: string): Promise<{ ok: true; js: string } | { ok: false; message: string }>`
- `parseSandboxMessage(data: unknown, runId: number): SandboxMessage | null`
- `buildSandboxProgram(coreSource: string, js: string, runId: number): string`; `buildSrcdoc(program: string): string` (CSP meta, escaping of `</script`)
- `presets: Preset[]` with `{ id, title, description, code }`

- [ ] Write failing tests: transpile strips types; syntax error returns `ok:false`; message validation (foreign shape, wrong runId); srcdoc contains CSP meta; every preset transpiles and runs inside `node:vm` against the real IIFE bundle with expected console output.
- [ ] Run, confirm they fail (modules missing).
- [ ] Implement modules, Vite plugin, virtual module typing.
- [ ] Run, confirm they pass.

### Task 2: Component, route, styles

**Files:**
- Create: `apps/docs/src/components/Sandbox.tsx`, `Sandbox.css`
- Modify: `apps/docs/src/routes.ts` (one line)
- Test: `apps/docs/tests/sandbox.test.tsx`

- [ ] Failing tests: page renders heading in `main`; frame is `sandbox="allow-scripts"` after Run; message from a foreign source is ignored, message from the frame's contentWindow appears in the `aria-live` console; syntax error shows in the error panel, nothing thrown; `?preset=` selects the preset and selecting updates the hash; Tab inserts two spaces, Escape then Tab does not; Dart/C# note present.
- [ ] Implement component (5 s timeout replaces the frame; each Run uses a fresh keyed frame).
- [ ] All docs tests green, including `app-shell.test.tsx` unchanged.

### Task 3: Build evidence and gates

- [ ] `npx tsc -b`; `pnpm --filter @ucsa/docs build`; list `dist/assets` and grep chunks for a sucrase identifier; record entry chunk size before (baseline build at 781fecb) and after.
- [ ] `grep -rnE "\beval\(|new Function" apps/docs/src` empty; `scripts/precheck.sh`.
- [ ] README: not edited in this slice (a later slice regenerates it, per slice brief).
- [ ] Phase gate: independent review of the diff, fix findings, re-verify.
- [ ] Commit (new commits only).

## Audit trail

Self-grill (plan-level): (1) blocking sync loops cannot be interrupted by the parent timer in every browser: documented as a caveat on the page, not claimed solved. (2) Core bundle must not enter the entry chunk: loaded through dynamic import. (3) Frame-side script is a plain string, so it is exercised in `node:vm` rather than assumed.

## Appendix - audit trail

- 2026-10-09 self-grill-audit: verdict safe-with-fixes. Corrected:
  - HIGH top-level await: the program wraps transpiled JS in `(async () => { ... })()` and reports rejection/`done`; presets may use top-level `await`.
  - HIGH node:vm harness: context gets `console`, `setTimeout`, `clearTimeout`, `Promise`, `parent`, `addEventListener`; real timers with short delays.
  - MEDIUM line-number gutter: added to Task 2 with a test (gutter line count follows the textarea).
  - MEDIUM nested build uses `configFile:false` (no recursion); the plugin is also registered in `vitest.config.ts`.
  - MEDIUM routes take no props: `Sandbox` calls `useHashRoute()` itself (re-renders on `hashchange`); tested.
  - MEDIUM sucrase absence check: grep the built chunks for a sucrase-specific string that survives minification (e.g. the "Unexpected token" parser text) and list chunk names.
  Open: none.
