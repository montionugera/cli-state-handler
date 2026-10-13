using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;

namespace Ucsa.Ipc
{
    /// <summary>
    /// Wire protocol frame types for UCB1 IPC communication.
    /// </summary>
    public enum FrameType : byte
    {
        Hello = 0x01,
        Welcome = 0x02,
        Subscribe = 0x03,
        Unsubscribe = 0x04,
        Publish = 0x05,
        Event = 0x06,
        Ping = 0x08,
        Pong = 0x09,
        Resync = 0x0a,
        Bye = 0x0b,
        Error = 0x0f
    }

    /// <summary>
    /// Thrown when frame magic bytes do not match 'UCB1'.
    /// </summary>
    public class InvalidMagicException : Exception
    {
        public InvalidMagicException(string message = "Invalid UCB1 magic header") : base(message) { }
    }

    /// <summary>
    /// Thrown when frame payload length exceeds 1MB (1,048,576 bytes).
    /// </summary>
    public class FrameTooLargeException : Exception
    {
        public FrameTooLargeException(string message = "Frame payload exceeds maximum size of 1MB") : base(message) { }
    }

    /// <summary>
    /// Thrown when non-zero flags or reserved bits are encountered in the header.
    /// </summary>
    public class ReservedFlagsException : Exception
    {
        public ReservedFlagsException(string message = "Non-zero flags or reserved bits encountered") : base(message) { }
    }

    /// <summary>
    /// Thrown when payload cannot be parsed as valid JSON.
    /// </summary>
    public class InvalidPayloadJsonException : Exception
    {
        public InvalidPayloadJsonException(string message = "Failed to parse frame payload as JSON", Exception? inner = null)
            : base(message, inner) { }
    }

    /// <summary>
    /// Decoded UCB1 IPC Frame with frame type and raw JSON payload string.
    /// </summary>
    public class Frame
    {
        public FrameType Type { get; set; }
        public string JsonPayload { get; set; } = "{}";

        public Frame() { }

        public Frame(FrameType type, string jsonPayload)
        {
            Type = type;
            JsonPayload = jsonPayload;
        }

        public override string ToString() => $"Frame(Type={Type}, Payload={JsonPayload})";
    }

    /// <summary>
    /// Static helper for encoding UCB1 binary frames.
    /// </summary>
    public static class FrameCodec
    {
        public const int HeaderSize = 12;
        public const string Magic = "UCB1";
        public const int MaxPayloadSize = 1_048_576; // 1MB
        public static readonly byte[] MagicBytes = new byte[] { 0x55, 0x43, 0x42, 0x31 };

        /// <summary>
        /// Encodes a frame with the fixed 12-byte UCB1 header and UTF-8 JSON payload.
        /// </summary>
        public static byte[] EncodeFrame(FrameType type, string? jsonPayload = null)
        {
            var payloadStr = string.IsNullOrEmpty(jsonPayload) ? "{}" : jsonPayload;
            var payloadBytes = Encoding.UTF8.GetBytes(payloadStr);

            if (payloadBytes.Length > MaxPayloadSize)
            {
                throw new FrameTooLargeException(
                    $"Payload length {payloadBytes.Length} exceeds maximum allowed size of {MaxPayloadSize} bytes"
                );
            }

            var frame = new byte[HeaderSize + payloadBytes.Length];

            // Magic bytes "UCB1" (0..3)
            frame[0] = MagicBytes[0];
            frame[1] = MagicBytes[1];
            frame[2] = MagicBytes[2];
            frame[3] = MagicBytes[3];

            // Frame type (byte 4)
            frame[4] = (byte)type;

            // Flags (byte 5 = 0)
            frame[5] = 0;

            // Reserved (bytes 6..7 = 0)
            BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(6, 2), 0);

            // Payload length (bytes 8..11, uint32BE)
            BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(8, 4), (uint)payloadBytes.Length);

            // Payload body (12..)
            Buffer.BlockCopy(payloadBytes, 0, frame, HeaderSize, payloadBytes.Length);

