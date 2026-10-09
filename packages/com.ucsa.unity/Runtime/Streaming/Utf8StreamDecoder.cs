using System;
using System.Text;

namespace Ucsa.Unity.Streaming
{
    /// <summary>
    /// UTF-8 Stream Decoder with multi-byte boundary protection.
    /// Buffers incomplete trailing multi-byte code points (2, 3, 4-byte sequences)
    /// so that no replacement characters (\uFFFD) are emitted across chunk boundaries.
    /// </summary>
    public class Utf8StreamDecoder
    {
        private byte[]? _leftover;

        /// <summary>
        /// Decodes a chunk of bytes, holding back any trailing incomplete UTF-8 sequence.
        /// </summary>
        public string Decode(byte[] chunk)
        {
            if (chunk == null || chunk.Length == 0)
            {
                return string.Empty;
            }

            byte[] combined;
            if (_leftover != null && _leftover.Length > 0)
            {
                combined = new byte[_leftover.Length + chunk.Length];
                Buffer.BlockCopy(_leftover, 0, combined, 0, _leftover.Length);
                Buffer.BlockCopy(chunk, 0, combined, _leftover.Length, chunk.Length);
            }
            else
            {
                combined = chunk;
            }

            int incompleteBytes = GetIncompleteTrailingBytes(combined);

            if (incompleteBytes > 0)
            {
                int completeEnd = combined.Length - incompleteBytes;
                _leftover = new byte[incompleteBytes];
                Buffer.BlockCopy(combined, completeEnd, _leftover, 0, incompleteBytes);

                if (completeEnd == 0)
                {
                    return string.Empty;
                }

                return Encoding.UTF8.GetString(combined, 0, completeEnd);
            }

            _leftover = null;
            return Encoding.UTF8.GetString(combined);
        }

        /// <summary>
        /// Flushes any remaining bytes in the leftover buffer as UTF-8 and clears it.
        /// </summary>
        public string Flush()
        {
            if (_leftover == null || _leftover.Length == 0)
            {
                _leftover = null;
                return string.Empty;
            }

            string result = Encoding.UTF8.GetString(_leftover);
            _leftover = null;
            return result;
        }

        /// <summary>
        /// Determines the number of trailing incomplete bytes in a UTF-8 buffer.
        /// Looks at the last 1 to 4 bytes:
        ///  - 1-byte char: 0xxxxxxx (0x00 - 0x7F) -> complete.
        ///  - 2-byte sequence start: 110xxxxx (0xC0 - 0xDF) -> needs 2 bytes.
        ///  - 3-byte sequence start: 1110xxxx (0xE0 - 0xEF) -> needs 3 bytes.
        ///  - 4-byte sequence start: 11110xxx (0xF0 - 0xF7) -> needs 4 bytes.
        /// </summary>
        private int GetIncompleteTrailingBytes(byte[] buf)
        {
            int len = buf.Length;
            if (len == 0) return 0;

            byte b1 = buf[len - 1];

            // 1-byte ASCII (0x00 - 0x7F) -> complete
            if ((b1 & 0x80) == 0x00)
            {
                return 0;
            }

            // Single trailing byte that is a sequence start
            if ((b1 & 0xe0) == 0xc0)
            {
                // 2-byte sequence start: needs 2 bytes, only 1 present
                return 1;
            }
            if ((b1 & 0xf0) == 0xe0)
            {
                // 3-byte sequence start: needs 3 bytes, only 1 present
                return 1;
            }
            if ((b1 & 0xf8) == 0xf0)
            {
                // 4-byte sequence start: needs 4 bytes, only 1 present
                return 1;
            }

            // b1 is a continuation byte (0x80 - 0xBF)
            if (len >= 2)
            {
                byte b2 = buf[len - 2];
                if ((b2 & 0xe0) == 0xc0)
                {
                    // 2-byte start at len - 2: needs 2 bytes, 2 present -> complete
                    return 0;
                }
                if ((b2 & 0xf0) == 0xe0)
                {
                    // 3-byte start at len - 2: needs 3 bytes, only 2 present
                    return 2;
                }
                if ((b2 & 0xf8) == 0xf0)
                {
                    // 4-byte start at len - 2: needs 4 bytes, only 2 present
                    return 2;
                }

                // b2 is also a continuation byte
                if (len >= 3)
                {
                    byte b3 = buf[len - 3];
                    if ((b3 & 0xf0) == 0xe0)
                    {
                        // 3-byte start at len - 3: needs 3 bytes, 3 present -> complete
                        return 0;
                    }
                    if ((b3 & 0xf8) == 0xf0)
                    {
                        // 4-byte start at len - 3: needs 4 bytes, only 3 present
                        return 3;
                    }
                }
            }

            return 0;
        }
    }
}
