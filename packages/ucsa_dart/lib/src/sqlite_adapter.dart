import 'dart:convert';
import 'package:sqlite3/sqlite3.dart';
import 'types.dart';

/// SQLite storage adapter providing WAL journaling, tag indexing with cascade
/// invalidation, and mutation outbox persistence.
class SqliteAdapter {
  final Database _db;
  final bool _isInMemory;
  bool _isClosed = false;
  int _transactionDepth = 0;

  SqliteAdapter({String? path, Database? db})
      : _db = db ??
            (path == null || path == ':memory:'
                ? sqlite3.openInMemory()
                : sqlite3.open(path)),
        _isInMemory =
            db != null ? false : (path == null || path == ':memory:') {
    _db.execute('PRAGMA foreign_keys = ON;');
    _db.execute('PRAGMA busy_timeout = 5000;');
    if (!_isInMemory) {
      _db.execute('PRAGMA journal_mode = WAL;');
      _db.execute('PRAGMA synchronous = NORMAL;');
    }
    initSchema();
  }

  factory SqliteAdapter.inMemory() => SqliteAdapter();

  factory SqliteAdapter.file(String path) => SqliteAdapter(path: path);

  /// Underlying SQLite database handle.
  Database get db => _db;

  /// Whether the database handle has been closed.
  bool get isClosed => _isClosed;

  /// Initializes UCSA tables and indexes if they do not exist.
  void initSchema() {
    _db.execute('''
      CREATE TABLE IF NOT EXISTS ucsa_query_cache (
        query_hash TEXT PRIMARY KEY,
        query_key TEXT NOT NULL,
        data_payload TEXT NOT NULL,
        etag TEXT,
        created_at INTEGER NOT NULL,
        stale_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_cache_expires ON ucsa_query_cache(expires_at);

      CREATE TABLE IF NOT EXISTS ucsa_cache_tags (
        tag TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        PRIMARY KEY (tag, query_hash),
        FOREIGN KEY (query_hash) REFERENCES ucsa_query_cache(query_hash) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_tags_hash ON ucsa_cache_tags(query_hash);
      CREATE INDEX IF NOT EXISTS idx_ucsa_tags_tag ON ucsa_cache_tags(tag);

      CREATE TABLE IF NOT EXISTS ucsa_mutation_outbox (
        mutation_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        headers TEXT,
        payload TEXT,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        error TEXT,
        forced INTEGER DEFAULT 0,
        conflict_policy TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_outbox_status ON ucsa_mutation_outbox(status, created_at);

      CREATE TABLE IF NOT EXISTS ucsa_cas_objects (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_cas_access ON ucsa_cas_objects(last_accessed_at);
    ''');
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
    final rows = _db.select(
      '''
      SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
      FROM ucsa_query_cache
      WHERE query_hash = ?;
      ''',
      [queryHash],
    );

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
    );
  }

  /// Deletes a cached query entry by hash.
  /// Cascade delete cleans up associated tags in [ucsa_cache_tags].
  void deleteQuery(String queryHash) {
    _db.execute(
      'DELETE FROM ucsa_query_cache WHERE query_hash = ?;',
      [queryHash],
    );
  }

  /// Invalidates all queries associated with the given tag.
  /// Returns the list of query hashes that were deleted.
  List<String> invalidateByTag(String tag) {
    final hashes = getQueryHashesByTag(tag);
    if (hashes.isEmpty) return [];

    transaction(() {
      for (final hash in hashes) {
        deleteQuery(hash);
      }
    });

    return hashes;
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
        retry_count, created_at, last_attempt_at, error, forced, conflict_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        conflict_policy = excluded.conflict_policy;
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
      ],
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
             retry_count, created_at, last_attempt_at, error, forced, conflict_policy
      FROM ucsa_mutation_outbox
      WHERE mutation_id = ?;
      ''',
      [mutationId],
    );

    if (rows.isEmpty) return null;
    final row = rows.first;

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
    );
  }

  /// Returns pending mutations ordered by created_at ascending.
  List<OutboxMutation<dynamic>> getPendingMutations({int limit = 100}) {
    final rows = _db.select(
      '''
      SELECT mutation_id, endpoint, method, headers, payload, status,
             retry_count, created_at, last_attempt_at, error, forced, conflict_policy
      FROM ucsa_mutation_outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?;
      ''',
      [limit],
    );

    return rows.map((row) {
      Map<String, String>? headers;
      if (row['headers'] != null) {
        final decoded = jsonDecode(row['headers'] as String) as Map;
        headers = decoded.map((k, v) => MapEntry(k.toString(), v.toString()));
      }

      dynamic payload;
      if (row['payload'] != null) {
        payload = jsonDecode(row['payload'] as String);
      }

      final rawPolicy = row['conflict_policy'] as String?;
      final policy =
          rawPolicy != null ? ConflictPolicy.fromString(rawPolicy) : null;

      return OutboxMutation<dynamic>(
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
      );
    }).toList();
  }

  /// Updates status and retry metadata for an outbox mutation.
  void updateMutationStatus(
    String mutationId,
    OutboxMutationStatus status, {
    int? lastAttemptAt,
    String? error,
    int? retryCount,
  }) {
    _db.execute(
      '''
      UPDATE ucsa_mutation_outbox
      SET status = ?,
          last_attempt_at = COALESCE(?, last_attempt_at),
          error = ?,
          retry_count = COALESCE(?, retry_count)
      WHERE mutation_id = ?;
      ''',
      [
        status.toWireString(),
        lastAttemptAt,
        error,
        retryCount,
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

  /// Closes the database handle and marks adapter as closed.
  void close() {
    if (!_isClosed) {
      _db.dispose();
      _isClosed = true;
    }
  }
}
