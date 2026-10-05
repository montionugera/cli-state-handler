# Unified Client State Architecture (UCSA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a multi-platform client state management library and runtime engine unifying query caching, SQLite persistence, Content-Addressable Storage (CAS), hardware image caching, and pluggable network transports (BFF REST, GQL, WS, WebRTC) across macOS, Web, iOS, Android, Windows, and developer CLIs.

**Architecture:** A multi-tier architecture powered by TanStack Query semantics (Stale-While-Revalidate, tag invalidation, optimistic rollbacks, AbortSignal cancellation) on top of an indexed SQLite database for structured data, a filesystem Content-Addressable Storage (CAS) for package binaries, native hardware GPU decoders for images, and pluggable network transport adapters.

**Tech Stack:** TypeScript (ESM / Node.js / Bun / Web), `@tanstack/query-core`, SQLite (`better-sqlite3` on Node/CLI, `wa-sqlite` on Web), Vitest for test-driven verification, Draw.io for architecture diagrams.

**Spec:** [`docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md`](file:///Users/pasitnusso/workspace/repos/cli-state-handler/docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md)

## Global Constraints

- **SQLite Affinity:** All JSON payload and query key columns must be declared as `TEXT NOT NULL` (never `JSON`) to avoid SQLite NUMERIC affinity coercion.
- **Journal Mode:** `PRAGMA journal_mode = WAL;` on native desktop, mobile, and CLI; fallback to `PRAGMA journal_mode = MEMORY;` on WebAssembly (`wa-sqlite`).
- **Concurrency & Busy Timeout:** All SQLite connections must set `PRAGMA busy_timeout = 5000;`.
- **CLI Ephemeral Durability:** CLI process exit handlers must execute synchronous write-through flushes to prevent dropped cache writes.
- **CAS Access Tracking:** CAS pruning must use explicit SQLite access timestamps (`last_accessed_at`) and file `mtime` updates rather than unreliable filesystem `atime`.
- **Label Protection:** All architecture diagrams must pass structural validation with `score: 0` via `drawio-skill/validate.py`.

---

## File Structure & Proposed Layout

```
packages/core/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                      # Public exports
│   ├── types.ts                      # Core interfaces (QueryKey, QueryState, OutboxMutation, Transport)
│   ├── storage/
│   │   ├── sqlite-adapter.ts         # SQLite WAL persistence, table DDL, busy_timeout
│   │   ├── tag-index.ts              # O(log N) tag invalidation mapping
│   │   └── cas-store.ts              # SHA-256 Content-Addressable Storage & LRU pruning
│   ├── query/
│   │   ├── query-engine.ts           # TanStack Query wrapper, SWR, cancellation signals
│   │   ├── lifecycle-fsm.ts          # 5-stage lifecycle state machine (Init, Load, Retry, Success, Fail)
│   │   └── mutation-outbox.ts        # Offline mutation outbox and conflict resolution
│   ├── network/
│   │   ├── online-manager.ts         # Connectivity listener and retry trigger
│   │   ├── focus-manager.ts          # Window/tab foreground revalidation listener
│   │   └── transports/
│   │       ├── bff-transport.ts      # HTTP/REST adapter with ETags and auth injection
│   │       ├── gql-transport.ts      # GraphQL query & persisted document adapter
│   │       ├── ws-transport.ts       # WebSocket multiplexer & push invalidation listener
│   │       └── webrtc-transport.ts   # WebRTC DataChannel signaling & ingress
└── tests/
    ├── storage/
    │   ├── sqlite.test.ts            # Schema, WAL mode, TEXT affinity, busy_timeout
    │   └── cas.test.ts               # SHA-256 storage, atomic rename, LRU eviction
    ├── query/
    │   ├── query-engine.test.ts      # SWR, structural sharing, query cancellation
    │   ├── lifecycle.test.ts         # 5-stage FSM, exponential backoff, jitter
    │   └── outbox.test.ts            # Offline mutations, conflict resolution
    └── network/
        ├── transports.test.ts        # BFF ETag 304, GQL, WS push invalidation
        └── re-render.test.ts         # Render count assertions (structural sharing)
```

---

## Phase 1: Core Contracts & SQLite Persistence Schema (Slice I-001)

### Task 1.1: Project Setup & Core Types
**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `packages/core/package.json`
- Create: `packages/core/src/types.ts`
- Test: `packages/core/tests/types.test.ts`

- [ ] Initialize workspace `package.json` with pnpm/npm workspace configuration, `typescript`, `vitest`, and `better-sqlite3`.
- [ ] Create `packages/core/src/types.ts` defining:
  - `QueryKey = readonly unknown[]`
  - `QueryState<TData, TError>`
  - `CacheEntry<TData>`
  - `OutboxMutation`
  - `TransportAdapter`
  - `ConflictPolicy: 'server-wins' | 'client-wins' | 'merge'`
- [ ] Write unit test `types.test.ts` ensuring type contracts compile and validate dummy fixtures.
- [ ] Run test: `pnpm test` (or `npx vitest run`).
- [ ] Commit: `chore(core): initialize workspace and core type definitions`.

### Task 1.2: SQLite Engine with WAL & Explicit TEXT Affinity
**Files:**
- Create: `packages/core/src/storage/sqlite-adapter.ts`
- Create: `packages/core/src/storage/tag-index.ts`
- Test: `packages/core/tests/storage/sqlite.test.ts`

- [ ] Write failing test in `sqlite.test.ts`:
  - Assert table creation with `TEXT` affinities for `query_key`, `data_payload`, `headers`.
  - Assert `PRAGMA busy_timeout = 5000;`.
  - Assert numeric keys (e.g. `[123, 456]`) do not get coerced to float/numbers.
  - Assert tag mapping insert and cascade delete on `ucsa_query_cache` purge.
- [ ] Implement `sqlite-adapter.ts` wrapping `better-sqlite3` with schema DDL, WAL initialization, and parameterized queries.
- [ ] Implement `tag-index.ts` with indexed `tag -> query_hash` lookups and bulk invalidation queries.
- [ ] Run tests to verify all tests pass.
- [ ] Phase Quality Gate 1:
  - Verify: Run test suite.
  - Review: Check no unindexed full-table scans exist.
  - Refactor: Streamline prepared statements.
  - Re-verify: Confirm clean execution.
- [ ] Commit: `feat(storage): implement SQLite persistence engine with tag index`.

---

## Phase 2: Query Cache & 5-State Lifecycle Engine (Slice I-002)

### Task 2.1: 5-Stage Lifecycle & Backoff FSM
**Files:**
- Create: `packages/core/src/query/lifecycle-fsm.ts`
- Test: `packages/core/tests/query/lifecycle.test.ts`

- [ ] Write failing test in `lifecycle.test.ts`:
  - Test transitions: `Init -> Load -> Retry -> Success / Fail`.
  - Verify exponential backoff delay calculation with full jitter.
  - Verify retry cap stops retries after max attempts and transitions to `Fail`.
- [ ] Implement `lifecycle-fsm.ts` implementing the state machine and decorrelated jitter formula.
- [ ] Run tests to verify all assertions pass.
- [ ] Commit: `feat(query): implement 5-stage lifecycle state machine with jitter`.

### Task 2.2: TanStack Query Wrapper & Query Cancellation
**Files:**
- Create: `packages/core/src/query/query-engine.ts`
- Test: `packages/core/tests/query/query-engine.test.ts`

- [ ] Write failing test in `query-engine.test.ts`:
  - Verify `staleTime` vs `gcTime` behavior.
  - Verify structural sharing: identical payload returns identical object reference.
  - Verify `AbortSignal` fires when query is cancelled or superseded.
  - Verify hydration from SQLite snapshot and synchronous cache hits.
- [ ] Implement `query-engine.ts` integrating `@tanstack/query-core` with `sqlite-adapter.ts`.
- [ ] Run tests and verify zero regressions.
- [ ] Phase Quality Gate 2:
  - Verify: Run query engine suite.
  - Review: Check AbortController teardowns and memory leak risks.
  - Refactor: Clean up unused observers.
  - Re-verify: All tests green.
- [ ] Commit: `feat(query): implement query cache engine with cancellation and SWR`.

---

## Phase 3: Content-Addressable Storage (CAS) Package Cache (Slice I-003)

### Task 3.1: SHA-256 CAS Store & Atomic Writes
**Files:**
- Create: `packages/core/src/storage/cas-store.ts`
- Test: `packages/core/tests/storage/cas.test.ts`

- [ ] Write failing test in `cas.test.ts`:
  - Test saving binary buffer -> writes to `.tmp` -> atomically renames to `<cas>/objects/ab/cdef...`.
  - Test content integrity verification (rejects corrupted stream with hash mismatch).
  - Test explicit access time update (`touch mtime` and update SQLite metadata table).
  - Test LRU pruning: when disk quota exceeds limit, oldest unaccessed items are deleted down to 70%.
- [ ] Implement `cas-store.ts` using `node:crypto`, `node:fs/promises`, and SQLite tracking.
- [ ] Run tests to verify CAS behavior.
- [ ] Phase Quality Gate 3:
  - Verify: Run CAS tests.
  - Review: Confirm atomic rename prevents partial file reads.
  - Refactor: Optimize buffer streaming.
  - Re-verify: Confirm clean execution.
- [ ] Commit: `feat(storage): implement CAS package cache with LRU pruning`.

---

## Phase 4: Pluggable Transport Adapters & Offline Outbox (Slice I-004)

### Task 4.1: Offline Mutation Outbox & Conflict Resolution
**Files:**
- Create: `packages/core/src/query/mutation-outbox.ts`
- Test: `packages/core/tests/query/outbox.test.ts`

- [ ] Write failing test in `outbox.test.ts`:
  - Enqueue offline mutations when network is down.
  - Replay mutations sequentially upon reconnection.
  - Verify conflict handling: `server-wins` rolls back optimistic cache update; `client-wins` forces retry.
- [ ] Implement `mutation-outbox.ts` backed by SQLite `ucsa_mutation_outbox`.
- [ ] Run tests to verify outbox replay.
- [ ] Commit: `feat(query): implement offline mutation outbox with conflict resolution`.

### Task 4.2: Transports (BFF REST, GraphQL, WebSocket, WebRTC)
**Files:**
- Create: `packages/core/src/network/transports/bff-transport.ts`
- Create: `packages/core/src/network/transports/gql-transport.ts`
- Create: `packages/core/src/network/transports/ws-transport.ts`
- Create: `packages/core/src/network/transports/webrtc-transport.ts`
- Create: `packages/core/src/network/online-manager.ts`
- Create: `packages/core/src/network/focus-manager.ts`
- Test: `packages/core/tests/network/transports.test.ts`

- [ ] Write failing tests for BFF ETag revalidation (`304 Not Modified`), GraphQL persisted queries, and WebSocket invalidation push frames.
- [ ] Implement `bff-transport.ts` with ETag caching and bearer token injection.
- [ ] Implement `gql-transport.ts` and `ws-transport.ts` with push invalidation multiplexing.
- [ ] Implement `online-manager.ts` and `focus-manager.ts`.
- [ ] Run all network tests.
- [ ] Phase Quality Gate 4:
  - Verify: Full transport suite.
  - Review: Check WS heartbeat ping/pong cleanup.
  - Refactor: Consolidate header parsing.
  - Re-verify: Confirm all passing.
- [ ] Commit: `feat(network): implement pluggable transport adapters and managers`.

---

## Phase 5: Re-render Benchmark & CLI Durability Verification (Slice I-005)

### Task 5.1: Re-render Benchmark & Structural Sharing Verification
**Files:**
- Create: `packages/core/tests/network/re-render.test.ts`
- Create: `packages/core/src/cli/flush.ts`

- [ ] Implement re-render assertion test asserting that observers render $\le 2$ times across background revalidations.
- [ ] Implement `cli/flush.ts` registering `process.on('exit')` to synchronously flush dirty SQLite buffers.
- [ ] Run full test suite: `pnpm test`.
- [ ] Commit: `test(perf): verify zero-extra-render structural sharing and CLI flush`.

---

## Phase 6: Documentation & Release Integration

### Task 6.1: README & Backlog Synchronization
**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md`

- [ ] Update `README.md` with:
  - Architecture overview and quickstart guide.
  - Code examples for `useQuery`, SQLite persistence setup, and CAS package caching.
  - Re-render prevention guide (structural sharing & selectors).
- [ ] Verify Draw.io diagram passes `validate.py --score` with score 0.
- [ ] Synchronize ps-release-workflow backlogs.
- [ ] Commit: `docs: update README with UCSA guides and architecture documentation`.
