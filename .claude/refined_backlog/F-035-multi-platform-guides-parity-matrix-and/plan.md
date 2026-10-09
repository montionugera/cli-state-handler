# F-035 Multi-platform guides, parity matrix and tutorial path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development. Steps use checkbox syntax.

**Goal:** Move multi-platform guide content into per-subsystem files verified against source, add a parity matrix page and a five-page tutorial.

**Architecture:** Pure data modules under `apps/docs/src/content/` (guides, parity, tutorial pages); `MultiPlatformDocs.tsx` becomes a thin renderer (tabs + side-by-side); routes registered in `routes.ts`. Every Dart/C# snippet cites the file it was checked against; missing features are marked "not available".

**Tech Stack:** React 19, Vite, vitest + jsdom, plain CSS (tokens from index.css).

**Spec:** `.claude/refined_backlog/F-035-multi-platform-guides-parity-matrix-and/spec.md`

## Global Constraints

- No edits to packages/, README.md (final slice regenerates it), App.tsx, index.css, shell.css, router.ts, apps/docs/package.json, tests/app-shell.test.tsx.
- No `any`, no non-null assertions, no index keys for dynamic lists, no new deps, no per-file test timeouts.
- Factual accuracy: snippets use only names that exist in source; sharp edges (no backoff, no refcount, no focus refetch, unfenced lease completion, Dart and C# have only a reduced hub: endpoint resolution and hub-record bookkeeping (Dart also elect/connectAsClient), no socket server, client or subscription filtering) stated plainly.
- No horizontal overflow at 360px; focusable scroll containers with accessible names; matrix cells carry text labels.
- New commits only, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never ship/push/promote.

---

### Task 1: Guide content + parity data (test first)
**Files:** Create `src/content/guides/{swr,timing,outbox,cas,wal,ucb1}.ts`, `src/content/guides/index.ts`, `src/content/guides/types.ts`, `src/content/parity.ts`; Test `tests/multiplatform-docs.test.tsx`, `tests/parity.test.tsx`.
**Interfaces:** `Guide { id; label; ts|dart|csharp: Snippet; }`, `Snippet { title; lang; source: string; code: string|null; notes: string[]; available: boolean }`; `parity: ParityRow[]` with cells `{level:'full'|'partial'|'none'; source:string; reason?:string}`.
- [ ] Write failing tests: six guide ids x three platforms present or marked not available; matrix = 6 rows x 3 columns; every cited path exists on disk (repo-root resolved from `import.meta.dirname`).
- [ ] Run, confirm FAIL. Write content files from verified source. Run, confirm PASS.
- [ ] Commit.

### Task 2: Renderer + matrix page
**Files:** Rewrite `src/components/MultiPlatformDocs.tsx` (<200 lines); Create `src/components/ParityMatrix.tsx`, `src/components/multiplatform.css`; Test update `tests/multiplatform-docs.test.tsx` (observer concept dropped: it is not one of the six subsystems and its snippets did not match source).
- [ ] Failing tests for tab switching, side-by-side view, matrix table with accessible scroll region. Implement. PASS. Commit.

### Task 3: Tutorial pages + routes
**Files:** Create `src/content/tutorial/{FirstQuery,Freshness,DurableCache,OfflineMutations,CrossProcess}.tsx`, `src/content/tutorial/index.ts`, `src/content/tutorial/tutorial.css`; Modify `src/routes.ts` (matrix in Guides; Tutorial group after Start); Test `tests/tutorial.test.tsx`.
- [ ] Failing test: five routes render h1, embedded visualiser, and a link to next page (last links back to the parity matrix). Implement. PASS. Commit.

### Task 4: Phase gate and acceptance
- [ ] `pnpm --filter @ucsa/docs test`, `wc -l MultiPlatformDocs.tsx`, `pnpm exec tsc -b` (from apps/docs), `pnpm --filter @ucsa/docs build`, `scripts/precheck.sh`, diff-stat guard, `git status`.
- [ ] Independent review of the diff against source facts; fix findings; re-verify.
- [ ] README update: intentionally NOT done in this slice (final slice regenerates README.md, per instruction).

## Appendix - audit trail
- 2026-10-09 self-grill-audit: verdict safe-with-fixes. Corrected: (1) Dart/C# UCB1 is "partial" (bus_hub.dart, Ipc/BusHub.cs exist; reduced hub, no sockets); (2) WAL cells justified by grep: TS sqlite-adapter.ts:173-175, Dart sqlite_adapter.dart:39 (the audit's "no WAL in Dart" was wrong; checked), C# UnitySqliteAdapter.cs pragma + Checkpoint; (3) multiplatform-docs.test.tsx: only the "Zero-Rebuild Observer" test is deleted (observer is not one of the six subsystems); every other asserted string is kept, route title "TS / Dart / Unity C#" untouched; (4) tutorial ids lowercase and unique (tutorial-*), tutorial test asserts visualiser by distinctive heading text, h1 duplication from Wal/Ucb1 accepted; repo root = path.resolve(import.meta.dirname, "../../.."); tsc command is `pnpm exec tsc -b`.
  Open: none. Commit trailer follows the task instruction (Opus 5.5).
