import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

Uint8List hexToBytes(String hex) {
  final result = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < result.length; i++) {
    result[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return result;
}

String bytesToHex(List<int> bytes) {
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

File findVectorsFile() {
  final candidates = [
    '../../contracts/ipc/vectors.json',
    '../contracts/ipc/vectors.json',
    'contracts/ipc/vectors.json',
  ];
  for (final path in candidates) {
    final file = File(path);
    if (file.existsSync()) return file;
  }
  throw StateError('Could not find contracts/ipc/vectors.json');
}

void main() {
  group('UCB1 Dart Frame Codec & Decoder', () {
    late FrameDecoder decoder;

    setUp(() {
      decoder = FrameDecoder();
    });

    test('defines all 11 FrameType enum values matching UCB1 specification', () {
      expect(FrameType.hello.value, equals(0x01));
      expect(FrameType.welcome.value, equals(0x02));
      expect(FrameType.subscribe.value, equals(0x03));
      expect(FrameType.unsubscribe.value, equals(0x04));
      expect(FrameType.publish.value, equals(0x05));
      expect(FrameType.event.value, equals(0x06));
      expect(FrameType.ping.value, equals(0x08));
      expect(FrameType.pong.value, equals(0x09));
      expect(FrameType.resync.value, equals(0x0a));
      expect(FrameType.bye.value, equals(0x0b));
      expect(FrameType.error.value, equals(0x0f));
    });

    group('Round-trip encode and decode for all 11 frame types', () {
      final testCases = <Map<String, dynamic>>[
        {'type': FrameType.hello, 'payload': {'version': '1.0', 'clientId': 'dart-client'}},
        {'type': FrameType.welcome, 'payload': {'sessionId': 'sess-123', 'heartbeatMs': 5000}},
        {'type': FrameType.subscribe, 'payload': {'topic': 'cache:invalidation:users', 'filter': '*'}},
        {'type': FrameType.unsubscribe, 'payload': {'topic': 'cache:invalidation:users'}},
        {'type': FrameType.publish, 'payload': {'channel': 'orders', 'data': {'orderId': 42, 'amount': 199.99}}},
        {'type': FrameType.event, 'payload': {'eventName': 'user_updated', 'id': 'usr-9'}},
        {'type': FrameType.ping, 'payload': {'timestamp': 1712000000000}},
        {'type': FrameType.pong, 'payload': {'timestamp': 1712000000000}},
        {'type': FrameType.resync, 'payload': {'lastSeq': 1042}},
        {'type': FrameType.bye, 'payload': {'reason': 'client_shutdown'}},
        {'type': FrameType.error, 'payload': {'code': 'ERR_TIMEOUT', 'message': 'Operation timed out'}},
      ];

      for (final tc in testCases) {
        final type = tc['type'] as FrameType;
        final payload = tc['payload'] as Map<String, dynamic>;

        test('round-trips FrameType 0x${type.value.toRadixString(16).padLeft(2, '0')}', () {
          final encoded = encodeFrame(type, payload);
          expect(encoded.length, greaterThanOrEqualTo(headerSize));
          expect(utf8.decode(encoded.sublist(0, 4)), equals('UCB1'));
          expect(encoded[4], equals(type.value));
          expect(encoded[5], equals(0)); // flags = 0
          final bd = ByteData.sublistView(encoded);
          expect(bd.getUint16(6, Endian.big), equals(0)); // reserved = 0

          final decoded = decoder.feed(encoded);
          expect(decoded.length, equals(1));
          expect(decoded[0].type, equals(type));
          expect(decoded[0].payload, equals(payload));
        });
      }

      test('encodes default empty payload when payload is omitted or null', () {
        final encoded = encodeFrame(FrameType.ping);
        final decoded = decoder.feed(encoded);
        expect(decoded.length, equals(1));
        expect(decoded[0].type, equals(FrameType.ping));
        expect(decoded[0].payload, equals(<String, dynamic>{}));
      });
    });

    group('Chunk fragmentation & streaming reassembly', () {
      test('handles byte-by-byte streaming', () {
        final payload = {'stream': 'byte-by-byte', 'count': 12345};
        final encoded = encodeFrame(FrameType.event, payload);

        final frames = <Frame>[];
        for (var i = 0; i < encoded.length; i++) {
          final chunk = encoded.sublist(i, i + 1);
          frames.addAll(decoder.feed(chunk));
        }

        expect(frames.length, equals(1));
        expect(frames[0].type, equals(FrameType.event));
        expect(frames[0].payload, equals(payload));
      });

      test('handles splits across 1 byte, 2 bytes, 11 bytes, and halfway through payload', () {
        final payload = {
          'key': 'value',
          'complex': [
            1,
            2,
            3,
            {'nested': true}
          ]
        };
        final encoded = encodeFrame(FrameType.publish, payload);
        final halfway = 12 + ((encoded.length - 12) ~/ 2);
        final splitPositions = [1, 2, 11, halfway];

        for (final split in splitPositions) {
          decoder.reset();
          final part1 = encoded.sublist(0, split);
          final part2 = encoded.sublist(split);

          final out1 = decoder.feed(part1);
          expect(out1, isEmpty);

          final out2 = decoder.feed(part2);
          expect(out2.length, equals(1));
          expect(out2[0].type, equals(FrameType.publish));
          expect(out2[0].payload, equals(payload));
        }
      });

      test('handles arbitrary chunk sizes with reset', () {
        final encoded = encodeFrame(FrameType.ping, {'seq': 1});
        decoder.feed(encoded.sublist(0, 5));
        decoder.reset();

        final decoded = decoder.feed(encoded);
        expect(decoded.length, equals(1));
        expect(decoded[0].payload, equals({'seq': 1}));
      });
    });

    group('Concatenation of multiple frames', () {
      test('decodes 3 frames in a single buffer in order', () {
        final f1 = encodeFrame(FrameType.hello, {'id': 1});
        final f2 = encodeFrame(FrameType.subscribe, {'id': 2});
        final f3 = encodeFrame(FrameType.event, {'id': 3});

        final concatenated = Uint8List(f1.length + f2.length + f3.length);
        concatenated.setRange(0, f1.length, f1);
        concatenated.setRange(f1.length, f1.length + f2.length, f2);
        concatenated.setRange(f1.length + f2.length, concatenated.length, f3);

        final decoded = decoder.feed(concatenated);
        expect(decoded.length, equals(3));
        expect(decoded[0].type, equals(FrameType.hello));
        expect(decoded[0].payload, equals({'id': 1}));
        expect(decoded[1].type, equals(FrameType.subscribe));
        expect(decoded[1].payload, equals({'id': 2}));
        expect(decoded[2].type, equals(FrameType.event));
        expect(decoded[2].payload, equals({'id': 3}));
      });

      test('decodes concatenated frames split across arbitrary boundaries', () {
        final f1 = encodeFrame(FrameType.ping, {'n': 1});
        final f2 = encodeFrame(FrameType.pong, {'n': 2});
        final concatenated = Uint8List(f1.length + f2.length);
        concatenated.setRange(0, f1.length, f1);
        concatenated.setRange(f1.length, concatenated.length, f2);

        // Split inside f2's header
        final splitPoint = f1.length + 6;
        final part1 = concatenated.sublist(0, splitPoint);
        final part2 = concatenated.sublist(splitPoint);

        final out1 = decoder.feed(part1);
        expect(out1.length, equals(1));
        expect(out1[0].type, equals(FrameType.ping));
        expect(out1[0].payload, equals({'n': 1}));

        final out2 = decoder.feed(part2);
        expect(out2.length, equals(1));
        expect(out2[0].type, equals(FrameType.pong));
        expect(out2[0].payload, equals({'n': 2}));
      });
    });

    group('Error handling', () {
      test('throws InvalidMagicException on bad magic bytes', () {
        final encoded = encodeFrame(FrameType.ping);
        encoded[0] = 0x42; // 'B'
        encoded[1] = 0x41; // 'A'
        encoded[2] = 0x44; // 'D'
        encoded[3] = 0x21; // '!'

        expect(() => decoder.feed(encoded), throwsA(isA<InvalidMagicException>()));
      });

      test('throws ReservedFlagsException on non-zero flags byte', () {
        final encoded = encodeFrame(FrameType.ping);
        encoded[5] = 0x01; // non-zero flags

        expect(() => decoder.feed(encoded), throwsA(isA<ReservedFlagsException>()));
      });

      test('throws ReservedFlagsException on non-zero reserved bytes', () {
        final encoded = encodeFrame(FrameType.ping);
        final bd = ByteData.sublistView(encoded);
        bd.setUint16(6, 0x0001, Endian.big); // non-zero reserved

        expect(() => decoder.feed(encoded), throwsA(isA<ReservedFlagsException>()));
      });

      test('throws FrameTooLargeException on payload > 1MB in encodeFrame', () {
        final hugeString = 'x' * (maxPayloadSize + 10);
        expect(() => encodeFrame(FrameType.event, {'huge': hugeString}), throwsA(isA<FrameTooLargeException>()));
      });

      test('throws FrameTooLargeException on header payloadLength > 1MB in FrameDecoder', () {
        final header = Uint8List(12);
        header.setRange(0, 4, [0x55, 0x43, 0x42, 0x31]); // UCB1
        header[4] = FrameType.ping.value;
        header[5] = 0; // flags
        final bd = ByteData.sublistView(header);
        bd.setUint16(6, 0, Endian.big); // reserved
        bd.setUint32(8, maxPayloadSize + 1, Endian.big); // payload length > 1MB

        expect(() => decoder.feed(header), throwsA(isA<FrameTooLargeException>()));
      });

      test('throws InvalidPayloadJsonException on malformed JSON payload', () {
        final badJsonBytes = utf8.encode('{not-valid-json');
        final frame = Uint8List(12 + badJsonBytes.length);
        frame.setRange(0, 4, [0x55, 0x43, 0x42, 0x31]);
        frame[4] = FrameType.ping.value;
        frame[5] = 0;
        final bd = ByteData.sublistView(frame);
        bd.setUint16(6, 0, Endian.big);
        bd.setUint32(8, badJsonBytes.length, Endian.big);
        frame.setRange(12, frame.length, badJsonBytes);

        expect(() => decoder.feed(frame), throwsA(isA<InvalidPayloadJsonException>()));
      });
    });

    group('Language-Neutral Conformance Vectors', () {
      late List<dynamic> vectors;

      setUpAll(() {
        final file = findVectorsFile();
        vectors = jsonDecode(file.readAsStringSync()) as List<dynamic>;
      });

      test('loads valid conformance vectors fixture with at least 10 vectors', () {
        expect(vectors.length, greaterThanOrEqualTo(10));
        final names = vectors.map((v) => v['name']).toList();
        expect(names, containsAll([
          'hello',
          'welcome',
          'subscribe',
          'publish',
          'event',
          'ping',
          'pong',
          'resync',
          'bye',
          'error',
        ]));
      });

      test('decodes all golden vector hex strings to expected type and payload', () {
        for (final v in vectors) {
          final hex = v['hex'] as String;
          final expectedType = v['type'] as int;
          final expectedPayload = v['payload'] as Map<String, dynamic>;

          final dec = FrameDecoder();
          final bytes = hexToBytes(hex);
          final frames = dec.feed(bytes);

          expect(frames.length, equals(1), reason: 'Vector ${v['name']} should yield exactly 1 frame');
          expect(frames[0].type.value, equals(expectedType), reason: 'Vector ${v['name']} type mismatch');
          expect(frames[0].payload, equals(expectedPayload), reason: 'Vector ${v['name']} payload mismatch');
        }
      });

      test('encodes vector payloads matching exact 12-byte header and wire hex', () {
        for (final v in vectors) {
          final hex = v['hex'] as String;
          final type = FrameType.fromValue(v['type'] as int);
          final payload = v['payload'] as Map<String, dynamic>;

          final encoded = encodeFrame(type, payload);

          // Verify 12-byte header matches first 24 hex characters
          final expectedHeaderHex = hex.substring(0, 24);
          final actualHeaderHex = bytesToHex(encoded.sublist(0, 12));
          expect(actualHeaderHex, equals(expectedHeaderHex), reason: 'Header mismatch for vector ${v['name']}');

          // Verify decoded frame matches original payload and type
          final dec = FrameDecoder();
          final decoded = dec.feed(encoded);
          expect(decoded.length, equals(1));
          expect(decoded[0].type, equals(type));
          expect(decoded[0].payload, equals(payload));

          // Verify exact full hex matches golden vector hex
          expect(bytesToHex(encoded), equals(hex), reason: 'Full hex mismatch for vector ${v['name']}');
        }
      });

      test('decodes golden hex across byte-by-byte streaming chunks for all vectors', () {
        for (final v in vectors) {
          final hex = v['hex'] as String;
          final expectedType = v['type'] as int;
          final expectedPayload = v['payload'] as Map<String, dynamic>;

          final dec = FrameDecoder();
          final bytes = hexToBytes(hex);
          final frames = <Frame>[];

          for (var i = 0; i < bytes.length; i++) {
            frames.addAll(dec.feed([bytes[i]]));
          }

          expect(frames.length, equals(1), reason: 'Byte streaming vector ${v['name']} failed');
          expect(frames[0].type.value, equals(expectedType));
          expect(frames[0].payload, equals(expectedPayload));
        }
      });
    });
  });
}
