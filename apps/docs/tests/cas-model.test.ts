// @vitest-environment node
import { describe, it, expect } from "vitest";
import { CasModel, sha256Hex } from "../src/models/cas-model.js";

const blob = (c: string, n = 40) => c.repeat(n);

describe("CasModel behaviour", () => {
  it("dedupes identical content: one blob, reported as deduped", async () => {
    const m = new CasModel({ maxBytes: 1000 });
    const first = await m.put("same");
    const second = await m.put("same");
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(m.entries()).toHaveLength(1);
    expect(m.totalBytes()).toBe(4);
  });

  it("evicts least recently used blobs when over budget", async () => {
    const m = new CasModel({ maxBytes: 100 });
    const a = await m.put(blob("a"));
    const b = await m.put(blob("b"));
    m.get(a.hash);
    const c = await m.put(blob("c"));
    expect(c.evicted).toEqual([b.hash, a.hash]);
    expect(m.entries().map((e) => e.hash)).toEqual([c.hash]);
  });

  it("get returns a copy of the data or null for a miss", async () => {
    const m = new CasModel({ maxBytes: 0 });
    const r = await m.put("hi");
    expect(new TextDecoder().decode(m.get(r.hash) ?? new Uint8Array())).toBe("hi");
    expect(m.get(await sha256Hex("nope"))).toBeNull();
  });

  it("does not prune when maxBytes is 0 (unbounded, same guard as the real store)", async () => {
    const m = new CasModel({ maxBytes: 0 });
    await m.put(blob("a", 500));
    expect(m.entries()).toHaveLength(1);
  });

  it("evicts a just-put blob that alone exceeds the budget, like the real store", async () => {
    const m = new CasModel({ maxBytes: 10 });
    const r = await m.put(blob("z", 50));
    expect(r.evicted).toEqual([r.hash]);
    expect(m.entries()).toHaveLength(0);
  });
});
