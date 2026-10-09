import 'dart:convert';
import 'dart:math' as math;
import 'types.dart';
import 'sqlite_adapter.dart';
import 'resume_strategy.dart';

enum StreamResumeState {
  idle,
  streaming,
  interrupted,
  resuming,
  complete,
  aborted,
}

class IncomingChunkResult {
  final bool accepted;
  final bool duplicate;
  final List<int> slice;
  final int seq;
  final int byteOffset;

  const IncomingChunkResult({
    required this.accepted,
    required this.duplicate,
    required this.slice,
    required this.seq,
    required this.byteOffset,
  });
}

class HandleErrorResult {
  final bool canResume;
  final int retryDelayMs;
  final Map<String, String>? headers;
  final dynamic continuationPayload;
  final bool restart;

  const HandleErrorResult({
    required this.canResume,
    required this.retryDelayMs,
    this.headers,
    this.continuationPayload,
    this.restart = false,
  });
}

class StreamResumeFsmOptions {
  final String queryHash;
  final QueryKey queryKey;
  final ResumeStrategy strategy;
  final int maxRetries;
  final int baseDelayMs;
  final int maxDelayMs;
  final SqliteAdapter? sqliteAdapter;
  final String? etag;
  final String? initialLastEventId;
  final void Function()? onReset;

  const StreamResumeFsmOptions({
    required this.queryHash,
    required this.queryKey,
    required this.strategy,
    this.maxRetries = 5,
    this.baseDelayMs = 300,
    this.maxDelayMs = 10000,
    this.sqliteAdapter,
    this.etag,
    this.initialLastEventId,
    this.onReset,
  });
}

/// Finite State Machine managing resumable stream connections, chunk deduplication,
/// exponential backoff retry with full jitter, and strategy-driven recovery in Dart.
class StreamResumeFsm {
  StreamResumeState state = StreamResumeState.idle;
  int retryCount = 0;
  int committedByteLength = 0;
  int committedSeq = 0;
  String? lastEventId;
  String accumulatedText = '';
  String? etag;

  final String queryHash;
  final QueryKey queryKey;
  final ResumeStrategy strategy;
  final int maxRetries;
  final int baseDelayMs;
  final int maxDelayMs;
  final SqliteAdapter? sqliteAdapter;
  final void Function()? onReset;

  StreamResumeFsm(StreamResumeFsmOptions options)
      : queryHash = options.queryHash,
        queryKey = options.queryKey,
        strategy = options.strategy,
        maxRetries = options.maxRetries,
        baseDelayMs = options.baseDelayMs,
        maxDelayMs = options.maxDelayMs,
        sqliteAdapter = options.sqliteAdapter,
        etag = options.etag,
        lastEventId = options.initialLastEventId,
        onReset = options.onReset {
    if (sqliteAdapter != null) {
      var existing = sqliteAdapter!.getStream(queryHash);
      if (existing == null && hashQueryKey(queryKey) == queryHash) {
        try {
          sqliteAdapter!.createStream(
            queryKey,
            etag: etag,
            resumeToken: lastEventId,
            resumeKind: strategy is LastEventIdResumeStrategy
                ? ResumeKind.lastEventId
                : null,
          );
          existing = sqliteAdapter!.getStream(queryHash);
        } catch (_) {
          // May already exist or created concurrently
        }
      }

      if (existing != null) {
        committedByteLength = existing.byteLength;
        committedSeq = existing.nextSeq;
        if (existing.resumeToken != null && lastEventId == null) {
          lastEventId = existing.resumeToken;
        }
        if (existing.etag != null && etag == null) {
          etag = existing.etag;
        }
        if (existing.byteLength > 0) {
          final chunks = sqliteAdapter!.getStreamChunks(queryHash, fromSeq: 0);
          final bytes = chunks.expand((c) => c.data).toList();
          accumulatedText = utf8.decode(bytes, allowMalformed: true);
        }
      }
    }
  }

  /// Transitions state from idle to streaming.
  void start() {
    state = StreamResumeState.streaming;
  }

