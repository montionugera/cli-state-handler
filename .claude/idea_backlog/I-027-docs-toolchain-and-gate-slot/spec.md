---
title: "Docs toolchain and gate slot"
id: I-027
status: idea
---

# Docs toolchain and gate slot

Slice 1 of epic E-008 (docs portal). Hard blocker for every other slice.

## Problem

Root `pnpm test`, `pnpm --filter @ucsa/docs test` and `pnpm --filter @ucsa/docs build` all fail with `MODULE_NOT_FOUND` for the rollup/rolldown native binding: Node runs as x64 while only the `darwin-arm64` bindings are installed. Gate 1 (`scripts/precheck.sh`, the pre-ship build and test check) is therefore red for the whole repo. Separately, `precheck.sh` slot 3 ("static UI checks") prints "n/a" although `apps/docs` is a UI.

## Scope

- Declare `supportedArchitectures` (`os: [darwin, linux]`, `cpu: [x64, arm64]`) in the pnpm config so both bindings install; reinstall; commit the lockfile change.
- Replace the "n/a" in `precheck.sh` slot 3 with a real check for `apps/docs`: typecheck (`tsc -b`) plus the docs test suite.
- No source changes to `apps/docs` or `packages/core`.

## Acceptance criteria

- [ ] `pnpm test` at the repo root exits 0.
- [ ] `pnpm --filter @ucsa/docs test` exits 0.
- [ ] `pnpm --filter @ucsa/docs build` exits 0 and writes `apps/docs/dist/index.html`.
- [ ] `scripts/precheck.sh` exits 0 and its slot 3 output names `apps/docs` instead of "n/a".
- [ ] `git diff` touches only pnpm config, the lockfile and `scripts/precheck.sh`.

## Non-goals

Changing the Node version, adding dependencies, touching `integration.sh` (slice 10).
