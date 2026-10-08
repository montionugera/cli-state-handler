import { describe, it, expect, beforeEach } from 'vitest';
import {
  FrameType,
  HEADER_SIZE,
  MAGIC,
  MAX_PAYLOAD_SIZE,
  InvalidMagicError,
  FrameTooLargeError,
  ReservedFlagsError,
  InvalidPayloadJsonError,
  encodeFrame,
  FrameDecoder,
  type Frame,
} from '../../src/ipc/frame-codec.js';

describe('UCB1 IPC Frame Codec & Decoder', () => {
  let decoder: FrameDecoder;

  beforeEach(() => {
    decoder = new FrameDecoder();
  });

  describe('Constants and Enums', () => {
    it('defines expected constants', () => {
      expect(HEADER_SIZE).toBe(12);
      expect(MAGIC).toBe('UCB1');
      expect(MAX_PAYLOAD_SIZE).toBe(1_048_576);
    });

    it('defines all 11 FrameType values', () => {
      expect(FrameType.HELLO).toBe(0x01);
      expect(FrameType.WELCOME).toBe(0x02);
      expect(FrameType.SUBSCRIBE).toBe(0x03);
      expect(FrameType.UNSUBSCRIBE).toBe(0x04);
      expect(FrameType.PUBLISH).toBe(0x05);
      expect(FrameType.EVENT).toBe(0x06);
      expect(FrameType.PING).toBe(0x08);
      expect(FrameType.PONG).toBe(0x09);
      expect(FrameType.RESYNC).toBe(0x0a);
      expect(FrameType.BYE).toBe(0x0b);
      expect(FrameType.ERROR).toBe(0x0f);
    });
  });

  describe('Round-trip encode and decode for all 11 frame types', () => {
    const testCases: Array<{ type: FrameType; payload: Record<string, unknown> }> = [
      { type: FrameType.HELLO, payload: { version: '1.0', clientId: 'test-client-1' } },
      { type: FrameType.WELCOME, payload: { sessionId: 'sess-abc-123', heartbeatMs: 5000 } },
      { type: FrameType.SUBSCRIBE, payload: { topic: 'cache:invalidation:users', filter: '*' } },
      { type: FrameType.UNSUBSCRIBE, payload: { topic: 'cache:invalidation:users' } },
      { type: FrameType.PUBLISH, payload: { channel: 'orders', data: { orderId: 42, amount: 199.99 } } },
      { type: FrameType.EVENT, payload: { eventName: 'user_updated', id: 'usr-9' } },
      { type: FrameType.PING, payload: { timestamp: 1712000000000 } },
      { type: FrameType.PONG, payload: { timestamp: 1712000000000 } },
      { type: FrameType.RESYNC, payload: { lastSeq: 1042 } },
      { type: FrameType.BYE, payload: { reason: 'client_shutdown' } },
      { type: FrameType.ERROR, payload: { code: 'ERR_TIMEOUT', message: 'Operation timed out' } },
    ];

    for (const { type, payload } of testCases) {
      it(`round-trips FrameType 0x${type.toString(16).padStart(2, '0')}`, () => {
        const encoded = encodeFrame(type, payload);
        expect(encoded.length).toBeGreaterThanOrEqual(HEADER_SIZE);
        expect(encoded.subarray(0, 4).toString('ascii')).toBe('UCB1');
        expect(encoded.readUInt8(4)).toBe(type);
        expect(encoded.readUInt8(5)).toBe(0);
        expect(encoded.readUInt16BE(6)).toBe(0);

        const decoded = decoder.feed(encoded);
        expect(decoded).toHaveLength(1);
        expect(decoded[0].type).toBe(type);
        expect(decoded[0].payload).toEqual(payload);
      });
    }

    it('encodes default empty payload when payload is omitted', () => {
      const encoded = encodeFrame(FrameType.PING);
      const decoded = decoder.feed(encoded);
      expect(decoded).toHaveLength(1);
      expect(decoded[0].type).toBe(FrameType.PING);
      expect(decoded[0].payload).toEqual({});
    });
  });

  describe('Chunk fragmentation & streaming reassembly', () => {
    it('handles byte-by-byte streaming', () => {
      const payload = { stream: 'byte-by-byte', count: 12345 };
      const encoded = encodeFrame(FrameType.EVENT, payload);

      const frames: Frame[] = [];
      for (let i = 0; i < encoded.length; i++) {
        const chunk = encoded.subarray(i, i + 1);
        const received = decoder.feed(chunk);
        frames.push(...received);
      }

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(FrameType.EVENT);
      expect(frames[0].payload).toEqual(payload);
    });

    it('handles splits across 1 byte, 2 bytes, 11 bytes, and halfway through payload', () => {
      const payload = { key: 'value', complex: [1, 2, 3, { nested: true }] };
      const encoded = encodeFrame(FrameType.PUBLISH, payload);
      const halfwayPayloadIndex = 12 + Math.floor((encoded.length - 12) / 2);

      const splitPositions = [1, 2, 11, halfwayPayloadIndex];

      for (const split of splitPositions) {
        decoder.reset();
        const part1 = encoded.subarray(0, split);
        const part2 = encoded.subarray(split);

        const out1 = decoder.feed(part1);
        expect(out1).toHaveLength(0);

        const out2 = decoder.feed(part2);
        expect(out2).toHaveLength(1);
        expect(out2[0].type).toBe(FrameType.PUBLISH);
        expect(out2[0].payload).toEqual(payload);
      }
    });

    it('handles arbitrary chunk sizes with reset', () => {
      const encoded = encodeFrame(FrameType.PING, { seq: 1 });
      decoder.feed(encoded.subarray(0, 5));
      decoder.reset();

      const decoded = decoder.feed(encoded);
      expect(decoded).toHaveLength(1);
      expect(decoded[0].payload).toEqual({ seq: 1 });
    });
  });

  describe('Concatenation of multiple frames', () => {
    it('decodes 3 frames in a single buffer in order', () => {
      const f1 = encodeFrame(FrameType.HELLO, { id: 1 });
      const f2 = encodeFrame(FrameType.SUBSCRIBE, { id: 2 });
      const f3 = encodeFrame(FrameType.EVENT, { id: 3 });

      const concatenated = Buffer.concat([f1, f2, f3]);
      const decoded = decoder.feed(concatenated);

      expect(decoded).toHaveLength(3);
      expect(decoded[0]).toEqual({ type: FrameType.HELLO, payload: { id: 1 } });
      expect(decoded[1]).toEqual({ type: FrameType.SUBSCRIBE, payload: { id: 2 } });
      expect(decoded[2]).toEqual({ type: FrameType.EVENT, payload: { id: 3 } });
    });

    it('decodes concatenated frames split across arbitrary boundaries', () => {
      const f1 = encodeFrame(FrameType.PING, { n: 1 });
      const f2 = encodeFrame(FrameType.PONG, { n: 2 });
      const concatenated = Buffer.concat([f1, f2]);

      // Split right inside f2's header
      const splitPoint = f1.length + 6;
      const part1 = concatenated.subarray(0, splitPoint);
      const part2 = concatenated.subarray(splitPoint);

      const out1 = decoder.feed(part1);
      expect(out1).toHaveLength(1);
      expect(out1[0]).toEqual({ type: FrameType.PING, payload: { n: 1 } });

      const out2 = decoder.feed(part2);
      expect(out2).toHaveLength(1);
      expect(out2[0]).toEqual({ type: FrameType.PONG, payload: { n: 2 } });
    });
  });

  describe('Error handling', () => {
    it('throws InvalidMagicError on bad magic bytes', () => {
      const encoded = encodeFrame(FrameType.PING, {});
      encoded.write('BAD!', 0, 4, 'ascii');

      expect(() => decoder.feed(encoded)).toThrow(InvalidMagicError);
    });

    it('throws ReservedFlagsError on non-zero flags byte', () => {
      const encoded = encodeFrame(FrameType.PING, {});
      encoded.writeUInt8(0x01, 5); // non-zero flags

      expect(() => decoder.feed(encoded)).toThrow(ReservedFlagsError);
    });

    it('throws ReservedFlagsError on non-zero reserved bytes', () => {
      const encoded = encodeFrame(FrameType.PING, {});
      encoded.writeUInt16BE(0x0001, 6); // non-zero reserved

      expect(() => decoder.feed(encoded)).toThrow(ReservedFlagsError);
    });

    it('throws FrameTooLargeError on payload > 1MB in encodeFrame', () => {
      const hugeString = 'x'.repeat(MAX_PAYLOAD_SIZE + 10);
      expect(() => encodeFrame(FrameType.EVENT, { huge: hugeString })).toThrow(FrameTooLargeError);
    });

    it('throws FrameTooLargeError on header payloadLength > 1MB in FrameDecoder', () => {
      const header = Buffer.alloc(12);
      header.write('UCB1', 0, 4, 'ascii');
      header.writeUInt8(FrameType.PING, 4);
      header.writeUInt8(0, 5);
      header.writeUInt16BE(0, 6);
      header.writeUInt32BE(MAX_PAYLOAD_SIZE + 1, 8);

      expect(() => decoder.feed(header)).toThrow(FrameTooLargeError);
    });

    it('throws InvalidPayloadJsonError on malformed JSON payload', () => {
      const header = Buffer.alloc(12);
      header.write('UCB1', 0, 4, 'ascii');
      header.writeUInt8(FrameType.PING, 4);
      header.writeUInt8(0, 5);
      header.writeUInt16BE(0, 6);

      const badJson = Buffer.from('{not-valid-json', 'utf-8');
      header.writeUInt32BE(badJson.length, 8);

      const frame = Buffer.concat([header, badJson]);
      expect(() => decoder.feed(frame)).toThrow(InvalidPayloadJsonError);
    });
  });
});
