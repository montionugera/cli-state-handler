/**
 * Browser model of the UCB1 frame codec (packages/core/src/ipc/frame-codec.ts).
 * Uses Uint8Array + DataView + TextEncoder/TextDecoder instead of Node Buffer.
 * Header layout, frame types, limits and error cases mirror the real codec;
 * tests/ucb1-codec.parity.test.ts proves byte parity.
 */

export const FrameType = {
  HELLO: 0x01,
  WELCOME: 0x02,
  SUBSCRIBE: 0x03,
  UNSUBSCRIBE: 0x04,
  PUBLISH: 0x05,
  EVENT: 0x06,
  PING: 0x08,
  PONG: 0x09,
  RESYNC: 0x0a,
  BYE: 0x0b,
  ERROR: 0x0f,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const HEADER_SIZE = 12;
export const MAGIC = "UCB1";
export const MAX_PAYLOAD_SIZE = 1_048_576;
const MAGIC_BYTES = [0x55, 0x43, 0x42, 0x31] as const;

export class InvalidMagicError extends Error {
  constructor(message = "Invalid UCB1 magic header") {
    super(message);
    this.name = "InvalidMagicError";
  }
}
export class FrameTooLargeError extends Error {
  constructor(message = "Frame payload exceeds maximum size of 1MB") {
    super(message);
    this.name = "FrameTooLargeError";
  }
}
export class ReservedFlagsError extends Error {
  constructor(message = "Non-zero flags or reserved bits encountered") {
    super(message);
    this.name = "ReservedFlagsError";
  }
}
export class InvalidPayloadJsonError extends Error {
  constructor(message = "Failed to parse frame payload as JSON") {
    super(message);
    this.name = "InvalidPayloadJsonError";
  }
}
/** Model-only: a one-shot decode of bytes that do not hold a complete frame. */
export class TruncatedFrameError extends Error {
  constructor(message = "Truncated UCB1 frame") {
    super(message);
    this.name = "TruncatedFrameError";
  }
}

export interface Frame {
  type: number;
  payload: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true }); // real Buffer.toString keeps a leading BOM

export function encodeFrame(type: number, payload: unknown = {}): Uint8Array {
  const body = encoder.encode(JSON.stringify(payload ?? {}));
  if (body.length > MAX_PAYLOAD_SIZE) {
    throw new FrameTooLargeError(
      `Payload length ${body.length} exceeds maximum allowed size of ${MAX_PAYLOAD_SIZE} bytes`,
    );
  }
  const out = new Uint8Array(HEADER_SIZE + body.length);
  const view = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  view.setUint8(4, type);
  view.setUint8(5, 0);
  view.setUint16(6, 0, false);
  view.setUint32(8, body.length, false);
  out.set(body, HEADER_SIZE);
  return out;
}

/** Streaming decoder; same semantics as the real FrameDecoder. */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  feed(chunk: Uint8Array): Frame[] {
    if (chunk.length === 0) return [];
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
    const frames: Frame[] = [];
    while (this.buffer.length >= HEADER_SIZE) {
      const buf = this.buffer;
      for (let i = 0; i < 4; i++) {
        if (buf[i] !== MAGIC_BYTES[i]) throw new InvalidMagicError("Invalid magic bytes");
      }
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const type = view.getUint8(4);
      const flags = view.getUint8(5);
      if (flags !== 0) throw new ReservedFlagsError(`Non-zero flags: ${flags}`);
      const reserved = view.getUint16(6, false);
      if (reserved !== 0) throw new ReservedFlagsError(`Non-zero reserved bits: ${reserved}`);
      const length = view.getUint32(8, false);
      if (length > MAX_PAYLOAD_SIZE) {
        throw new FrameTooLargeError(
          `Payload length ${length} exceeds maximum allowed size of ${MAX_PAYLOAD_SIZE} bytes`,
        );
      }
      if (buf.length < HEADER_SIZE + length) break;
      let payload: unknown;
      try {
        payload = JSON.parse(decoder.decode(buf.subarray(HEADER_SIZE, HEADER_SIZE + length)));
      } catch {
        throw new InvalidPayloadJsonError("Failed to parse frame payload as JSON");
      }
      this.buffer = buf.subarray(HEADER_SIZE + length);
      frames.push({ type, payload });
    }
    return frames;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }
}

/** Decode exactly one complete frame; throws TruncatedFrameError if incomplete. */
export function decodeFrame(bytes: Uint8Array): Frame {
  const frames = new FrameDecoder().feed(bytes);
  const first = frames[0];
  if (first === undefined) throw new TruncatedFrameError();
  return first;
}

export interface HeaderField {
  name: string;
  offset: number;
  length: number;
  bytes: number[];
  value: string;
}

/** Label each header byte range. Returns [] when fewer than 12 bytes. */
export function describeHeader(bytes: Uint8Array): HeaderField[] {
  if (bytes.length < HEADER_SIZE) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slice = (o: number, l: number) => Array.from(bytes.subarray(o, o + l));
  return [
    { name: "Magic", offset: 0, length: 4, bytes: slice(0, 4), value: decoder.decode(bytes.subarray(0, 4)) },
    { name: "Type", offset: 4, length: 1, bytes: slice(4, 1), value: String(view.getUint8(4)) },
    { name: "Flags", offset: 5, length: 1, bytes: slice(5, 1), value: String(view.getUint8(5)) },
    { name: "Reserved", offset: 6, length: 2, bytes: slice(6, 2), value: String(view.getUint16(6, false)) },
    { name: "Length", offset: 8, length: 4, bytes: slice(8, 4), value: String(view.getUint32(8, false)) },
  ];
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}
