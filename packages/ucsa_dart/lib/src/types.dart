import 'dart:convert';
import 'package:crypto/crypto.dart';

/// Structured hierarchical key representing a cached query.
/// Must be JSON-serializable (numbers, strings, booleans, maps, lists, null).
typedef QueryKey = List<Object?>;

/// 5-stage lifecycle query status.
enum QueryStatus {
  idle,
  loading,
  success,
  error,
  retrying;

  bool get isIdle => this == QueryStatus.idle;
  bool get isLoading => this == QueryStatus.loading;
  bool get isSuccess => this == QueryStatus.success;
  bool get isError => this == QueryStatus.error;
  bool get isRetrying => this == QueryStatus.retrying;
}

/// Conflict resolution policies for optimistic offline updates.
enum ConflictPolicy {
  serverWins,
  clientWins,
  merge;

  String toWireString() => switch (this) {
        serverWins => 'server-wins',
        clientWins => 'client-wins',
        merge => 'merge',
      };

  static ConflictPolicy fromString(String value) => switch (value) {
        'server-wins' || 'serverWins' => serverWins,
        'client-wins' || 'clientWins' => clientWins,
        'merge' => merge,
        _ => throw ArgumentError('Unknown ConflictPolicy: $value'),
      };
}

/// Offline mutation lifecycle status.
enum OutboxMutationStatus {
  pending,
  inFlight,
  failed;

  String toWireString() => switch (this) {
        pending => 'pending',
        inFlight => 'in_flight',
        failed => 'failed',
      };

  static OutboxMutationStatus fromString(String value) => switch (value) {
        'pending' => pending,
        'in_flight' || 'inFlight' => inFlight,
        'failed' => failed,
        _ => throw ArgumentError('Unknown OutboxMutationStatus: $value'),
      };
}

/// Generates a deterministic normalized JSON string for a [QueryKey].
/// Maps inside the key have their keys sorted recursively.
String hashQueryKey(QueryKey queryKey) {
  Object? normalize(Object? value) {
    if (value is Map) {
      final sortedKeys = value.keys.map((k) => k.toString()).toList()..sort();
      final result = <String, Object?>{};
      for (final k in sortedKeys) {
        result[k] = normalize(value[k]);
      }
      return result;
    } else if (value is List) {
      return value.map(normalize).toList();
    }
    return value;
  }

  return jsonEncode(normalize(queryKey));
}

/// Computes hex-encoded SHA-256 of the input UTF-8 string or bytes.
String computeSha256(String input) {
  return sha256.convert(utf8.encode(input)).toString();
}

/// Authoritative cached query entry stored in memory and persisted in SQLite.
class CacheEntry<T> {
  final String queryHash;
  final QueryKey queryKey;
  final T dataPayload;
  final String? etag;
  final int createdAt;
  final int staleAt;
  final int expiresAt;
  final int payloadVersion;

  const CacheEntry({
    required this.queryHash,
    required this.queryKey,
    required this.dataPayload,
    this.etag,
    required this.createdAt,
    required this.staleAt,
    required this.expiresAt,
    this.payloadVersion = 1,
  });

  /// Checks if this cache entry is considered stale given the current or provided timestamp.
  bool isStale([int? now]) =>
      (now ?? DateTime.now().millisecondsSinceEpoch) >= staleAt;

  /// Checks if this cache entry has expired given the current or provided timestamp.
  bool isExpired([int? now]) =>
      (now ?? DateTime.now().millisecondsSinceEpoch) >= expiresAt;

  CacheEntry<T> copyWith({
    String? queryHash,
    QueryKey? queryKey,
    T? dataPayload,
    String? etag,
    int? createdAt,
    int? staleAt,
    int? expiresAt,
    int? payloadVersion,
  }) {
    return CacheEntry<T>(
      queryHash: queryHash ?? this.queryHash,
      queryKey: queryKey ?? this.queryKey,
      dataPayload: dataPayload ?? this.dataPayload,
      etag: etag ?? this.etag,
      createdAt: createdAt ?? this.createdAt,
      staleAt: staleAt ?? this.staleAt,
      expiresAt: expiresAt ?? this.expiresAt,
      payloadVersion: payloadVersion ?? this.payloadVersion,
    );
  }

