# Feature F-022: Cross-Process Engine & Outbox Leases

> **For agentic workers:** Implement this plan phase-by-phase using strict TDD (write tests first -> watch them fail -> implement minimal code -> verify tests pass).

**Goal:** Wire the event bus client into `QueryEngine` for zero-polling instant cache invalidation, implement distributed outbox lease claims (`lease_owner`, `lease_until`) in `MutationOutbox` to prevent duplicate concurrent replay, implement designated non-blocking WAL checkpointer, ensure cross-platform parity, run the full verification gate, ship F-022, and promote Release 1.6.

---

## Tasks

### Task 1: Bus Client Integration in QueryEngine & Cross-Process Invalidation
- [x] Implement `packages/core/src/ipc/bus-client.ts`:
  - `class BusClient`:
    - Connects to bus socket endpoint, performs `HELLO`/`WELCOME` handshake, sends `SUBSCRIBE`.
    - Listens for `EVENT` frames and emits to registered listeners.
    - Handles `RESYNC`: reads missed events via `sqliteAdapter.readChangesSince(lastSeq)`.
    - Method `publish(change)` sends `PUBLISH` frame.
    - Auto-reconnect with exponential backoff on disconnect.
- [x] Update `QueryEngine` in `packages/core/src/query/query-engine.ts`:
  - Add optional `busClient?: BusClient` to `QueryEngineOptions`.
  - On local `invalidateByTag()` or `invalidateQueries()`, publishes invalidation event to bus.
  - On remote `EVENT` from bus (echo suppressed if origin matches): marks in-memory queries stale and triggers observer refetch.
- [x] Export `BusClient` in `packages/core/src/index.ts`.
- [x] Write unit tests in `packages/core/tests/ipc/cross-process-invalidation.test.ts`:
  - Two QueryEngine instances on shared database: invalidate on Engine A triggers observer refetch on Engine B within <100ms.
  - Reconnect catch-up: events emitted while Engine B is disconnected are replayed from change log on reconnect.
  - Echo suppression: Engine A does not refetch on its own published invalidation.
- [x] Verify `pnpm test` in `packages/core`.
- [x] Commit: `feat(query): integrate IPC bus client for zero-polling cross-process cache invalidation`.

### Task 2: Outbox Distributed Leases & WAL Checkpointing
- [x] Update `packages/core/src/query/mutation-outbox.ts`:
  - Update `replay()`:
    - Atomically claims rows: `UPDATE ucsa_mutation_outbox SET status = 'in_flight', lease_owner = ?, lease_until = ? WHERE status = 'pending' OR (status = 'in_flight' AND lease_until < ?)`.
    - Executes only mutations leased to current worker.
    - Expired leases automatically reclaimed by surviving workers.
- [x] Update `packages/core/src/storage/sqlite-adapter.ts`:
  - `checkpoint(mode = 'TRUNCATE')`: falls back to `PASSIVE` if `TRUNCATE` encounters `SQLITE_BUSY`, guaranteeing zero unhandled exit exceptions.
- [x] Write unit tests in `packages/core/tests/query/outbox-leases.test.ts`:
  - Two concurrent replay workers execute pending mutations with zero duplicates.
  - Dead worker lease recovery: abandoned mutation is retried after lease expires.
  - Checkpoint fallback under concurrent database readers.
- [x] Verify `pnpm test` in `packages/core`.
- [x] Commit: `feat(outbox): implement distributed outbox lease claims and non-blocking checkpointing`.

### Task 3: Cross-Platform Parity & Documentation
- [x] Update `packages/ucsa_dart`:
  - Implement lease claim SQL in `MutationOutbox.replay()` in `packages/ucsa_dart/lib/src/mutation_outbox.dart` / `sqlite_adapter.dart`.
  - Add unit test in `packages/ucsa_dart/test/outbox_lease_test.dart`.
- [x] Update `packages/com.ucsa.unity`:
  - Implement lease claim SQL in `MutationOutbox` in `packages/com.ucsa.unity/Runtime/Core/MutationOutbox.cs` / `UnitySqliteAdapter.cs`.
  - Add unit test in `packages/com.ucsa.unity/Tests/Runtime/OutboxLeaseTests.cs`.
- [x] Update `README.md`:
  - Add Section 11: `Cross-Process State Architecture & Outbox Leases`.
  - Synchronize cross-platform test tables.
- [x] Commit: `feat(parity): implement cross-platform outbox leases and update documentation`.

### Task 4: Full-Chain E2E Verification & Promotion
- [x] Run `./scripts/precheck.sh` (Gate 1).
- [x] Run `./scripts/integration.sh` (Gate 2).
- [x] Run `./scripts/e2e-full-chain.sh` (All 5 tiers).
- [x] Update `plan.md` checking off all tasks.
- [ ] Ship via `psrw ship`.
- [ ] Promote release 1.6 via `psrw promote --direct`.
