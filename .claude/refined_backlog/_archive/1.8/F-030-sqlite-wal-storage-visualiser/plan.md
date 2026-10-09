# SQLite WAL storage visualiser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A docs-portal page that teaches SQLite WAL (snapshot readers, single writer, checkpoint limits, crash recovery, rollback-journal contrast) through a pure model plus a React component.

**Architecture:** `apps/docs/src/models/wal-model.ts` is a pure immutable state machine (each op returns `{ state, event }`). `WalVisualiser.tsx` holds state in `useState`, renders three labelled regions (Main file, WAL, Readers), an `aria-live` log, and links to the adapter options it illustrates. One line in `routes.ts`.

**Tech Stack:** React, plain CSS, vitest + jsdom + testing-library. No new dependencies.

**Spec:** `.claude/refined_backlog/F-030-sqlite-wal-storage-visualiser/spec.md`

## Global Constraints

- Do not modify `packages/core`, `README.md` (a later slice regenerates it), `apps/docs/package.json`, `App.tsx`, `index.css`, `shell.css`, `router.ts`.
- The page must visibly contain the word "simulation" (label: "Simulation - not a real SQLite engine").
- No `any`, no non-null assertions. No colour-only meaning. Respect `prefers-reduced-motion`. No horizontal overflow at 360px.
- Sidebar title "WAL Storage" must not equal any other shell text node.
- Commits: new commits only, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

- Create `apps/docs/src/models/wal-model.ts` (pure model)
- Create `apps/docs/tests/wal-model.test.ts`
- Create `apps/docs/src/components/WalVisualiser.tsx`, `wal-visualiser.css`
- Create `apps/docs/tests/wal-visualiser.test.tsx`
- Modify `apps/docs/src/routes.ts` (one line, Visualisers group)

## Model contract (Task 1 produces, Task 2 consumes)

```ts
type JournalMode = "WAL" | "DELETE";
interface Frame { key: string; value: string }
interface Reader { id: number; mark: number }          // mark = committed frame count at open (WAL)
interface WalState {
  mode: JournalMode; main: Record<string,string>; wal: Frame[];
  committedLen: number; checkpointed: number;
  txnOpen: boolean; pending: Frame[];                  // pending = DELETE-mode journal
  readers: Reader[]; nextReaderId: number; crashed: boolean;
}
interface OpResult { state: WalState; event: { ok: boolean; message: string } }
createState(mode?): WalState            // main = { counter: "1" }
write(s,key,value) / commit(s) / openReader(s) / closeReader(s,id)
checkpoint(s) / crash(s) / recover(s) / setMode(s,mode)
readerView(s,id): Record<string,string> | undefined
committedView(s): Record<string,string>
```

Rules: readers see main + wal[0..mark); one write transaction at a time (write while another is open continues the same txn; a second concurrent writer is modelled by the DELETE-mode block); checkpoint copies frames up to min(committedLen, oldest reader mark), WAL is reset only when all frames are backfilled, no txn is open and no reader is active; crash marks `crashed`, drops readers and the open txn handle, `recover` truncates the WAL to `committedLen`; DELETE mode: write blocked while any reader is open, openReader blocked while a txn is open, commit applies `pending` to main; every op except `recover` is rejected while crashed; `setMode` needs no readers and no open txn, and backfills the WAL first.

### Task 1: Pure model (test first)

- [ ] Write `tests/wal-model.test.ts` covering: snapshot isolation, commit visibility, checkpoint blocked by old reader (partial copy, WAL kept), checkpoint with no reader empties WAL, crash/recover discards uncommitted and keeps committed, DELETE-mode mutual blocking, ops rejected while crashed, immutability (input state unchanged).
- [ ] Run `pnpm --filter @ucsa/docs test wal-model` - expect FAIL (module missing).
- [ ] Implement `wal-model.ts`.
- [ ] Run again - expect PASS. Commit.
- [ ] Phase gate: verify, independent review (typescript-reviewer), simplify, re-verify.

### Task 2: Component, CSS, route (test first)

- [ ] Write `tests/wal-visualiser.test.tsx`: after write+commit the value is inside region "WAL" and not inside region "Main file"; reader opened before the write still shows the old value; after closing readers and checkpoint, WAL region is empty and Main file shows the new value; text "simulation" present; crash/recover and DELETE-mode blocking surface in the `aria-live` log; the adapter-option link text is present.
- [ ] Run - expect FAIL.
- [ ] Implement `WalVisualiser.tsx` (regions via `<section aria-label>`, key/value inputs with labels, wrapping button row, tables inside `overflow-x:auto`, textual status badges) and `wal-visualiser.css` (`minmax(0,1fr)` grid, one column under 768px, `:focus-visible`, reduced-motion).
- [ ] Add route line `{ id: "wal", title: "WAL Storage", icon: "🪵", group: "Visualisers", component: WalVisualiser }`.
- [ ] Run docs tests, `npx tsc -b`, `pnpm --filter @ucsa/docs build`, `scripts/precheck.sh`. Commit.
- [ ] README: intentionally NOT edited here (a later slice regenerates it); no architecture diagram change.
- [ ] Phase gate: verify, review (code-reviewer + typescript-reviewer), simplify, re-verify.

## Audit trail

See self-grill-audit result appended below.

## Appendix — audit trail
- 2026-10-09 self-grill-audit: verdict safe-with-fixes (no CRITICAL/HIGH). Corrected: DELETE-mode rules kept per spec ("readers block writers") but the page labels it a simplified contrast (real SQLite locks exclusively only at commit); copy says "WAL for file databases, MEMORY for :memory:" and names `checkpoint(mode)`; page h1 is "SQLite WAL Storage Visualiser" (not the bare sidebar title) and tests scope with `within`; trailer kept as Opus 5.5 per task instruction.
  Open: README.md test-table row and add-a-page note are stale until the README-regeneration slice runs (task forbids editing README here); WAL-mode "second concurrent writer" is not an explicit op (a write joins the one open transaction); `routes.ts` will likely conflict trivially with sibling slices.
