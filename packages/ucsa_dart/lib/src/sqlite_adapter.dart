import 'dart:convert';
import 'dart:math';
import 'package:sqlite3/sqlite3.dart';
import 'types.dart';
import 'migration_runner.dart';
import 'cas_store.dart';

String _generateUuidV4() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}';
}

/// SQLite storage adapter providing WAL journaling, tag indexing with cascade
/// invalidation, and mutation outbox persistence.
class SqliteAdapter {
  final Database _db;
  final bool _isInMemory;
  final String _origin;
  final String? _path;
  bool _isClosed = false;
  int _transactionDepth = 0;

  SqliteAdapter({String? path, Database? db, String? origin, int? targetVersion})
      : _path = path,
        _db = db ??
            (path == null || path == ':memory:'
                ? sqlite3.openInMemory()
                : sqlite3.open(path)),
        _isInMemory =
            db != null ? false : (path == null || path == ':memory:'),
        _origin = origin ?? _generateUuidV4() {
    _db.execute('PRAGMA foreign_keys = ON;');
    _db.execute('PRAGMA busy_timeout = 5000;');
    if (!_isInMemory) {
      _db.execute('PRAGMA journal_mode = WAL;');
      _db.execute('PRAGMA synchronous = NORMAL;');
    }
    initSchema(targetVersion: targetVersion ?? targetSchemaVersion);
  }

  factory SqliteAdapter.inMemory({String? origin, int? targetVersion}) =>
      SqliteAdapter(origin: origin, targetVersion: targetVersion);

  factory SqliteAdapter.file(String path, {String? origin, int? targetVersion}) =>
      SqliteAdapter(path: path, origin: origin, targetVersion: targetVersion);

  /// Unique origin identifier for this adapter.
  String get origin => _origin;

  /// Database file path, or null if in-memory.
  String? get path => _path;

  /// Underlying SQLite database handle.
  Database get db => _db;

  /// Whether the database handle has been closed.
  bool get isClosed => _isClosed;

  /// Returns current user_version from SQLite schema.
  int getSchemaVersion() => MigrationRunner.getUserVersion(_db);

  /// Initializes UCSA tables and indexes by executing migrations.
  void initSchema({int targetVersion = targetSchemaVersion}) {
    MigrationRunner.migrate(_db, targetVersion: targetVersion);
  }

  /// Runs [action] within a transaction. Supports reentrant/nested calls.
  T transaction<T>(T Function() action) {
    final isTopLevel = _transactionDepth == 0;
    if (isTopLevel) {
      _db.execute('BEGIN TRANSACTION;');
    }
    _transactionDepth++;
    try {
      final result = action();
      _transactionDepth--;
      if (isTopLevel) {
        _db.execute('COMMIT;');
      }
      return result;
    } catch (e) {
      _transactionDepth--;
      if (isTopLevel) {
        _db.execute('ROLLBACK;');
      }
      rethrow;
    }
  }

  /// Persists or updates a query entry in SQLite and synchronizes tag mappings.
  void setQuery<T>(CacheEntry<T> entry, {List<String>? tags}) {
    final serializedKey = jsonEncode(entry.queryKey);
    final serializedPayload = jsonEncode(entry.dataPayload);

    transaction(() {
      if (getSchemaVersion() >= 2) {
        _db.execute(
          '''
          INSERT INTO ucsa_query_cache (
            query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(query_hash) DO UPDATE SET
            query_key = excluded.query_key,
            data_payload = excluded.data_payload,
            etag = excluded.etag,
            created_at = excluded.created_at,
            stale_at = excluded.stale_at,
            expires_at = excluded.expires_at,
            payload_version = excluded.payload_version;
          ''',
          [
            entry.queryHash,
            serializedKey,
            serializedPayload,
            entry.etag,
            entry.createdAt,
            entry.staleAt,
            entry.expiresAt,
            entry.payloadVersion,
          ],
        );
      } else {
        _db.execute(
          '''
          INSERT INTO ucsa_query_cache (
            query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(query_hash) DO UPDATE SET
            query_key = excluded.query_key,
            data_payload = excluded.data_payload,
            etag = excluded.etag,
            created_at = excluded.created_at,
            stale_at = excluded.stale_at,
            expires_at = excluded.expires_at;
          ''',
          [
            entry.queryHash,
            serializedKey,
            serializedPayload,
            entry.etag,
            entry.createdAt,
            entry.staleAt,
            entry.expiresAt,
          ],
        );
      }

      if (tags != null) {
        _db.execute(
          'DELETE FROM ucsa_cache_tags WHERE query_hash = ?;',
          [entry.queryHash],
        );
        for (final tag in tags) {
          _db.execute(
            '''
            INSERT OR IGNORE INTO ucsa_cache_tags (tag, query_hash)
            VALUES (?, ?);
            ''',
            [tag, entry.queryHash],
          );
        }
      }
    });
  }