  /// Processes an incoming raw chunk, slicing off duplicate overlapping bytes if needed.
  /// Persists accepted chunks to SQLite if an adapter is configured.
  IncomingChunkResult handleIncomingChunk(
    dynamic data, {
    int? seq,
    int? byteOffset,
    String? eventId,
  }) {
    List<int> bytes;
    if (data is List<int>) {
      bytes = data;
    } else if (data is String) {
      bytes = utf8.encode(data);
    } else {
      bytes = utf8.encode(data.toString());
    }

    var slice = bytes;

    if (byteOffset != null && byteOffset < committedByteLength) {
      if (byteOffset + bytes.length <= committedByteLength) {
        return IncomingChunkResult(
          accepted: false,
          duplicate: true,
          slice: const [],
          seq: seq ?? committedSeq,
          byteOffset: byteOffset,
        );
      }
      slice = bytes.sublist(committedByteLength - byteOffset);
    }

    if (eventId != null && eventId.isNotEmpty) {
      lastEventId = eventId;
      sqliteAdapter?.updateStreamResumeToken(
        queryHash,
        eventId,
        resumeKind: ResumeKind.lastEventId,
      );
    }

    final currentSeq = committedSeq;
    final currentOffset = committedByteLength;

    if (sqliteAdapter != null) {
      sqliteAdapter!.appendStreamChunk(queryHash, slice, expectedSeq: currentSeq);
    }

    committedByteLength += slice.length;
    committedSeq += 1;
    try {
      accumulatedText += utf8.decode(slice, allowMalformed: true);
    } catch (_) {}

    if (state == StreamResumeState.resuming ||
        state == StreamResumeState.interrupted ||
        state == StreamResumeState.idle) {
      state = StreamResumeState.streaming;
      retryCount = 0;
    }

    return IncomingChunkResult(
      accepted: true,
      duplicate: false,
      slice: slice,
      seq: currentSeq,
      byteOffset: currentOffset,
    );
  }

  /// Handles network errors or transport disconnects with exponential backoff and jitter.
  HandleErrorResult handleError(dynamic error, {int? statusCode}) {
    if (statusCode == 416 || statusCode == 412) {
      _performReset();
      return const HandleErrorResult(
        canResume: true,
        retryDelayMs: 0,
        restart: true,
      );
    }

    if (retryCount >= maxRetries) {
      state = StreamResumeState.aborted;
      sqliteAdapter?.abortStream(queryHash, error: error.toString());
      return const HandleErrorResult(
        canResume: false,
        retryDelayMs: 0,
        restart: false,
      );
    }

    final maxExp = (baseDelayMs * math.pow(2, retryCount)).toInt();
    final cap = math.min(maxDelayMs, maxExp);
    final retryDelayMs = cap > 0 ? (math.Random().nextDouble() * cap).floor() : 0;
    retryCount += 1;
    state = StreamResumeState.resuming;

    final ctx = ResumeContext(
      queryHash: queryHash,
      queryKey: queryKey,
      byteLength: committedByteLength,
      nextSeq: committedSeq,
      etag: etag,
      lastEventId: lastEventId,
      accumulatedText: accumulatedText,
    );

    Map<String, String>? headers;
    dynamic continuationPayload;
    var restart = false;

    if (strategy is RangeResumeStrategy) {
      headers = (strategy as RangeResumeStrategy).buildHeaders(ctx);
    } else if (strategy is LastEventIdResumeStrategy) {
      headers = (strategy as LastEventIdResumeStrategy).buildHeaders(ctx);
    } else if (strategy is ContinuationResumeStrategy) {
      continuationPayload =
          (strategy as ContinuationResumeStrategy).buildContinuation(ctx);
    } else if (strategy is RestartResumeStrategy) {
      (strategy as RestartResumeStrategy).reset(ctx);
      _performReset();
      restart = true;
    }

    return HandleErrorResult(
      canResume: true,
      retryDelayMs: retryDelayMs,
      headers: headers,
      continuationPayload: continuationPayload,
      restart: restart,
    );
  }

  /// Marks stream as complete.
  void complete() {
    state = StreamResumeState.complete;
  }

  /// Aborts the active stream and updates SQLite if configured.
  void abort({String? reason}) {
    state = StreamResumeState.aborted;
    sqliteAdapter?.abortStream(queryHash, error: reason);
  }

  void _performReset() {
    sqliteAdapter?.resetStream(queryHash);
    committedByteLength = 0;
    committedSeq = 0;
    accumulatedText = '';
    onReset?.call();
    state = StreamResumeState.resuming;
  }
}
