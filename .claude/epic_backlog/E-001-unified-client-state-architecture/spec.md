---
title: "Unified Client State Architecture"
id: E-001
status: epic
---

# Unified Client State Architecture

## Outcome

All client applications (macOS, iOS, Web, Android, Windows, and developer CLIs) share a standardized state management mental model based on TanStack Query semantics, persistent SQLite storage in WAL mode, Content-Addressable Storage (CAS) for package artifacts, hardware-accelerated GPU image caches, and pluggable network transports (BFF REST, GraphQL, WebSockets, and WebRTC DataChannels).

Detailed specification and validated architecture diagram: `docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md`.

## Slices

- S1: Core Contracts & SQLite Persistence Schema
- S2: Query Cache Engine with Stale-While-Revalidate and 5-Stage Lifecycle
- S3: Content-Addressable Storage (CAS) Package Cache with LRU Quota
- S4: Pluggable Transport Adapters (BFF REST, GraphQL, WebSocket, WebRTC)
- S5: Multi-Platform Consumer Bindings (macOS, Web, iOS, Android, Windows/CLI)
