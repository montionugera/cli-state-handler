// Pure teaching model of SQLite write-ahead logging. This is a SIMULATION: it
// encodes the rules, not SQLite's page format or the -shm index. Every
// operation returns a new state plus an event for the log; inputs are never
// mutated.

export type JournalMode = "WAL" | "DELETE";

export interface Frame {
  key: string;
  value: string;
}

/** Rollback-journal entry: a page's ORIGINAL value (null = key did not exist). */
export interface JournalEntry {
  key: string;
  original: string | null;
}

export interface Reader {
  id: number;
  /** Number of committed WAL frames this reader can see (fixed when it opened). */
  mark: number;
}

export interface WalState {
  mode: JournalMode;
  /** The main database file (pages reduced to key/value pairs). */
  main: Record<string, string>;
  /** WAL frames in order; the first `committedLen` are covered by a commit marker. */
  wal: Frame[];
  committedLen: number;
  /** Frames already copied into the main file by a checkpoint. */
  checkpointed: number;
  txnOpen: boolean;
  /** DELETE mode only: the rollback journal, holding original values saved before each change. */
  pending: JournalEntry[];
  readers: Reader[];
  nextReaderId: number;
  crashed: boolean;
}

export interface OpEvent {
  ok: boolean;
  message: string;
}

export interface OpResult {
  state: WalState;
  event: OpEvent;
}

export function createState(mode: JournalMode = "WAL"): WalState {
  return {
    mode,
    main: { counter: "1" },
    wal: [],
    committedLen: 0,
    checkpointed: 0,
    txnOpen: false,
    pending: [],
    readers: [],
    nextReaderId: 1,
    crashed: false,
  };
}

const ok = (state: WalState, message: string): OpResult => ({ state, event: { ok: true, message } });
const no = (state: WalState, message: string): OpResult => ({ state, event: { ok: false, message } });
const CRASHED = "Database crashed: run recovery first.";

function overlay(base: Record<string, string>, frames: Frame[]): Record<string, string> {
  const out = { ...base };
  for (const f of frames) out[f.key] = f.value;
  return out;
}

/** Copy the journal's original values back over the main file (rollback / hot-journal recovery). */
function rollback(main: Record<string, string>, journal: JournalEntry[]): Record<string, string> {
  const out = { ...main };
  for (const e of journal) {
    if (e.original === null) delete out[e.key];
    else out[e.key] = e.original;
  }
  return out;
}

/** What a brand-new reader would see right now. */
export function committedView(s: WalState): Record<string, string> {
  if (s.mode === "DELETE") return rollback(s.main, s.pending);
  return overlay(s.main, s.wal.slice(0, s.committedLen));
}

/** What an existing reader sees: main file plus WAL frames up to its mark. */
export function readerView(s: WalState, id: number): Record<string, string> | undefined {
  const r = s.readers.find((x) => x.id === id);
  if (!r) return undefined;
  return overlay(s.main, s.wal.slice(0, r.mark));
}

export function write(s: WalState, key: string, value: string): OpResult {
  if (s.crashed) return no(s, CRASHED);
  if (s.mode === "DELETE") {
    if (s.readers.length > 0) {
      return no(s, "Write blocked: in rollback-journal mode a writer needs an exclusive lock and readers are open (simplified).");
    }
    const saved = s.pending.some((e) => e.key === key);
    const pending = saved ? s.pending : [...s.pending, { key, original: key in s.main ? s.main[key] : null }];
    return ok(
      { ...s, txnOpen: true, pending, main: { ...s.main, [key]: value } },
      `Saved the original of ${key} to the rollback journal, then wrote ${key}=${value} into the main file (not yet committed).`,
    );
  }
  return ok(
    { ...s, txnOpen: true, wal: [...s.wal, { key, value }] },
    `Appended frame ${key}=${value} to the WAL (not yet committed).`,
  );
}

export function commit(s: WalState): OpResult {
  if (s.crashed) return no(s, CRASHED);
  if (!s.txnOpen) return no(s, "Nothing to commit: no write transaction is open.");
  if (s.mode === "DELETE") {
    return ok(
      { ...s, pending: [], txnOpen: false },
      "Committed: the rollback journal was deleted; the new values in the main file are now final.",
    );
  }
  return ok(
    { ...s, committedLen: s.wal.length, txnOpen: false },
    `Committed: commit marker written after frame ${s.wal.length}. Readers who open now will see it.`,
  );
}

