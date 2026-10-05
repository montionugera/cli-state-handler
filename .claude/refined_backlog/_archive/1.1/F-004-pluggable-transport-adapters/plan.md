# F-004: Pluggable Transport Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement pluggable transport adapters for BFF REST (ETag/auth), GraphQL, WebSocket (multiplexed FSM), WebRTC DataChannel, online/focus managers, and the offline mutation outbox with deterministic conflict resolution.

**Architecture:** Transports implement the `TransportAdapter` interface. `BffTransport` tracks ETags and injects auth tokens. `WsTransport` manages heartbeats and server push invalidations. `MutationOutbox` records offline mutations to SQLite and replays them upon network recovery, enforcing conflict policies (`server-wins`, `client-wins`, `merge`).

**Tech Stack:** TypeScript (ESM), SQLite (`SqliteAdapter`), Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md`](file:///Users/pasitnusso/workspace/repos/cli-state-handler/docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md)

## Global Constraints

- **ETag Support:** When an ETag is present in the cache, GET requests must include `If-None-Match: <etag>`. A `304 Not Modified` response must update freshness without rewriting payload data.
- **Push Invalidation:** WebSocket invalidation frames (`{ type: 'INVALIDATE', tags: [...] }`) must directly invoke `QueryEngine.invalidateByTag()`.
- **Conflict Policies:** On HTTP 409 conflict during outbox replay:
  - `server-wins`: rollback local optimistic mutation.
  - `client-wins`: force overwrite upstream.
  - `merge`: invoke registered entity merge function.

---

## Tasks

### Task 1: Offline Mutation Outbox & Conflict Resolution
**Files:**
- Create: `packages/core/src/query/mutation-outbox.ts`
- Test: `packages/core/tests/query/outbox.test.ts`

- [ ] Write unit tests in `packages/core/tests/query/outbox.test.ts`:
  - Enqueue mutation when offline -> records in SQLite `ucsa_mutation_outbox`.
  - Replay pending mutations sequentially when online.
  - Test conflict handling:
    - `server-wins`: rolls back optimistic update on 409.
    - `client-wins`: marks mutation for forced retry.
    - `merge`: executes custom merge resolver.
  - Increment retry counter on transient failures; mark `failed` after max attempts.
- [ ] Implement `MutationOutbox` in `packages/core/src/query/mutation-outbox.ts`.
- [ ] Export `MutationOutbox` from `packages/core/src/index.ts`.
- [ ] Run `pnpm test` and verify tests pass.
- [ ] Commit: `feat(query): implement offline mutation outbox with conflict resolution`.

### Task 2: Transports (BFF REST, GraphQL, WebSocket, WebRTC) & Managers
**Files:**
- Create: `packages/core/src/network/online-manager.ts`
- Create: `packages/core/src/network/focus-manager.ts`
- Create: `packages/core/src/network/transports/bff-transport.ts`
- Create: `packages/core/src/network/transports/gql-transport.ts`
- Create: `packages/core/src/network/transports/ws-transport.ts`
- Create: `packages/core/src/network/transports/webrtc-transport.ts`
- Test: `packages/core/tests/network/transports.test.ts`

- [ ] Write tests in `packages/core/tests/network/transports.test.ts`:
  - `BffTransport`: sends headers, handles ETag 304 conditional responses, injects bearer token.
  - `GqlTransport`: formats GraphQL payload with query/variables and persisted document hash.
  - `WsTransport`: ping/pong heartbeat, reconnection state machine, emits `INVALIDATE` events to subscribers.
  - `WebRtcDataTransport`: handles connection state transitions and message framing.
  - `OnlineManager` & `FocusManager`: event subscription, state getters, and listener notifications.
- [ ] Implement `online-manager.ts` and `focus-manager.ts`.
- [ ] Implement `bff-transport.ts`, `gql-transport.ts`, `ws-transport.ts`, and `webrtc-transport.ts`.
- [ ] Export all transports and managers in `packages/core/src/index.ts`.
- [ ] Run `pnpm test` and verify 100% pass rate.
- [ ] Commit: `feat(network): implement pluggable transport adapters and managers`.

### Task 3: Verification Gate & Precheck
**Files:**
- Test: `packages/core/tests/network/transports.test.ts`
- Modify: `README.md`

- [ ] Run full test suite: `pnpm test`.
- [ ] Update `README.md` with Transports (BFF, GQL, WS, WebRTC), Online/Focus managers, and Mutation Outbox examples.
- [ ] Run `./scripts/precheck.sh` and ensure Gate 1 passes cleanly (`Gate 1: ok`).
- [ ] Commit: `chore(release): verify Gate 1 precheck for F-004`.
