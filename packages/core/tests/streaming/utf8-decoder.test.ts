import { describe, it, expect, beforeEach } from 'vitest';
import { Utf8StreamDecoder } from '../../src/index.js';

describe('Utf8StreamDecoder', () => {
  let decoder: Utf8StreamDecoder;

  beforeEach(() => {
    decoder = new Utf8StreamDecoder();
  });

  it('decodes regular ASCII chunks without buffering', () => {
    expect(decoder.decode(Buffer.from('hello '))).toBe('hello ');
    expect(decoder.decode(Buffer.from('world'))).toBe('world');
    expect(decoder.flush()).toBe('');
  });

  it('handles empty chunks and empty flush', () => {
    expect(decoder.decode(Buffer.from(''))).toBe('');
    expect(decoder.decode(new Uint8Array([]))).toBe('');
    expect(decoder.flush()).toBe('');
  });

  describe('4-byte emoji splitting (🚀 [0xF0, 0x9F, 0x9A, 0x80])', () => {
    const rocketBytes = [0xf0, 0x9f, 0x9a, 0x80];

    it('splits across 4 chunks (1 byte per chunk) with zero replacement characters', () => {
      // Chunk 1: [0xF0] -> incomplete 4-byte start
      const chunk1 = decoder.decode(Buffer.from([rocketBytes[0]]));
      expect(chunk1).toBe('');
      expect(chunk1).not.toContain('\uFFFD');

      // Chunk 2: [0x9F] -> incomplete 2 bytes
      const chunk2 = decoder.decode(Buffer.from([rocketBytes[1]]));
      expect(chunk2).toBe('');
      expect(chunk2).not.toContain('\uFFFD');

      // Chunk 3: [0x9A] -> incomplete 3 bytes
      const chunk3 = decoder.decode(Buffer.from([rocketBytes[2]]));
      expect(chunk3).toBe('');
      expect(chunk3).not.toContain('\uFFFD');

      // Chunk 4: [0x80] -> complete 4 bytes!
      const chunk4 = decoder.decode(Buffer.from([rocketBytes[3]]));
      expect(chunk4).toBe('🚀');
      expect(chunk4).not.toContain('\uFFFD');

      expect(decoder.flush()).toBe('');
    });

    it('splits across 2 chunks (2 bytes per chunk)', () => {
      const chunk1 = decoder.decode(Buffer.from(rocketBytes.slice(0, 2)));
      expect(chunk1).toBe('');
      expect(chunk1).not.toContain('\uFFFD');

      const chunk2 = decoder.decode(Buffer.from(rocketBytes.slice(2, 4)));
      expect(chunk2).toBe('🚀');
      expect(chunk2).not.toContain('\uFFFD');

      expect(decoder.flush()).toBe('');
    });

    it('splits across 2 chunks (3 bytes then 1 byte)', () => {
      const chunk1 = decoder.decode(Buffer.from(rocketBytes.slice(0, 3)));
      expect(chunk1).toBe('');
      expect(chunk1).not.toContain('\uFFFD');

      const chunk2 = decoder.decode(Buffer.from(rocketBytes.slice(3, 4)));
      expect(chunk2).toBe('🚀');
      expect(chunk2).not.toContain('\uFFFD');

      expect(decoder.flush()).toBe('');
    });
  });

  describe('3-byte multilingual characters (你好 -> 6 bytes)', () => {
    // 你: [0xE4, 0xBD, 0xA0]
    // 好: [0xE5, 0xA5, 0xBD]
    const niHaoBytes = [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd];

    it('splits at byte 1 (1 byte then 5 bytes)', () => {
      const chunk1 = decoder.decode(Buffer.from(niHaoBytes.slice(0, 1)));
      expect(chunk1).toBe('');
      expect(chunk1).not.toContain('\uFFFD');

      const chunk2 = decoder.decode(Buffer.from(niHaoBytes.slice(1)));
      expect(chunk2).toBe('你好');
      expect(chunk2).not.toContain('\uFFFD');
      expect(decoder.flush()).toBe('');
    });

    it('splits at byte 2 (2 bytes then 4 bytes)', () => {
      const chunk1 = decoder.decode(Buffer.from(niHaoBytes.slice(0, 2)));
      expect(chunk1).toBe('');
      expect(chunk1).not.toContain('\uFFFD');

      const chunk2 = decoder.decode(Buffer.from(niHaoBytes.slice(2)));
      expect(chunk2).toBe('你好');
      expect(chunk2).not.toContain('\uFFFD');
      expect(decoder.flush()).toBe('');
    });

    it('splits at byte 4 (4 bytes [complete "你" + incomplete "好"] then 2 bytes)', () => {
      const chunk1 = decoder.decode(Buffer.from(niHaoBytes.slice(0, 4)));
      expect(chunk1).toBe('你');
      expect(chunk1).not.toContain('\uFFFD');

      const chunk2 = decoder.decode(Buffer.from(niHaoBytes.slice(4)));
      expect(chunk2).toBe('好');
      expect(chunk2).not.toContain('\uFFFD');
      expect(decoder.flush()).toBe('');
    });

    it('splits at byte 5 (5 bytes [complete "你" + 2 bytes of "好"] then 1 byte)', () => {
      const chunk1 = decoder.decode(Buffer.from(niHaoBytes.slice(0, 5)));
      expect(chunk1).toBe('你');
      expect(chunk1).not.toContain('\uFFFD');

      const chunk2 = decoder.decode(Buffer.from(niHaoBytes.slice(5)));
      expect(chunk2).toBe('好');
      expect(chunk2).not.toContain('\uFFFD');
      expect(decoder.flush()).toBe('');
    });
  });

  describe('2-byte character splitting (é [0xC3, 0xA9])', () => {
    it('buffers 1st byte and completes on 2nd byte', () => {
      const chunk1 = decoder.decode(Buffer.from([0xc3]));
      expect(chunk1).toBe('');
      const chunk2 = decoder.decode(Buffer.from([0xa9]));
      expect(chunk2).toBe('é');
      expect(decoder.flush()).toBe('');
    });
  });

  describe('flush()', () => {
    it('flushes incomplete trailing bytes when stream terminates unexpectedly', () => {
      decoder.decode(Buffer.from('hello '));
      decoder.decode(Buffer.from([0xe4, 0xbd])); // first 2 bytes of 3-byte char
      const flushed = decoder.flush();
      expect(flushed.length).toBeGreaterThan(0);
      // After flush, leftover buffer is empty
      expect(decoder.flush()).toBe('');
    });

    it('returns empty string when no bytes are buffered', () => {
      expect(decoder.flush()).toBe('');
      expect(decoder.flush()).toBe('');
    });
  });

  describe('Uint8Array support', () => {
    it('accepts Uint8Array chunk input directly', () => {
      const arr1 = new Uint8Array([0xf0, 0x9f]);
      const arr2 = new Uint8Array([0x9a, 0x80]);
      expect(decoder.decode(arr1)).toBe('');
      expect(decoder.decode(arr2)).toBe('🚀');
    });
  });

  describe('stray and edge-case byte sequences', () => {
    it('handles stray continuation bytes without hanging', () => {
      // 0x80 alone is a continuation byte without start byte
      const result = decoder.decode(Buffer.from([0x80]));
      expect(result).toBe('\uFFFD');
      expect(decoder.flush()).toBe('');
    });
  });
});

