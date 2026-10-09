# CAS playground on a tested model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task.

**Goal:** Rewire the docs CAS playground onto an in-memory, WebCrypto-based model whose hashes, keys and LRU eviction order are proven equal to the real `CasStore` by a parity test.

**Architecture:** `apps/docs/src/models/cas-model.ts` is a pure async model (no React, no node imports). A Node-side vitest parity test drives the real `CasStore` + `SqliteAdapter` (imported by relative path from `packages/core/src`, `@ucsa/core` untouched) with the same fixtures and compares. The component holds the model in a ref, serialises operations through a promise chain, and renders immutable snapshots.

**Tech Stack:** TypeScript, React 19, vitest (jsdom), WebCrypto.

**Spec:** `.claude/refined_backlog/F-031-cas-playground-on-a-tested-model/spec.md`

## Global Constraints

- `packages/core`, `README.md`, `apps/docs/package.json`, `App.tsx`, `index.css`, `shell.css`, `router.ts`, `routes.ts` are NOT modified.
- No new dependencies; no `any`; no non-null assertions.
- Page labelled "browser model, hash-compatible with the real store".
- No horizontal overflow at 360px; keyboard-operable controls with visible focus; no colour-only meaning; respect `prefers-reduced-motion`.
- Built bundle contains no `node:crypto` / `better-sqlite3`.

## Real rules to mirror (verified from source)

- hash = lowercase hex SHA-256 of bytes; key = `objects/<hash[0..2]>/<hash>` (`CasStore.getPath` relative to baseDir).
- put of existing hash = upsert: size set, `last_accessed_at` refreshed (dedupe; one blob).
- get on hit refreshes access time; miss returns null.
- After put, if total > maxBytes: prune. prune: target = floor(max*0.7); candidates ordered `last_accessed_at ASC, rowid ASC` (insertion order breaks ties; upsert keeps rowid); evict until total <= target.
- Reference counting has no counterpart in the real store: the model adds "referenced entries are skipped as eviction candidates" (pinned to the spec, noted in the test as not parity-checked).

### Task 1: Model + parity test (test first)

**Files:** Create `apps/docs/src/models/cas-model.ts`, `apps/docs/tests/cas-model.parity.test.ts`, `apps/docs/tests/cas-model.test.ts`.

**Interfaces — Produces:**
`class CasModel(opts: {maxBytes: number; targetRatio?: number; now?: () => number})`; `put(data: string | Uint8Array): Promise<PutResult {hash,size,key,deduped,evicted: string[]}>`; `get(hash): Uint8Array | null`; `retain(hash): boolean`; `release(hash): boolean`; `delete(hash): boolean`; `prune(ratio?): string[]`; `setMaxBytes(n)`; `entries(): CasEntry[]` (LRU order); `totalBytes(): number`; `hashOf(data): Promise<string>`; `keyOf(hash): string`.

- [ ] Step 1: write parity test (fixtures: empty, ascii, utf-8 multibyte, binary; hashes+keys vs `crypto.createHash` and real `CasStore.put`/`getPath`; eviction order scripted with `vi.useFakeTimers({toFake:['Date']})` and `vi.setSystemTime` against real `CasStore` with `SqliteAdapter(':memory:')`, comparing survivors order from `getLruCasObjects`) and behaviour tests (dedupe, evict LRU, referenced kept, get touches).
- [ ] Step 2: run, expect FAIL (module missing).
- [ ] Step 3: implement model.
- [ ] Step 4: run, expect PASS. Commit.
- [ ] Step 5: Phase gate (tsc, review, simplify, re-verify).

### Task 2: Rewire component + CSS

**Files:** Modify `apps/docs/src/components/CasPlayground.tsx`; Create `apps/docs/src/components/CasPlayground.css`; extend `apps/docs/tests/cas-playground.test.tsx`.

- [ ] Step 1: add failing behaviour tests (dedupe message, eviction message and row gone, pinned row survives, label text, serial rapid clicks).
- [ ] Step 2: run, FAIL. Step 3: implement (ref model, promise-chain queue, snapshot state, unmount guard, aria-live log). Step 4: PASS. Commit.
- [ ] Step 5: Phase gate.

### Task 3: Full verification

- [ ] `pnpm --filter @ucsa/docs test`, `npx tsc -b`, `pnpm --filter @ucsa/docs build` + grep dist, `scripts/precheck.sh`, diff-stat/ status checks.
- [ ] README: deliberately NOT edited in this slice (a later slice regenerates it; per caller instruction).

## Audit trail
Self-grill below.

## Appendix — audit trail
- 2026-10-09 self-grill-audit: verdict safe-with-fixes. Corrected: model carries an insertion sequence as tie-break and the parity test has a same-millisecond case; edge behaviours (all referenced, oversize blob, maxBytes 0) get explicit tests; parity test uses temp baseDir, normalised separators, and restores real timers; dist grep widened to `node:`. Open: none.
- Note: the browser default clock is a logical counter (no same-ms ties); parity runs with `Date.now()` under fake timers where ties break by insertion order, as in the real `ORDER BY last_accessed_at, rowid`.
