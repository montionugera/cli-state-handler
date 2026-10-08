import 'dart:convert';
import 'dart:typed_data';

/// Fixed size in bytes of the UCB1 binary header.
const int headerSize = 12;

/// Magic protocol identifier string.
const String magic = 'UCB1';

/// Magic protocol identifier bytes (ASCII 'U', 'C', 'B', '1').
const List<int> magicBytes = [0x55, 0x43, 0x42, 0x31];

/// Maximum allowed payload size in bytes (1MB = 1,048,576 bytes).
const int maxPayloadSize = 1048576;

/// Wire protocol frame types for UCB1 IPC communication.
enum FrameType {
  hello(0x01),
  welcome(0x02),
  subscribe(0x03),
  unsubscribe(0x04),
  publish(0x05),
  event(0x06),
  ping(0x08),
  pong(0x09),
  resync(0x0a),
  bye(0x0b),
  error(0x0f);

  final int value;
  const FrameType(this.value);

  /// Resolves a [FrameType] by its wire byte [value].
  static FrameType fromValue(int value) {
    for (final type in FrameType.values) {
      if (type.value == value) return type;
    }
    throw ArgumentError('Unknown frame type: 0x${value.toRadixString(16)}');
  }
}

/// Thrown when frame magic bytes do not match 'UCB1'.
class InvalidMagicException implements Exception {
  final String message;
  const InvalidMagicException([this.message = 'Invalid UCB1 magic header']);

  @override
  String toString() => 'InvalidMagicException: $message';
}

/// Thrown when frame payload length exceeds 1MB (1,048,576 bytes).
class FrameTooLargeException implements Exception {
  final String message;
  const FrameTooLargeException([this.message = 'Frame payload exceeds maximum size of 1MB']);

  @override
  String toString() => 'FrameTooLargeException: $message';
}

/// Thrown when non-zero flags or reserved bits are encountered in the header.
class ReservedFlagsException implements Exception {
  final String message;
  const ReservedFlagsException([this.message = 'Non-zero flags or reserved bits encountered']);

  @override
  String toString() => 'ReservedFlagsException: $message';
}

/// Thrown when payload cannot be parsed as valid JSON.
class InvalidPayloadJsonException implements Exception {
  final String message;
  final Object? cause;
  const InvalidPayloadJsonException([this.message = 'Failed to parse frame payload as JSON', this.cause]);

  @override
  String toString() => cause != null ? 'InvalidPayloadJsonException: $message (cause: $cause)' : 'InvalidPayloadJsonException: $message';
}

/// Decoded UCB1 IPC Frame with [type] and parsed [payload].
class Frame {
  final FrameType type;
  final dynamic payload;

  const Frame(this.type, this.payload);

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Frame &&
          runtimeType == other.runtimeType &&
          type == other.type &&
          _deepEquals(payload, other.payload);

  @override
  int get hashCode => type.hashCode ^ (payload?.hashCode ?? 0);

  @override
  String toString() => 'Frame(type: $type, payload: $payload)';

  static bool _deepEquals(dynamic a, dynamic b) {
    if (identical(a, b)) return true;
    if (a is Map && b is Map) {
      if (a.length != b.length) return false;
      for (final key in a.keys) {
        if (!b.containsKey(key) || !_deepEquals(a[key], b[key])) return false;
      }
      return true;
    }
    if (a is List && b is List) {
      if (a.length != b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (!_deepEquals(a[i], b[i])) return false;
      }
      return true;
    }
    return a == b;
  }
}

