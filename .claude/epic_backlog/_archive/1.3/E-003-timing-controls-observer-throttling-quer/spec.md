---
title: "Timing Controls: Observer Throttling, Query Debouncing, and Outbox Rate-Limiting"
id: E-003
status: epic
---

# Timing Controls: Observer Throttling, Query Debouncing, and Outbox Rate-Limiting

## Outcome

All three client platforms (TypeScript Core, Dart 3+, and C# Unity) support native, zero-dependency timing controls:
1. **Observer Throttling & Debouncing**: `createSelectorObserver` and platform state observers support `throttleMs` and `debounceMs` to rate-limit high-frequency data streams (e.g. 60Hz WebSockets/telemetry) before dispatching to UI subscribers.
2. **Query Execution Debouncing**: `QueryEngine` supports debounced queries (`debounceMs`), collapsing rapid user input triggers (e.g. search typeahead) into a single network execution with automatic prior timer cancellation.
3. **Outbox Replay Rate-Limiting**: `MutationOutbox.replay()` supports `rateLimitMs` pacing and `batchSize` chunking to prevent HTTP 429 Too Many Requests when syncing offline queues.

## Slices

- `F-009`: observer-throttling (Observer Debouncing & Throttling in TS, Dart, C# Unity)
- `F-010`: query-debouncing (Query Execution Debouncing & Timer Cancellation in TS, Dart, C# Unity)
- `F-011`: outbox-rate-limiting (Outbox Batch Replay Rate-Limiting in TS, Dart, C# Unity)

## Acceptance Criteria

- [ ] `createSelectorObserver` in TypeScript supports `throttleMs` (leading + trailing) and `debounceMs` with unit tests proving render suppression under rapid bursts.
- [ ] `SelectorObserver` in Dart and `StateObserver` in C# Unity support equivalent throttling and debouncing.
- [ ] `QueryEngine.fetchQuery` / `useQuery` support `debounceMs` with automatic cancellation of superseded timers.
- [ ] `MutationOutbox.replay` in TS, Dart, and C# Unity supports `rateLimitMs` pacing and `batchSize` limits.
- [ ] All 30 existing test suites continue to pass 100%.
- [ ] Full-chain runner (`scripts/e2e-full-chain.sh`) passes across all 5 phases.
- [ ] Gate 1 (`precheck.sh`) and Gate 2 (`integration.sh`) pass cleanly.
