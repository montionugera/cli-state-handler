# F-002: Query Cache & SWR Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 5-stage lifecycle state machine with exponential jitter backoff, Stale-While-Revalidate (SWR) query engine, structural sharing, and AbortSignal query cancellation.

**Architecture:** `LifecycleFSM` manages request lifecycles across `Init`, `Load`, `Retry`, `Success`, and `Fail` with decorrelated jitter. `QueryEngine` wraps cached asynchronous state, providing synchronous memory reads, background revalidations, structural sharing (preserving referential equality), and query cancellation via `AbortController`.

**Tech Stack:** TypeScript (ESM), Vitest, `@tanstack/query-core` (or custom lightweight TanStack-compatible SWR store).

**Spec:** [`docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md`](file:///Users/pasitnusso/workspace/repos/cli-state-handler/docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md)

## Global Constraints

- **Structural Sharing:** If a background revalidation returns data structurally identical to the cached entry, the exact previous memory reference must be retained (`prev === next`).
- **Cancellation:** In-flight network operations must be aborted via `AbortSignal` when a query is cancelled or superseded.
- **Backoff Formula:** Exponential backoff with full jitter:
  `delay = random(0, min(max_delay, base_delay * 2^attempt))`.

---

## Tasks

### Task 1: 5-Stage Lifecycle & Backoff FSM
**Files:**
- Create: `packages/core/src/query/lifecycle-fsm.ts`
- Test: `packages/core/tests/query/lifecycle.test.ts`

- [ ] Write tests in `packages/core/tests/query/lifecycle.test.ts`:
  - Assert deterministic transitions: `idle -> loading -> retrying -> success / error`.
  - Assert backoff delay calculation bounded by `maxDelay` with random jitter.
  - Assert retry count increments and transitions to `error` when reaching `maxRetries`.
  - Assert reset restores FSM to `idle`.
- [ ] Implement `LifecycleFSM` class in `packages/core/src/query/lifecycle-fsm.ts`.
- [ ] Export `LifecycleFSM` from `packages/core/src/index.ts`.
- [ ] Run `pnpm test` and verify tests pass.
- [ ] Commit: `feat(query): implement 5-stage lifecycle state machine with backoff jitter`.

### Task 2: Query Engine, SWR, Structural Sharing & Cancellation
**Files:**
- Create: `packages/core/src/query/structural-sharing.ts`
- Create: `packages/core/src/query/query-engine.ts`
- Test: `packages/core/tests/query/query-engine.test.ts`

- [ ] Write tests in `packages/core/tests/query/query-engine.test.ts`:
  - Assert synchronous cached read from memory/SQLite.
  - Assert SWR: returns cached data immediately while firing background revalidation.
  - Assert structural sharing: identical payload returns identical object reference.
  - Assert `AbortSignal` is passed to query fetcher and aborts when `cancelQuery()` is invoked.
  - Assert `staleTime` prevents background refetch if query is still fresh.
  - Assert tag invalidation triggers revalidation of matching active queries.
- [ ] Implement `packages/core/src/query/structural-sharing.ts`:
  - Deep comparison algorithm that re-uses existing object and array references when child properties match.
- [ ] Implement `packages/core/src/query/query-engine.ts`:
  - Manages active queries, subscriptions, SQLite synchronization, and cancellation controllers.
- [ ] Export `QueryEngine` from `packages/core/src/index.ts`.
- [ ] Run `pnpm test` and verify 100% pass rate.
- [ ] Commit: `feat(query): implement query engine with SWR and cancellation`.

### Task 3: Verification Gate & Precheck
**Files:**
- Test: `packages/core/tests/query/query-engine.test.ts`
- Modify: `README.md`

- [ ] Run full test suite: `pnpm test`.
- [ ] Update `README.md` with QueryEngine usage examples (SWR, cancellation, structural sharing).
- [ ] Run `./scripts/precheck.sh` and ensure Gate 1 passes cleanly.
- [ ] Commit: `chore(release): verify Gate 1 precheck for F-002`.
