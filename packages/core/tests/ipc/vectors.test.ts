import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encodeFrame,
  FrameDecoder,
  HEADER_SIZE,
  type FrameType,
} from '../../src/ipc/frame-codec.js';

interface ConformanceVector {
  name: string;
  type: FrameType;
  payload: Record<string, unknown>;
  hex: string;
}

const currentDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

const vectorsPath = existsSync(resolve(currentDir, '../../../../contracts/ipc/vectors.json'))
  ? resolve(currentDir, '../../../../contracts/ipc/vectors.json')
  : resolve(process.cwd(), 'contracts/ipc/vectors.json');

const vectors: ConformanceVector[] = JSON.parse(readFileSync(vectorsPath, 'utf-8'));

describe('UCB1 Conformance Vectors', () => {
  it('loads valid conformance vectors fixture', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
    const names = vectors.map((v) => v.name);
    expect(names).toContain('hello');
    expect(names).toContain('welcome');
    expect(names).toContain('subscribe');
    expect(names).toContain('publish');
    expect(names).toContain('event');
    expect(names).toContain('ping');
    expect(names).toContain('pong');
    expect(names).toContain('resync');
    expect(names).toContain('bye');
    expect(names).toContain('error');
  });

  describe.each(vectors)('vector: $name (type: $type)', (vector) => {
    it('decodes golden hex to expected type and deep-equal payload', () => {
      const buffer = Buffer.from(vector.hex, 'hex');
      const decoder = new FrameDecoder();
      const frames = decoder.feed(buffer);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(vector.type);
      expect(frames[0].payload).toEqual(vector.payload);
    });

    it('encodes { type, payload } matching 12-byte header and round-trips correctly', () => {
      const encoded = encodeFrame(vector.type, vector.payload);

      // Verify exact 12-byte header matching vector hex (24 hex characters)
      const expectedHeaderHex = vector.hex.slice(0, HEADER_SIZE * 2);
      const actualHeaderHex = encoded.subarray(0, HEADER_SIZE).toString('hex');
      expect(actualHeaderHex).toBe(expectedHeaderHex);

      // Verify decoding the encoded buffer produces identical payload and type
      const decoder = new FrameDecoder();
      const frames = decoder.feed(encoded);
      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(vector.type);
      expect(frames[0].payload).toEqual(vector.payload);

      // Verify exact wire hex matches golden serialization
      expect(encoded.toString('hex')).toBe(vector.hex);
    });

    it('decodes golden hex across byte-by-byte streaming chunks', () => {
      const buffer = Buffer.from(vector.hex, 'hex');
      const decoder = new FrameDecoder();
      const frames = [];

      for (let i = 0; i < buffer.length; i++) {
        const chunk = buffer.subarray(i, i + 1);
        frames.push(...decoder.feed(chunk));
      }

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe(vector.type);
      expect(frames[0].payload).toEqual(vector.payload);
    });
  });
});