  /// Retrieves and deserializes a cached query entry by hash.
  CacheEntry<T>? getQuery<T>(
    String queryHash, {
    T Function(dynamic json)? dataParser,
  }) {
    final hasPayloadVersion = getSchemaVersion() >= 2;
    final sql = hasPayloadVersion
        ? '''
          SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
          FROM ucsa_query_cache
          WHERE query_hash = ?;
          '''
        : '''
          SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
          FROM ucsa_query_cache
          WHERE query_hash = ?;
          ''';

    final rows = _db.select(sql, [queryHash]);

    if (rows.isEmpty) return null;
    final row = rows.first;

    final decodedKey = jsonDecode(row['query_key'] as String);
    final decodedPayload = jsonDecode(row['data_payload'] as String);

    return CacheEntry<T>(
      queryHash: row['query_hash'] as String,
      queryKey: (decodedKey as List).cast<Object?>(),
      dataPayload:
          dataParser != null ? dataParser(decodedPayload) : decodedPayload as T,
      etag: row['etag'] as String?,
      createdAt: row['created_at'] as int,
      staleAt: row['stale_at'] as int,
      expiresAt: row['expires_at'] as int,
      payloadVersion: (hasPayloadVersion && row['payload_version'] != null)
          ? row['payload_version'] as int
          : 1,
    );
  }

  /// Deletes a cached query entry by hash.
  /// Cascade delete cleans up associated tags in [ucsa_cache_tags].
  /// If schema version >= 3, atomically journals an invalidate change log entry.
  /// Returns true if a row was deleted.
  bool deleteQuery(String queryHash, {String? origin}) {
    return transaction(() {
      _db.execute(
        'DELETE FROM ucsa_query_cache WHERE query_hash = ?;',
        [queryHash],
      );
      final wasDeleted = _db.updatedRows > 0;
      if (wasDeleted && getSchemaVersion() >= 3) {
        appendChangeLog(
          ChangeLogKind.invalidate,
          origin: origin ?? _origin,
          queryHashes: [queryHash],
        );
      }
      return wasDeleted;
    });
  }

  /// Invalidates all queries associated with the given tag.
  /// Returns the list of query hashes that were deleted.
  /// If schema version >= 3, atomically journals an invalidate change log entry.
  List<String> invalidateByTag(String tag, {String? origin}) {
    return transaction(() {
      final hashes = getQueryHashesByTag(tag);
      for (final hash in hashes) {
        _db.execute(
          'DELETE FROM ucsa_query_cache WHERE query_hash = ?;',
          [hash],
        );
      }
      if (getSchemaVersion() >= 3) {
        appendChangeLog(
          ChangeLogKind.invalidate,
          origin: origin ?? _origin,
          tags: [tag],
          queryHashes: hashes,
        );
      }
      return hashes;
    });
  }

  /// Appends an entry to ucsa_change_log and returns the generated seq number.
  int appendChangeLog(
    ChangeLogKind kind, {
    String? origin,
    List<String>? tags,
    List<String>? queryHashes,
    Map<String, dynamic>? detail,
  }) {
    final entryOrigin = origin ?? _origin;
    final tagsJson = tags != null ? jsonEncode(tags) : null;
    final queryHashesJson = queryHashes != null ? jsonEncode(queryHashes) : null;
    final detailJson = detail != null ? jsonEncode(detail) : null;
    final createdAt = DateTime.now().millisecondsSinceEpoch;

    _db.execute(
      '''
      INSERT INTO ucsa_change_log (
        origin, kind, tags, query_hashes, detail, created_at
      ) VALUES (?, ?, ?, ?, ?, ?);
      ''',
      [entryOrigin, kind.toWireString(), tagsJson, queryHashesJson, detailJson, createdAt],
    );

    return _db.lastInsertRowId;
  }

