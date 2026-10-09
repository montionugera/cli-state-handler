import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  late Directory tempDir;
  late SqliteAdapter adapter;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('ucsa_dart_resume_test_');
    final dbPath = '${tempDir.path}/test.db';
    adapter = SqliteAdapter.file(dbPath);
  });

  tearDown(() {
    adapter.close();
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  group('Resume Strategies (Dart Parity)', () {
    test('RangeResumeStrategy formats Range header without etag', () {
      final strategy = createRangeResumeStrategy();
      expect(strategy.kind, equals('range'));

      const ctx = ResumeContext(
        queryHash: 'q-hash-1',
        queryKey: ['llm', 'completion'],
        byteLength: 1024,
        nextSeq: 5,
        etag: null,
      );

      final headers = strategy.buildHeaders(ctx);
      expect(headers, equals({'Range': 'bytes=1024-'}));
    });

    test('RangeResumeStrategy formats Range and If-Range headers when etag is present', () {
      final strategy = createRangeResumeStrategy();
      const ctx = ResumeContext(
        queryHash: 'q-hash-1',
        queryKey: ['llm', 'completion'],
        byteLength: 2048,
        nextSeq: 10,
        etag: '"etag-xyz-123"',
      );

      final headers = strategy.buildHeaders(ctx);
      expect(headers, equals({
        'Range': 'bytes=2048-',
        'If-Range': '"etag-xyz-123"',
      }));
    });

    test('LastEventIdResumeStrategy formats Last-Event-ID header when set', () {
      final strategy = createLastEventIdResumeStrategy();
      expect(strategy.kind, equals('last-event-id'));

      const ctx = ResumeContext(
        queryHash: 'q-hash-2',
        queryKey: ['sse', 'events'],
        byteLength: 512,
        nextSeq: 3,
        lastEventId: 'evt_98765',
      );

      final headers = strategy.buildHeaders(ctx);
      expect(headers, equals({'Last-Event-ID': 'evt_98765'}));
    });

    test('LastEventIdResumeStrategy returns empty map when lastEventId is null or empty', () {
      final strategy = createLastEventIdResumeStrategy();
      const ctxNull = ResumeContext(
        queryHash: 'q-hash-2',
        queryKey: ['sse', 'events'],
        byteLength: 512,
        nextSeq: 3,
        lastEventId: null,
      );
      expect(strategy.buildHeaders(ctxNull), isEmpty);

      const ctxEmpty = ResumeContext(
        queryHash: 'q-hash-2',
        queryKey: ['sse', 'events'],
        byteLength: 512,
        nextSeq: 3,
        lastEventId: '',
      );
      expect(strategy.buildHeaders(ctxEmpty), isEmpty);
    });

    test('ContinuationResumeStrategy passes ResumeContext to continuation callback', () {
      final strategy = createContinuationResumeStrategy<Map<String, dynamic>>((ctx) => {
        'prompt': 'Continue from: ${ctx.accumulatedText ?? ''}',
        'byteOffset': ctx.byteLength,
        'seq': ctx.nextSeq,
      });
      expect(strategy.kind, equals('continuation'));

      const ctx = ResumeContext(
        queryHash: 'q-hash-3',
        queryKey: ['ai', 'agent'],
        byteLength: 120,
        nextSeq: 4,
        accumulatedText: 'Hello world, this is a streaming response.',
      );

      final result = strategy.buildContinuation(ctx);
      expect(result, equals({
        'prompt': 'Continue from: Hello world, this is a streaming response.',
        'byteOffset': 120,
        'seq': 4,
      }));
    });

    test('RestartResumeStrategy returns reset signal', () {
      final strategy = createRestartResumeStrategy();
      expect(strategy.kind, equals('restart'));

      const ctx = ResumeContext(
        queryHash: 'q-hash-4',
        queryKey: ['stream', 'data'],
        byteLength: 4096,
        nextSeq: 8,
      );

      final signal = strategy.reset(ctx);
      expect(signal, equals({
        'reset': true,
        'seq': 0,
        'byteOffset': 0,
      }));
    });
  });

  group('SQLite resetStream & updateStreamResumeToken', () {
    test('resetStream clears chunks and resets stream record to seq 0, byteLength 0, status open', () {
      final queryKey = ['ai', 'stream', 'session-reset'];
      final stream = adapter.createStream(queryKey);
      final queryHash = stream.queryHash;

      adapter.appendStreamChunk(queryHash, 'chunk 1 - ');
      adapter.appendStreamChunk(queryHash, 'chunk 2 - ');
      adapter.appendStreamChunk(queryHash, 'chunk 3');

      final chunksBefore = adapter.getStreamChunks(queryHash, fromSeq: 0);
      expect(chunksBefore.length, equals(3));

      final streamBefore = adapter.getStream(queryHash);
      expect(streamBefore?.nextSeq, equals(3));
      expect(streamBefore?.byteLength, equals(27));

      adapter.abortStream(queryHash, error: 'Connection lost');
      final aborted = adapter.getStream(queryHash);
      expect(aborted?.status, equals(StreamStatus.aborted));
      expect(aborted?.error, equals('Connection lost'));

      adapter.resetStream(queryHash);

      final chunksAfter = adapter.getStreamChunks(queryHash, fromSeq: 0);
      expect(chunksAfter, isEmpty);

      final streamAfter = adapter.getStream(queryHash);
      expect(streamAfter, isNotNull);
      expect(streamAfter?.nextSeq, equals(0));
      expect(streamAfter?.byteLength, equals(0));
      expect(streamAfter?.status, equals(StreamStatus.open));
      expect(streamAfter?.error, isNull);
    });

    test('updateStreamResumeToken updates token and resumeKind', () {
      final queryKey = ['ai', 'stream', 'token-test'];
      final stream = adapter.createStream(queryKey);
      final queryHash = stream.queryHash;

      expect(stream.resumeToken, isNull);
      expect(stream.resumeKind, isNull);

      adapter.updateStreamResumeToken(
        queryHash,
        'cursor_token_123',
        resumeKind: ResumeKind.continuation,
      );

      final updated1 = adapter.getStream(queryHash);
      expect(updated1?.resumeToken, equals('cursor_token_123'));
      expect(updated1?.resumeKind, equals(ResumeKind.continuation));

      adapter.updateStreamResumeToken(queryHash, 'cursor_token_456');

      final updated2 = adapter.getStream(queryHash);
      expect(updated2?.resumeToken, equals('cursor_token_456'));
      expect(updated2?.resumeKind, equals(ResumeKind.continuation));
    });
  });

  group('StreamResumeFsm (Dart Parity)', () {
    test('Lifecycle transitions: idle -> streaming -> complete', () {
      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: 'q-hash-life',
        queryKey: ['llm', 'stream'],
        strategy: createRangeResumeStrategy(),
      ));

      expect(fsm.state, equals(StreamResumeState.idle));
      expect(fsm.retryCount, equals(0));
      expect(fsm.committedByteLength, equals(0));
      expect(fsm.committedSeq, equals(0));
      expect(fsm.accumulatedText, equals(''));

      fsm.start();
      expect(fsm.state, equals(StreamResumeState.streaming));

      fsm.complete();
      expect(fsm.state, equals(StreamResumeState.complete));
    });

    test('Lifecycle transitions: abort marks aborted in SQLite', () {
      final queryKey = ['llm', 'stream-abort'];
      final stream = adapter.createStream(queryKey);

      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: stream.queryHash,
        queryKey: queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
      ));

      fsm.start();
      fsm.abort(reason: 'User cancelled');
      expect(fsm.state, equals(StreamResumeState.aborted));

      final row = adapter.getStream(stream.queryHash);
      expect(row?.status, equals(StreamStatus.aborted));
      expect(row?.error, equals('User cancelled'));
    });

    test('Seamless HTTP Range resume and chunk deduplication', () {
      final queryKey = ['llm', 'range-stream'];
      final stream = adapter.createStream(queryKey);
      final queryHash = stream.queryHash;

      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: queryHash,
        queryKey: queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
      ));
      fsm.start();

      // 1. Feed 500 bytes ('A' * 500)
      final initialBytes = List.filled(500, 65); // ASCII 'A'
      final r1 = fsm.handleIncomingChunk(initialBytes);
      expect(r1.accepted, isTrue);
      expect(r1.duplicate, isFalse);
      expect(r1.slice.length, equals(500));
      expect(r1.seq, equals(0));
      expect(r1.byteOffset, equals(0));
      expect(fsm.committedByteLength, equals(500));
      expect(fsm.committedSeq, equals(1));

      // 2. Simulate error
      final err = fsm.handleError('Connection reset');
      expect(err.canResume, isTrue);
      expect(err.restart, isFalse);
      expect(err.headers, equals({'Range': 'bytes=500-'}));
      expect(fsm.state, equals(StreamResumeState.resuming));
      expect(fsm.retryCount, equals(1));

      // 3. Server sends overlapping chunk 450..600 (50 'A's + 100 'B's)
      final overlap = <int>[...List.filled(50, 65), ...List.filled(100, 66)];
      final r2 = fsm.handleIncomingChunk(overlap, seq: 1, byteOffset: 450);

      expect(r2.accepted, isTrue);
      expect(r2.duplicate, isFalse);
      expect(r2.slice.length, equals(100));
      expect(r2.slice, equals(List.filled(100, 66)));
      expect(r2.seq, equals(1));
      expect(r2.byteOffset, equals(500));

      expect(fsm.committedByteLength, equals(600));
      expect(fsm.committedSeq, equals(2));
      expect(fsm.state, equals(StreamResumeState.streaming));
      expect(fsm.retryCount, equals(0));

      // Check SQLite chunks
      final chunks = adapter.getStreamChunks(queryHash, fromSeq: 0);
      expect(chunks.length, equals(2));
      expect(chunks[0].seq, equals(0));
      expect(chunks[0].byteOffset, equals(0));
      expect(chunks[0].data.length, equals(500));
      expect(chunks[1].seq, equals(1));
      expect(chunks[1].byteOffset, equals(500));
      expect(chunks[1].data.length, equals(100));
    });

    test('Rejects completely duplicate chunks', () {
      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: 'q-dup',
        queryKey: ['test', 'dup'],
        strategy: createRangeResumeStrategy(),
      ));

      fsm.handleIncomingChunk(List.filled(300, 88), seq: 0, byteOffset: 0);
      expect(fsm.committedByteLength, equals(300));

      final dup = fsm.handleIncomingChunk(List.filled(100, 88), seq: 0, byteOffset: 100);
      expect(dup.accepted, isFalse);
      expect(dup.duplicate, isTrue);
      expect(dup.slice, isEmpty);
      expect(dup.seq, equals(0));
      expect(dup.byteOffset, equals(100));
      expect(fsm.committedByteLength, equals(300));
      expect(fsm.committedSeq, equals(1));
    });

    test('SSE Last-Event-ID updates resume token and generates header', () {
      final queryKey = ['sse', 'stream'];
      final stream = adapter.createStream(queryKey);
      final queryHash = stream.queryHash;

      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: queryHash,
        queryKey: queryKey,
        strategy: createLastEventIdResumeStrategy(),
        sqliteAdapter: adapter,
      ));

      fsm.handleIncomingChunk('data: test\n\n', seq: 0, byteOffset: 0, eventId: 'evt-42');
      expect(fsm.lastEventId, equals('evt-42'));

      final dbStream = adapter.getStream(queryHash);
      expect(dbStream?.resumeToken, equals('evt-42'));
      expect(dbStream?.resumeKind, equals(ResumeKind.lastEventId));

      final err = fsm.handleError('dropped');
      expect(err.canResume, isTrue);
      expect(err.headers, equals({'Last-Event-ID': 'evt-42'}));
    });

    test('416 Range Not Satisfiable triggers clean restart and purges chunks', () {
      final queryKey = ['llm', 'stream-416'];
      final stream = adapter.createStream(queryKey);
      final queryHash = stream.queryHash;

      var resetCalled = false;
      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: queryHash,
        queryKey: queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
        onReset: () => resetCalled = true,
      ));

      fsm.handleIncomingChunk('chunk 1');
      fsm.handleIncomingChunk('chunk 2');
      expect(adapter.getStreamChunks(queryHash, fromSeq: 0).length, equals(2));

      final err = fsm.handleError('Range Not Satisfiable', statusCode: 416);
      expect(err.canResume, isTrue);
      expect(err.restart, isTrue);
      expect(err.retryDelayMs, equals(0));
      expect(resetCalled, isTrue);

      expect(fsm.committedByteLength, equals(0));
      expect(fsm.committedSeq, equals(0));
      expect(fsm.accumulatedText, equals(''));
      expect(fsm.state, equals(StreamResumeState.resuming));

      expect(adapter.getStreamChunks(queryHash, fromSeq: 0), isEmpty);
      final dbStream = adapter.getStream(queryHash);
      expect(dbStream?.byteLength, equals(0));
      expect(dbStream?.nextSeq, equals(0));
      expect(dbStream?.status, equals(StreamStatus.open));
    });

    test('412 Precondition Failed triggers restart', () {
      var resetCalled = false;
      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: 'q-412',
        queryKey: ['llm', 'stream-412'],
        strategy: createRangeResumeStrategy(),
        onReset: () => resetCalled = true,
      ));

      fsm.handleIncomingChunk('payload');
      final err = fsm.handleError('ETag mismatch', statusCode: 412);
      expect(err.canResume, isTrue);
      expect(err.restart, isTrue);
      expect(err.retryDelayMs, equals(0));
      expect(resetCalled, isTrue);
      expect(fsm.committedByteLength, equals(0));
    });

    test('Exponential backoff with jitter and max retries abort', () {
      final queryKey = ['test', 'max-retries'];
      final stream = adapter.createStream(queryKey);

      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: stream.queryHash,
        queryKey: queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      ));

      final e1 = fsm.handleError('e1');
      expect(e1.canResume, isTrue);
      expect(e1.retryDelayMs, inInclusiveRange(0, 100));
      expect(fsm.retryCount, equals(1));

      final e2 = fsm.handleError('e2');
      expect(e2.canResume, isTrue);
      expect(e2.retryDelayMs, inInclusiveRange(0, 200));
      expect(fsm.retryCount, equals(2));

      final e3 = fsm.handleError('e3');
      expect(e3.canResume, isTrue);
      expect(e3.retryDelayMs, inInclusiveRange(0, 400));
      expect(fsm.retryCount, equals(3));

      final e4 = fsm.handleError('e4 fatal');
      expect(e4.canResume, isFalse);
      expect(e4.restart, isFalse);
      expect(fsm.state, equals(StreamResumeState.aborted));

      final dbStream = adapter.getStream(stream.queryHash);
      expect(dbStream?.status, equals(StreamStatus.aborted));
      expect(dbStream?.error, equals('e4 fatal'));
    });

    test('Hydrates state from existing SQLite stream', () {
      final queryKey = ['llm', 'existing'];
      final stream = adapter.createStream(
        queryKey,
        etag: '"init-etag"',
        resumeToken: 'token-init-1',
        resumeKind: ResumeKind.lastEventId,
      );

      adapter.appendStreamChunk(stream.queryHash, 'Hello, ');
      adapter.appendStreamChunk(stream.queryHash, 'world!');

      final fsm = StreamResumeFsm(StreamResumeFsmOptions(
        queryHash: stream.queryHash,
        queryKey: queryKey,
        strategy: createLastEventIdResumeStrategy(),
        sqliteAdapter: adapter,
      ));

      expect(fsm.committedByteLength, equals(13));
      expect(fsm.committedSeq, equals(2));
      expect(fsm.accumulatedText, equals('Hello, world!'));
      expect(fsm.lastEventId, equals('token-init-1'));
      expect(fsm.etag, equals('"init-etag"'));
    });
  });
}
