---
title: "Docs workflow file README handoff and epic check"
id: F-036
status: refined
from_idea: I-036
---

# Docs workflow file README handoff and epic check

Slice 10 of epic E-008 (docs portal). Last slice; depends on all others.

## Problem

The repo has no `.github/` directory, the README's portal section describes a tutorial that did not exist, its test-count table is hardcoded, `scripts/integration.sh` never runs `apps/docs`, there is no `scripts/epic-check.sh`, and the handoff document that started this epic is 14 lines with no state.

## Scope

- `.github/workflows/docs.yml`: on push to `main`, install with pnpm, run docs tests, build `apps/docs`, upload the Pages artifact and deploy. The repo has no git remote, so the workflow is delivered and validated as a file only; nothing is deployed.
- `scripts/integration.sh`: run the docs tests and build, replacing the "n/a" browser-smoke slot with a check that `apps/docs/dist/index.html` exists and the bundle has no Node-only imports.
- `scripts/epic-check.sh`: implement assertions 1–10 of the epic's `verification.md`. It takes the epic id as its argument and exits 0 without checking for any other epic.
- `README.md`: rewrite the "Interactive Storybook Tutorial & Live Documentation Studio" section to list the pages that exist (taken from `routes.ts`), the commands (dev, test, build, `ucsa docs`), the simulation-versus-real note, and the deploy workflow; regenerate the test-count table from the actual suite.
- `docs/handoff/ucsa-docs-portal.md`: the refreshed handoff — objective, what shipped (per slice), how to run and verify, known limits (simulations, no deploy without a remote), next actions. The original `/tmp/handoff-ucsa-docs-reactive.md` is updated to point at it.

## Acceptance criteria

- [ ] `.github/workflows/docs.yml` parses as YAML and references `apps/docs`.
- [ ] `scripts/integration.sh` exits 0 and no longer prints "n/a" for the browser slot.
- [ ] `scripts/epic-check.sh E-008` exits 0, and exits 0 immediately for an unknown epic id.
- [ ] `README.md` contains the title of every route in `routes.ts` (asserted by `epic-check.sh`).
- [ ] The README test-count table matches the counts reported by the test run.
- [ ] `docs/handoff/ucsa-docs-portal.md` exists and lists all ten slices with their state.

## Non-goals

Creating a git remote, enabling GitHub Pages, adding a browser test runner.
