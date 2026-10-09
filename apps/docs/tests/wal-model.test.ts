import { describe, it, expect } from "vitest";
import {
  createState,
  write,
  commit,
  openReader,
  closeReader,
  checkpoint,
  crash,
  recover,
  setMode,
  readerView,
  committedView,
  type WalState,
} from "../src/models/wal-model.js";

function must(r: { state: WalState; event: { ok: boolean; message: string } }): WalState {
  expect(r.event.ok, r.event.message).toBe(true);
  return r.state;
}

describe("wal-model: WAL mode", () => {
  it("starts with a seeded main file and an empty WAL", () => {
    const s = createState();
    expect(s.mode).toBe("WAL");
    expect(s.main).toEqual({ counter: "1" });
    expect(s.wal).toEqual([]);
  });

  it("a write appends an uncommitted frame to the WAL, not to the main file", () => {
    const s = must(write(createState(), "counter", "2"));
    expect(s.wal).toEqual([{ key: "counter", value: "2" }]);
    expect(s.committedLen).toBe(0);
    expect(s.main.counter).toBe("1");
    expect(committedView(s).counter).toBe("1");
  });

  it("commit makes the frame durable in the WAL and visible, main untouched", () => {
    const s = must(commit(must(write(createState(), "counter", "2"))));
    expect(s.committedLen).toBe(1);
    expect(s.txnOpen).toBe(false);
    expect(committedView(s).counter).toBe("2");
    expect(s.main.counter).toBe("1");
  });

  it("commit without an open transaction is rejected", () => {
    const r = commit(createState());
    expect(r.event.ok).toBe(false);
  });

  it("a reader keeps its snapshot after a later commit (snapshot isolation)", () => {
    let s = must(openReader(createState()));
    const id = s.readers[0].id;
    s = must(commit(must(write(s, "counter", "2"))));
    expect(readerView(s, id)?.counter).toBe("1");
    s = must(openReader(s));
    expect(readerView(s, s.readers[1].id)?.counter).toBe("2");
  });

  it("a reader does not see uncommitted frames", () => {
    let s = must(write(createState(), "counter", "9"));
    s = must(openReader(s));
    expect(readerView(s, s.readers[0].id)?.counter).toBe("1");
  });

  it("readers do not block the writer in WAL mode", () => {
    const s = must(openReader(createState()));
    expect(write(s, "counter", "2").event.ok).toBe(true);
  });

  it("only one write transaction at a time: writes join the open transaction and commit together", () => {
    let s = must(write(createState(), "a", "1"));
    s = must(write(s, "b", "2"));
    expect(s.wal).toHaveLength(2);
    s = must(commit(s));
    expect(s.committedLen).toBe(2);
    expect(s.txnOpen).toBe(false);
  });

  it("checkpoint with no readers copies committed frames to main and empties the WAL", () => {
    let s = must(commit(must(write(createState(), "counter", "2"))));
    s = must(checkpoint(s));
    expect(s.main.counter).toBe("2");
    expect(s.wal).toEqual([]);
    expect(s.committedLen).toBe(0);
    expect(s.checkpointed).toBe(0);
  });

  it("checkpoint is blocked at the oldest reader's mark and the WAL is kept", () => {
    let s = must(commit(must(write(createState(), "counter", "2")))); // frame 1
    s = must(openReader(s)); // mark = 1
    const oldId = s.readers[0].id;
    s = must(commit(must(write(s, "counter", "3")))); // frame 2
    const r = checkpoint(s);
    expect(r.event.ok).toBe(true);
    s = r.state;
    expect(s.main.counter).toBe("2"); // only frame 1 copied
    expect(s.checkpointed).toBe(1);
    expect(s.wal).toHaveLength(2); // not reset
    expect(readerView(s, oldId)?.counter).toBe("2");
    expect(committedView(s).counter).toBe("3");
    expect(r.event.message).toMatch(/reader/i);
  });

  it("an old reader holding mark 0 blocks any copying", () => {
    let s = must(openReader(createState()));
    s = must(commit(must(write(s, "counter", "2"))));
    s = must(checkpoint(s));
    expect(s.main.counter).toBe("1");
    expect(s.checkpointed).toBe(0);
  });

  it("after the old reader closes, a second checkpoint finishes and resets the WAL", () => {
    let s = must(openReader(createState()));
    const id = s.readers[0].id;
    s = must(commit(must(write(s, "counter", "2"))));
    s = must(checkpoint(s));
    s = must(closeReader(s, id));
    s = must(checkpoint(s));
    expect(s.main.counter).toBe("2");
    expect(s.wal).toEqual([]);
  });

  it("WAL is not reset while a reader remains, even if every frame is backfilled", () => {
    let s = must(commit(must(write(createState(), "counter", "2"))));
    s = must(openReader(s)); // mark = 1, sees everything
    s = must(checkpoint(s));
    expect(s.main.counter).toBe("2");
    expect(s.wal).toHaveLength(1);
  });

  it("an open transaction's uncommitted frames survive a checkpoint", () => {
    let s = must(commit(must(write(createState(), "counter", "2"))));
    s = must(write(s, "counter", "3"));
    s = must(checkpoint(s));
    expect(s.main.counter).toBe("2");
    expect(s.wal).toHaveLength(2);
    expect(s.committedLen).toBe(1);
    s = must(commit(s));
    expect(committedView(s).counter).toBe("3");
  });

  it("closeReader rejects an unknown reader id", () => {
    expect(closeReader(createState(), 42).event.ok).toBe(false);
  });
});