  /// Reads change log entries created since [lastSeq] in ascending sequence order up to [limit].
  /// Detects gaps caused by pruning (truncated: true).
  ReadChangesResult readChangesSince(int lastSeq, {int limit = 1000}) {
    final maxRow = _db.select('SELECT MAX(seq) as max_seq FROM ucsa_change_log;');
    final headSeq = maxRow.isNotEmpty ? (maxRow.first['max_seq'] as int? ?? 0) : 0;

    final minRow = _db.select('SELECT MIN(seq) as min_seq FROM ucsa_change_log;');
    final minSeq = minRow.isNotEmpty ? minRow.first['min_seq'] as int? : null;

    bool truncated = false;
    if (lastSeq > 0 && minSeq != null && lastSeq < minSeq - 1) {
      truncated = true;
    }

    final rows = _db.select(
      '''
      SELECT seq, origin, kind, tags, query_hashes, detail, created_at
      FROM ucsa_change_log
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?;
      ''',
      [lastSeq, limit],
    );

    final changeRows = rows.map((row) {
      final tagsJson = row['tags'] as String?;
      final hashesJson = row['query_hashes'] as String?;
      final detailJson = row['detail'] as String?;

      return ChangeLogRow(
        seq: row['seq'] as int,
        origin: row['origin'] as String,
        kind: ChangeLogKind.fromString(row['kind'] as String),
        tags: tagsJson != null ? (jsonDecode(tagsJson) as List).cast<String>() : null,
        queryHashes: hashesJson != null
            ? (jsonDecode(hashesJson) as List).cast<String>()
            : null,
        detail: detailJson != null
            ? jsonDecode(detailJson) as Map<String, dynamic>
            : null,
        createdAt: row['created_at'] as int,
      );
    }).toList();

    return ReadChangesResult(
      rows: changeRows,
      truncated: truncated,
      headSeq: headSeq,
    );
  }

  /// Prunes old change log entries beyond retention window (retentionMs)
  /// or beyond maxRows ceiling (retaining newest maxRows).
  int pruneChangeLog({int retentionMs = 86400000, int maxRows = 10000}) {
    final cutoff = DateTime.now().millisecondsSinceEpoch - retentionMs;

    return transaction(() {
      int? seqThreshold;
      if (maxRows > 0) {
        final rows = _db.select(
          'SELECT seq FROM ucsa_change_log ORDER BY seq DESC LIMIT 1 OFFSET ?;',
          [maxRows],
        );
        if (rows.isNotEmpty) {
          seqThreshold = rows.first['seq'] as int;
        }
      }

      if (seqThreshold != null) {
        _db.execute(
          'DELETE FROM ucsa_change_log WHERE created_at < ? OR seq <= ?;',
          [cutoff, seqThreshold],
        );
      } else {
        _db.execute(
          'DELETE FROM ucsa_change_log WHERE created_at < ?;',
          [cutoff],
        );
      }

      return _db.updatedRows;
    });
  }

  /// Returns all query hashes associated with a tag without deleting them.
  List<String> getQueryHashesByTag(String tag) {
    final rows = _db.select(
      'SELECT query_hash FROM ucsa_cache_tags WHERE tag = ?;',
      [tag],
    );
    return rows.map((r) => r['query_hash'] as String).toList();
  }

  /// Returns all tags associated with a specific query hash.
  List<String> getTagsForQuery(String queryHash) {
    final rows = _db.select(
      'SELECT tag FROM ucsa_cache_tags WHERE query_hash = ?;',
      [queryHash],
    );
    return rows.map((r) => r['tag'] as String).toList();
  }

  /// Returns all query entries whose expires_at timestamp is <= the specified cutoff.
  List<CacheEntry<dynamic>> getExpiredQueries({
    int? now,
    dynamic Function(dynamic json)? dataParser,
  }) {
    final cutoff = now ?? DateTime.now().millisecondsSinceEpoch;
    final rows = _db.select(
      '''
      SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
      FROM ucsa_query_cache
      WHERE expires_at <= ?;
      ''',
      [cutoff],
    );

    return rows.map((row) {
      final decodedKey = jsonDecode(row['query_key'] as String);
      final decodedPayload = jsonDecode(row['data_payload'] as String);
      return CacheEntry<dynamic>(
        queryHash: row['query_hash'] as String,
        queryKey: (decodedKey as List).cast<Object?>(),
        dataPayload:
            dataParser != null ? dataParser(decodedPayload) : decodedPayload,
        etag: row['etag'] as String?,
        createdAt: row['created_at'] as int,
        staleAt: row['stale_at'] as int,
        expiresAt: row['expires_at'] as int,
      );
    }).toList();
  }