export function openReader(s: WalState): OpResult {
  if (s.crashed) return no(s, CRASHED);
  if (s.mode === "DELETE" && s.txnOpen) {
    return no(s, "Reader blocked: the writer holds an exclusive lock in rollback-journal mode (simplified).");
  }
  const reader: Reader = { id: s.nextReaderId, mark: s.committedLen };
  return ok(
    { ...s, readers: [...s.readers, reader], nextReaderId: s.nextReaderId + 1 },
    `Reader ${reader.id} opened with snapshot mark ${reader.mark}.`,
  );
}

export function closeReader(s: WalState, id: number): OpResult {
  if (s.crashed) return no(s, CRASHED);
  if (!s.readers.some((r) => r.id === id)) return no(s, `Reader ${id} is not open.`);
  return ok({ ...s, readers: s.readers.filter((r) => r.id !== id) }, `Reader ${id} closed.`);
}

export function checkpoint(s: WalState): OpResult {
  if (s.crashed) return no(s, CRASHED);
  if (s.mode !== "WAL") return no(s, "Checkpoint only applies in WAL mode.");
  const oldest = s.readers.length > 0 ? Math.min(...s.readers.map((r) => r.mark)) : undefined;
  const limit = oldest === undefined ? s.committedLen : Math.min(s.committedLen, oldest);
  const start = s.checkpointed;
  const copyTo = Math.max(start, limit);
  const main = overlay(s.main, s.wal.slice(start, copyTo));
  const copied = copyTo - start;
  const base: WalState = { ...s, main, checkpointed: copyTo };

  const fullyBackfilled = copyTo === s.wal.length;
  if (fullyBackfilled && !s.txnOpen && s.readers.length === 0) {
    return ok(
      { ...base, wal: [], committedLen: 0, checkpointed: 0 },
      `Checkpoint copied ${copied} frame(s) to the main file and reset the WAL.`,
    );
  }
  let why = "";
  if (s.readers.length > 0 && copyTo < s.committedLen) {
    why = ` Stopped at the oldest reader's mark (${copyTo}): that reader still needs those WAL frames.`;
  } else if (s.readers.length > 0) {
    why = " WAL kept: a reader is still active, so it cannot be reset.";
  } else if (s.txnOpen) {
    why = " WAL kept: a write transaction is still open.";
  }
  return ok(base, `Checkpoint copied ${copied} frame(s) to the main file.${why}`);
}

export function crash(s: WalState): OpResult {
  if (s.crashed) return no(s, "Already crashed.");
  return ok(
    { ...s, crashed: true, readers: [], txnOpen: false },
    s.mode === "DELETE"
      ? s.pending.length === 0
        ? "Crash: all connections lost. No write was in progress, so there is no journal on disk."
        : "Crash: all connections lost. The main file holds uncommitted changes and a hot journal remains on disk."
      : "Crash: all connections lost. Uncommitted work is still on disk but not yet cleaned up.",
  );
}

export function recover(s: WalState): OpResult {
  if (!s.crashed) return no(s, "Nothing to recover: the database did not crash.");
  if (s.mode === "DELETE") {
    if (s.pending.length === 0) {
      return ok(
        { ...s, crashed: false, txnOpen: false },
        "Recovery: no hot journal found, nothing to roll back; committed data survives.",
      );
    }
    return ok(
      { ...s, crashed: false, main: rollback(s.main, s.pending), pending: [], txnOpen: false },
      `Recovery: the hot journal was rolled back into the main file, restoring ${s.pending.length} original page(s); committed data survives.`,
    );
  }
  const dropped = s.wal.length - s.committedLen;
  return ok(
    { ...s, crashed: false, wal: s.wal.slice(0, s.committedLen), pending: [], txnOpen: false },
    `Recovery: discarded ${dropped} uncommitted frame(s) after the last commit marker; committed data survives.`,
  );
}

export function setMode(s: WalState, mode: JournalMode): OpResult {
  if (s.crashed) return no(s, CRASHED);
  if (s.mode === mode) return ok(s, `Already in ${mode} mode.`);
  if (s.readers.length > 0 || s.txnOpen) {
    return no(s, "Cannot switch journal mode while a reader or write transaction is open.");
  }
  if (mode === "DELETE") {
    return ok(
      { ...s, mode, main: overlay(s.main, s.wal.slice(0, s.committedLen)), wal: [], committedLen: 0, checkpointed: 0 },
      "Switched to rollback-journal (DELETE) mode: WAL was backfilled into the main file first.",
    );
  }
  return ok({ ...s, mode }, "Switched to WAL mode.");
}
