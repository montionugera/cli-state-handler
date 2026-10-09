---
title: "SQLite WAL storage visualiser"
id: I-030
status: idea
---

# SQLite WAL storage visualiser

Slice 4 of epic E-008 (docs portal). Depends on slice 2.

## Problem

UCSA's durability story rests on SQLite in WAL mode (`packages/core/src/storage/sqlite-adapter.ts`: `journalMode` option, WAL by default, `wal_checkpoint`). The portal has nothing that shows what WAL does. SQLite itself cannot run in this bundle, so this is a teaching simulation.

## Scope

- `apps/docs/src/models/wal-model.ts`: a pure state machine with a main file (pages), a WAL (ordered frames with commit markers), readers holding a snapshot mark, `write`, `commit`, `openReader`, `closeReader`, `checkpoint`, `crash` and `recover`. Rules it must encode: readers see the last commit at the time they opened; a checkpoint cannot pass the oldest reader's mark; after a crash, uncommitted frames are discarded and committed ones survive. A `journalMode` switch to rollback-journal ("DELETE") mode shows writers blocking readers for contrast.
- `apps/docs/src/components/WalVisualiser.tsx` + CSS: three panels (main file, WAL, readers), step controls, an event log, and a visible "Simulation — not a real SQLite engine" label linking to the adapter options it illustrates.
- One line in `routes.ts`.

## Acceptance criteria

- [ ] `apps/docs/tests/wal-model.test.ts` covers each rule above, including checkpoint blocked by an old reader and crash recovery.
- [ ] `apps/docs/tests/wal-visualiser.test.tsx`: after a write and commit, the value appears in the WAL panel and not yet in the main-file panel.
- [ ] Same test: a reader opened before the write still shows the old value.
- [ ] Same test: after checkpoint with no readers, the WAL panel is empty and the main-file panel shows the new value.
- [ ] The text "simulation" is present on the page.

## Non-goals

Running real SQLite (wasm), page-level byte layouts, the `-shm` index.