  /// Persists or updates an outbox mutation.
  void setMutation<T>(OutboxMutation<T> mutation) {
    _db.execute(
      '''
      INSERT INTO ucsa_mutation_outbox (
        mutation_id, endpoint, method, headers, payload, status,
        retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
        lease_owner, lease_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mutation_id) DO UPDATE SET
        endpoint = excluded.endpoint,
        method = excluded.method,
        headers = excluded.headers,
        payload = excluded.payload,
        status = excluded.status,
        retry_count = excluded.retry_count,
        created_at = excluded.created_at,
        last_attempt_at = excluded.last_attempt_at,
        error = excluded.error,
        forced = excluded.forced,
        conflict_policy = excluded.conflict_policy,
        lease_owner = excluded.lease_owner,
        lease_until = excluded.lease_until;
      ''',
      [
        mutation.mutationId,
        mutation.endpoint,
        mutation.method,
        mutation.headers != null ? jsonEncode(mutation.headers) : null,
        mutation.payload != null ? jsonEncode(mutation.payload) : null,
        mutation.status.toWireString(),
        mutation.retryCount,
        mutation.createdAt,
        mutation.lastAttemptAt,
        mutation.error,
        mutation.forced ? 1 : 0,
        mutation.conflictPolicy?.toWireString(),
        mutation.leaseOwner,
        mutation.leaseUntil,
      ],
    );
  }

  OutboxMutation<T> _mapRowToMutation<T>(
    Row row, {
    T Function(dynamic json)? payloadParser,
  }) {
    Map<String, String>? headers;
    if (row['headers'] != null) {
      final decoded = jsonDecode(row['headers'] as String) as Map;
      headers = decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
    }

    T? payload;
    if (row['payload'] != null) {
      final decoded = jsonDecode(row['payload'] as String);
      payload = payloadParser != null ? payloadParser(decoded) : decoded as T?;
    }

    final rawPolicy = row['conflict_policy'] as String?;
    final policy =
        rawPolicy != null ? ConflictPolicy.fromString(rawPolicy) : null;

    return OutboxMutation<T>(
      mutationId: row['mutation_id'] as String,
      endpoint: row['endpoint'] as String,
      method: row['method'] as String,
      headers: headers,
      payload: payload,
      status: OutboxMutationStatus.fromString(row['status'] as String),
      retryCount: row['retry_count'] as int,
      createdAt: row['created_at'] as int,
      lastAttemptAt: row['last_attempt_at'] as int?,
      error: row['error'] as String?,
      forced: (row['forced'] as int? ?? 0) == 1,
      conflictPolicy: policy,
      leaseOwner: row['lease_owner'] as String?,
      leaseUntil: row['lease_until'] as int?,
    );
  }

  /// Retrieves an outbox mutation by ID.
  OutboxMutation<T>? getMutation<T>(
    String mutationId, {
    T Function(dynamic json)? payloadParser,
  }) {
    final rows = _db.select(
      '''
      SELECT mutation_id, endpoint, method, headers, payload, status,
             retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
             lease_owner, lease_until
      FROM ucsa_mutation_outbox
      WHERE mutation_id = ?;
      ''',
      [mutationId],
    );

    if (rows.isEmpty) return null;
    return _mapRowToMutation<T>(rows.first, payloadParser: payloadParser);
  }

  /// Returns pending mutations ordered by created_at ascending.
  List<OutboxMutation<dynamic>> getPendingMutations({int limit = 100}) {
    final rows = _db.select(
      '''
      SELECT mutation_id, endpoint, method, headers, payload, status,
             retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
             lease_owner, lease_until
      FROM ucsa_mutation_outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?;
      ''',
      [limit],
    );

    return rows.map((row) => _mapRowToMutation<dynamic>(row)).toList();
  }

  /// Atomically claims pending or expired in-flight mutations for a specific worker.
  List<OutboxMutation<dynamic>> claimPendingMutations(
    String workerId,
    int leaseDurationMs, {
    int limit = 50,
  }) {
    return transaction(() {
      final now = DateTime.now().millisecondsSinceEpoch;
      final leaseUntil = now + leaseDurationMs;

      final candidates = _db.select(
        '''
        SELECT mutation_id
        FROM ucsa_mutation_outbox
        WHERE status = 'pending' OR (status = 'in_flight' AND lease_until IS NOT NULL AND lease_until < ?)
        ORDER BY created_at ASC
        LIMIT ?;
        ''',
        [now, limit],
      );

      if (candidates.isEmpty) {
        return <OutboxMutation<dynamic>>[];
      }

      final candidateIds =
          candidates.map((c) => c['mutation_id'] as String).toList();
      final placeholders = List.filled(candidateIds.length, '?').join(', ');

      _db.execute(
        '''
        UPDATE ucsa_mutation_outbox
        SET status = 'in_flight',
            lease_owner = ?,
            lease_until = ?,
            last_attempt_at = ?
        WHERE mutation_id IN ($placeholders);
        ''',
        [workerId, leaseUntil, now, ...candidateIds],
      );

      final rows = _db.select(
        '''
        SELECT mutation_id, endpoint, method, headers, payload, status,
               retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
               lease_owner, lease_until
        FROM ucsa_mutation_outbox
        WHERE mutation_id IN ($placeholders)
        ORDER BY created_at ASC;
        ''',
        candidateIds,
      );

      return rows.map((row) => _mapRowToMutation<dynamic>(row)).toList();
    });
  }

