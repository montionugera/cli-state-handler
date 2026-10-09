---
title: "SWR lifecycle state graph and stale-gc timeline"
id: I-033
status: idea
---

# SWR lifecycle state graph and stale-gc timeline

Slice 7 of epic E-008 (docs portal). Depends on slice 2.

## Problem

The SWR playground uses the real `QueryEngine` but shows state only as text. `LifecycleFSM` is exported from the browser entry and unused. It has five states but no subscribe API and no transition table, and `QueryEngine` does not drive it.

## Scope

- `apps/docs/src/models/lifecycle-graph.ts`: the five states and the hand-authored edges between them, each edge naming the `LifecycleFSM` method that performs it.
- `apps/docs/src/components/LifecycleGraph.tsx` + CSS: an SVG graph that owns its own `LifecycleFSM` instance, highlights the current state, enables only the transitions legal from it, and logs each transition.
- `apps/docs/src/components/StaleTimeline.tsx`: a timeline showing fresh, stale and gc windows for adjustable `staleTime`/`gcTime`, with markers for fetch, focus refetch and garbage collection, driven by a controllable clock.
- Both are added to the existing SWR page; one new line in `routes.ts` only if a separate page is needed.

## Acceptance criteria

- [ ] `apps/docs/tests/lifecycle-graph.test.tsx`: for every authored edge, calling the named FSM method from the source state lands in the target state (the graph cannot drift from the real FSM).
- [ ] Same test: a transition not in the edge list is rejected by the real FSM, and its button is disabled.
- [ ] The current state node carries `aria-current="true"` and changes after a transition.
- [ ] `apps/docs/tests/stale-timeline.test.tsx`: advancing the clock past `staleTime` marks the query stale; past `gcTime` with no observers marks it collected.
- [ ] `apps/docs/tests/swr-playground.test.tsx` still passes.

## Non-goals

Changing `LifecycleFSM` or `QueryEngine`; a graph layout library.
