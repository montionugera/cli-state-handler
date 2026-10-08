---
title: "durable-change-log-catchup"
id: F-019
status: refined
from_idea: I-019
---

# durable-change-log-catchup

## Acceptance criteria

- [ ] Schema migration v3 creates `ucsa_change_log`, `ucsa_bus_hub`, and adds outbox lease columns.
- [ ] `SqliteAdapter.invalidateByTag()` and `deleteQuery()` atomically insert a record into `ucsa_change_log` within the same transaction.
- [ ] `SqliteAdapter.readChangesSince(lastSeq, limit)` returns change log rows in strictly ascending `seq` order.
- [ ] `readChangesSince()` detects sequence gaps and returns `truncated: true` when `lastSeq` has been pruned.
- [ ] Retention pruning preserves rows within 24 hours or the newest 10,000 entries.
- [ ] A forced transaction rollback cleanly reverts both the cache invalidation and change log insertion.
