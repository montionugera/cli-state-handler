---
title: "Inter-Process Event Bus & Live Daemon"
id: E-006
---

# How we will know E-006 works

## Assertions

1. **Atomic Change Log Journaling:** Every cache invalidation (`invalidateByTag`, `invalidateQueries`) writes exactly one row to `ucsa_change_log` in the same SQLite transaction. A rollback leaves zero orphan log entries.
2. **Deterministic Wire Codec:** The `UCB1` frame codec encodes and decodes all frame types (`HELLO`, `WELCOME`, `SUBSCRIBE`, `PUBLISH`, `EVENT`, `PING`, `PONG`, `RESYNC`, `BYE`, `ERROR`) across fragmented byte streams without buffer corruptions or uncaught exceptions.
3. **Hub Takeover & Crash Resilience:** In a 10-process concurrent cold start against a shared database, exactly 1 process binds the hub and 9 become clients. Killing the active hub (`SIGKILL`) causes an automated election of a successor hub within 3 seconds, removing stale socket files.
4. **Zero-Polling Instant Invalidation:** Process A calling `invalidateByTag('orders')` causes active observers in Process B to be notified and trigger SWR revalidation within < 100ms with zero periodic polling timers.
5. **Outbox Lease Exclusivity:** Two concurrent processes running `outbox replay` claim mutations via `lease_owner` and `lease_until`, guaranteeing that zero mutations are executed more than once.
6. **Graceful WAL Checkpointing:** Background processes and short-lived CLI runs trigger WAL checkpoints without throwing `SQLITE_BUSY` errors when concurrent readers exist.
