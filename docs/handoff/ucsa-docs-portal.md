# Handoff: UCSA docs portal (`apps/docs`, epic E-008)

Supersedes the 14-line `/tmp/handoff-ucsa-docs-reactive.md`, which now points here.

## Objective

An interactive, hash-routed documentation portal for UCSA (Unified Client State Architecture): visualisers for the SWR lifecycle, timing controls, the offline outbox, CAS, the UCB1 event bus and SQLite WAL, plus multi-platform (TypeScript, Dart, C#) guides, a parity matrix, a five-page tutorial and an editable TypeScript sandbox (15 routes in `apps/docs/src/routes.ts`). It runs fully in the browser against the browser-safe entry of `@montionugera/ucsa-core`, and is deployed as static files (GitHub Pages workflow).

## Slice status

State as of `release/1.8` with every slice merged (2026-10-09). Release 1.8 is **not promoted to main**, by the user's instruction.

| Slice | Feature | Content | State |
| :--- | :--- | :--- | :--- |
| 1 | F-027 | Docs toolchain and Gate 1 slot | On main via release 1.7 |
| 2 | F-028 | App shell, hash routing, `routes.ts` registry | Shipped to `release/1.8` |
| 3 | F-029 | UCB1 event bus visualiser + codec parity test | Shipped to `release/1.8` |
| 4 | F-030 | SQLite WAL visualiser (labelled simulation) | Shipped to `release/1.8` |
| 5 | F-031 | CAS playground on a tested model | Shipped to `release/1.8` |
| 6 | F-032 | Outbox playground on a tested model | Shipped to `release/1.8` |
| 7 | F-033 | SWR lifecycle graph + stale/gc timeline | Shipped to `release/1.8` |
| 8 | F-034 | TypeScript sandbox (`#/sandbox`) | Shipped to `release/1.8` on 2026-10-09 (details below) |
| 9 | F-035 | Multi-platform guides, parity matrix (`#/parity`), five tutorial pages | Shipped to `release/1.8` on 2026-10-09 (details below) |
| 10 | F-037 | Phone-width and cosmetic fixes | Shipped to `release/1.8` on 2026-10-09 |
| 11 | F-036 | Pages workflow, README, this handoff, `epic-check.sh`, `integration.sh` slot | Shipped to `release/1.8` on 2026-10-09; `scripts/epic-check.sh E-008` passes assertions 1 to 10 on the release branch |

- **F-034 sandbox.** An independent security review approved it after fixes: user code is embedded as an escaped JSON string; the iframe uses `sandbox="allow-scripts"` only; a run ends on a second frame load; every frame message counts toward the 2000-message cap. A real Chrome run passed: four presets, Stop, awkward input (`x<!--b`), isolation (parent, storage and fetch blocked), the cap message, and no overflow at 360px. Its Vite plugin lives in `apps/docs/vite-plugins/`. It was first written under `apps/docs/build/`, which the root `.gitignore` rule `build/` silently ignored; the post-merge gate caught the missing file.
- **F-035 guides, matrix, tutorial.** Two independent accuracy reviews against the TypeScript, Dart and C# source; 18 findings fixed. Final matrix levels (ts / dart / csharp): swr full/full/full; timing full/full/partial; outbox full/partial/partial; cas full/full/full; wal full/partial/partial; ucb1 full/partial/partial.
- **F-037.** A real Chrome check at 360px passed for `#/cas`, `#/swr`, `#/outbox`, `#/wal`, `#/ucb1`.
- **Browser check of guides, parity matrix and tutorial: done (real Chrome, 2026-10-09, `release/1.8` build, all 15 routes).** The guides platform switch, the parity matrix (18 cells match), the tutorial chain 1 to 5 and the embedded visualisers all passed. No page-level horizontal overflow at 360px on the nine pages measured. Two defects were found and fixed in this slice: five pages (`#/swr`, `#/timing`, `#/outbox`, `#/cas`, `#/multiplatform`) had no `h1`, and the sandbox SWR preset depended on a 20 ms timer. **Not checked:** the fixed SWR preset was only ever run in a background (hidden) tab; the Copy button was only seen in its "Copy failed" state because the tab was unfocused; touch input and keyboard focus rings were not exercised.
- The repository has no git remote, so the Pages workflow has never run.

## How to run and verify

```bash
pnpm install && pnpm --filter @montionugera/ucsa-core build   # fresh worktree needs both
pnpm --filter @ucsa/docs dev      # http://localhost:6006/cli-state-handler/ (6007 if busy)
pnpm --filter @ucsa/docs test
pnpm --filter @ucsa/docs build    # -> apps/docs/dist
ucsa docs                         # CLI launcher for the dev server (alias: ucsa tutorial)
scripts/precheck.sh               # Gate 1: includes apps/docs typecheck + tests
scripts/integration.sh            # Gate 2: browser slot = docs tests + build + bundle check
scripts/epic-check.sh E-008       # epic assertions 1-10; any other epic id exits 0
```

Epic assertion 11 (built portal in Chrome at 360px and 1280px, no horizontal scroll, no console errors on every route) is manual and is not done by any script. It was run once by a browser agent on 2026-10-09 against the `vite preview` build of `release/1.8` at `97ddede`: all 15 routes from `apps/docs/src/routes.ts` passed at both widths (`scrollWidth` equal to `clientWidth`, exactly one `h1` per route, no console errors captured). Limits of that run: each width was a same-origin iframe of exactly 360px or 1280px in a tab that was probably in the background, not a real phone or a resized window; console errors were collected by listeners installed inside the iframe after the first load, so errors during the initial `#/home` load are not covered; touch, keyboard focus, playground interactions, other browsers and the base path on a real host were not exercised.

`epic-check.sh` greps the built bundle for real Node imports only (`better-sqlite3|node:(fs|net|crypto|path)`). The epic's original wording, which also matched `Buffer.from`, is too broad: browser `@montionugera/ucsa-core` code legitimately uses `Buffer`.

## Deploy

`.github/workflows/docs.yml` (push to `main` or manual): pnpm install, build `@montionugera/ucsa-core`, test and build `apps/docs`, upload `apps/docs/dist`, deploy to Pages. Base path is `/cli-state-handler/` (`apps/docs/vite.config.ts`). The repository has **no git remote and no CI**, so the workflow has never run and is validated only as YAML. To use it: add a remote, push, and set Settings > Pages > Source to "GitHub Actions".

## Known limits

- Most pages are simulations or models, not the production classes. Parity tests pin the UCB1 codec, CAS and Outbox models to the real implementations; the WAL page is a labelled simulation of SQLite's pager; the UCB1 hub model has no HELLO/token handshake.
- Real behaviour that the docs must not overstate: `QueryEngine` has no observer-based garbage collection and no built-in focus/online refetch (`stale_at`/`expires_at` are fixed at fetch; expiry is checked lazily when SQLite reloads). `LifecycleFSM` has no guards and is not used by the engine. CAS has no refcount (LRU prune to 70% of quota). The Outbox has no backoff, no lease fencing on completion/failure, no connectivity check, and its callbacks and policy live in memory only. In the UCB1 hub an empty subscription set receives every event, and a malformed frame destroys the socket with no ERROR frame.
- No browser test runner: UI tests are Vitest + jsdom, so layout, scrolling and real-browser console errors are unverified by machine (assertion 11 was a one-off manual pass, see Verification, and must be repeated after layout changes).
- Nothing has been deployed.

## Follow-ups (not fixed in this epic)

- `better-sqlite3` is declared `^11` in two `package.json` files (root devDependencies and `packages/core`) while `pnpm-workspace.yaml` overrides it to `^12.11.1` (11.x does not build on Node 26). Bump both ranges and drop the override.
- Outbox stale-worker completion/failure is unfenced: a worker whose lease expired can still complete or fail an item, and can double-rollback.
- Outbox callbacks are not persisted; after a restart, queued mutations have no `onSuccess`/`onError`/conflict policy.
- Existing `Buffer` use in the browser bundle of `@montionugera/ucsa-core`.
- The TypeScript sandbox could move to a terminable Web Worker so a runaway script can be stopped.
- The SWR sandbox preset (1000 ms stale time) reads the fresh step right after the first fetch resolves and waits for each fetch by subscribing to the query, so only its single 1100 ms sleep uses the clock (a throttled tab only makes it longer, which is still stale). It has not been re-run in a foreground tab; a very slow machine could still cross 1000 ms between two awaited statements.
- The sandbox frame can still navigate itself once before the run is ended, so it is not a network-isolation guarantee (the page says so).
- `.gitignore` has a bare `build/` rule that will silently ignore any future `build/` source folder (this already hid the F-034 Vite plugin once).
- The Dart and C# ports differ from the TypeScript core in ways the guides now document (Dart `watchQuery` staleness formula, `prune()` threshold, `ConflictPolicy.merge` not implemented, C# `StateObserver` not engine-bound): candidates for port alignment.
- Page titles are not one size: the `h1` renders at 20px on `#/swr`, `#/timing`, `#/outbox`, `#/cas`, `#/multiplatform` and `#/parity`, and at 28px on `#/wal`, `#/ucb1`, the tutorial pages and home (measured in Chrome, 2026-10-09). Cosmetic only.
- Heading outline when embedded: `TimingPlayground`'s second card keeps a hard-coded `h2`, so inside the Freshness tutorial page it is a sibling of the playground title, not a child.
- The Unity test rows in the README table sum to 151, while `dotnet test` reports 137; the per-row counts need recounting.
- The native addon needs `pnpm rebuild better-sqlite3` when switching Node architecture (x64 vs arm64).

## Next actions

1. All slices are shipped to `release/1.8`; nothing is left to ship for this epic.
2. Epic assertion 11 passed on 2026-10-09 (15 routes, 360px and 1280px, iframe method; limits listed under the verification commands above). `scripts/epic-check.sh E-008` covers assertions 1 to 10. A foreground-tab look at the initial home load, the Copy button and focus rings is still open.
3. Release 1.8 stays unpromoted until the user decides.
4. When a remote exists: push, enable Pages, confirm the first workflow run, then open the deployed URL.
