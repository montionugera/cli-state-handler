import 'dart:async';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('Utf8StreamDecoder', () {
    late Utf8StreamDecoder decoder;

    setUp(() {
      decoder = Utf8StreamDecoder();
    });

    test('decodes regular ASCII chunks without buffering', () {
      expect(decoder.decode('hello '.codeUnits), equals('hello '));
      expect(decoder.decode('world'.codeUnits), equals('world'));
      expect(decoder.flush(), isEmpty);
    });

    test('handles empty chunks and empty flush', () {
      expect(decoder.decode([]), isEmpty);
      expect(decoder.flush(), isEmpty);
    });

    group('4-byte emoji splitting (🚀 [0xF0, 0x9F, 0x9A, 0x80])', () {
      final rocketBytes = [0xf0, 0x9f, 0x9a, 0x80];

      test('splits across 4 chunks (1 byte per chunk) with zero replacement characters', () {
        final chunk1 = decoder.decode([rocketBytes[0]]);
        expect(chunk1, isEmpty);
        expect(chunk1.contains('\uFFFD'), isFalse);

        final chunk2 = decoder.decode([rocketBytes[1]]);
        expect(chunk2, isEmpty);
        expect(chunk2.contains('\uFFFD'), isFalse);

        final chunk3 = decoder.decode([rocketBytes[2]]);
        expect(chunk3, isEmpty);
        expect(chunk3.contains('\uFFFD'), isFalse);

        final chunk4 = decoder.decode([rocketBytes[3]]);
        expect(chunk4, equals('🚀'));
        expect(chunk4.contains('\uFFFD'), isFalse);

        expect(decoder.flush(), isEmpty);
      });

      test('splits across 2 chunks (2 bytes per chunk)', () {
        final chunk1 = decoder.decode(rocketBytes.sublist(0, 2));
        expect(chunk1, isEmpty);
        expect(chunk1.contains('\uFFFD'), isFalse);

        final chunk2 = decoder.decode(rocketBytes.sublist(2, 4));
        expect(chunk2, equals('🚀'));
        expect(chunk2.contains('\uFFFD'), isFalse);

        expect(decoder.flush(), isEmpty);
      });

      test('splits across 2 chunks (3 bytes then 1 byte)', () {
        final chunk1 = decoder.decode(rocketBytes.sublist(0, 3));
        expect(chunk1, isEmpty);
        expect(chunk1.contains('\uFFFD'), isFalse);

        final chunk2 = decoder.decode(rocketBytes.sublist(3, 4));
        expect(chunk2, equals('🚀'));
        expect(chunk2.contains('\uFFFD'), isFalse);

        expect(decoder.flush(), isEmpty);
      });
    });

    group('3-byte multilingual characters (你好 -> 6 bytes)', () {
      final niHaoBytes = [0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd];

      test('splits at byte 1 (1 byte then 5 bytes)', () {
        final chunk1 = decoder.decode(niHaoBytes.sublist(0, 1));
        expect(chunk1, isEmpty);
        expect(chunk1.contains('\uFFFD'), isFalse);

        final chunk2 = decoder.decode(niHaoBytes.sublist(1));
        expect(chunk2, equals('你好'));
        expect(chunk2.contains('\uFFFD'), isFalse);
        expect(decoder.flush(), isEmpty);
      });

      test('splits at byte 2 (2 bytes then 4 bytes)', () {
        final chunk1 = decoder.decode(niHaoBytes.sublist(0, 2));
        expect(chunk1, isEmpty);

        final chunk2 = decoder.decode(niHaoBytes.sublist(2));
        expect(chunk2, equals('你好'));
        expect(decoder.flush(), isEmpty);
      });

      test('splits at byte 4 (4 bytes [complete 你 + 1 byte of 好] then 2 bytes)', () {
        final chunk1 = decoder.decode(niHaoBytes.sublist(0, 4));
        expect(chunk1, equals('你'));

        final chunk2 = decoder.decode(niHaoBytes.sublist(4));
        expect(chunk2, equals('好'));
        expect(decoder.flush(), isEmpty);
      });
    });

    test('flushes incomplete trailing bytes when stream terminates unexpectedly', () {
      decoder.decode('hello '.codeUnits);
      decoder.decode([0xe4, 0xbd]); // first 2 bytes of 3-byte char
      final flushed = decoder.flush();
      expect(flushed.isNotEmpty, isTrue);
      expect(decoder.flush(), isEmpty);
    });
  });

  group('QueryEngine.streamQuery()', () {
    late SqliteAdapter adapter;
    late QueryEngine engine;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
      engine = QueryEngine(
        sqliteAdapter: adapter,
        defaultStaleTime: const Duration(minutes: 1),
      );
    });

    tearDown(() {
      adapter.close();
    });

    test('streams tokens incrementally with live atomic compaction into SQLite', () async {
      final tokens = ['The ', 'quick ', 'brown ', 'fox ', 'jumps.'];
      final queryKey = ['llm', 'completion', '1'];
      final queryHash = hashQueryKey(queryKey);

      Stream<List<int>> tokenProducer(StreamFnContext ctx) async* {
        for (final token in tokens) {
          if (ctx.cancellationToken?.isCancelled == true) break;
          await Future.delayed(const Duration(milliseconds: 10));
          yield token.codeUnits;
        }
      }

      final handle = engine.streamQuery<String>(queryKey, tokenProducer);

      final receivedSlices = <StreamSlice<String>>[];
      await for (final slice in handle.stream) {
        receivedSlices.add(slice);
      }

      final deltas = receivedSlices
          .where((s) => s.delta.isNotEmpty)
          .map((s) => s.delta)
          .toList();
      expect(deltas, equals(tokens));

      final finalResult = await handle.done;
      expect(finalResult, equals('The quick brown fox jumps.'));

      final lastSlice = receivedSlices.last;
      expect(lastSlice.done, isTrue);
      expect(lastSlice.cumulative, equals('The quick brown fox jumps.'));

      // Stream record and chunks should be compacted into cache and purged
      expect(adapter.getStream(queryHash), isNull);
      expect(adapter.getStreamChunks(queryHash), isEmpty);

      // Query cache must contain compacted entry
      final cached = adapter.getQuery<dynamic>(queryHash);
      expect(cached, isNotNull);
      expect(cached!.dataPayload, equals('The quick brown fox jumps.'));

      // QueryEngine in-memory state is success
      final state = engine.getQueryState<String>(queryKey);
      expect(state?.status, equals(QueryStatus.success));
      expect(state?.data, equals('The quick brown fox jumps.'));
    });

    test('SWR cached stream query immediately completes without re-streaming', () async {
      final queryKey = ['cached', 'stream', 'swr'];
      var streamCallCount = 0;

      Stream<List<int>> streamFn(StreamFnContext ctx) async* {
        streamCallCount++;
        yield 'Initial '.codeUnits;
        yield 'Stream'.codeUnits;
      }

      // First execution
      final handle1 = engine.streamQuery<String>(
        queryKey,
        streamFn,
        staleTime: const Duration(minutes: 1),
      );
      final result1 = await handle1.done;
      expect(result1, equals('Initial Stream'));
      expect(streamCallCount, equals(1));

      // Second execution: must hit cache immediately
      final handle2 = engine.streamQuery<String>(
        queryKey,
        streamFn,
        staleTime: const Duration(minutes: 1),
      );
      final slices2 = <StreamSlice<String>>[];
      await for (final s in handle2.stream) {
        slices2.add(s);
      }
      final result2 = await handle2.done;
      expect(result2, equals('Initial Stream'));
      expect(streamCallCount, equals(1)); // Producer never called second time
      expect(slices2.length, equals(1));
      expect(slices2.first.done, isTrue);
      expect(slices2.first.cumulative, equals('Initial Stream'));

      // Subsequent fetchQuery also hits cache
      var fetchFnCalled = false;
      final fetchData = await engine.fetchQuery<String>(queryKey, () async {
        fetchFnCalled = true;
        return 'new data';
      });
      expect(fetchData, equals('Initial Stream'));
      expect(fetchFnCalled, isFalse);
    });

    test('stops producer and marks stream aborted when handle.cancel() is called', () async {
      final queryKey = ['stream', 'cancellation'];
      final queryHash = hashQueryKey(queryKey);
      var producerCleanedUp = false;

      Stream<List<int>> infiniteStream(StreamFnContext ctx) async* {
        try {
          var i = 0;
          while (ctx.cancellationToken?.isCancelled != true) {
            yield 'token-$i '.codeUnits;
            i++;
            await Future.delayed(const Duration(milliseconds: 15));
          }
        } finally {
          producerCleanedUp = true;
        }
      }

      final handle = engine.streamQuery<String>(queryKey, infiniteStream);

      final received = <String>[];
      final sub = handle.stream.listen((slice) {
        if (slice.delta.isNotEmpty) {
          received.add(slice.delta);
          if (received.length >= 2) {
            handle.cancel('User stopped stream');
          }
        }
      });

      await expectLater(
        handle.done,
        throwsA(isA<StreamCancelledException>()),
      );

      await sub.cancel();
      expect(handle.isCancelled, isTrue);
      expect(received.length, greaterThanOrEqualTo(2));

      await Future.delayed(const Duration(milliseconds: 50));
      expect(producerCleanedUp, isTrue);

      final streamRecord = adapter.getStream(queryHash);
      if (streamRecord != null) {
        expect(streamRecord.status, equals(StreamStatus.aborted));
      }
    });
  });
}