  /// Updates status and retry metadata for an outbox mutation.
  void updateMutationStatus(
    String mutationId,
    OutboxMutationStatus status, {
    int? lastAttemptAt,
    String? error,
    int? retryCount,
    String? leaseOwner,
    int? leaseUntil,
  }) {
    _db.execute(
      '''
      UPDATE ucsa_mutation_outbox
      SET status = ?,
          last_attempt_at = COALESCE(?, last_attempt_at),
          error = ?,
          retry_count = COALESCE(?, retry_count),
          lease_owner = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(?, lease_owner) END,
          lease_until = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(?, lease_until) END
      WHERE mutation_id = ?;
      ''',
      [
        status.toWireString(),
        lastAttemptAt,
        error,
        retryCount,
        status.toWireString(),
        leaseOwner,
        status.toWireString(),
        leaseUntil,
        mutationId,
      ],
    );
  }

  /// Deletes an outbox mutation by ID.
  void deleteMutation(String mutationId) {
    _db.execute(
      'DELETE FROM ucsa_mutation_outbox WHERE mutation_id = ?;',
      [mutationId],
    );
  }

  /// Replays pending outbox mutations sequentially via an executor function.
  /// Supports [rateLimit] delay between mutations, [batchSize] limits, and distributed leases.
  Future<ReplayResult> replayOutbox(
    Future<Map<String, dynamic>> Function(OutboxMutation<dynamic> mutation)
        executor, {
    Duration? rateLimit,
    int? batchSize,
    String? workerId,
    int? leaseDurationMs,
    Future<String> Function(
            OutboxMutation<dynamic> mutation, dynamic conflictData)?
        conflictResolver,
  }) async {
    final effectiveWorkerId =
        workerId ?? 'worker-${DateTime.now().microsecondsSinceEpoch}';
    final effectiveLease = leaseDurationMs ?? 30000;
    final limit = batchSize ?? 100;

    final claimed = claimPendingMutations(
      effectiveWorkerId,
      effectiveLease,
      limit: limit,
    );

    int processed = 0;
    int successful = 0;
    int failed = 0;

    for (int i = 0; i < claimed.length; i++) {
      final mutation = claimed[i];
      if (i > 0 && rateLimit != null && rateLimit > Duration.zero) {
        await Future.delayed(rateLimit);
      }
      processed++;

      try {
        final res = await executor(mutation);
        final status = res['status'] as int? ?? 200;

        if (status >= 200 && status < 300) {
          deleteMutation(mutation.mutationId);
          successful++;
        } else if (status == 409) {
          // Conflict
          String resolution = 'rollback';
          if (conflictResolver != null) {
            resolution = await conflictResolver(mutation, res['data']);
          } else if (mutation.conflictPolicy == ConflictPolicy.clientWins) {
            resolution = 'force';
          } else {
            resolution = 'rollback';
          }

          if (resolution == 'rollback') {
            deleteMutation(mutation.mutationId);
            successful++;
          } else if (resolution == 'force') {
            updateMutationStatus(
                mutation.mutationId, OutboxMutationStatus.pending);
          }
        } else if (status >= 400 && status < 500) {
          updateMutationStatus(
            mutation.mutationId,
            OutboxMutationStatus.failed,
            error: 'HTTP $status',
          );
          failed++;
        } else {
          // Transient failure
          final nextRetry = mutation.retryCount + 1;
          final isPermanent = nextRetry >= 3;
          updateMutationStatus(
            mutation.mutationId,
            isPermanent
                ? OutboxMutationStatus.failed
                : OutboxMutationStatus.pending,
            error: 'HTTP $status',
            retryCount: nextRetry,
          );
          if (isPermanent) failed++;
        }
      } catch (e) {
        final nextRetry = mutation.retryCount + 1;
        final isPermanent = nextRetry >= 3;
        updateMutationStatus(
          mutation.mutationId,
          isPermanent
              ? OutboxMutationStatus.failed
              : OutboxMutationStatus.pending,
          error: e.toString(),
          retryCount: nextRetry,
        );
        if (isPermanent) failed++;
      }
    }

    return ReplayResult(
      processed: processed,
      successful: successful,
      failed: failed,
    );
  }