describe("wal-model: crash and recovery", () => {
  it("after recover, uncommitted frames are gone and committed frames survive", () => {
    let s = must(commit(must(write(createState(), "counter", "2"))));
    s = must(write(s, "counter", "3")); // never committed
    s = must(crash(s));
    expect(s.crashed).toBe(true);
    s = must(recover(s));
    expect(s.crashed).toBe(false);
    expect(s.wal).toEqual([{ key: "counter", value: "2" }]);
    expect(committedView(s).counter).toBe("2");
    expect(s.txnOpen).toBe(false);
  });

  it("a crash drops all readers", () => {
    let s = must(openReader(createState()));
    s = must(recover(must(crash(s))));
    expect(s.readers).toEqual([]);
  });

  it("operations are rejected while crashed, except recover", () => {
    const s = must(crash(createState()));
    expect(write(s, "a", "b").event.ok).toBe(false);
    expect(openReader(s).event.ok).toBe(false);
    expect(checkpoint(s).event.ok).toBe(false);
    expect(commit(s).event.ok).toBe(false);
    expect(recover(s).event.ok).toBe(true);
  });

  it("recover when not crashed is rejected", () => {
    expect(recover(createState()).event.ok).toBe(false);
  });

  it("committed-but-not-checkpointed data survives a crash in the WAL", () => {
    let s = must(commit(must(write(createState(), "counter", "7"))));
    s = must(recover(must(crash(s))));
    expect(s.main.counter).toBe("1");
    expect(committedView(s).counter).toBe("7");
  });
});

