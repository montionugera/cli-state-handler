---
title: "Editable TypeScript sandbox"
id: I-035
status: idea
---

# Editable TypeScript sandbox

Slice 9 of epic E-008 (docs portal). Depends on slice 2.

## Problem

The handoff asks for interactive code sandboxes. Today all code in the portal is static text.

## Scope

- `apps/docs/src/components/Sandbox.tsx` + CSS: a plain `<textarea>`-based editor (monospace, tab handling, line numbers), a Run button, a console panel and an error panel. No editor library.
- Transpile: `sucrase` (TypeScript transform only), loaded with a dynamic `import()` on first Run so it is not in the initial bundle. This is the epic's one declared dependency exception.
- Isolation: user code runs in an `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) built from `srcdoc`. The frame receives the browser-safe `@ucsa/core` build and the transpiled code; `console.*` calls and uncaught errors are forwarded to the parent with `postMessage`, and the parent accepts messages only from that frame's `contentWindow`. A run that exceeds 5 seconds is ended by replacing the frame.
- Presets: at least four runnable examples (first query, stale-while-revalidate refetch, debounce, selector observer), each also linkable as `#/sandbox?preset=<id>`.
- A note on the page that Dart and C# are read-only in this portal.
- One line in `routes.ts`.

## Acceptance criteria

- [ ] `apps/docs/tests/sandbox.test.tsx`: the transpile step turns a typed snippet into runnable JavaScript, and a syntax error is shown in the error panel rather than thrown.
- [ ] Same test: the generated frame has `sandbox="allow-scripts"` exactly, and a message from any other source is ignored.
- [ ] Same test: every preset transpiles without error.
- [ ] `sucrase` is absent from the entry chunk of `pnpm --filter @ucsa/docs build` (it appears only in a lazily loaded chunk).
- [ ] No use of `eval` or `new Function` in the parent page code.

## Non-goals

Type checking in the browser, npm imports, saving or sharing snippets.
