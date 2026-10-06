---
title: "Timing Controls: Observer Throttling, Query Debouncing, and Outbox Rate-Limiting"
id: E-003
---

# How we will know E-003 works

## Assertions

1. `createSelectorObserver` with `throttleMs: 100` suppresses rapid bursts of 10 state mutations, firing only leading (t=0) and trailing (t=100) notifications.
2. `createSelectorObserver` with `debounceMs: 50` suppresses rapid bursts, firing once after quiet.
3. `QueryEngine.fetchQuery` with `debounceMs: 50` collapses rapid calls into one network query execution.
4. `MutationOutbox.replay` with `rateLimitMs: 20` and `batchSize: 2` paces replay execution across batches.
5. Dart and C# Unity implementations mirror the exact timing behavior with 100% test pass rate.
6. The full-chain test runner (`./scripts/e2e-full-chain.sh`) passes across all 5 phases.
