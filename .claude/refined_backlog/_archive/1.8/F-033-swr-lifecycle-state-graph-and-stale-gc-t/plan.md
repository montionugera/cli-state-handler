# SWR lifecycle graph and stale/gc timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task.

**Goal:** Add an SVG LifecycleFSM state graph and a controllable-clock stale/gc timeline to the existing SWR docs page.

**Architecture:** `models/lifecycle-graph.ts` holds states and authored edges (each naming the FSM method + args). `LifecycleGraph` owns a `LifecycleFSM`, applies an edge, re-reads `fsm.state`. `models/stale-timeline.ts` is a pure phase function over (fetchedAt, staleTime, observers, unmountedAt, gcTime, now); `StaleTimeline` drives it from an injectable clock with advance buttons.

**Tech Stack:** React, Vite, plain CSS, vitest + jsdom. No new deps.

**Spec:** `.claude/refined_backlog/F-033-swr-lifecycle-state-graph-and-stale-gc-t/spec.md`

## Global Constraints
- Do not modify packages/core, README.md, App.tsx, index.css, shell.css, router.ts, routes.ts, other components, package.json.
- swr-playground.test.tsx and app-shell.test.tsx pass unchanged (avoid new text matching their getByText queries: "Status: success", "INITIAL LOAD", "REFERENCE PRESERVED", "SWR & Lifecycle", button labels).
- No `any`, no non-null assertions. 360px no horizontal overflow. `aria-current="true"` on current node, aria-live log, reduced-motion respected.

## Findings that shape the plan
- Real `LifecycleFSM` has NO guards: every method works from every state. So the "rejected" criterion is enforced by the authored edge list (buttons disabled / not applied), and the drift test proves each edge's method really lands on its target, and that each (state, method) outcome is documented. Deviation from spec noted.
- Engine: `staleTime` => `stale_at = fetchedAt + staleTime`; `gcTime` default 300000 (ms). Timeline treats gc as gcTime after last observer leaves (spec).

### Task 1: lifecycle graph model + component
**Files:** Create `apps/docs/src/models/lifecycle-graph.ts`, `apps/docs/src/components/LifecycleGraph.tsx`, `LifecycleGraph.css`; Test `apps/docs/tests/lifecycle-graph.test.tsx`.
**Produces:** `LIFECYCLE_STATES`, `LIFECYCLE_EDGES: {from,to,method,label}[]`, `applyEdge(fsm, edge)`, `<LifecycleGraph/>`.
- [ ] Write failing tests: every edge lands on `to` via real FSM; edge list unique per (from,to); non-edge targets have disabled buttons and clicking leaves state; aria-current moves; log gets an entry.
- [ ] Run, see fail. [ ] Implement. [ ] Run, pass. [ ] Commit.

### Task 2: stale timeline model + component
**Files:** Create `models/stale-timeline.ts`, `components/StaleTimeline.tsx`, `StaleTimeline.css`; Test `tests/stale-timeline.test.tsx`.
**Produces:** `phaseAt(s, now)`, `<StaleTimeline startAt?: number />`.
- [ ] Failing tests: fresh -> stale after staleTime; collected after gcTime with no observers; observers prevent collection; focus refetch skipped while fresh, refetches when stale. [ ] Implement. [ ] Pass. [ ] Commit.

### Task 3: mount in SwrPlayground
- [ ] Render both below existing content (minimal edit); run full docs tests, tsc, build, scripts/precheck.sh. README is intentionally NOT edited (a later slice regenerates it). Commit.
- [ ] Phase gate: code-reviewer pass, simplify, re-verify.

## Appendix — audit trail
- 2026-10-09 self-grill-audit: verdict safe-with-fixes. Corrected: (1) timeline UI copy labels observers/focus-refetch/"gc after last observer" as illustrative simulation and cites the engine's real `stale_at`/`expires_at` (query-engine.ts:619); (2) spec criterion 2 ("real FSM rejects") is impossible because LifecycleFSM has no guards (lifecycle-fsm.ts:46-77), so gating is UI-level via authored edges and each edge is proven against the real FSM (deviation, reported to caller); (3) log/node text avoids "Status: success", "INITIAL LOAD", "REFERENCE PRESERVED"; (4) clock is manual state, no interval/rAF/Date.now; (5) README not edited because the dispatching task forbids it (a later slice regenerates it). Open: 360px/reduced-motion are CSS-only, not test-enforced.
