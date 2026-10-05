# F-005: Multi-Platform Consumer Bindings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement consumer integration adapters, re-render benchmarks proving zero-unnecessary-renders via structural sharing, and CLI process durability with synchronous exit write-through flushes.

**Architecture:** Consumer hooks bind `QueryEngine` to UI/CLI subscriber models. `re-render.test.ts` rigorously tests observer notification counts across background polling and push invalidations. `CliDurability` registers `beforeExit` / `exit` hooks to force synchronous write-through flushes, preventing dropped state during rapid CLI process terminations.

**Tech Stack:** TypeScript (ESM), SQLite (`SqliteAdapter`), Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md`](file:///Users/pasitnusso/workspace/repos/cli-state-handler/docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md)

## Global Constraints

- **Re-render Budget:** An observer must not be notified more than once for initial data and zero times for identical background revalidations.
- **Process Exit Flush:** All pending in-memory writes and outbox mutations must flush synchronously before `process.exit()` terminates the runtime.

---

## Tasks

### Task 1: Re-render Benchmark & Structural Sharing Verification
**Files:**
- Create: `packages/core/src/consumer/observer.ts`
- Create: `packages/core/tests/consumer/re-render.test.ts`

- [ ] Implement `packages/core/src/consumer/observer.ts`:
  - `createSelectorObserver<T, TSelected>(engine: QueryEngine, queryKey: QueryKey, selector: (data: T) => TSelected): { getSnapshot: () => TSelected | undefined, subscribe: (listener: () => void) => () => void }`
- [ ] Write unit tests in `packages/core/tests/consumer/re-render.test.ts`:
  - Verify render counter: subscriber renders exactly 1 time on initial fetch.
  - Background revalidation with identical data: subscriber renders 0 additional times.
  - Background revalidation with partial update outside selector: subscriber renders 0 additional times.
  - Background revalidation modifying selected slice: subscriber renders exactly 1 additional time.
- [ ] Export `createSelectorObserver` in `packages/core/src/index.ts`.
- [ ] Run `pnpm test` and verify tests pass.
- [ ] Commit: `feat(consumer): implement selector observer with re-render elimination`.

### Task 2: CLI Ephemeral Process Durability & Flush Manager
**Files:**
- Create: `packages/core/src/cli/durability.ts`
- Create: `packages/core/tests/cli/durability.test.ts`

- [ ] Implement `packages/core/src/cli/durability.ts`:
  - `CliDurabilityManager`: registers flusher callbacks.
  - `registerExitFlush(flusher: () => void): () => void`: attaches to `beforeExit` and `exit` events.
  - `flushAll(): void`: runs all registered flushes synchronously.
- [ ] Write unit tests in `packages/core/tests/cli/durability.test.ts`:
  - Verify flush handler execution.
  - Verify SQLite WAL checkpointing on exit (`PRAGMA wal_checkpoint(TRUNCATE);`).
- [ ] Export `CliDurabilityManager` and `registerExitFlush` in `packages/core/src/index.ts`.
- [ ] Run `pnpm test` and verify 100% pass rate.
- [ ] Commit: `feat(cli): implement CLI durability manager with synchronous exit flush`.

### Task 3: Full-Chain End-to-End Verification & Precheck Gate
**Files:**
- Create: `packages/core/tests/e2e/full-chain.test.ts`
- Modify: `README.md`

- [ ] Write `packages/core/tests/e2e/full-chain.test.ts`:
  - Test full chain: Ingress -> QueryEngine -> SQLite WAL -> CAS Package Cache -> Outbox -> Durability Flush.
- [ ] Update `README.md` with complete architecture guide, re-render prevention metrics, and multi-platform consumer examples.
- [ ] Run `./scripts/precheck.sh` and ensure Gate 1 passes cleanly (`Gate 1: ok`).
- [ ] Commit: `chore(release): verify Gate 1 precheck for F-005`.
