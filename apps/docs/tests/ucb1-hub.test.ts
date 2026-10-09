import { describe, it, expect } from "vitest";
import { encodeFrame, FrameType } from "../src/models/ucb1-codec.js";
import { hubPublish, matchesFilters } from "../src/models/ucb1-hub.js";

describe("matchesFilters", () => {
  it("matches on the payload kind", () => {
    expect(matchesFilters(["cache.invalidate"], { kind: "cache.invalidate" })).toBe(true);
  });

  it("matches when any tag equals a filter", () => {
    expect(matchesFilters(["beta"], { tags: ["alpha", "beta"] })).toBe(true);
    expect(matchesFilters(["gamma"], { tags: ["alpha", "beta"] })).toBe(false);
  });

  it("does not deliver a payload with no kind, topic or tags to a non-empty filter", () => {
    expect(matchesFilters(["cache.invalidate"], { value: 1 })).toBe(false);
    expect(matchesFilters(["cache.invalidate"], "plain")).toBe(false);
    expect(matchesFilters(["cache.invalidate"], null)).toBe(false);
  });

  it("is an exact match, not a prefix match", () => {
    expect(matchesFilters(["cache.invalidate"], { topic: "cache.invalidate.all" })).toBe(false);
    expect(matchesFilters(["cache.invalidate"], { topic: "cache.invalidate" })).toBe(true);
  });

  it("hubPublish applies the kind/tags/none branches per process", () => {
    const bytes = encodeFrame(FrameType.PUBLISH, { value: 1 });
    const r = hubPublish(
      bytes,
      [
        { name: "B", filters: ["cache.invalidate"] },
        { name: "C", filters: [] },
      ],
      "A",
    );
    expect(r.delivered.map((d) => d.process)).toEqual(["C"]);
  });
});
