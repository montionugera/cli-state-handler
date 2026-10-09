# F-027 plan: Docs toolchain and gate slot

Goal: make root test, docs test and docs build pass on this machine and give Gate 1 slot 3 a real apps/docs check.

## Task 1: pnpm config (pnpm 10.13.1 reads pnpm-workspace.yaml)
- Add `supportedArchitectures` (os darwin+linux, cpu x64+arm64) so rollup/rolldown bindings for both arches install.
- Add `onlyBuiltDependencies` (better-sqlite3, esbuild) so pnpm 10 runs their build scripts.
- Add `overrides: better-sqlite3 ^12.11.1`: 11.10.0 does not compile against Node 26 (v8 API removals); 12.x does. Config-only, no package.json edit.
- `pnpm install`; commit lockfile.
- Verify: `pnpm test`, `pnpm --filter @ucsa/docs test`, `pnpm --filter @ucsa/docs build` exit 0; apps/docs/dist/index.html exists.

## Task 2: precheck slot 3
- Replace `unfilled` in `slot_static_ui_checks` with `tsc -b` in apps/docs plus the docs test suite.
- Verify: `scripts/precheck.sh` exits 0; slot 3 output names apps/docs.

## Task 3: gate
- Verify `git diff --stat` touches only pnpm config, lockfile, precheck.sh, this plan.
- Review: audit findings (below) applied; no src changes. README: no new capability/env/API, nothing to update.

## Audit notes
- Risk: the better-sqlite3 override is a major bump (11 to 12); full core suite passes on it (395 tests).
- Limitation: better-sqlite3 is a native addon built once for the Node that ran the install. This tree was installed under x64 Node 26, so the arm64 Node 24 at /opt/homebrew/bin fails to load it (ERR_DLOPEN_FAILED). Switching Node architecture requires `pnpm rebuild better-sqlite3`.
- Do not touch integration.sh.