  /// Inserts or updates a CAS object record with size and last accessed time.
  void upsertCasObject(
    String hash,
    int size, {
    int? lastAccessedAt,
  }) {
    final accessTime = lastAccessedAt ?? DateTime.now().millisecondsSinceEpoch;
    _db.execute(
      '''
      INSERT INTO ucsa_cas_objects (hash, size, last_accessed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        size = excluded.size,
        last_accessed_at = excluded.last_accessed_at;
      ''',
      [hash, size, accessTime],
    );
  }

  /// Retrieves a CAS object record by hash.
  Map<String, dynamic>? getCasObject(String hash) {
    final rows = _db.select(
      'SELECT hash, size, last_accessed_at FROM ucsa_cas_objects WHERE hash = ?;',
      [hash],
    );
    if (rows.isEmpty) return null;
    final row = rows.first;
    return {
      'hash': row['hash'] as String,
      'size': row['size'] as int,
      'last_accessed_at': row['last_accessed_at'] as int,
    };
  }

  /// Updates the last_accessed_at timestamp for a CAS object.
  bool updateCasAccessTime(String hash, {int? lastAccessedAt}) {
    final accessTime = lastAccessedAt ?? DateTime.now().millisecondsSinceEpoch;
    _db.execute(
      'UPDATE ucsa_cas_objects SET last_accessed_at = ? WHERE hash = ?;',
      [accessTime, hash],
    );
    return _db.updatedRows > 0;
  }

  /// Deletes a CAS object record.
  bool deleteCasObject(String hash) {
    _db.execute(
      'DELETE FROM ucsa_cas_objects WHERE hash = ?;',
      [hash],
    );
    return _db.updatedRows > 0;
  }

  /// Returns the total size of all CAS objects tracked in the database.
  int getTotalCasSize() {
    final rows = _db.select(
        'SELECT COALESCE(SUM(size), 0) AS total FROM ucsa_cas_objects;');
    if (rows.isEmpty) return 0;
    return (rows.first['total'] as num).toInt();
  }

  /// Returns CAS objects ordered by LRU (least recently accessed first).
  List<Map<String, dynamic>> getLruCasObjects({int? limit}) {
    final sql = limit != null
        ? 'SELECT hash, size, last_accessed_at FROM ucsa_cas_objects ORDER BY last_accessed_at ASC LIMIT ?;'
        : 'SELECT hash, size, last_accessed_at FROM ucsa_cas_objects ORDER BY last_accessed_at ASC;';
    final rows = limit != null ? _db.select(sql, [limit]) : _db.select(sql);
    return rows
        .map((r) => {
              'hash': r['hash'] as String,
              'size': r['size'] as int,
              'last_accessed_at': r['last_accessed_at'] as int,
            })
        .toList();
  }

  /// Checkpoints the SQLite WAL log.
  /// Defaults to 'TRUNCATE' mode.
  void checkpoint([String mode = 'TRUNCATE']) {
    if (!_isClosed && !_isInMemory) {
      _db.execute('PRAGMA wal_checkpoint($mode);');
    }
  }

  /// Creates a new streaming chunk record in ucsa_streams and registers associated tags.
  StreamRecord createStream(
    QueryKey queryKey, {
    StreamEncoding encoding = StreamEncoding.utf8,
    ResumeKind? resumeKind,
    String? resumeToken,
    String? etag,
    String? writerId,
    int? writerLeaseUntil,
    int payloadVersion = 1,
    int ttlMs = 300000,
    List<String>? tags,
  }) {
    final queryHash = hashQueryKey(queryKey);
    final now = DateTime.now().millisecondsSinceEpoch;
    final expiresAt = now + ttlMs;
    final serializedKey = jsonEncode(queryKey);

    transaction(() {
      _db.execute(
        '''
        INSERT INTO ucsa_streams (
          query_hash, query_key, status, encoding, next_seq, byte_length,
          resume_kind, resume_token, etag, writer_id, writer_lease_until,
          payload_version, error, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        ''',
        [
          queryHash,
          serializedKey,
          StreamStatus.open.name,
          encoding.name,
          0,
          0,
          resumeKind?.toWireString(),
          resumeToken,
          etag,
          writerId,
          writerLeaseUntil,
          payloadVersion,
          null,
          now,
          now,
          expiresAt,
        ],
      );

      if (tags != null && tags.isNotEmpty) {
        for (final tag in tags) {
          _db.execute(
            '''
            INSERT OR IGNORE INTO ucsa_stream_tags (tag, query_hash)
            VALUES (?, ?);
            ''',
            [tag, queryHash],
          );
        }
      }
    });

    return StreamRecord(
      queryHash: queryHash,
      queryKey: queryKey,
      status: StreamStatus.open,
      encoding: encoding,
      nextSeq: 0,
      byteLength: 0,
      resumeKind: resumeKind,
      resumeToken: resumeToken,
      etag: etag,
      writerId: writerId,
      writerLeaseUntil: writerLeaseUntil,
      payloadVersion: payloadVersion,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: expiresAt,
    );
  }

