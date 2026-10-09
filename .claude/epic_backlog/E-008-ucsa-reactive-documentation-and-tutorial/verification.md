---
title: "UCSA reactive documentation and tutorial studio"
id: E-008
---

# How we will know E-008 works

Prose for humans. `scripts/epic-check.sh` implements these assertions; the
toolkit never parses this file.

## Assertions

Checked by `scripts/epic-check.sh` (created in the last slice):

1. `pnpm --filter @ucsa/docs test` exits 0, and each of these files exists under `apps/docs/tests/`: `app-shell.test.tsx`, `swr-playground.test.tsx`, `timing-playground.test.tsx`, `outbox-playground.test.tsx`, `cas-playground.test.tsx`, `wal-visualiser.test.tsx`, `ucb1-visualiser.test.tsx`, `sandbox.test.tsx`, `multiplatform-docs.test.tsx`, plus the model tests `ucb1-codec.parity.test.ts`, `cas-model.parity.test.ts`, `outbox-model.parity.test.ts`, `wal-model.test.ts`.
2. `pnpm --filter @ucsa/docs build` exits 0 and `apps/docs/dist/index.html` exists.
3. No file under `apps/docs/dist/assets` matches `better-sqlite3|node:(fs|net|crypto|path)`.
4. `app-shell.test.tsx` renders every route id in the exported `routes` array and renders the not-found page for an unknown hash.
5. `ucb1-codec.parity.test.ts` asserts the browser model's encoded bytes equal the real `frame-codec` output for the shared fixtures, starting with the bytes `UCB1`, and decode back to the original payload.
6. `wal-visualiser.test.tsx` asserts: a write appears in the WAL list before the main-file list; a reader opened earlier still reads the old value; a checkpoint empties the WAL list; the text "simulation" is present.
7. `multiplatform-docs.test.tsx` asserts TypeScript, Dart and C# code is present for each of the six subsystem ids, and that the parity matrix renders one row per subsystem.
8. `.github/workflows/docs.yml` exists, parses as YAML and references `apps/docs`.
9. `README.md` contains the title of every route in `routes.ts` and the four commands: dev, test, build, and the docs CLI.
10. `scripts/precheck.sh` and `scripts/integration.sh` exit 0, and neither prints "n/a" for the UI slots.

Checked by hand, not by the script (no browser test runner is in scope):

11. The built portal, loaded in Chrome at 360px and 1280px widths, shows no horizontal page scroll and no console errors on every route.
