---
title: "Unified Client State Architecture"
id: E-001
---

# How we will know E-001 works

Prose for humans. `scripts/epic-check.sh` implements these assertions; the
toolkit never parses this file.

## Assertions

1. SQLite persistence schema initializes cleanly in WAL mode and supports indexed query lookups, TTL invalidations, and offline mutation queues.
2. Query cache correctly handles Stale-While-Revalidate, returning cached results synchronously and revalidating in the background.
3. 5-stage lifecycle state machine transitions deterministically through Init, Load, Retry (with exponential jitter), Success, and Fail.
4. Content-Addressable Storage (CAS) writes packages atomically by SHA-256 and prunes stale objects under LRU disk budget limits.
5. Ingress adapters for BFF REST, GraphQL, WebSockets, and WebRTC DataChannels feed frames and push events into the query cache.
6. Multi-platform adapters verify against macOS (SwiftUI), Web (Svelte/React), Android (Compose), and developer CLIs without race conditions or memory leaks.
