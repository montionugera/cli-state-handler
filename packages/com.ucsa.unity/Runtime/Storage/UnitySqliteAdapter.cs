using System;
using System.Collections.Generic;
using System.Data;
using System.IO;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Ucsa.Unity.Core;

namespace Ucsa.Unity.Storage
{
    /// <summary>
    /// Metadata record for objects stored in Content-Addressable Storage (CAS).
    /// </summary>
    public class CasObjectRecord
    {
        public string Hash { get; set; } = string.Empty;
        public long Size { get; set; }
        public long LastAccessedAt { get; set; }

        public CasObjectRecord() { }

        public CasObjectRecord(string hash, long size, long lastAccessedAt)
        {
            Hash = hash;
            Size = size;
            LastAccessedAt = lastAccessedAt;
        }
    }

    /// <summary>
    /// SQLite storage adapter executing UCSA schema in WAL mode with busy timeout
    /// and tag index cascade invalidation.
    /// </summary>
    public class UnitySqliteAdapter : IDisposable
    {
        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            PropertyNameCaseInsensitive = true,
            WriteIndented = false
        };

        private readonly object _lock = new();
        private readonly SqliteConnection _connection;
        private readonly bool _isInMemory;
        private bool _isDisposed;

        /// <summary>
        /// Underlying SqliteConnection instance.
        /// </summary>
        public SqliteConnection Connection => _connection;

        /// <summary>
        /// Indicates if database is strictly in-memory.
        /// </summary>
        public bool IsInMemory => _isInMemory;

        /// <summary>
        /// Indicates if the connection is closed or disposed.
        /// </summary>
        public bool IsClosed => _isDisposed || _connection.State != ConnectionState.Open;

        public UnitySqliteAdapter(string connectionStringOrPath = ":memory:", int busyTimeout = 5000)
        {
            string connStr;
            if (string.IsNullOrEmpty(connectionStringOrPath) || connectionStringOrPath == ":memory:")
            {
                _isInMemory = true;
                connStr = "Data Source=:memory:;Mode=Memory;Cache=Shared";
            }
            else if (connectionStringOrPath.Contains("Data Source=") || connectionStringOrPath.Contains("DataSource="))
            {
                connStr = connectionStringOrPath;
                _isInMemory = connStr.Contains("Mode=Memory", StringComparison.OrdinalIgnoreCase) ||
                              connStr.Contains(":memory:", StringComparison.OrdinalIgnoreCase);
            }
            else
            {
                _isInMemory = false;
                var builder = new SqliteConnectionStringBuilder
                {
                    DataSource = connectionStringOrPath,
                    Mode = SqliteOpenMode.ReadWriteCreate
                };
                connStr = builder.ConnectionString;
            }

            _connection = new SqliteConnection(connStr);
            _connection.Open();

            lock (_lock)
            {
                using var pragmaCmd = _connection.CreateCommand();
                pragmaCmd.CommandText = "PRAGMA foreign_keys = ON;";
                pragmaCmd.ExecuteNonQuery();

                pragmaCmd.CommandText = $"PRAGMA busy_timeout = {busyTimeout};";
                pragmaCmd.ExecuteNonQuery();

                if (!_isInMemory)
                {
                    pragmaCmd.CommandText = "PRAGMA journal_mode = WAL;";
                    pragmaCmd.ExecuteNonQuery();

                    pragmaCmd.CommandText = "PRAGMA synchronous = NORMAL;";
                    pragmaCmd.ExecuteNonQuery();
                }
            }

            InitSchema();
        }

