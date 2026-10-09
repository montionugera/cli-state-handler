# Outbox playground on a tested model Implementation Plan

**Goal:** Replace the mock queue in `OutboxPlayground.tsx` with an in-memory model that mirrors `MutationOutbox` and is proven equal to it by a parity test.

**Architecture:** `apps/docs/src/models/outbox-model.ts` is a pure TS class with an injectable clock and no I/O. A Node-side vitest parity test imports the real `MutationOutbox` + `SqliteAdapter(':memory:')` by relative path from `packages/core/src` and drives identical scripts through both, using fake timers so `Date.now()` is controlled. The component is rewired onto the model with a virtual clock, two workers, and an offline toggle.

**Tech Stack:** React 19, Vite, vitest + jsdom, @testing-library/react. No new dependencies.

**Spec:** `.claude/refined_backlog/F-032-outbox-playground-on-a-tested-model/spec.md`

## Global Constraints
- `packages/core`, `README.md`, `apps/docs/package.json`, `routes.ts`, `App.tsx`, `index.css`, `shell.css`, `router.ts` are NOT modified (README deviation: a later slice regenerates it).
- No `any`, no non-null assertions, no real sleeps in tests.
- 360px: `minmax(0,1fr)` grids, wrapping button rows, table in `overflow-x:auto`.
- Bundle must not contain `better-sqlite3` / `node:`.
- Mirrored (read from `mutation-outbox.ts`): statuses `pending|in_flight|failed`; claim candidates = `pending` OR (`in_flight` AND `lease_until < now`, strict); ordered by `created_at`; claim sets `lease_owner`, `lease_until=now+lease`, `last_attempt_at`. 2xx removes row; 409 -> server-wins `rollback` (callback, remove), client-wins `force` (pending, `forced`, header `X-Force-Overwrite: true`), merge (`mergeResolver(local, server)` -> payload, pending); other 4xx -> `failed` w/o retry bump, error `HTTP n`; 5xx/throw -> `retry_count+1`, `failed` when `>= maxRetries` (3) else `pending`; lease cleared on all non-claim updates. Rate limit = sleep between consecutive mutations in a batch (not before the first). The real outbox has NO backoff delay and does NOT fence completion by lease owner; the model mirrors both.

---

### Task 1: Model + parity test
**Files:** Create `apps/docs/src/models/outbox-model.ts`, `apps/docs/tests/outbox-model.parity.test.ts`
**Interfaces:** Produces `OutboxModel({clock, maxRetries?, workerId?, defaultLeaseDurationMs?})` with `enqueue`, `getMutation`, `getAllMutations`, `getPendingMutations`, `claimPendingMutations(workerId?, leaseMs?, limit?)`, `settle(mutation, response | Error)` -> `Promise<SettleOutcome>`, `replay(executor, {rateLimitMs, batchSize, workerId, leaseDurationMs, sleep})`, `remove`, `markStatus`.
- [ ] Write parity test first (happy path, retry to failure, lease expiry + takeover incl. exact-boundary, 4xx permanent, each conflict policy, rate-limit spacing, ordering). Run: fails (module missing).
- [ ] Implement model. Run: passes.
- [ ] Commit.
- [ ] Phase gate: review, simplify, re-verify.

### Task 2: Component rewire + tests
**Files:** Modify `apps/docs/src/components/OutboxPlayground.tsx`, `apps/docs/tests/outbox-playground.test.tsx`; Create `apps/docs/src/components/outbox-playground.css`
- [ ] Update tests first: offline enqueue stays pending and flushes in order when online; single live lease; takeover winner after clock advance; outcome per conflict policy; labelled "browser model"; log is `role="log"` `aria-live`.
- [ ] Rewire: virtual clock (+buttons), offline/online toggle, Worker A/B panels (claim, respond 200/503/409/400), flush with rate-limit meter (`<progress>` + text), lease owner + countdown as text, status as text badges. Styles in the new CSS file, `prefers-reduced-motion` respected.
- [ ] Run docs tests, `tsc -b`, build, bundle grep, `scripts/precheck.sh`.
- [ ] Commit; phase gate.

### Task 3: Docs
README is intentionally NOT edited (instruction from coordinator; later slice regenerates it). No architecture diagram change.

## Audit trail
Self-grill (inline): risk that `created_at` ties make claim order ambiguous in SQLite -> parity tests advance the clock between enqueues. Risk that stale completion after takeover differs -> mirrored, no fencing, documented in the model.

## Appendix - audit trail
- 2026-10-09 self-grill-audit: verdict safe-with-fixes. Corrected: lease is kept by markStatus('in_flight') only (not "all non-claim updates"); branch order is 2xx, 409, other 4xx (permanent, no retry bump), everything else (0, 1xx, 3xx, 5xx, throw) transient; throw stores err.message; rollback counts as successful, force/merge count nothing; claim needs `lease_until IS NOT NULL`; failed rows never reclaimed. Parity tests added for markStatus, non-2xx/4xx transient, stale completion (no fencing), upsert on re-enqueue.
- Deviations: spec's "backoff" is mirrored as none (real outbox has none); `conflictResolver` replay option is not modelled (UI never uses it); README is waived by coordinator instruction; UI virtual clock advances 1ms per enqueue so created_at ties cannot occur.
