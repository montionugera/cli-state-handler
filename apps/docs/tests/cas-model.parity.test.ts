// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { CasStore } from "../../../packages/core/src/storage/cas-store.js";
import { SqliteAdapter } from "../../../packages/core/src/storage/sqlite-adapter.js";
import { getLruCasObjects } from "../../../packages/core/src/storage/cas-lru.js";
import { CasModel, keyOf, sha256Hex } from "../src/models/cas-model.js";

const fixtures: Array<[string, Uint8Array]> = [
  ["empty", new Uint8Array(0)],
  ["ascii", new TextEncoder().encode("hello world")],
  ["utf8 multibyte", new TextEncoder().encode("UCSA — สวัสดี \u{1f4be}")],
  ["binary", Uint8Array.from({ length: 256 }, (_, i) => i)],
];

describe("CasModel parity with the real CasStore", () => {
  let dir: string;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-parity-"));
    adapter = new SqliteAdapter(":memory:");
  });

  afterEach(() => {
    vi.useRealTimers();
    adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(fixtures)("hash and key match for %s", async (_name, bytes) => {
    const real = new CasStore({ baseDir: dir });
    const result = await real.put(bytes);
    const modelHash = await sha256Hex(bytes);
    expect(modelHash).toBe(result.hash);
    expect(modelHash).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    // Real path is <baseDir>/objects/<prefix>/<hash>; the model key is that relative to baseDir.
    expect(path.join(dir, keyOf(modelHash))).toBe(result.path);
    const model = new CasModel({ maxBytes: 0 });
    const put = await model.put(bytes);
    expect(put.hash).toBe(result.hash);
    expect(put.key).toBe(path.relative(dir, result.path).split(path.sep).join("/"));
    expect(put.size).toBe(result.size);
  });

  async function drive(
    steps: Array<{ op: "put" | "get"; text: string }>,
    maxBytes: number,
    startMs: number,
    stepMs: number,
  ): Promise<{ real: string[]; model: string[] }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = startMs;
    vi.setSystemTime(clock);
    const real = new CasStore({ baseDir: dir, sqliteAdapter: adapter, maxSizeBytes: maxBytes });
    const model = new CasModel({ maxBytes, now: () => Date.now() });
    for (const step of steps) {
      vi.setSystemTime(clock);
      const bytes = new TextEncoder().encode(step.text);
      if (step.op === "put") {
        await real.put(bytes);
        await model.put(bytes);
      } else {
        await real.get(await sha256Hex(bytes));
        model.get(await sha256Hex(bytes));
      }
      clock += stepMs;
    }
    return {
      real: getLruCasObjects(adapter.db).map((r) => r.hash),
      model: model.entries().map((e) => e.hash),
    };
  }

  const blob = (c: string) => c.repeat(40);

  it("eviction order matches for a scripted access sequence", async () => {
    const { real, model } = await drive(
      [
        { op: "put", text: blob("a") },
        { op: "put", text: blob("b") },
        { op: "get", text: blob("a") }, // a becomes most recent; b is now LRU
        { op: "put", text: blob("c") }, // 120 > 100 -> prune to 70: evicts b then a
      ],
      100,
      1_000,
      10,
    );
    expect(real).toEqual([await sha256Hex(blob("c"))]);
    expect(model).toEqual(real);
  });

  it("matches across a longer sequence with a re-put (dedupe) refreshing access", async () => {
    const { real, model } = await drive(
      [
        { op: "put", text: blob("a") },
        { op: "put", text: blob("b") },
        { op: "put", text: blob("a") }, // dedupe refresh: b is LRU
        { op: "put", text: "c".repeat(10) },
        { op: "put", text: "d".repeat(30) }, // 120 > 100 -> target 70
      ],
      100,
      5_000,
      7,
    );
    expect(model).toEqual(real);
    expect(real).not.toContain(await sha256Hex(blob("b")));
  });

  it("breaks timestamp ties by insertion order, like the real ORDER BY rowid", async () => {
    const { real, model } = await drive(
      [
        { op: "put", text: blob("a") },
        { op: "put", text: blob("b") },
        { op: "put", text: blob("c") }, // all share one millisecond; a then b are evicted
      ],
      100,
      9_000,
      0,
    );
    expect(real).toEqual([await sha256Hex(blob("c"))]);
    expect(model).toEqual(real);
  });
});
