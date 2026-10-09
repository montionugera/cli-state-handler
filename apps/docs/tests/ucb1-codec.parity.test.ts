import { describe, it, expect } from "vitest";
import * as real from "../../../packages/core/src/ipc/frame-codec.js";
import * as model from "../src/models/ucb1-codec.js";

const bigPayload = { d: "x".repeat(model.MAX_PAYLOAD_SIZE - 8) }; // {"d":"..."} = 8 bytes overhead
const types = Object.entries(real.FrameType).filter(([k]) =>
  Number.isNaN(Number(k)),
);
const fixtures: [string, unknown][] = [
  ["empty payload", {}],
  ["ASCII", { topic: "cache.invalidate", key: "user:42" }],
  ["multi-byte UTF-8", { msg: "สวัสดี 🌏 héllo" }],
  ["maximum size", bigPayload],
];

describe("UCB1 model parity with real frame-codec", () => {
  it("max fixture is exactly the limit", () => {
    expect(new TextEncoder().encode(JSON.stringify(bigPayload)).length).toBe(
      model.MAX_PAYLOAD_SIZE,
    );
  });

  it("frame type table matches", () => {
    for (const [name, value] of types) {
      expect(model.FrameType[name as keyof typeof model.FrameType]).toBe(value);
    }
    expect(Object.keys(model.FrameType).length).toBe(types.length);
  });

  for (const [name, payload] of fixtures) {
    it(`identical bytes, starts with UCB1, round trips: ${name}`, () => {
      const a = real.encodeFrame(real.FrameType.PUBLISH, payload);
      const b = model.encodeFrame(model.FrameType.PUBLISH, payload);
      expect(Buffer.from(b).equals(a)).toBe(true);
      expect(new TextDecoder().decode(b.subarray(0, 4))).toBe("UCB1");
      expect(model.decodeFrame(b).payload).toEqual(payload);
      expect(new real.FrameDecoder().feed(Buffer.from(b))[0]?.payload).toEqual(
        payload,
      );
      expect(
        new model.FrameDecoder().feed(new Uint8Array(a))[0]?.payload,
      ).toEqual(payload);
    });
  }

  for (const [name, value] of types) {
    it(`identical bytes for frame type ${name}`, () => {
      const a = real.encodeFrame(value as real.FrameType, { n: 1 });
      const b = model.encodeFrame(value as number, { n: 1 });
      expect(Buffer.from(b).equals(a)).toBe(true);
      expect(model.decodeFrame(b).type).toBe(value);
    });
  }

  it("oversized payload is rejected on encode by both", () => {
    const big = { d: "x".repeat(model.MAX_PAYLOAD_SIZE) };
    expect(() => real.encodeFrame(real.FrameType.PUBLISH, big)).toThrow(
      real.FrameTooLargeError,
    );
    expect(() => model.encodeFrame(model.FrameType.PUBLISH, big)).toThrow(
      model.FrameTooLargeError,
    );
  });

  const good = real.encodeFrame(real.FrameType.PUBLISH, { a: 1 });
  const mutate = (fn: (b: Buffer) => void) => {
    const b = Buffer.from(good);
    fn(b);
    return b;
  };
  const badJson = Buffer.concat([good.subarray(0, 12), Buffer.from("{{")]);
  badJson.writeUInt32BE(2, 8);
  const errorName = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return e instanceof Error ? e.name : "non-error";
    }
    return "no-throw";
  };
  const malformed: [string, Buffer, string][] = [
    ["bad magic", mutate((b) => b.write("XXXX", 0)), "InvalidMagicError"],
    ["non-zero flags", mutate((b) => b.writeUInt8(1, 5)), "ReservedFlagsError"],
    [
      "non-zero reserved",
      mutate((b) => b.writeUInt16BE(1, 6)),
      "ReservedFlagsError",
    ],
    [
      "oversized length",
      mutate((b) => b.writeUInt32BE(model.MAX_PAYLOAD_SIZE + 1, 8)),
      "FrameTooLargeError",
    ],
    ["invalid JSON", badJson, "InvalidPayloadJsonError"],
  ];
  for (const [name, bytes, errName] of malformed) {
    it(`both reject ${name}`, () => {
      expect(errorName(() => new real.FrameDecoder().feed(bytes))).toBe(
        errName,
      );
      expect(
        errorName(() => new model.FrameDecoder().feed(new Uint8Array(bytes))),
      ).toBe(errName);
    });
  }

  it("truncated header: neither emits a frame; model one-shot reports truncation", () => {
    const cut = good.subarray(0, 7);
    expect(new real.FrameDecoder().feed(cut)).toEqual([]);
    expect(new model.FrameDecoder().feed(new Uint8Array(cut))).toEqual([]);
    expect(() => model.decodeFrame(new Uint8Array(cut))).toThrow(
      model.TruncatedFrameError,
    );
  });

  it("fragmented and concatenated chunks decode identically", () => {
    const two = Buffer.concat([good, good]);
    const d = new model.FrameDecoder();
    const out = [
      ...d.feed(new Uint8Array(two.subarray(0, 5))),
      ...d.feed(new Uint8Array(two.subarray(5, 20))),
      ...d.feed(new Uint8Array(two.subarray(20))),
    ];
    expect(out).toEqual(new real.FrameDecoder().feed(two));
  });

  it("leading byte-order mark in payload: both reject (no BOM stripping)", () => {
    const body = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("{}"),
    ]);
    const bytes = Buffer.concat([good.subarray(0, 12), body]);
    bytes.writeUInt32BE(body.length, 8);
    expect(errorName(() => new real.FrameDecoder().feed(bytes))).toBe(
      "InvalidPayloadJsonError",
    );
    expect(
      errorName(() => new model.FrameDecoder().feed(new Uint8Array(bytes))),
    ).toBe("InvalidPayloadJsonError");
  });

  it("truncated payload after a complete header: neither emits a frame, then both complete on more bytes", () => {
    const cut = good.subarray(0, good.length - 1);
    const r = new real.FrameDecoder();
    const m = new model.FrameDecoder();
    expect(r.feed(cut)).toEqual([]);
    expect(m.feed(new Uint8Array(cut))).toEqual([]);
    expect(r.feed(good.subarray(good.length - 1))).toEqual(
      m.feed(new Uint8Array(good.subarray(good.length - 1))),
    );
  });

  it("two frames concatenated in one chunk: both decoders emit both", () => {
    const other = real.encodeFrame(real.FrameType.PING, { n: 2 });
    const chunk = Buffer.concat([good, other]);
    const a = new real.FrameDecoder().feed(chunk);
    const b = new model.FrameDecoder().feed(new Uint8Array(chunk));
    expect(a.length).toBe(2);
    expect(b).toEqual(a);
  });
});
