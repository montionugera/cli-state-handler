/**
 * UCB1 Wire Protocol IPC Frame Codec & Streaming Decoder.
 *
 * Wire format (12-byte header + variable payload):
 * 0..3:   Magic bytes "UCB1" (0x55, 0x43, 0x42, 0x31)
 * 4:      Frame type (uint8)
 * 5:      Flags (uint8, must be 0)
 * 6..7:   Reserved (uint16BE, must be 0)
 * 8..11:  Payload length in bytes (uint32BE, max 1MB)
 * 12..:   UTF-8 JSON-encoded payload
 */

export enum FrameType {
  HELLO = 0x01,
  WELCOME = 0x02,
  SUBSCRIBE = 0x03,
  UNSUBSCRIBE = 0x04,
  PUBLISH = 0x05,
  EVENT = 0x06,
  PING = 0x08,
  PONG = 0x09,
  RESYNC = 0x0a,
  BYE = 0x0b,
  ERROR = 0x0f,
}

export const HEADER_SIZE = 12;
export const MAGIC = 'UCB1';
export const MAX_PAYLOAD_SIZE = 1_048_576; // 1MB

const MAGIC_BYTES = [0x55, 0x43, 0x42, 0x31] as const;

export class InvalidMagicError extends Error {
  constructor(message = 'Invalid UCB1 magic header') {
    super(message);
    this.name = 'InvalidMagicError';
  }
}

export class FrameTooLargeError extends Error {
  constructor(message = 'Frame payload exceeds maximum size of 1MB') {
    super(message);
    this.name = 'FrameTooLargeError';
  }
}

export class ReservedFlagsError extends Error {
  constructor(message = 'Non-zero flags or reserved bits encountered') {
    super(message);
    this.name = 'ReservedFlagsError';
  }
}

export class InvalidPayloadJsonError extends Error {
  constructor(message = 'Failed to parse frame payload as JSON', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidPayloadJsonError';
  }
}

export interface Frame<T = Record<string, unknown>> {
  type: FrameType;
  payload: T;
}

/**
 * Encodes a frame with the fixed 12-byte UCB1 header and UTF-8 JSON payload.
 */
export function encodeFrame(type: FrameType, payload: unknown = {}): Buffer {
  const serialized = JSON.stringify(payload ?? {});
  const payloadBuf = Buffer.from(serialized, 'utf-8');

  if (payloadBuf.length > MAX_PAYLOAD_SIZE) {
    throw new FrameTooLargeError(
      `Payload length ${payloadBuf.length} exceeds maximum allowed size of ${MAX_PAYLOAD_SIZE} bytes`,
    );
  }

  const frameBuf = Buffer.alloc(HEADER_SIZE + payloadBuf.length);

  // Magic bytes "UCB1"
  frameBuf[0] = MAGIC_BYTES[0];
  frameBuf[1] = MAGIC_BYTES[1];
  frameBuf[2] = MAGIC_BYTES[2];
  frameBuf[3] = MAGIC_BYTES[3];

  // Type (byte 4)
  frameBuf.writeUInt8(type, 4);

  // Flags (byte 5 = 0)
  frameBuf.writeUInt8(0, 5);

  // Reserved (bytes 6..7 = 0)
  frameBuf.writeUInt16BE(0, 6);

  // Payload length (bytes 8..11, uint32BE)
  frameBuf.writeUInt32BE(payloadBuf.length, 8);

  // Payload body
  payloadBuf.copy(frameBuf, HEADER_SIZE);

  return frameBuf;
}

/**
 * Streaming decoder for UCB1 frames supporting arbitrary chunk fragmentation
 * across headers and payloads, and frame concatenation.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  /**
   * Feeds an incoming raw chunk into the internal accumulator and
   * extracts any complete frames.
   */
  public feed(chunk: Buffer): Frame[] {
    if (chunk.length === 0) {
      return [];
    }

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      // Validate magic bytes (0..3 === 'UCB1')
      if (
        this.buffer[0] !== MAGIC_BYTES[0] ||
        this.buffer[1] !== MAGIC_BYTES[1] ||
        this.buffer[2] !== MAGIC_BYTES[2] ||
        this.buffer[3] !== MAGIC_BYTES[3]
      ) {
        throw new InvalidMagicError('Invalid magic bytes');
      }

      // Read type (byte 4)
      const type = this.buffer.readUInt8(4) as FrameType;

      // Read flags (byte 5; must be 0)
      const flags = this.buffer.readUInt8(5);
      if (flags !== 0) {
        throw new ReservedFlagsError(`Non-zero flags: ${flags}`);
      }

      // Read reserved (bytes 6..7; must be 0)
      const reserved = this.buffer.readUInt16BE(6);
      if (reserved !== 0) {
        throw new ReservedFlagsError(`Non-zero reserved bits: ${reserved}`);
      }

      // Read payloadLength (bytes 8..11, uint32BE)
      const payloadLength = this.buffer.readUInt32BE(8);
      if (payloadLength > MAX_PAYLOAD_SIZE) {
        throw new FrameTooLargeError(
          `Payload length ${payloadLength} exceeds maximum allowed size of ${MAX_PAYLOAD_SIZE} bytes`,
        );
      }

      // Check if complete frame is available
      if (this.buffer.length < HEADER_SIZE + payloadLength) {
        break;
      }

      // Slice payload bytes
      const payloadBytes = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength);
      let payload: unknown;
      try {
        const payloadStr = payloadBytes.toString('utf-8');
        payload = JSON.parse(payloadStr);
      } catch (err) {
        throw new InvalidPayloadJsonError('Failed to parse frame payload as JSON', { cause: err });
      }

      // Advance internal buffer
      if (this.buffer.length === HEADER_SIZE + payloadLength) {
        this.buffer = Buffer.alloc(0);
      } else {
        this.buffer = this.buffer.subarray(HEADER_SIZE + payloadLength);
      }

      frames.push({ type, payload: payload as Record<string, unknown> });
    }

    return frames;
  }

  /**
   * Resets the internal accumulator buffer.
   */
  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