        /// <summary>
        /// Creates UCSA schema tables and indexes if they do not exist.
        /// </summary>
        public void InitSchema()
        {
            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
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
                ";
                cmd.ExecuteNonQuery();
            }
        }

        #region Query Cache Methods

        /// <summary>
        /// Persists or updates a query entry in SQLite and synchronizes tag mappings.
        /// </summary>
        public void SetQuery<T>(CacheEntry<T> entry, IEnumerable<string>? tags = null)
        {
            if (entry == null) throw new ArgumentNullException(nameof(entry));

            string serializedKey = JsonSerializer.Serialize(entry.QueryKey, SerializerOptions);
            string serializedPayload = JsonSerializer.Serialize(entry.DataPayload, SerializerOptions);

            lock (_lock)
            {
                using var tx = _connection.BeginTransaction();

                using (var cmd = _connection.CreateCommand())
                {
                    cmd.Transaction = tx;
                    cmd.CommandText = @"
                        INSERT INTO ucsa_query_cache (
                            query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
                        ) VALUES ($hash, $key, $payload, $etag, $created, $stale, $expires)
                        ON CONFLICT(query_hash) DO UPDATE SET
                            query_key = excluded.query_key,
                            data_payload = excluded.data_payload,
                            etag = excluded.etag,
                            created_at = excluded.created_at,
                            stale_at = excluded.stale_at,
                            expires_at = excluded.expires_at;
                    ";
                    cmd.Parameters.AddWithValue("$hash", entry.QueryHash);
                    cmd.Parameters.AddWithValue("$key", serializedKey);
                    cmd.Parameters.AddWithValue("$payload", serializedPayload);
                    cmd.Parameters.AddWithValue("$etag", (object?)entry.Etag ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("$created", entry.CreatedAt);
                    cmd.Parameters.AddWithValue("$stale", entry.StaleAt);
                    cmd.Parameters.AddWithValue("$expires", entry.ExpiresAt);
                    cmd.ExecuteNonQuery();
                }

                if (tags != null)
                {
                    using (var delTagsCmd = _connection.CreateCommand())
                    {
                        delTagsCmd.Transaction = tx;
                        delTagsCmd.CommandText = "DELETE FROM ucsa_cache_tags WHERE query_hash = $hash;";
                        delTagsCmd.Parameters.AddWithValue("$hash", entry.QueryHash);
                        delTagsCmd.ExecuteNonQuery();
                    }

                    foreach (var tag in tags)
                    {
                        using (var insertTagCmd = _connection.CreateCommand())
                        {
                            insertTagCmd.Transaction = tx;
                            insertTagCmd.CommandText = @"
                                INSERT INTO ucsa_cache_tags (tag, query_hash)
                                VALUES ($tag, $hash)
                                ON CONFLICT(tag, query_hash) DO NOTHING;
                            ";
                            insertTagCmd.Parameters.AddWithValue("$tag", tag);
                            insertTagCmd.Parameters.AddWithValue("$hash", entry.QueryHash);
                            insertTagCmd.ExecuteNonQuery();
                        }
                    }
                }

                tx.Commit();
            }
        }

        /// <summary>
        /// Retrieves and deserializes a cached query entry by hash.
        /// </summary>
        public CacheEntry<T>? GetQuery<T>(string queryHash)
        {
            if (string.IsNullOrEmpty(queryHash)) return null;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
                    FROM ucsa_query_cache
                    WHERE query_hash = $hash;
                ";
                cmd.Parameters.AddWithValue("$hash", queryHash);

                using var reader = cmd.ExecuteReader();
                if (!reader.Read()) return null;

                string hash = reader.GetString(0);
                string keyJson = reader.GetString(1);
                string payloadJson = reader.GetString(2);
                string? etag = reader.IsDBNull(3) ? null : reader.GetString(3);
                long createdAt = reader.GetInt64(4);
                long staleAt = reader.GetInt64(5);
                long expiresAt = reader.GetInt64(6);

                object[] queryKey = JsonSerializer.Deserialize<object[]>(keyJson, SerializerOptions) ?? Array.Empty<object>();
                T dataPayload = JsonSerializer.Deserialize<T>(payloadJson, SerializerOptions)!;

                return new CacheEntry<T>(
                    hash,
                    queryKey,
                    dataPayload,
                    createdAt,
                    staleAt,
                    expiresAt,
                    etag
                );
            }
        }

        /// <summary>
        /// Deletes a cached query entry by hash.
        /// Cascade delete automatically cleans up all associated tags in ucsa_cache_tags.
        /// </summary>
        public void DeleteQuery(string queryHash)
        {
            if (string.IsNullOrEmpty(queryHash)) return;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "DELETE FROM ucsa_query_cache WHERE query_hash = $hash;";
                cmd.Parameters.AddWithValue("$hash", queryHash);
                cmd.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// Invalidates all queries associated with the given tag.
        /// Returns the list of query hashes that were deleted.
        /// </summary>
        public List<string> InvalidateByTag(string tag)
        {
            if (string.IsNullOrEmpty(tag)) return new List<string>();

            lock (_lock)
            {
                var hashes = GetQueryHashesByTag(tag);
                if (hashes.Count == 0) return hashes;

                using var tx = _connection.BeginTransaction();
                foreach (var hash in hashes)
                {
                    using var cmd = _connection.CreateCommand();
                    cmd.Transaction = tx;
                    cmd.CommandText = "DELETE FROM ucsa_query_cache WHERE query_hash = $hash;";
                    cmd.Parameters.AddWithValue("$hash", hash);
                    cmd.ExecuteNonQuery();
                }
                tx.Commit();

                return hashes;
            }
        }

        /// <summary>
        /// Returns all query hashes associated with a tag without deleting them.
        /// </summary>
        public List<string> GetQueryHashesByTag(string tag)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(tag)) return result;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "SELECT query_hash FROM ucsa_cache_tags WHERE tag = $tag;";
                cmd.Parameters.AddWithValue("$tag", tag);

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    result.Add(reader.GetString(0));
                }
            }
            return result;
        }

        /// <summary>
        /// Returns all tags associated with a specific query hash.
        /// </summary>
        public List<string> GetTagsForQuery(string queryHash)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(queryHash)) return result;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "SELECT tag FROM ucsa_cache_tags WHERE query_hash = $hash;";
                cmd.Parameters.AddWithValue("$hash", queryHash);

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    result.Add(reader.GetString(0));
                }
            }
            return result;
        }

        /// <summary>
        /// Returns all query entries whose expires_at timestamp is <= the specified cutoff.
        /// </summary>
        public List<CacheEntry<T>> GetExpiredQueries<T>(long? nowMs = null)
        {
            long cutoff = nowMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var list = new List<CacheEntry<T>>();

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
                    FROM ucsa_query_cache
                    WHERE expires_at <= $cutoff;
                ";
                cmd.Parameters.AddWithValue("$cutoff", cutoff);

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    string hash = reader.GetString(0);
                    string keyJson = reader.GetString(1);
                    string payloadJson = reader.GetString(2);
                    string? etag = reader.IsDBNull(3) ? null : reader.GetString(3);
                    long createdAt = reader.GetInt64(4);
                    long staleAt = reader.GetInt64(5);
                    long expiresAt = reader.GetInt64(6);

                    object[] queryKey = JsonSerializer.Deserialize<object[]>(keyJson, SerializerOptions) ?? Array.Empty<object>();
                    T dataPayload = JsonSerializer.Deserialize<T>(payloadJson, SerializerOptions)!;

                    list.Add(new CacheEntry<T>(
                        hash,
                        queryKey,
                        dataPayload,
                        createdAt,
                        staleAt,
                        expiresAt,
                        etag
                    ));
                }
            }
            return list;
        }

        #endregion

        #region Outbox Methods

        /// <summary>
        /// Persists or updates an outbox mutation.
        /// </summary>
        public void SetMutation<T>(OutboxMutation<T> mutation)
        {
            if (mutation == null) throw new ArgumentNullException(nameof(mutation));

            string? headersJson = mutation.Headers != null
                ? JsonSerializer.Serialize(mutation.Headers, SerializerOptions)
                : null;
            string? payloadJson = mutation.Payload != null
                ? JsonSerializer.Serialize(mutation.Payload, SerializerOptions)
                : null;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    INSERT INTO ucsa_mutation_outbox (
                        mutation_id, endpoint, method, headers, payload, status,
                        retry_count, created_at, last_attempt_at, error, forced, conflict_policy
                    ) VALUES (
                        $id, $endpoint, $method, $headers, $payload, $status,
                        $retry, $created, $lastAttempt, $error, $forced, $policy
                    )
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
                ";
                cmd.Parameters.AddWithValue("$id", mutation.MutationId);
                cmd.Parameters.AddWithValue("$endpoint", mutation.Endpoint);
                cmd.Parameters.AddWithValue("$method", mutation.Method);
                cmd.Parameters.AddWithValue("$headers", (object?)headersJson ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$payload", (object?)payloadJson ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$status", mutation.Status.ToString());
                cmd.Parameters.AddWithValue("$retry", mutation.RetryCount);
                cmd.Parameters.AddWithValue("$created", mutation.CreatedAt);
                cmd.Parameters.AddWithValue("$lastAttempt", (object?)mutation.LastAttemptAt ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$error", (object?)mutation.Error ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$forced", mutation.Forced ? 1 : 0);
                cmd.Parameters.AddWithValue("$policy", (object?)mutation.ConflictPolicy?.ToString() ?? DBNull.Value);

                cmd.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// Retrieves an outbox mutation by ID.
        /// </summary>
        public OutboxMutation<T>? GetMutation<T>(string mutationId)
        {
            if (string.IsNullOrEmpty(mutationId)) return null;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    SELECT mutation_id, endpoint, method, headers, payload, status,
                           retry_count, created_at, last_attempt_at, error, forced, conflict_policy
                    FROM ucsa_mutation_outbox
                    WHERE mutation_id = $id;
                ";
                cmd.Parameters.AddWithValue("$id", mutationId);

                using var reader = cmd.ExecuteReader();
                if (!reader.Read()) return null;

                string id = reader.GetString(0);
                string endpoint = reader.GetString(1);
                string method = reader.GetString(2);
                string? headersJson = reader.IsDBNull(3) ? null : reader.GetString(3);
                string? payloadJson = reader.IsDBNull(4) ? null : reader.GetString(4);
                string statusStr = reader.GetString(5);
                int retryCount = reader.GetInt32(6);
                long createdAt = reader.GetInt64(7);
                long? lastAttemptAt = reader.IsDBNull(8) ? null : reader.GetInt64(8);
                string? error = reader.IsDBNull(9) ? null : reader.GetString(9);
                bool forced = reader.GetInt32(10) == 1;
                string? policyStr = reader.IsDBNull(11) ? null : reader.GetString(11);

                Dictionary<string, string>? headers = headersJson != null
                    ? JsonSerializer.Deserialize<Dictionary<string, string>>(headersJson, SerializerOptions)
                    : null;
                T? payload = payloadJson != null
                    ? JsonSerializer.Deserialize<T>(payloadJson, SerializerOptions)
                    : default;

                Enum.TryParse<OutboxMutationStatus>(statusStr, true, out var status);
                ConflictPolicy? policy = null;
                if (!string.IsNullOrEmpty(policyStr) && Enum.TryParse<ConflictPolicy>(policyStr, true, out var p))
                {
                    policy = p;
                }

                return new OutboxMutation<T>(
                    id,
                    endpoint,
                    method,
                    createdAt,
                    payload,
                    headers,
                    status,
                    retryCount,
                    lastAttemptAt,
                    error,
                    forced,
                    policy
                );
            }
        }

        /// <summary>
        /// Returns pending mutations ordered by created_at ascending.
        /// </summary>
        public List<OutboxMutation<T>> GetPendingMutations<T>(int limit = 100)
        {
            var list = new List<OutboxMutation<T>>();

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    SELECT mutation_id, endpoint, method, headers, payload, status,
                           retry_count, created_at, last_attempt_at, error, forced, conflict_policy
                    FROM ucsa_mutation_outbox
                    WHERE status = 'Pending' OR status = 'pending'
                    ORDER BY created_at ASC
                    LIMIT $limit;
                ";
                cmd.Parameters.AddWithValue("$limit", limit);

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    string id = reader.GetString(0);
                    string endpoint = reader.GetString(1);
                    string method = reader.GetString(2);
                    string? headersJson = reader.IsDBNull(3) ? null : reader.GetString(3);
                    string? payloadJson = reader.IsDBNull(4) ? null : reader.GetString(4);
                    string statusStr = reader.GetString(5);
                    int retryCount = reader.GetInt32(6);
                    long createdAt = reader.GetInt64(7);
                    long? lastAttemptAt = reader.IsDBNull(8) ? null : reader.GetInt64(8);
                    string? error = reader.IsDBNull(9) ? null : reader.GetString(9);
                    bool forced = reader.GetInt32(10) == 1;
                    string? policyStr = reader.IsDBNull(11) ? null : reader.GetString(11);

                    Dictionary<string, string>? headers = headersJson != null
                        ? JsonSerializer.Deserialize<Dictionary<string, string>>(headersJson, SerializerOptions)
                        : null;
                    T? payload = payloadJson != null
                        ? JsonSerializer.Deserialize<T>(payloadJson, SerializerOptions)
                        : default;

                    Enum.TryParse<OutboxMutationStatus>(statusStr, true, out var status);
                    ConflictPolicy? policy = null;
                    if (!string.IsNullOrEmpty(policyStr) && Enum.TryParse<ConflictPolicy>(policyStr, true, out var p))
                    {
                        policy = p;
                    }

                    list.Add(new OutboxMutation<T>(
                        id,
                        endpoint,
                        method,
                        createdAt,
                        payload,
                        headers,
                        status,
                        retryCount,
                        lastAttemptAt,
                        error,
                        forced,
                        policy
                    ));
                }
            }

            return list;
        }

        /// <summary>
        /// Updates status and retry metadata for an outbox mutation.
        /// </summary>
        public void UpdateMutationStatus(
            string mutationId,
            OutboxMutationStatus status,
            long? lastAttemptAt = null,
            string? error = null,
            int? retryCount = null)
        {
            if (string.IsNullOrEmpty(mutationId)) return;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    UPDATE ucsa_mutation_outbox
                    SET status = $status,
                        last_attempt_at = COALESCE($lastAttempt, last_attempt_at),
                        error = $error,
                        retry_count = COALESCE($retry, retry_count)
                    WHERE mutation_id = $id;
                ";
                cmd.Parameters.AddWithValue("$status", status.ToString());
                cmd.Parameters.AddWithValue("$lastAttempt", (object?)lastAttemptAt ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$retry", (object?)retryCount ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$id", mutationId);

                cmd.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// Deletes an outbox mutation by ID.
        /// </summary>
        public void DeleteMutation(string mutationId)
        {
            if (string.IsNullOrEmpty(mutationId)) return;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "DELETE FROM ucsa_mutation_outbox WHERE mutation_id = $id;";
                cmd.Parameters.AddWithValue("$id", mutationId);
                cmd.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// Replays pending outbox mutations sequentially via an executor function.
        /// Supports rateLimitMs delay between mutation calls and batchSize limits.
        /// </summary>
        public async Task<ReplayResult> ReplayOutboxAsync<T>(
            Func<OutboxMutation<T>, Task<(int status, object? data)>> executor,
            int rateLimitMs = 0,
            int batchSize = 10,
            Func<OutboxMutation<T>, object?, Task<string>>? conflictResolver = null,
            CancellationToken ct = default)
        {
            var pending = GetPendingMutations<T>(batchSize);
            int processed = 0;
            int successful = 0;
            int failed = 0;

            for (int i = 0; i < pending.Count; i++)
            {
                ct.ThrowIfCancellationRequested();

                var mutation = pending[i];
                if (i > 0 && rateLimitMs > 0)
                {
                    await Task.Delay(rateLimitMs, ct).ConfigureAwait(false);
                }

                processed++;
                UpdateMutationStatus(mutation.MutationId, OutboxMutationStatus.InFlight);

                try
                {
                    var response = await executor(mutation).ConfigureAwait(false);
                    if (response.status >= 200 && response.status < 300)
                    {
                        DeleteMutation(mutation.MutationId);
                        successful++;
                    }
                    else if (response.status == 409)
                    {
                        string resolution = "rollback";
                        if (conflictResolver != null)
                        {
                            resolution = await conflictResolver(mutation, response.data).ConfigureAwait(false);
                        }
                        else if (mutation.ConflictPolicy == ConflictPolicy.ClientWins)
                        {
                            resolution = "force";
                        }

                        if (resolution == "rollback")
                        {
                            DeleteMutation(mutation.MutationId);
                            successful++;
                        }
                        else if (resolution == "force")
                        {
                            UpdateMutationStatus(mutation.MutationId, OutboxMutationStatus.Pending);
                        }
                    }
                    else if (response.status >= 400 && response.status < 500)
                    {
                        UpdateMutationStatus(mutation.MutationId, OutboxMutationStatus.Failed, error: $"HTTP {response.status}");
                        failed++;
                    }
                    else
                    {
                        int nextRetry = mutation.RetryCount + 1;
                        bool isPermanent = nextRetry >= 3;
                        UpdateMutationStatus(
                            mutation.MutationId,
                            isPermanent ? OutboxMutationStatus.Failed : OutboxMutationStatus.Pending,
                            error: $"HTTP {response.status}",
                            retryCount: nextRetry);
                        if (isPermanent) failed++;
                    }
                }
                catch (Exception ex)
                {
                    int nextRetry = mutation.RetryCount + 1;
                    bool isPermanent = nextRetry >= 3;
                    UpdateMutationStatus(
                        mutation.MutationId,
                        isPermanent ? OutboxMutationStatus.Failed : OutboxMutationStatus.Pending,
                        error: ex.Message,
                        retryCount: nextRetry);
                    if (isPermanent) failed++;
                }
            }

            return new ReplayResult(processed, successful, failed);
        }

        #endregion

        #region CAS Helpers

        /// <summary>
        /// Inserts or updates a CAS object record with size and last accessed time.
        /// </summary>
        public void UpsertCasObject(string hash, long size, long? lastAccessedAt = null)
        {
            if (string.IsNullOrEmpty(hash)) return;
            long access = lastAccessedAt ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    INSERT INTO ucsa_cas_objects (hash, size, last_accessed_at)
                    VALUES ($hash, $size, $access)
                    ON CONFLICT(hash) DO UPDATE SET
                        size = excluded.size,
                        last_accessed_at = excluded.last_accessed_at;
                ";
                cmd.Parameters.AddWithValue("$hash", hash);
                cmd.Parameters.AddWithValue("$size", size);
                cmd.Parameters.AddWithValue("$access", access);
                cmd.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// Retrieves a CAS object record by hash.
        /// </summary>
        public CasObjectRecord? GetCasObject(string hash)
        {
            if (string.IsNullOrEmpty(hash)) return null;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "SELECT hash, size, last_accessed_at FROM ucsa_cas_objects WHERE hash = $hash;";
                cmd.Parameters.AddWithValue("$hash", hash);

                using var reader = cmd.ExecuteReader();
                if (!reader.Read()) return null;

                return new CasObjectRecord(
                    reader.GetString(0),
                    reader.GetInt64(1),
                    reader.GetInt64(2)
                );
            }
        }

        /// <summary>
        /// Updates the last_accessed_at timestamp for a CAS object.
        /// </summary>
        public bool UpdateCasAccessTime(string hash, long? lastAccessedAt = null)
        {
            if (string.IsNullOrEmpty(hash)) return false;
            long access = lastAccessedAt ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "UPDATE ucsa_cas_objects SET last_accessed_at = $access WHERE hash = $hash;";
                cmd.Parameters.AddWithValue("$access", access);
                cmd.Parameters.AddWithValue("$hash", hash);

                return cmd.ExecuteNonQuery() > 0;
            }
        }

        /// <summary>
        /// Deletes a CAS object record.
        /// </summary>
        public bool DeleteCasObject(string hash)
        {
            if (string.IsNullOrEmpty(hash)) return false;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "DELETE FROM ucsa_cas_objects WHERE hash = $hash;";
                cmd.Parameters.AddWithValue("$hash", hash);

                return cmd.ExecuteNonQuery() > 0;
            }
        }

        /// <summary>
        /// Returns the total size of all CAS objects tracked in the database.
        /// </summary>
        public long GetTotalCasSize()
        {
            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = "SELECT COALESCE(SUM(size), 0) FROM ucsa_cas_objects;";
                object? result = cmd.ExecuteScalar();
                return Convert.ToInt64(result);
            }
        }

        /// <summary>
        /// Returns CAS objects ordered by LRU (least recently accessed first).
        /// </summary>
        public List<CasObjectRecord> GetLruCasObjects(int? limit = null)
        {
            var list = new List<CasObjectRecord>();

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = limit.HasValue
                    ? "SELECT hash, size, last_accessed_at FROM ucsa_cas_objects ORDER BY last_accessed_at ASC LIMIT $limit;"
                    : "SELECT hash, size, last_accessed_at FROM ucsa_cas_objects ORDER BY last_accessed_at ASC;";

                if (limit.HasValue)
                {
                    cmd.Parameters.AddWithValue("$limit", limit.Value);
                }

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    list.Add(new CasObjectRecord(
                        reader.GetString(0),
                        reader.GetInt64(1),
                        reader.GetInt64(2)
                    ));
                }
            }

            return list;
        }

        #endregion

        /// <summary>
        /// Checkpoints the SQLite WAL log.
        /// Defaults to 'TRUNCATE' mode.
        /// </summary>
        public void Checkpoint(string mode = "TRUNCATE")
        {
            lock (_lock)
            {
                if (!_isDisposed && !_isInMemory)
                {
                    using var cmd = _connection.CreateCommand();
                    cmd.CommandText = $"PRAGMA wal_checkpoint({mode});";
                    cmd.ExecuteNonQuery();
                }
            }
        }

        /// <summary>
        /// Closes the database connection.
        /// </summary>
        public void Close()
        {
            Dispose();
        }

        public void Dispose()
        {
            lock (_lock)
            {
                if (!_isDisposed)
                {
                    _connection.Close();
                    _connection.Dispose();
                    _isDisposed = true;
                }
            }
            GC.SuppressFinalize(this);
        }
    }
}