  Map<String, dynamic> toJson() => {
        'query_hash': queryHash,
        'query_key': queryKey,
        'data_payload': dataPayload,
        if (etag != null) 'etag': etag,
        'created_at': createdAt,
        'stale_at': staleAt,
        'expires_at': expiresAt,
        'payload_version': payloadVersion,
      };

  factory CacheEntry.fromJson(
    Map<String, dynamic> json, {
    T Function(dynamic json)? dataParser,
  }) {
    final rawPayload = json['data_payload'] ?? json['dataPayload'];
    final keyRaw = json['query_key'] ?? json['queryKey'];
    return CacheEntry<T>(
      queryHash: (json['query_hash'] ?? json['queryHash']) as String,
      queryKey: (keyRaw as List).cast<Object?>(),
      dataPayload:
          dataParser != null ? dataParser(rawPayload) : rawPayload as T,
      etag: (json['etag']) as String?,
      createdAt: (json['created_at'] ?? json['createdAt']) as int,
      staleAt: (json['stale_at'] ?? json['staleAt']) as int,
      expiresAt: (json['expires_at'] ?? json['expiresAt']) as int,
      payloadVersion:
          (json['payload_version'] ?? json['payloadVersion'] ?? 1) as int,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CacheEntry<T> &&
          runtimeType == other.runtimeType &&
          queryHash == other.queryHash &&
          dataPayload == other.dataPayload &&
          etag == other.etag &&
          createdAt == other.createdAt &&
          staleAt == other.staleAt &&
          expiresAt == other.expiresAt &&
          payloadVersion == other.payloadVersion;

  @override
  int get hashCode => Object.hash(
        queryHash,
        dataPayload,
        etag,
        createdAt,
        staleAt,
        expiresAt,
        payloadVersion,
      );

  @override
  String toString() =>
      'CacheEntry($queryHash, staleAt: $staleAt, expiresAt: $expiresAt)';
}

/// Outbox mutation record for offline resilience and replay.
class OutboxMutation<T> {
  final String mutationId;
  final String endpoint;
  final String method;
  final Map<String, String>? headers;
  final T? payload;
  final OutboxMutationStatus status;
  final int retryCount;
  final int createdAt;
  final int? lastAttemptAt;
  final String? error;
  final bool forced;
  final ConflictPolicy? conflictPolicy;
  final String? leaseOwner;
  final int? leaseUntil;

  const OutboxMutation({
    required this.mutationId,
    required this.endpoint,
    required this.method,
    this.headers,
    this.payload,
    this.status = OutboxMutationStatus.pending,
    this.retryCount = 0,
    required this.createdAt,
    this.lastAttemptAt,
    this.error,
    this.forced = false,
    this.conflictPolicy,
    this.leaseOwner,
    this.leaseUntil,
  });

  bool get isPending => status == OutboxMutationStatus.pending;
  bool get isInFlight => status == OutboxMutationStatus.inFlight;
  bool get isFailed => status == OutboxMutationStatus.failed;

  OutboxMutation<T> copyWith({
    String? mutationId,
    String? endpoint,
    String? method,
    Map<String, String>? headers,
    T? payload,
    OutboxMutationStatus? status,
    int? retryCount,
    int? createdAt,
    int? lastAttemptAt,
    String? error,
    bool? forced,
    ConflictPolicy? conflictPolicy,
    String? leaseOwner,
    int? leaseUntil,
  }) {
    return OutboxMutation<T>(
      mutationId: mutationId ?? this.mutationId,
      endpoint: endpoint ?? this.endpoint,
      method: method ?? this.method,
      headers: headers ?? this.headers,
      payload: payload ?? this.payload,
      status: status ?? this.status,
      retryCount: retryCount ?? this.retryCount,
      createdAt: createdAt ?? this.createdAt,
      lastAttemptAt: lastAttemptAt ?? this.lastAttemptAt,
      error: error ?? this.error,
      forced: forced ?? this.forced,
      conflictPolicy: conflictPolicy ?? this.conflictPolicy,
      leaseOwner: leaseOwner ?? this.leaseOwner,
      leaseUntil: leaseUntil ?? this.leaseUntil,
    );
  }

  Map<String, dynamic> toJson() => {
        'mutation_id': mutationId,
        'endpoint': endpoint,
        'method': method,
        if (headers != null) 'headers': headers,
        if (payload != null) 'payload': payload,
        'status': status.toWireString(),
        'retry_count': retryCount,
        'created_at': createdAt,
        if (lastAttemptAt != null) 'last_attempt_at': lastAttemptAt,
        if (error != null) 'error': error,
        if (forced) 'forced': forced,
        if (conflictPolicy != null)
          'conflict_policy': conflictPolicy!.toWireString(),
        if (leaseOwner != null) 'lease_owner': leaseOwner,
        if (leaseUntil != null) 'lease_until': leaseUntil,
      };

  factory OutboxMutation.fromJson(
    Map<String, dynamic> json, {
    T Function(dynamic json)? payloadParser,
  }) {
    final rawStatus = json['status'];
    final parsedStatus = rawStatus is OutboxMutationStatus
        ? rawStatus
        : OutboxMutationStatus.fromString(rawStatus as String);

    final rawPolicy = json['conflict_policy'] ?? json['conflictPolicy'];
    final parsedPolicy = rawPolicy != null
        ? (rawPolicy is ConflictPolicy
            ? rawPolicy
            : ConflictPolicy.fromString(rawPolicy as String))
        : null;

    final rawHeaders = json['headers'];
    Map<String, String>? parsedHeaders;
    if (rawHeaders is Map) {
      parsedHeaders =
          rawHeaders.map((k, v) => MapEntry(k.toString(), v.toString()));
    }

    final rawPayload = json['payload'];
    return OutboxMutation<T>(
      mutationId: (json['mutation_id'] ?? json['mutationId']) as String,
      endpoint: json['endpoint'] as String,
      method: json['method'] as String,
      headers: parsedHeaders,
      payload:
          payloadParser != null ? payloadParser(rawPayload) : rawPayload as T?,
      status: parsedStatus,
      retryCount: (json['retry_count'] ?? json['retryCount'] ?? 0) as int,
      createdAt: (json['created_at'] ?? json['createdAt']) as int,
      lastAttemptAt: (json['last_attempt_at'] ?? json['lastAttemptAt']) as int?,
      error: json['error'] as String?,
      forced: (json['forced'] == true || json['forced'] == 1),
      conflictPolicy: parsedPolicy,
      leaseOwner: json['lease_owner'] as String?,
      leaseUntil: json['lease_until'] as int?,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is OutboxMutation<T> &&
          runtimeType == other.runtimeType &&
          mutationId == other.mutationId &&
          endpoint == other.endpoint &&
          method == other.method &&
          status == other.status &&
          retryCount == other.retryCount &&
          createdAt == other.createdAt &&
          leaseOwner == other.leaseOwner &&
          leaseUntil == other.leaseUntil;

  @override
  int get hashCode => Object.hash(
        mutationId,
        endpoint,
        method,
        status,
        retryCount,
        createdAt,
        leaseOwner,
        leaseUntil,
      );

  @override
  String toString() =>
      'OutboxMutation($mutationId, $method $endpoint, status: ${status.name}, retries: $retryCount, leaseOwner: $leaseOwner, leaseUntil: $leaseUntil)';
}

/// Result of replaying offline mutations.
class ReplayResult {
  final int processed;
  final int successful;
  final int failed;

  const ReplayResult({
    required this.processed,
    required this.successful,
    required this.failed,
  });

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ReplayResult &&
          runtimeType == other.runtimeType &&
          processed == other.processed &&
          successful == other.successful &&
          failed == other.failed;

  @override
  int get hashCode => processed.hashCode ^ successful.hashCode ^ failed.hashCode;

  @override
  String toString() =>
      'ReplayResult(processed: $processed, successful: $successful, failed: $failed)';
}

/// In-memory reactive query state representation.
class QueryState<T> {
  final QueryStatus status;
  final T? data;
  final Object? error;
  final int? dataUpdatedAt;
  final int? errorUpdatedAt;
  final bool isFetching;

  const QueryState({
    this.status = QueryStatus.idle,
    this.data,
    this.error,
    this.dataUpdatedAt,
    this.errorUpdatedAt,
    this.isFetching = false,
  });

  bool get isIdle => status == QueryStatus.idle;
  bool get isLoading => status == QueryStatus.loading;
  bool get isSuccess => status == QueryStatus.success;
  bool get isError => status == QueryStatus.error;
  bool get isRetrying => status == QueryStatus.retrying;

  QueryState<T> copyWith({
    QueryStatus? status,
    T? data,
    Object? error,
    int? dataUpdatedAt,
    int? errorUpdatedAt,
    bool? isFetching,
  }) {
    return QueryState<T>(
      status: status ?? this.status,
      data: data ?? this.data,
      error: error ?? this.error,
      dataUpdatedAt: dataUpdatedAt ?? this.dataUpdatedAt,
      errorUpdatedAt: errorUpdatedAt ?? this.errorUpdatedAt,
      isFetching: isFetching ?? this.isFetching,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is QueryState<T> &&
          runtimeType == other.runtimeType &&
          status == other.status &&
          data == other.data &&
          error == other.error &&
          dataUpdatedAt == other.dataUpdatedAt &&
          errorUpdatedAt == other.errorUpdatedAt &&
          isFetching == other.isFetching;

  @override
  int get hashCode => Object.hash(
        status,
        data,
        error,
        dataUpdatedAt,
        errorUpdatedAt,
        isFetching,
      );

  @override
  String toString() =>
      'QueryState(status: ${status.name}, data: $data, isFetching: $isFetching, error: $error)';
}

/// Cooperative cancellation token for in-flight query operations.
class CancellationToken {
  bool _isCancelled = false;
  bool get isCancelled => _isCancelled;

  final List<void Function()> _listeners = [];

  void cancel() {
    if (_isCancelled) return;
    _isCancelled = true;
    for (final l in List<void Function()>.from(_listeners)) {
      try {
        l();
      } catch (_) {}
    }
    _listeners.clear();
  }

  void onCancel(void Function() listener) {
    if (_isCancelled) {
      listener();
    } else {
      _listeners.add(listener);
    }
  }
}

/// Context provided to producer function in a streaming query.
class StreamFnContext {
  final String queryHash;
  final CancellationToken? cancellationToken;
  final Map<String, String>? resumeHeaders;
  final dynamic continuationPayload;

  const StreamFnContext({
    required this.queryHash,
    this.cancellationToken,
    this.resumeHeaders,
    this.continuationPayload,
  });
}

/// Category of persistent event logged to ucsa_change_log.
enum ChangeLogKind {
  invalidate,
  mutation,
  stream,
  reset;

  String toWireString() => name;

  static ChangeLogKind fromString(String value) => switch (value) {
        'invalidate' => invalidate,
        'mutation' => mutation,
        'stream' => stream,
        'reset' => reset,
        _ => throw ArgumentError('Unknown ChangeLogKind: $value'),
      };
}

/// Authoritative row in ucsa_change_log table.
class ChangeLogRow {
  final int seq;
  final String origin;
  final ChangeLogKind kind;
  final List<String>? tags;
  final List<String>? queryHashes;
  final Map<String, dynamic>? detail;
  final int createdAt;

  const ChangeLogRow({
    required this.seq,
    required this.origin,
    required this.kind,
    this.tags,
    this.queryHashes,
    this.detail,
    required this.createdAt,
  });

  List<String>? get query_hashes => queryHashes;
  int get created_at => createdAt;

  @override
  String toString() =>
      'ChangeLogRow(seq: $seq, origin: $origin, kind: ${kind.name}, tags: $tags, queryHashes: $queryHashes)';
}

/// Result of reading changes from ucsa_change_log with gap/truncation detection.
class ReadChangesResult {
  final List<ChangeLogRow> rows;
  final bool truncated;
  final int headSeq;

  const ReadChangesResult({
    required this.rows,
    required this.truncated,
    required this.headSeq,
  });

  @override
  String toString() =>
      'ReadChangesResult(rows: ${rows.length}, truncated: $truncated, headSeq: $headSeq)';
}

/// Streaming chunk store status.
enum StreamStatus {
  open,
  complete,
  aborted,
  error;

  String toWireString() => name;

  static StreamStatus fromString(String value) => switch (value) {
        'open' => open,
        'complete' => complete,
        'aborted' => aborted,
        'error' => error,
        _ => throw ArgumentError('Unknown StreamStatus: $value'),
      };
}

/// Encoding for streaming chunk payloads.
enum StreamEncoding {
  utf8,
  bytes;

  String toWireString() => name;

  static StreamEncoding fromString(String value) => switch (value) {
        'utf8' => utf8,
        'bytes' => bytes,
        _ => throw ArgumentError('Unknown StreamEncoding: $value'),
      };
}

/// Resume strategy for reconnecting streams.
enum ResumeKind {
  range,
  lastEventId,
  continuation,
  restart;

  String toWireString() => switch (this) {
        range => 'range',
        lastEventId => 'last-event-id',
        continuation => 'continuation',
        restart => 'restart',
      };

  static ResumeKind fromString(String value) => switch (value) {
        'range' => range,
        'last-event-id' || 'lastEventId' => lastEventId,
        'continuation' => continuation,
        'restart' => restart,
        _ => throw ArgumentError('Unknown ResumeKind: $value'),
      };
}

/// Authoritative stream record in ucsa_streams table.
class StreamRecord {
  final String queryHash;
  final QueryKey queryKey;
  final StreamStatus status;
  final StreamEncoding encoding;
  final int nextSeq;
  final int byteLength;
  final ResumeKind? resumeKind;
  final String? resumeToken;
  final String? etag;
  final String? writerId;
  final int? writerLeaseUntil;
  final int payloadVersion;
  final String? error;
  final int createdAt;
  final int updatedAt;
  final int expiresAt;

  const StreamRecord({
    required this.queryHash,
    required this.queryKey,
    required this.status,
    required this.encoding,
    required this.nextSeq,
    required this.byteLength,
    this.resumeKind,
    this.resumeToken,
    this.etag,
    this.writerId,
    this.writerLeaseUntil,
    this.payloadVersion = 1,
    this.error,
    required this.createdAt,
    required this.updatedAt,
    required this.expiresAt,
  });

  Map<String, dynamic> toJson() => {
        'query_hash': queryHash,
        'query_key': queryKey,
        'status': status.toWireString(),
        'encoding': encoding.toWireString(),
        'next_seq': nextSeq,
        'byte_length': byteLength,
        if (resumeKind != null) 'resume_kind': resumeKind!.toWireString(),
        if (resumeToken != null) 'resume_token': resumeToken,
        if (etag != null) 'etag': etag,
        if (writerId != null) 'writer_id': writerId,
        if (writerLeaseUntil != null) 'writer_lease_until': writerLeaseUntil,
        'payload_version': payloadVersion,
        if (error != null) 'error': error,
        'created_at': createdAt,
        'updated_at': updatedAt,
        'expires_at': expiresAt,
      };

  @override
  String toString() =>
      'StreamRecord($queryHash, status: ${status.name}, nextSeq: $nextSeq, byteLength: $byteLength)';
}

/// Chunk of streaming payload in ucsa_stream_chunks table.
class StreamChunk {
  final String queryHash;
  final int seq;
  final int byteOffset;
  final List<int> data;

  const StreamChunk({
    required this.queryHash,
    required this.seq,
    required this.byteOffset,
    required this.data,
  });

  Map<String, dynamic> toJson() => {
        'query_hash': queryHash,
        'seq': seq,
        'byte_offset': byteOffset,
        'data_length': data.length,
      };

  @override
  String toString() =>
      'StreamChunk($queryHash, seq: $seq, offset: $byteOffset, len: ${data.length})';
}
