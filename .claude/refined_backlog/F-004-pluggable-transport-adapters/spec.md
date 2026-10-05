---
title: "Pluggable Transport Adapters"
id: F-004
status: refined
from_idea: I-004
---

# Pluggable Transport Adapters

## Acceptance criteria

- [ ] Implement `BffTransport` supporting HTTP REST methods, bearer auth injection, and ETag conditional revalidations (`If-None-Match` -> `304 Not Modified`).
- [ ] Implement `GqlTransport` supporting GraphQL queries, mutations, and persisted document hashes.
- [ ] Implement `WsTransport` with heartbeat ping/pong (30s), reconnection FSM, multiplexing, and server push invalidation event emission (`{ type: 'INVALIDATE', tags: [...] }`).
- [ ] Implement `WebRtcDataTransport` supporting DataChannel low-latency event framing and connection state management.
- [ ] Implement `OnlineManager` and `FocusManager` listeners.
- [ ] Implement `MutationOutbox` supporting offline queuing and deterministic conflict policies (`server-wins`, `client-wins`, `merge`).
- [ ] Unit tests pass in Vitest validating all transports, ETag 304 behavior, push invalidation, and outbox conflict resolution.