/// Encodes a [type] and [payload] into a UCB1 binary frame.
///
/// If [payload] is null, defaults to an empty object `{}`.
Uint8List encodeFrame(FrameType type, [dynamic payload]) {
  final serialized = jsonEncode(payload ?? const <String, dynamic>{});
  final payloadBytes = utf8.encode(serialized);

  if (payloadBytes.length > maxPayloadSize) {
    throw FrameTooLargeException(
      'Payload length ${payloadBytes.length} exceeds maximum allowed size of $maxPayloadSize bytes',
    );
  }

  final totalLength = headerSize + payloadBytes.length;
  final result = Uint8List(totalLength);
  final byteData = ByteData.sublistView(result);

  // Magic bytes "UCB1" (0..3)
  result[0] = magicBytes[0];
  result[1] = magicBytes[1];
  result[2] = magicBytes[2];
  result[3] = magicBytes[3];

  // Frame type (byte 4)
  result[4] = type.value;

  // Flags (byte 5 = 0)
  result[5] = 0;

  // Reserved (bytes 6..7 = 0)
  byteData.setUint16(6, 0, Endian.big);

  // Payload length (bytes 8..11, uint32BE)
  byteData.setUint32(8, payloadBytes.length, Endian.big);

  // Payload body (12..)
  result.setRange(headerSize, totalLength, payloadBytes);

  return result;
}

/// Streaming decoder for UCB1 frames supporting arbitrary chunk fragmentation
/// across headers and payloads, and frame concatenation.
class FrameDecoder {
  Uint8List _buffer = Uint8List(0);

  /// Feeds an incoming raw [chunk] into the internal accumulator and
  /// extracts any complete frames.
  List<Frame> feed(List<int> chunk) {
    if (chunk.isEmpty) return <Frame>[];

    if (_buffer.isEmpty) {
      _buffer = chunk is Uint8List ? Uint8List.fromList(chunk) : Uint8List.fromList(chunk);
    } else {
      final newBuf = Uint8List(_buffer.length + chunk.length);
      newBuf.setRange(0, _buffer.length, _buffer);
      newBuf.setRange(_buffer.length, newBuf.length, chunk);
      _buffer = newBuf;
    }

    final frames = <Frame>[];

    while (_buffer.length >= headerSize) {
      // Validate magic bytes (0..3 === 'UCB1')
      if (_buffer[0] != magicBytes[0] ||
          _buffer[1] != magicBytes[1] ||
          _buffer[2] != magicBytes[2] ||
          _buffer[3] != magicBytes[3]) {
        throw const InvalidMagicException();
      }

      // Read type (byte 4)
      final typeByte = _buffer[4];
      final FrameType type;
      try {
        type = FrameType.fromValue(typeByte);
      } catch (err) {
        throw InvalidMagicException('Unknown frame type: $typeByte');
      }

      // Read flags (byte 5; must be 0)
      final flags = _buffer[5];
      if (flags != 0) {
        throw ReservedFlagsException('Non-zero flags: $flags');
      }

      // Read reserved (bytes 6..7; must be 0)
      final byteData = ByteData.sublistView(_buffer);
      final reserved = byteData.getUint16(6, Endian.big);
      if (reserved != 0) {
        throw ReservedFlagsException('Non-zero reserved bits: $reserved');
      }

      // Read payloadLength (bytes 8..11, uint32BE)
      final payloadLength = byteData.getUint32(8, Endian.big);
      if (payloadLength > maxPayloadSize) {
        throw FrameTooLargeException(
          'Payload length $payloadLength exceeds maximum allowed size of $maxPayloadSize bytes',
        );
      }

      // Check if complete frame is available
      if (_buffer.length < headerSize + payloadLength) {
        break;
      }

      // Slice payload bytes
      final payloadBytes = _buffer.sublist(headerSize, headerSize + payloadLength);
      dynamic payload;
      try {
        final payloadStr = utf8.decode(payloadBytes);
        payload = jsonDecode(payloadStr);
      } catch (err) {
        throw InvalidPayloadJsonException('Failed to parse frame payload as JSON', err);
      }

      // Advance internal buffer
      if (_buffer.length == headerSize + payloadLength) {
        _buffer = Uint8List(0);
      } else {
        _buffer = _buffer.sublist(headerSize + payloadLength);
      }

      frames.add(Frame(type, payload));
    }

    return frames;
  }

  /// Resets the internal accumulator buffer.
  void reset() {
    _buffer = Uint8List(0);
  }
}
