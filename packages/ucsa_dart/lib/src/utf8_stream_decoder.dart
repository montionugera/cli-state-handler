import 'dart:convert';

/// UTF-8 Stream Decoder with multi-byte boundary protection.
/// Buffers incomplete trailing multi-byte code points (2, 3, 4-byte sequences)
/// so that no replacement characters (\uFFFD) are emitted across chunk boundaries.
class Utf8StreamDecoder {
  List<int>? _leftover;

  /// Decodes a chunk of bytes, holding back any trailing incomplete UTF-8 sequence.
  String decode(List<int> chunk) {
    if (chunk.isEmpty) {
      return '';
    }

    final combined = _leftover != null && _leftover!.isNotEmpty
        ? [..._leftover!, ...chunk]
        : chunk;

    final incompleteBytes = _getIncompleteTrailingBytes(combined);

    if (incompleteBytes > 0) {
      final completeEnd = combined.length - incompleteBytes;
      _leftover = combined.sublist(completeEnd);
      if (completeEnd == 0) {
        return '';
      }
      return utf8.decode(combined.sublist(0, completeEnd), allowMalformed: true);
    }

    _leftover = null;
    return utf8.decode(combined, allowMalformed: true);
  }

  /// Flushes any remaining bytes in the leftover buffer as UTF-8 and clears it.
  String flush() {
    if (_leftover == null || _leftover!.isEmpty) {
      _leftover = null;
      return '';
    }
    final result = utf8.decode(_leftover!, allowMalformed: true);
    _leftover = null;
    return result;
  }

  /// Determines the number of trailing incomplete bytes in a UTF-8 buffer.
  /// Looks at the last 1 to 4 bytes:
  ///  - 1-byte char: 0xxxxxxx (0x00 - 0x7F) -> complete.
  ///  - 2-byte sequence start: 110xxxxx (0xC0 - 0xDF) -> needs 2 bytes.
  ///  - 3-byte sequence start: 1110xxxx (0xE0 - 0xEF) -> needs 3 bytes.
  ///  - 4-byte sequence start: 11110xxx (0xF0 - 0xF7) -> needs 4 bytes.
  int _getIncompleteTrailingBytes(List<int> buf) {
    final len = buf.length;
    if (len == 0) return 0;

    final b1 = buf[len - 1];

    // 1-byte ASCII (0x00 - 0x7F) -> complete
    if ((b1 & 0x80) == 0x00) {
      return 0;
    }

    // Single trailing byte that is a sequence start
    if ((b1 & 0xe0) == 0xc0) {
      // 2-byte sequence start: needs 2 bytes, only 1 present
      return 1;
    }
    if ((b1 & 0xf0) == 0xe0) {
      // 3-byte sequence start: needs 3 bytes, only 1 present
      return 1;
    }
    if ((b1 & 0xf8) == 0xf0) {
      // 4-byte sequence start: needs 4 bytes, only 1 present
      return 1;
    }

    // b1 is a continuation byte (0x80 - 0xBF)
    if (len >= 2) {
      final b2 = buf[len - 2];
      if ((b2 & 0xe0) == 0xc0) {
        // 2-byte start at len - 2: needs 2 bytes, 2 present -> complete
        return 0;
      }
      if ((b2 & 0xf0) == 0xe0) {
        // 3-byte start at len - 2: needs 3 bytes, only 2 present
        return 2;
      }
      if ((b2 & 0xf8) == 0xf0) {
        // 4-byte start at len - 2: needs 4 bytes, only 2 present
        return 2;
      }

      // b2 is also a continuation byte
      if (len >= 3) {
        final b3 = buf[len - 3];
        if ((b3 & 0xf0) == 0xe0) {
          // 3-byte start at len - 3: needs 3 bytes, 3 present -> complete
          return 0;
        }
        if ((b3 & 0xf8) == 0xf0) {
          // 4-byte start at len - 3: needs 4 bytes, only 3 present
          return 3;
        }
      }
    }

    return 0;
  }
}
