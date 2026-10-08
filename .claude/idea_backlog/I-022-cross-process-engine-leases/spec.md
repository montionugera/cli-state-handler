---
title: "cross-process-engine-leases"
id: I-022
status: idea
---

# cross-process-engine-leases

## Acceptance criteria

- [ ] `QueryEngine` connects to event bus and marks in-memory queries stale upon receiving remote invalidation events with < 100ms latency.
- [ ] Observers on Process B refetch invalidated queries automatically when Process A invalidates by tag or query key.
- [ ] Lagging or reconnected clients replay missing sequence numbers from `ucsa_change_log` without dropping invalidations.
- [ ] Outbox lease management prevents concurrent processes from executing identical pending mutations via atomic `lease_owner` and `lease_until` claims.
- [ ] Expired leases on aborted or killed processes are safely reclaimed by surviving processes after lease expiry.
- [ ] Non-blocking WAL checkpointing ensures short-lived processes exit cleanly without `SQLITE_BUSY` contention.
- [ ] Full Gate 1, Gate 2, and e2e full-chain verification passes across all test tiers.
