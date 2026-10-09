---
title: "Multi-platform guides parity matrix and tutorial path"
id: F-035
status: refined
from_idea: I-034
---

# Multi-platform guides parity matrix and tutorial path

Slice 8 of epic E-008 (docs portal). Depends on slices 2–7 (it embeds their visualisers).

## Problem

`MultiPlatformDocs.tsx` (555 lines) holds static code strings for five topics in TypeScript, Dart and C#. It has no WAL or UCB1 section, no side-by-side view, no parity matrix, and the portal has no long-form tutorial.

## Scope

- Move guide content out of the component into `apps/docs/src/content/guides/<subsystem>.ts` (one file per subsystem: swr, timing, outbox, cas, wal, ucb1), each exporting `{ ts, dart, csharp }` snippets plus notes. Snippets must be taken from, or checked against, the real packages (`packages/core`, `packages/ucsa_dart`, `packages/com.ucsa.unity`); any API that does not exist on a platform is marked "not available" rather than invented.
- Views: tabbed (existing) and side-by-side on wide screens.
- `apps/docs/src/content/parity.ts` and a parity matrix page: one row per subsystem, one column per platform, each cell `full`, `partial` or `none` with the source file path that justifies it.
- Tutorial path under `apps/docs/src/content/tutorial/`: five pages using the `Prose` primitive, each embedding a visualiser — first query; freshness and refetch timing; durable cache and WAL; offline mutations with the outbox; cross-process events over UCB1.
- Registry lines in `routes.ts` for the matrix and tutorial pages.

## Acceptance criteria

- [ ] `apps/docs/tests/multiplatform-docs.test.tsx`: TypeScript, Dart and C# content is present for each of the six subsystem ids (or an explicit "not available" marker).
- [ ] Same test: the parity matrix renders exactly one row per subsystem and three platform columns.
- [ ] Every source path cited in `parity.ts` exists in the repo (asserted by a test).
- [ ] `apps/docs/tests/tutorial.test.tsx`: all five tutorial routes render a heading and their embedded visualiser, and each links to the next page.
- [ ] `MultiPlatformDocs.tsx` is under 200 lines after the content move.

## Non-goals

Running Dart or C# in the browser; API reference generation.