  /// Appends a chunk to the stream, validating sequence contiguity and byte offsets.
  Map<String, dynamic> appendStreamChunk(
    String queryHash,
    dynamic data, {
    int? expectedSeq,
  }) {
    final List<int> bytes = data is String
        ? utf8.encode(data)
        : (data is List<int> ? data : (data as List).cast<int>());

    return transaction(() {
      final rows = _db.select(
        'SELECT status, next_seq, byte_length FROM ucsa_streams WHERE query_hash = ?;',
        [queryHash],
      );

      if (rows.isEmpty) {
        throw StateError('Stream not found: $queryHash');
      }

      final row = rows.first;
      final statusStr = row['status'] as String;
      if (statusStr != 'open') {
        throw StateError('Stream is not open (status: $statusStr)');
      }

      final nextSeq = row['next_seq'] as int;
      if (expectedSeq != null && expectedSeq != nextSeq) {
        throw StateError(
          'Sequence mismatch: expected $expectedSeq, but next sequence is $nextSeq',
        );
      }

      final seq = nextSeq;
      final byteOffset = row['byte_length'] as int;
      final byteLength = bytes.length;
      final now = DateTime.now().millisecondsSinceEpoch;

      _db.execute(
        '''
        INSERT INTO ucsa_stream_chunks (query_hash, seq, byte_offset, data)
        VALUES (?, ?, ?, ?);
        ''',
        [queryHash, seq, byteOffset, bytes],
      );

      _db.execute(
        '''
        UPDATE ucsa_streams
        SET next_seq = next_seq + 1, byte_length = byte_length + ?, updated_at = ?
        WHERE query_hash = ?;
        ''',
        [byteLength, now, queryHash],
      );

      return {
        'seq': seq,
        'byteOffset': byteOffset,
        'byteLength': byteLength,
      };
    });
  }

  /// Retrieves a stream record by its query hash.
  StreamRecord? getStream(String queryHash) {
    final rows = _db.select(
      '''
      SELECT query_hash, query_key, status, encoding, next_seq, byte_length,
             resume_kind, resume_token, etag, writer_id, writer_lease_until,
             payload_version, error, created_at, updated_at, expires_at
      FROM ucsa_streams
      WHERE query_hash = ?;
      ''',
      [queryHash],
    );

    if (rows.isEmpty) return null;
    final row = rows.first;
    final resumeKindStr = row['resume_kind'] as String?;

    return StreamRecord(
      queryHash: row['query_hash'] as String,
      queryKey: (jsonDecode(row['query_key'] as String) as List).cast<Object?>(),
      status: StreamStatus.fromString(row['status'] as String),
      encoding: StreamEncoding.fromString(row['encoding'] as String),
      nextSeq: row['next_seq'] as int,
      byteLength: row['byte_length'] as int,
      resumeKind:
          resumeKindStr != null ? ResumeKind.fromString(resumeKindStr) : null,
      resumeToken: row['resume_token'] as String?,
      etag: row['etag'] as String?,
      writerId: row['writer_id'] as String?,
      writerLeaseUntil: row['writer_lease_until'] as int?,
      payloadVersion: row['payload_version'] as int? ?? 1,
      error: row['error'] as String?,
      createdAt: row['created_at'] as int,
      updatedAt: row['updated_at'] as int,
      expiresAt: row['expires_at'] as int,
    );
  }

