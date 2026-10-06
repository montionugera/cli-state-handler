# Epic E-003: Timing Controls (Observer Throttling, Query Debouncing, Outbox Rate-Limiting)

> **For agentic workers:** Implement this plan phase-by-phase using strict TDD (write tests first -> watch them fail -> implement minimal code -> verify tests pass).

**Goal:** Provide zero-dependency, production-grade timing controls across all three UCSA platforms (TypeScript Core, Dart 3+, and C# Unity):
1. **F-009**: Observer Throttling & Debouncing (`throttleMs`, `debounceMs`).
2. **F-010**: Query Execution Debouncing & Superseded Timer Cancellation.
3. **F-011**: Outbox Batch Replay Rate-Limiting (`rateLimitMs`, `batchSize`).

---

## Phases

### Phase 1: Feature F-009 — Observer Throttling & Debouncing
- [x] **TypeScript Core TDD Tests** (`packages/core/tests/consumer/observer-timing.test.ts`):
  - Test `throttleMs`: leading edge fires immediately; 10 rapid bursts within window result in exactly 2 dispatches (leading + trailing with latest value).
  - Test `debounceMs`: 10 rapid bursts reset timer; listener fires exactly once after quiet period with final value.
  - Test combined or fallback behavior.
- [x] **TypeScript Core Implementation** (`packages/core/src/consumer/observer.ts`):
  - Add `throttleMs?: number` and `debounceMs?: number` to `SelectorObserverOptions`.
  - Implement throttle leading/trailing state and debounce timer scheduling with clean unsubscribe disposal.
- [x] **Dart Core TDD & Implementation** (`packages/ucsa_dart/lib/src/selector_observer.dart`, `test/observer_timing_test.dart`):
  - Add `Duration? throttleDuration` and `Duration? debounceDuration`.
  - Verify zero redundant dispatches during high-frequency bursts.
- [x] **C# Unity TDD & Implementation** (`packages/com.ucsa.unity/Runtime/Core/StateObserver.cs`, `Tests/Runtime/StateObserverTimingTests.cs`):
  - Add `int throttleMs = 0` and `int debounceMs = 0` support with zero-allocation dirty checking.
- [x] **Verify Phase 1**: Run tests across all 3 platforms. Commit: `feat(consumer): implement observer throttling and debouncing across TS, Dart, and C#`.

### Phase 2: Feature F-010 — Query Execution Debouncing & Cancellation
- [x] **TypeScript Core TDD Tests** (`packages/core/tests/query/query-debouncing.test.ts`):
  - Test `engine.fetchQuery(key, queryFn, { debounceMs: 50 })`: rapid calls collapse into one network fetch.
  - Test `engine.cancelQuery(key)` cancels pending debounce timer without firing `queryFn`.
  - Test standalone `debounceQuery` helper function.
- [x] **TypeScript Core Implementation** (`packages/core/src/query/query-engine.ts`, `packages/core/src/index.ts`):
  - Add `debounceMs?: number` to `QueryOptions`.
  - Maintain `debounceTimer?: NodeJS.Timeout` on `InternalQueryRecord`.
  - Export `debounceQuery`.
- [x] **Dart Core TDD & Implementation** (`packages/ucsa_dart/lib/src/query_engine.dart`, `test/query_debouncing_test.dart`):
  - Add `Duration? debounceDuration` to `fetchQuery`.
  - Verify timer cancellation when new calls arrive or `cancelQuery()` is invoked.
- [x] **C# Unity TDD & Implementation** (`packages/com.ucsa.unity/Runtime/Core/QueryEngine.cs`, `Tests/Runtime/QueryDebouncingTests.cs`):
  - Add `int debounceMs = 0` to `QueryOptions` and `CancellationToken` integration.
- [x] **Verify Phase 2**: Run tests across all 3 platforms. Commit: `feat(query): implement query execution debouncing and timer cancellation across TS, Dart, and C#`.

### Phase 3: Feature F-011 — Outbox Batch Replay Rate-Limiting
- [x] **TypeScript Core TDD Tests** (`packages/core/tests/query/outbox-rate-limit.test.ts`):
  - Test replaying 5 mutations with `rateLimitMs: 25`: takes >= 100ms total, orderly sequential execution.
  - Test replaying with `batchSize: 2`: processes in chunks of 2.
- [x] **TypeScript Core Implementation** (`packages/core/src/query/mutation-outbox.ts`):
  - Add `rateLimitMs?: number` and `batchSize?: number` to `replay()` options.
  - Implement async batch delay pacing.
- [x] **Dart Core TDD & Implementation** (`packages/ucsa_dart/lib/src/sqlite_adapter.dart`, `test/outbox_rate_limit_test.dart`):
  - Add `Duration? rateLimit` and `int? batchSize` to outbox replay.
- [x] **C# Unity TDD & Implementation** (`packages/com.ucsa.unity/Runtime/Storage/UnitySqliteAdapter.cs`, `Tests/Runtime/OutboxRateLimitTests.cs`):
  - Add `int rateLimitMs = 0` and `int batchSize = 10` to `ReplayOutboxAsync`.
- [x] **Verify Phase 3**: Run tests across all 3 platforms. Commit: `feat(outbox): implement outbox batch replay rate-limiting across TS, Dart, and C#`.

### Phase 4: Full-Chain Integration & Verification Gate
- [x] **Update Full-Chain Script** (`scripts/e2e-full-chain.sh`):
  - Exercise observer throttling, debounced queries, and rate-limited outbox in the E2E script.
- [x] **Update README.md**:
  - Document all timing control options with code examples and verified test count metrics.
- [x] **Run All Gates**:
  - Run `scripts/precheck.sh` (Gate 1).
  - Run `scripts/integration.sh` (Gate 2).
  - Run `scripts/e2e-full-chain.sh` (5-phase E2E runner).
- [x] **Commit & Release**: Commit: `chore(release): verify Gate 1 and Gate 2 for Epic E-003 timing controls`.
