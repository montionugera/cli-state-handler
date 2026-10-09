---
title: "SWR lifecycle state graph and stale-gc timeline"
id: F-033
status: refined
from_idea: I-033
---

# SWR lifecycle state graph and stale-gc timeline

Slice 7 of epic E-008 (docs portal). Depends on slice 2.

## Problem

The SWR playground uses the real `QueryEngine` but shows state only as text. `LifecycleFSM` is exported from the browser entry and unused. It has five states but no subscribe API and no transition table, accepts any call from any state, and `QueryEngine` does not use it (the engine reports only loading / success / error).

## Scope

- `apps/docs/src/models/lifecycle-graph.ts`: the five states and the hand-authored edges between them (the intended lifecycle, an editorial choice of the page, not enforced by the class), each edge naming the `LifecycleFSM` method that performs it.
- `apps/docs/src/components/LifecycleGraph.tsx` + CSS: an SVG graph that owns its own `LifecycleFSM` instance, highlights the current state, enables only the transitions the page treats as intended from it (a docs decision, not enforcement), and logs each transition including the `recordError` attempt argument.
- `apps/docs/src/components/StaleTimeline.tsx`: a timeline showing fresh, stale and expired windows for adjustable `staleTime`/`gcTime`, with markers for fetch, read and expiry, driven by a controllable clock. Real semantics: a fetch stamps `stale_at = fetch + staleTime` and `expires_at = fetch + gcTime` (fixed at write time, observers play no part); staleness is evaluated only on a read (fresh = served from cache; stale = served from cache plus background revalidation that resets both windows); expiry is checked lazily, only when a record is hydrated from SQLite, so a cold read of an expired record is a cold load; focus/online refetch is wired by the application, not built into the engine.
- Both are added to the existing SWR page; one new line in `routes.ts` only if a separate page is needed.

## Acceptance criteria

- [ ] `apps/docs/tests/lifecycle-graph.test.tsx`: for every authored edge, calling the named FSM method from the source state lands in the target state (proves only that each method lands on its target).
- [ ] Same test file: a transition not in the edge list has a disabled button that ignores clicks; the note states this is a docs decision, not enforcement, and that `QueryEngine` does not use the class.
- [ ] The current state node carries `aria-current="true"` and changes after a transition.
- [ ] `apps/docs/tests/stale-timeline.test.tsx`: phase is empty / fresh (now < fetchedAt + staleTime) / stale / expired (now > fetchedAt + gcTime, regardless of any reader, checked first so it wins when staleTime > gcTime); a stale read resets both windows; no observer controls exist.
- [ ] `apps/docs/tests/swr-playground.test.tsx` still passes.

## Non-goals

Changing `LifecycleFSM` or `QueryEngine`; a graph layout library.
