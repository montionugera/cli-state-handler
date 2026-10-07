---
title: "live-swr-playground"
id: F-012
status: refined
from_idea: I-012
---

# live-swr-playground

## Summary

Scaffold `apps/docs` as a high-performance, Storybook-like tutorial and live documentation application using Vite, React 19, and Tailwind CSS.
Provide the **Live SWR Playground** (`<SwrPlayground />`) which executes real queries using `@ucsa/core`, demonstrating:
1. Cache inspection in real-time (Query Hash, Key, Status, Data Payload, Stale Timestamp).
2. Stale-While-Revalidate (SWR) lifecycle: immediate cache hit return with background asynchronous refetch.
3. Structural Sharing Diff Visualizer: compares old and new payloads via `replaceEqualDeep`, visually highlighting identical vs mutated references.
4. Tag Invalidation Simulator: allows tagging queries and triggering `invalidateByTag()` to observe automatic cache invalidation and background revalidation.

## Acceptance criteria

- [ ] `apps/docs` is scaffolded with Vite, React 19, Tailwind CSS, and linked to `@ucsa/core` via `pnpm` workspace dependency.
- [ ] `<SwrPlayground />` provides interactive triggers to execute queries with customizable stale times and tags.
- [ ] Live cache state visualizer displays current cache entries, lifecycle states (`idle`, `loading`, `success`, `retrying`, `error`), and TTL countdowns.
- [ ] Structural sharing panel highlights whether subsequent refetches produced new references or retained existing references via `replaceEqualDeep`.
- [ ] Tag invalidation control allows invalidating cache entries by tag and visually reflects the stale transition and re-fetch.
- [ ] Automated Vitest component tests in `apps/docs/tests/swr-playground.test.tsx` verify state transitions and UI rendering.
