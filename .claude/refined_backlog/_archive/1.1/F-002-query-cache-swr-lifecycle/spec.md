---
title: "Query Cache & SWR Lifecycle"
id: F-002
status: refined
from_idea: I-002
---

# Query Cache & SWR Lifecycle

## Acceptance criteria

- [ ] Implement `LifecycleFSM` with deterministic transitions across `Init`, `Load`, `Retry`, `Success`, and `Fail`.
- [ ] Implement exponential backoff with full jitter formula preventing thundering herds.
- [ ] Implement `QueryEngine` with Stale-While-Revalidate (SWR) semantics, serving cached data synchronously from memory/SQLite.
- [ ] Structural sharing preserves object references (`prev === next`) across background revalidations.
- [ ] Query cancellation: Every query execution receives an `AbortSignal`; unmounting or superseding triggers abort on the transport request.
- [ ] Support `staleTime` and `gcTime` memory lifecycle eviction for unobserved queries.
- [ ] Unit tests pass in Vitest covering all lifecycle transitions, SWR background updates, and abort signals.