describe("wal-model: rollback-journal (DELETE) mode", () => {
  it("setMode DELETE backfills the WAL into main and clears it", () => {
    let s = must(commit(must(write(createState(), "counter", "2"))));
    s = must(setMode(s, "DELETE"));
    expect(s.mode).toBe("DELETE");
    expect(s.main.counter).toBe("2");
    expect(s.wal).toEqual([]);
  });

  it("setMode is rejected while a reader or transaction is open", () => {
    expect(setMode(must(openReader(createState())), "DELETE").event.ok).toBe(false);
    expect(setMode(must(write(createState(), "a", "b")), "DELETE").event.ok).toBe(false);
  });

  it("an open reader blocks the writer", () => {
    const s = must(setMode(createState(), "DELETE"));
    const withReader = must(openReader(s));
    const r = write(withReader, "counter", "2");
    expect(r.event.ok).toBe(false);
    expect(r.event.message).toMatch(/block/i);
    expect(r.state).toEqual(withReader);
  });

  it("an open writer blocks new readers", () => {
    const s = must(write(must(setMode(createState(), "DELETE")), "counter", "2"));
    const r = openReader(s);
    expect(r.event.ok).toBe(false);
    expect(r.event.message).toMatch(/block/i);
  });

  it("a write saves the ORIGINAL value in the journal and puts the new value in the main file", () => {
    const s = must(write(must(setMode(createState(), "DELETE")), "counter", "2"));
    expect(s.pending).toEqual([{ key: "counter", original: "1" }]);
    expect(s.main.counter).toBe("2");
    expect(s.wal).toEqual([]);
  });

  it("journals only the first original of a key and records brand-new keys as absent", () => {
    let s = must(setMode(createState(), "DELETE"));
    s = must(write(s, "counter", "2"));
    s = must(write(s, "counter", "3"));
    s = must(write(s, "fresh", "x"));
    expect(s.pending).toEqual([
      { key: "counter", original: "1" },
      { key: "fresh", original: null },
    ]);
  });

  it("commit just deletes the journal; the new value stays in main", () => {
    let s = must(write(must(setMode(createState(), "DELETE")), "counter", "2"));
    const r = commit(s);
    s = must(r);
    expect(s.main.counter).toBe("2");
    expect(s.pending).toEqual([]);
    expect(s.wal).toEqual([]);
    expect(r.event.message).toMatch(/journal.*deleted/i);
  });

  it("crash then recover restores the original values from the hot journal", () => {
    let s = must(write(must(setMode(createState(), "DELETE")), "counter", "2"));
    s = must(write(s, "fresh", "x"));
    s = must(crash(s));
    expect(s.main.counter).toBe("2");
    const r = recover(s);
    s = must(r);
    expect(s.main).toEqual({ counter: "1" });
    expect(s.pending).toEqual([]);
    expect(r.event.message).toMatch(/hot journal.*rolled back/i);
    expect(r.event.message).not.toMatch(/frame|commit marker/i);
  });

  it("blocking messages are flagged as simplified", () => {
    const withReader = must(openReader(must(setMode(createState(), "DELETE"))));
    expect(write(withReader, "counter", "2").event.message).toMatch(/\(simplified\)/);
    const open = must(write(must(setMode(createState(), "DELETE")), "counter", "2"));
    expect(openReader(open).event.message).toMatch(/\(simplified\)/);
  });

  it("checkpoint is not applicable in DELETE mode", () => {
    expect(checkpoint(must(setMode(createState(), "DELETE"))).event.ok).toBe(false);
  });

  it("a crash mid-transaction rolls back to the pre-transaction main file", () => {
    let s = must(write(must(setMode(createState(), "DELETE")), "counter", "2"));
    s = must(recover(must(crash(s))));
    expect(s.main.counter).toBe("1");
    expect(s.pending).toEqual([]);
  });

  it("switching back to WAL works when idle", () => {
    const s = must(setMode(must(setMode(createState(), "DELETE")), "WAL"));
    expect(s.mode).toBe("WAL");
  });
});

describe("wal-model: immutability", () => {
  it("operations never mutate the input state", () => {
    const s = createState();
    const snapshot = JSON.stringify(s);
    write(s, "counter", "2");
    openReader(s);
    checkpoint(s);
    crash(s);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe("wal-model: DELETE mode crash with no open write", () => {
  it("reports no journal and nothing to roll back", () => {
    const base = createState("DELETE");
    const crashed = crash(base);
    expect(crashed.event.message).toMatch(/no journal/);
    const recovered = recover(crashed.state);
    expect(recovered.event.message).toMatch(/nothing to roll back/);
    expect(recovered.state.main).toEqual(base.main);
  });
});
