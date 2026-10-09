import 'types.dart';

/// Context provided to a resume strategy when reconnecting an interrupted stream.
class ResumeContext {
  final String queryHash;
  final QueryKey queryKey;
  final int byteLength;
  final int nextSeq;
  final String? etag;
  final String? lastEventId;
  final String? accumulatedText;

  const ResumeContext({
    required this.queryHash,
    required this.queryKey,
    required this.byteLength,
    required this.nextSeq,
    this.etag,
    this.lastEventId,
    this.accumulatedText,
  });
}

/// Base strategy interface for reconnecting interrupted streams.
abstract class ResumeStrategy {
  String get kind;
}

/// Strategy generating HTTP Range and optional If-Range headers.
class RangeResumeStrategy implements ResumeStrategy {
  @override
  String get kind => 'range';

  const RangeResumeStrategy();

  Map<String, String> buildHeaders(ResumeContext ctx) {
    final headers = <String, String>{
      'Range': 'bytes=${ctx.byteLength}-',
    };
    if (ctx.etag != null && ctx.etag!.isNotEmpty) {
      headers['If-Range'] = ctx.etag!;
    }
    return headers;
  }
}

/// Strategy passing the Last-Event-ID header upon SSE reconnection.
class LastEventIdResumeStrategy implements ResumeStrategy {
  @override
  String get kind => 'last-event-id';

  const LastEventIdResumeStrategy();

  Map<String, String> buildHeaders(ResumeContext ctx) {
    if (ctx.lastEventId != null && ctx.lastEventId!.isNotEmpty) {
      return {'Last-Event-ID': ctx.lastEventId!};
    }
    return {};
  }
}

/// Strategy invoking a user callback to produce an application-level continuation payload.
class ContinuationResumeStrategy<T> implements ResumeStrategy {
  @override
  String get kind => 'continuation';

  final T Function(ResumeContext ctx) _builder;

  const ContinuationResumeStrategy(this._builder);

  T buildContinuation(ResumeContext ctx) => _builder(ctx);
}

/// Strategy requesting a clean restart of the stream from sequence 0.
class RestartResumeStrategy implements ResumeStrategy {
  @override
  String get kind => 'restart';

  const RestartResumeStrategy();

  Map<String, dynamic> reset(ResumeContext ctx) {
    return const {'reset': true, 'seq': 0, 'byteOffset': 0};
  }
}

RangeResumeStrategy createRangeResumeStrategy() => const RangeResumeStrategy();

LastEventIdResumeStrategy createLastEventIdResumeStrategy() =>
    const LastEventIdResumeStrategy();

ContinuationResumeStrategy<T> createContinuationResumeStrategy<T>(
  T Function(ResumeContext ctx) fn,
) =>
    ContinuationResumeStrategy<T>(fn);

RestartResumeStrategy createRestartResumeStrategy() =>
    const RestartResumeStrategy();
