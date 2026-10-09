/**
 * UTF-8 Stream Decoder with multi-byte boundary protection.
 * Buffers incomplete trailing multi-byte code points (2, 3, 4-byte sequences)
 * so that no replacement characters (\uFFFD) are emitted across chunk boundaries.
 */
export class Utf8StreamDecoder {
  private leftover: Buffer | null = null;

  /**
   * Decodes a chunk of bytes, holding back any trailing incomplete UTF-8 sequence.
   */
  decode(chunk: Buffer | Uint8Array): string {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    if (buf.length === 0) {
      return '';
    }

    const combined = this.leftover && this.leftover.length > 0
      ? Buffer.concat([this.leftover, buf])
      : buf;

    const incompleteBytes = this.getIncompleteTrailingBytes(combined);

    if (incompleteBytes > 0) {
      const completeEnd = combined.length - incompleteBytes;
      this.leftover = Buffer.from(combined.subarray(completeEnd));
      if (completeEnd === 0) {
        return '';
      }
      return combined.subarray(0, completeEnd).toString('utf8');
    }

    this.leftover = null;
    return combined.toString('utf8');
  }

  /**
   * Flushes any remaining bytes in the leftover buffer as UTF-8 and clears it.
   */
  flush(): string {
    if (!this.leftover || this.leftover.length === 0) {
      this.leftover = null;
      return '';
    }
    const result = this.leftover.toString('utf8');
    this.leftover = null;
    return result;
  }

  /**
   * Determines the number of trailing incomplete bytes in a UTF-8 buffer.
   * Looks at the last 1 to 4 bytes:
   *  - 1-byte char: 0xxxxxxx (0x00 - 0x7F) -> complete.
   *  - 2-byte sequence start: 110xxxxx (0xC0 - 0xDF) -> needs 2 bytes.
   *  - 3-byte sequence start: 1110xxxx (0xE0 - 0xEF) -> needs 3 bytes.
   *  - 4-byte sequence start: 11110xxx (0xF0 - 0xF7) -> needs 4 bytes.
   */
  private getIncompleteTrailingBytes(buf: Buffer): number {
    const len = buf.length;
    if (len === 0) return 0;

    const b1 = buf[len - 1]!;

    // 1-byte ASCII (0x00 - 0x7F) -> complete
    if ((b1 & 0x80) === 0x00) {
      return 0;
    }

    // Single trailing byte that is a sequence start
    if ((b1 & 0xe0) === 0xc0) {
      // 2-byte sequence start: needs 2 bytes, only 1 present
      return 1;
    }
    if ((b1 & 0xf0) === 0xe0) {
      // 3-byte sequence start: needs 3 bytes, only 1 present
      return 1;
    }
    if ((b1 & 0xf8) === 0xf0) {
      // 4-byte sequence start: needs 4 bytes, only 1 present
      return 1;
    }

    // b1 is a continuation byte (0x80 - 0xBF)
    if (len >= 2) {
      const b2 = buf[len - 2]!;
      if ((b2 & 0xe0) === 0xc0) {
        // 2-byte start at len - 2: needs 2 bytes, 2 present -> complete
        return 0;
      }
      if ((b2 & 0xf0) === 0xe0) {
        // 3-byte start at len - 2: needs 3 bytes, only 2 present
        return 2;
      }
      if ((b2 & 0xf8) === 0xf0) {
        // 4-byte start at len - 2: needs 4 bytes, only 2 present
        return 2;
      }

      // b2 is also a continuation byte
      if (len >= 3) {
        const b3 = buf[len - 3]!;
        if ((b3 & 0xf0) === 0xe0) {
          // 3-byte start at len - 3: needs 3 bytes, 3 present -> complete
          return 0;
        }
        if ((b3 & 0xf8) === 0xf0) {
          // 4-byte start at len - 3: needs 4 bytes, only 3 present
          return 3;
        }
      }
    }

    return 0;
  }
}