  /// Retrieves sequential stream chunks starting from [fromSeq].
  List<StreamChunk> getStreamChunks(String queryHash, {int fromSeq = 0}) {
    final rows = _db.select(
      '''
      SELECT query_hash, seq, byte_offset, data
      FROM ucsa_stream_chunks
      WHERE query_hash = ? AND seq >= ?
      ORDER BY seq ASC;
      ''',
      [queryHash, fromSeq],
    );

    return rows
        .map((r) => StreamChunk(
              queryHash: r['query_hash'] as String,
              seq: r['seq'] as int,
              byteOffset: r['byte_offset'] as int,
              data: (r['data'] as List<int>),
            ))
        .toList();
  }

  /// Aborts an active stream and records an optional error.
  void abortStream(String queryHash, {String? error}) {
    final now = DateTime.now().millisecondsSinceEpoch;
    _db.execute(
      '''
      UPDATE ucsa_streams
      SET status = 'aborted', error = ?, updated_at = ?
      WHERE query_hash = ?;
      ''',
      [error, now, queryHash],
    );
  }

  /// Resets a stream by deleting all chunks and resetting sequence counter, byte length, and status.
  /// Atomically resets next_seq = 0, byte_length = 0, status = 'open', error = NULL.
  void resetStream(String queryHash) {
    final now = DateTime.now().millisecondsSinceEpoch;
    transaction(() {
      _db.execute(
        'DELETE FROM ucsa_stream_chunks WHERE query_hash = ?;',
        [queryHash],
      );
      _db.execute(
        '''
        UPDATE ucsa_streams
        SET next_seq = 0, byte_length = 0, status = 'open', error = NULL, updated_at = ?
        WHERE query_hash = ?;
        ''',
        [now, queryHash],
      );
    });
  }

  /// Updates the resume token (and optional resume kind) for an active or completed stream.
  void updateStreamResumeToken(
    String queryHash,
    String resumeToken, {
    ResumeKind? resumeKind,
  }) {
    final now = DateTime.now().millisecondsSinceEpoch;
    if (resumeKind != null) {
      _db.execute(
        '''
        UPDATE ucsa_streams
        SET resume_token = ?, resume_kind = ?, updated_at = ?
        WHERE query_hash = ?;
        ''',
        [resumeToken, resumeKind.toWireString(), now, queryHash],
      );
    } else {
      _db.execute(
        '''
        UPDATE ucsa_streams
        SET resume_token = ?, updated_at = ?
        WHERE query_hash = ?;
        ''',
        [resumeToken, now, queryHash],
      );
    }
  }


  /// Compacts all chunks of a stream atomically into query cache (or CAS store if exceeding [casThresholdBytes]).
  /// Moves stream tags to ucsa_cache_tags and purges stream row and chunks via cascade.
  Future<CacheEntry<dynamic>> compactStream(
    String queryHash, {
    CasStore? casStore,
    int casThresholdBytes = 1048576,
  }) async {
    final stream = getStream(queryHash);
    if (stream == null) {
      throw StateError('Stream not found: $queryHash');
    }

    final chunks = getStreamChunks(queryHash, fromSeq: 0);
    final totalBytes = <int>[];
    for (final c in chunks) {
      totalBytes.addAll(c.data);
    }

    dynamic payload;

    if (casStore != null && totalBytes.length > casThresholdBytes) {
      final casResult = await casStore.put(totalBytes);
      payload = {
        '__cas_ref': true,
        'hash': casResult.hash,
        'size': casResult.size,
      };
    } else {
      if (stream.encoding == StreamEncoding.utf8) {
        final text = utf8.decode(totalBytes);
        try {
          payload = jsonDecode(text);
        } catch (_) {
          payload = text;
        }
      } else {
        payload = totalBytes;
      }
    }

    final tagRows = _db.select(
      'SELECT tag FROM ucsa_stream_tags WHERE query_hash = ?;',
      [queryHash],
    );
    final tags = tagRows.map((r) => r['tag'] as String).toList();

    final cacheEntry = CacheEntry<dynamic>(
      queryHash: stream.queryHash,
      queryKey: stream.queryKey,
      dataPayload: payload,
      etag: stream.etag,
      createdAt: stream.createdAt,
      staleAt: stream.createdAt + 60000,
      expiresAt: stream.expiresAt,
      payloadVersion: stream.payloadVersion,
    );

    transaction(() {
      setQuery(cacheEntry, tags: tags.isNotEmpty ? tags : null);
      _db.execute(
        'DELETE FROM ucsa_streams WHERE query_hash = ?;',
        [queryHash],
      );
    });

    return cacheEntry;
  }

  /// Closes the database handle and marks adapter as closed.
  void close() {
    if (!_isClosed) {
      _db.dispose();
      _isClosed = true;
    }
  }
}
