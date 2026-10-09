import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  late Directory tempDir;
  late SqliteAdapter adapter;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('ucsa_dart_stream_test_');
    final dbPath = '${tempDir.path}/test.db';
    adapter = SqliteAdapter.file(dbPath);
  });

  tearDown(() {
    adapter.close();
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  group('Streaming Chunk Store', () {
    test('creates a stream with default options and tags', () {
      final queryKey = ['ai', 'generate', 'req-1'];
      final stream = adapter.createStream(
        queryKey,
        tags: ['llm', 'chat'],
        etag: '"v1-etag"',
        payloadVersion: 2,
      );

      expect(stream.queryHash, equals(hashQueryKey(queryKey)));
      expect(stream.queryKey, equals(queryKey));
      expect(stream.status, equals(StreamStatus.open));
      expect(stream.encoding, equals(StreamEncoding.utf8));
      expect(stream.nextSeq, equals(0));
      expect(stream.byteLength, equals(0));
      expect(stream.etag, equals('"v1-etag"'));
      expect(stream.payloadVersion, equals(2));
      expect(stream.expiresAt, greaterThan(stream.createdAt));

      final retrieved = adapter.getStream(stream.queryHash);
      expect(retrieved, isNotNull);
      expect(retrieved?.queryHash, equals(stream.queryHash));
      expect(retrieved?.status, equals(StreamStatus.open));
      expect(retrieved?.nextSeq, equals(0));
      expect(retrieved?.byteLength, equals(0));
    });

    test('appends chunks sequentially with strict sequence and offset validation', () {
      final queryKey = ['ai', 'stream', 'chunks-1'];
      final stream = adapter.createStream(queryKey);

      final c0 = adapter.appendStreamChunk(stream.queryHash, 'Hello, ');
      expect(c0['seq'], equals(0));
      expect(c0['byteOffset'], equals(0));
      expect(c0['byteLength'], equals(7));

      final sAfter0 = adapter.getStream(stream.queryHash);
      expect(sAfter0?.nextSeq, equals(1));
      expect(sAfter0?.byteLength, equals(7));

      final c1 = adapter.appendStreamChunk(stream.queryHash, 'world!', expectedSeq: 1);
      expect(c1['seq'], equals(1));
      expect(c1['byteOffset'], equals(7));
      expect(c1['byteLength'], equals(6));

      final sAfter1 = adapter.getStream(stream.queryHash);
      expect(sAfter1?.nextSeq, equals(2));
      expect(sAfter1?.byteLength, equals(13));

      final chunks = adapter.getStreamChunks(stream.queryHash);
      expect(chunks.length, equals(2));
      expect(chunks[0].seq, equals(0));
      expect(chunks[0].byteOffset, equals(0));
      expect(utf8.decode(chunks[0].data), equals('Hello, '));
      expect(chunks[1].seq, equals(1));
      expect(chunks[1].byteOffset, equals(7));
      expect(utf8.decode(chunks[1].data), equals('world!'));
    });

    test('rejects append when expectedSeq mismatches', () {
      final queryKey = ['ai', 'mismatch'];
      final stream = adapter.createStream(queryKey);

      expect(
        () => adapter.appendStreamChunk(stream.queryHash, 'Chunk 0', expectedSeq: 1),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('Sequence mismatch: expected 1, but next sequence is 0'),
        )),
      );
    });

    test('rejects append when stream is aborted or closed', () {
      final queryKey = ['ai', 'aborted'];
      final stream = adapter.createStream(queryKey);

      adapter.abortStream(stream.queryHash, error: 'User cancelled');

      final s = adapter.getStream(stream.queryHash);
      expect(s?.status, equals(StreamStatus.aborted));
      expect(s?.error, equals('User cancelled'));

      expect(
        () => adapter.appendStreamChunk(stream.queryHash, 'data'),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('Stream is not open (status: aborted)'),
        )),
      );
    });

    test('cascade delete cleans up chunks and tags when stream is deleted', () {
      final queryKey = ['ai', 'cascade'];
      final stream = adapter.createStream(
        queryKey,
        tags: ['cascade-tag'],
      );

      adapter.appendStreamChunk(stream.queryHash, 'Chunk data');
      expect(adapter.getStreamChunks(stream.queryHash).length, equals(1));

      adapter.db.execute('DELETE FROM ucsa_streams WHERE query_hash = ?;', [stream.queryHash]);

      expect(adapter.getStream(stream.queryHash), isNull);
      expect(adapter.getStreamChunks(stream.queryHash), isEmpty);

      final tagRows = adapter.db.select(
        'SELECT count(*) as cnt FROM ucsa_stream_tags WHERE query_hash = ?;',
        [stream.queryHash],
      );
      expect(tagRows.first['cnt'], equals(0));
    });

    test('compacts JSON stream atomically into ucsa_query_cache and moves tags', () async {
      final queryKey = ['ai', 'response', 'req-1'];
      final tags = ['ai-response', 'user-42'];
      final stream = adapter.createStream(
        queryKey,
        encoding: StreamEncoding.utf8,
        etag: '"response-etag-123"',
        tags: tags,
        payloadVersion: 2,
      );

      adapter.appendStreamChunk(stream.queryHash, '{"answer":');
      adapter.appendStreamChunk(stream.queryHash, ' "Paris",');
      adapter.appendStreamChunk(stream.queryHash, ' "confidence": 0.99}');

      final entry = await adapter.compactStream(stream.queryHash);

      expect(entry.queryHash, equals(stream.queryHash));
      expect(entry.queryKey, equals(queryKey));
      expect(entry.dataPayload, equals({'answer': 'Paris', 'confidence': 0.99}));
      expect(entry.etag, equals('"response-etag-123"'));
      expect(entry.createdAt, equals(stream.createdAt));
      expect(entry.staleAt, equals(stream.createdAt + 60000));
      expect(entry.expiresAt, equals(stream.expiresAt));
      expect(entry.payloadVersion, equals(2));

      // Stream row, chunks, and stream tags purged
      expect(adapter.getStream(stream.queryHash), isNull);
      expect(adapter.getStreamChunks(stream.queryHash), isEmpty);
      final streamTagRows = adapter.db.select(
        'SELECT count(*) as cnt FROM ucsa_stream_tags WHERE query_hash = ?;',
        [stream.queryHash],
      );
      expect(streamTagRows.first['cnt'], equals(0));

      // Cache entry retrievable via getQuery
      final cached = adapter.getQuery<Map<String, dynamic>>(stream.queryHash);
      expect(cached, isNotNull);
      expect(cached?.dataPayload, equals({'answer': 'Paris', 'confidence': 0.99}));

      // Tags moved to ucsa_cache_tags
      final cacheHashes = adapter.getQueryHashesByTag('ai-response');
      expect(cacheHashes, contains(stream.queryHash));
      final userHashes = adapter.getQueryHashesByTag('user-42');
      expect(userHashes, contains(stream.queryHash));
    });

    test('compacts UTF-8 plain text (non-JSON) stream into ucsa_query_cache', () async {
      final queryKey = ['stream', 'text-raw'];
      final stream = adapter.createStream(queryKey, encoding: StreamEncoding.utf8);

      adapter.appendStreamChunk(stream.queryHash, 'Line 1\n');
      adapter.appendStreamChunk(stream.queryHash, 'Line 2\n');

      final entry = await adapter.compactStream(stream.queryHash);
      expect(entry.dataPayload, equals('Line 1\nLine 2\n'));

      final cached = adapter.getQuery<String>(stream.queryHash);
      expect(cached?.dataPayload, equals('Line 1\nLine 2\n'));
    });

    test('compacts bytes stream into ucsa_query_cache', () async {
      final queryKey = ['stream', 'binary-raw'];
      final stream = adapter.createStream(queryKey, encoding: StreamEncoding.bytes);

      final b1 = [10, 20];
      final b2 = [30, 40, 50];
      adapter.appendStreamChunk(stream.queryHash, b1);
      adapter.appendStreamChunk(stream.queryHash, b2);

      final entry = await adapter.compactStream(stream.queryHash);
      expect(entry.dataPayload, equals([10, 20, 30, 40, 50]));
    });

    test('compacts stream exceeding casThresholdBytes into CAS store fallback', () async {
      final casDir = '${tempDir.path}/cas';
      final casStore = CasStore(baseDir: casDir, sqliteAdapter: adapter);

      final queryKey = ['stream', 'large-payload'];
      final stream = adapter.createStream(
        queryKey,
        encoding: StreamEncoding.utf8,
        tags: ['large-blob'],
      );

      final chunkData = 'x' * 600;
      adapter.appendStreamChunk(stream.queryHash, chunkData, expectedSeq: 0);
      adapter.appendStreamChunk(stream.queryHash, chunkData, expectedSeq: 1);
      adapter.appendStreamChunk(stream.queryHash, chunkData, expectedSeq: 2);

      final totalSize = 1800;
      expect(adapter.getStream(stream.queryHash)?.byteLength, equals(totalSize));

      final entry = await adapter.compactStream(
        stream.queryHash,
        casStore: casStore,
        casThresholdBytes: 1024,
      );

      expect(entry.dataPayload['__cas_ref'], isTrue);
      expect(entry.dataPayload['size'], equals(totalSize));
      final casHash = entry.dataPayload['hash'] as String;
      expect(casHash.length, equals(64));

      // CAS file exists on disk
      final casPath = casStore.getPath(casHash);
      expect(File(casPath).existsSync(), isTrue);
      expect(File(casPath).readAsStringSync(), equals('x' * 1800));

      // Stream purged
      expect(adapter.getStream(stream.queryHash), isNull);
      expect(adapter.getStreamChunks(stream.queryHash), isEmpty);

      // Tags moved to ucsa_cache_tags
      expect(adapter.getQueryHashesByTag('large-blob'), contains(stream.queryHash));
    });

    test('throws if compactStream is called on nonexistent stream', () async {
      expect(
        () => adapter.compactStream('nonexistent-hash'),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('Stream not found: nonexistent-hash'),
        )),
      );
    });
  });
}