            return frame;
        }
    }

    /// <summary>
    /// Streaming decoder for UCB1 frames supporting arbitrary chunk fragmentation
    /// across headers and payloads, and frame concatenation.
    /// </summary>
    public class FrameDecoder
    {
        private byte[] _buffer = Array.Empty<byte>();

        /// <summary>
        /// Feeds an incoming raw chunk into the internal accumulator and
        /// extracts any complete frames.
        /// </summary>
        public List<Frame> Feed(byte[] chunk)
        {
            if (chunk == null || chunk.Length == 0)
            {
                return new List<Frame>();
            }

            if (_buffer.Length == 0)
            {
                _buffer = (byte[])chunk.Clone();
            }
            else
            {
                var newBuf = new byte[_buffer.Length + chunk.Length];
                Buffer.BlockCopy(_buffer, 0, newBuf, 0, _buffer.Length);
                Buffer.BlockCopy(chunk, 0, newBuf, _buffer.Length, chunk.Length);
                _buffer = newBuf;
            }

            var frames = new List<Frame>();

            while (_buffer.Length >= FrameCodec.HeaderSize)
            {
                // Validate magic bytes (0..3 === 'UCB1')
                if (_buffer[0] != FrameCodec.MagicBytes[0] ||
                    _buffer[1] != FrameCodec.MagicBytes[1] ||
                    _buffer[2] != FrameCodec.MagicBytes[2] ||
                    _buffer[3] != FrameCodec.MagicBytes[3])
                {
                    throw new InvalidMagicException();
                }

                // Read type (byte 4)
                var typeByte = _buffer[4];
                if (!Enum.IsDefined(typeof(FrameType), typeByte))
                {
                    throw new InvalidMagicException($"Unknown frame type: 0x{typeByte:X2}");
                }
                var type = (FrameType)typeByte;

                // Read flags (byte 5; must be 0)
                var flags = _buffer[5];
                if (flags != 0)
                {
                    throw new ReservedFlagsException($"Non-zero flags: {flags}");
                }

                // Read reserved (bytes 6..7; must be 0)
                var reserved = BinaryPrimitives.ReadUInt16BigEndian(_buffer.AsSpan(6, 2));
                if (reserved != 0)
                {
                    throw new ReservedFlagsException($"Non-zero reserved bits: {reserved}");
                }

                // Read payloadLength (bytes 8..11, uint32BE)
                var payloadLength = BinaryPrimitives.ReadUInt32BigEndian(_buffer.AsSpan(8, 4));
                if (payloadLength > FrameCodec.MaxPayloadSize)
                {
                    throw new FrameTooLargeException(
                        $"Payload length {payloadLength} exceeds maximum allowed size of {FrameCodec.MaxPayloadSize} bytes"
                    );
                }

                // Check if complete frame is available
                if (_buffer.Length < FrameCodec.HeaderSize + (int)payloadLength)
                {
                    break;
                }

                // Extract payload string
                string jsonStr;
                try
                {
                    jsonStr = Encoding.UTF8.GetString(_buffer, FrameCodec.HeaderSize, (int)payloadLength);
                    // Validate valid JSON
                    using var doc = JsonDocument.Parse(jsonStr);
                }
                catch (JsonException ex)
                {
                    throw new InvalidPayloadJsonException("Failed to parse frame payload as JSON", ex);
                }

                // Advance internal buffer
                var frameTotalLen = FrameCodec.HeaderSize + (int)payloadLength;
                if (_buffer.Length == frameTotalLen)
                {
                    _buffer = Array.Empty<byte>();
                }
                else
                {
                    var rem = _buffer.Length - frameTotalLen;
                    var nextBuf = new byte[rem];
                    Buffer.BlockCopy(_buffer, frameTotalLen, nextBuf, 0, rem);
                    _buffer = nextBuf;
                }

                frames.Add(new Frame(type, jsonStr));
            }

            return frames;
        }

        /// <summary>
        /// Resets the internal accumulator buffer.
        /// </summary>
        public void Reset()
        {
            _buffer = Array.Empty<byte>();
        }
    }
}
