using System;
using System.Collections.Generic;
using System.Data;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Ucsa.Core;

namespace Ucsa.Storage
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
    public class SqliteAdapter : IDisposable
    {
        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            PropertyNameCaseInsensitive = true,
            WriteIndented = false
        };

        private readonly object _lock = new();
        private readonly SqliteConnection _connection;
        private readonly bool _isInMemory;
        private readonly string _origin;
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
        /// Unique origin identifier for this adapter.
        /// </summary>
        public string Origin => _origin;

        /// <summary>
        /// Indicates if the connection is closed or disposed.
        /// </summary>
        public bool IsClosed => _isDisposed || _connection.State != ConnectionState.Open;

        public SqliteAdapter(
            string connectionStringOrPath = ":memory:",
            int busyTimeout = 5000,
            string? origin = null,
            int? targetVersion = null)
        {
            _origin = origin ?? Guid.NewGuid().ToString();

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

            InitSchema(targetVersion);
        }

        /// <summary>
        /// Creates UCSA schema tables and indexes by applying canonical migrations.
        /// </summary>
        public void InitSchema(int? targetVersion = null)
        {
            lock (_lock)
            {
                MigrationRunner.Migrate(_connection, targetVersion ?? MigrationRunner.TargetSchemaVersion);
            }
        }

        /// <summary>
        /// Returns the current schema version from SQLite PRAGMA user_version.
        /// </summary>
        public int GetSchemaVersion()
        {
            lock (_lock)
            {
                return MigrationRunner.GetUserVersion(_connection);
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

                bool hasPayloadVersion = GetSchemaVersion() >= 2;
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.Transaction = tx;
                    if (hasPayloadVersion)
                    {
                        cmd.CommandText = @"
                            INSERT INTO ucsa_query_cache (
                                query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
                            ) VALUES ($hash, $key, $payload, $etag, $created, $stale, $expires, $payloadVersion)
                            ON CONFLICT(query_hash) DO UPDATE SET
                                query_key = excluded.query_key,
                                data_payload = excluded.data_payload,
                                etag = excluded.etag,
                                created_at = excluded.created_at,
                                stale_at = excluded.stale_at,
                                expires_at = excluded.expires_at,
                                payload_version = excluded.payload_version;
                        ";
                        cmd.Parameters.AddWithValue("$payloadVersion", entry.PayloadVersion);
                    }
                    else
                    {
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
                    }
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
                bool hasPayloadVersion = GetSchemaVersion() >= 2;
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = hasPayloadVersion
                    ? @"
                        SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
                        FROM ucsa_query_cache
                        WHERE query_hash = $hash;
                    "
                    : @"
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
                int payloadVersion = hasPayloadVersion && !reader.IsDBNull(7) ? reader.GetInt32(7) : 1;

                object[] queryKey = JsonSerializer.Deserialize<object[]>(keyJson, SerializerOptions) ?? Array.Empty<object>();
                T dataPayload = JsonSerializer.Deserialize<T>(payloadJson, SerializerOptions)!;

                return new CacheEntry<T>(
                    hash,
                    queryKey,
                    dataPayload,
                    createdAt,
                    staleAt,
                    expiresAt,
                    etag,
                    payloadVersion
                );
            }
        }

        /// <summary>
        /// Deletes a cached query entry by hash.
        /// Cascade delete automatically cleans up all associated tags in ucsa_cache_tags.
        /// If schema version >= 3, atomically journals an invalidate change log entry.
        /// Returns true if a row was deleted.
        /// </summary>
        public bool DeleteQuery(string queryHash, string? origin = null)
        {
            if (string.IsNullOrEmpty(queryHash)) return false;

            lock (_lock)
            {
                int schemaVersion = GetSchemaVersion();
                using var tx = _connection.BeginTransaction();
                using var cmd = _connection.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = "DELETE FROM ucsa_query_cache WHERE query_hash = $hash;";
                cmd.Parameters.AddWithValue("$hash", queryHash);
                int rowsAffected = cmd.ExecuteNonQuery();

                if (rowsAffected > 0 && schemaVersion >= 3)
                {
                    AppendChangeLogInternal(
                        tx,
                        ChangeLogKind.Invalidate,
                        origin ?? _origin,
                        null,
                        new List<string> { queryHash },
                        null
                    );
                }

                tx.Commit();
                return rowsAffected > 0;
            }
        }

        /// <summary>
        /// Invalidates all queries associated with the given tag.
        /// Returns the list of query hashes that were deleted.
        /// If schema version >= 3, atomically journals an invalidate change log entry.
        /// </summary>
        public List<string> InvalidateByTag(string tag, string? origin = null)
        {
            if (string.IsNullOrEmpty(tag)) return new List<string>();

            lock (_lock)
            {
                var hashes = GetQueryHashesByTag(tag);
                int schemaVersion = GetSchemaVersion();

                using var tx = _connection.BeginTransaction();
                foreach (var hash in hashes)
                {
                    using var cmd = _connection.CreateCommand();
                    cmd.Transaction = tx;
                    cmd.CommandText = "DELETE FROM ucsa_query_cache WHERE query_hash = $hash;";
                    cmd.Parameters.AddWithValue("$hash", hash);
                    cmd.ExecuteNonQuery();
                }

                if (schemaVersion >= 3)
                {
                    AppendChangeLogInternal(
                        tx,
                        ChangeLogKind.Invalidate,
                        origin ?? _origin,
                        new List<string> { tag },
                        hashes,
                        null
                    );
                }

                tx.Commit();
                return hashes;
            }
        }

        #region Change Log Methods

        /// <summary>
        /// Appends an entry to ucsa_change_log and returns the generated seq number.
        /// </summary>
        public long AppendChangeLog(
            ChangeLogKind kind,
            string? origin = null,
            List<string>? tags = null,
            List<string>? queryHashes = null,
            Dictionary<string, object>? detail = null)
        {
            lock (_lock)
            {
                return AppendChangeLogInternal(null, kind, origin ?? _origin, tags, queryHashes, detail);
            }
        }

        private long AppendChangeLogInternal(
            SqliteTransaction? tx,
            ChangeLogKind kind,
            string origin,
            List<string>? tags,
            List<string>? queryHashes,
            Dictionary<string, object>? detail)
        {
            using var cmd = _connection.CreateCommand();
            if (tx != null) cmd.Transaction = tx;

            cmd.CommandText = @"
                INSERT INTO ucsa_change_log (
                    origin, kind, tags, query_hashes, detail, created_at
                ) VALUES ($origin, $kind, $tags, $query_hashes, $detail, $created_at);
                SELECT last_insert_rowid();
            ";

            cmd.Parameters.AddWithValue("$origin", origin);
            cmd.Parameters.AddWithValue("$kind", kind.ToWireString());
            cmd.Parameters.AddWithValue("$tags", tags != null ? JsonSerializer.Serialize(tags, SerializerOptions) : (object)DBNull.Value);
            cmd.Parameters.AddWithValue("$query_hashes", queryHashes != null ? JsonSerializer.Serialize(queryHashes, SerializerOptions) : (object)DBNull.Value);
            cmd.Parameters.AddWithValue("$detail", detail != null ? JsonSerializer.Serialize(detail, SerializerOptions) : (object)DBNull.Value);
            cmd.Parameters.AddWithValue("$created_at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

            var result = cmd.ExecuteScalar();
            return result != null && result != DBNull.Value ? Convert.ToInt64(result) : 0;
        }

        /// <summary>
        /// Reads change log entries created since lastSeq in ascending sequence order up to limit.
        /// Detects gaps caused by pruning (Truncated: true).
        /// </summary>
        public ReadChangesResult ReadChangesSince(long lastSeq, int limit = 1000)
        {
            lock (_lock)
            {
                long headSeq = 0;
                long? minSeq = null;

                using (var headCmd = _connection.CreateCommand())
                {
                    headCmd.CommandText = "SELECT MAX(seq) FROM ucsa_change_log;";
                    var maxObj = headCmd.ExecuteScalar();
                    if (maxObj != null && maxObj != DBNull.Value)
                    {
                        headSeq = Convert.ToInt64(maxObj);
                    }
                }

                using (var minCmd = _connection.CreateCommand())
                {
                    minCmd.CommandText = "SELECT MIN(seq) FROM ucsa_change_log;";
                    var minObj = minCmd.ExecuteScalar();
                    if (minObj != null && minObj != DBNull.Value)
                    {
                        minSeq = Convert.ToInt64(minObj);
                    }
                }

                bool truncated = false;
                if (lastSeq > 0 && minSeq.HasValue && lastSeq < minSeq.Value - 1)
                {
                    truncated = true;
                }

                var rows = new List<ChangeLogRow>();
                using (var queryCmd = _connection.CreateCommand())
                {
                    queryCmd.CommandText = @"
                        SELECT seq, origin, kind, tags, query_hashes, detail, created_at
                        FROM ucsa_change_log
                        WHERE seq > $lastSeq
                        ORDER BY seq ASC
                        LIMIT $limit;
                    ";
                    queryCmd.Parameters.AddWithValue("$lastSeq", lastSeq);
                    queryCmd.Parameters.AddWithValue("$limit", limit);

                    using var reader = queryCmd.ExecuteReader();
                    while (reader.Read())
                    {
                        long seq = reader.GetInt64(0);
                        string origin = reader.GetString(1);
                        string kindStr = reader.GetString(2);
                        string? tagsJson = reader.IsDBNull(3) ? null : reader.GetString(3);
                        string? hashesJson = reader.IsDBNull(4) ? null : reader.GetString(4);
                        string? detailJson = reader.IsDBNull(5) ? null : reader.GetString(5);
                        long createdAt = reader.GetInt64(6);

                        var tags = !string.IsNullOrEmpty(tagsJson)
                            ? JsonSerializer.Deserialize<List<string>>(tagsJson, SerializerOptions)
                            : null;
                        var queryHashes = !string.IsNullOrEmpty(hashesJson)
                            ? JsonSerializer.Deserialize<List<string>>(hashesJson, SerializerOptions)
                            : null;
                        var detail = !string.IsNullOrEmpty(detailJson)
                            ? JsonSerializer.Deserialize<Dictionary<string, object>>(detailJson, SerializerOptions)
                            : null;

                        rows.Add(new ChangeLogRow(
                            seq,
                            origin,
                            ChangeLogKindExtensions.FromString(kindStr),
                            tags,
                            queryHashes,
                            detail,
                            createdAt
                        ));
                    }
                }

                return new ReadChangesResult(rows, truncated, headSeq);
            }
        }

        /// <summary>
        /// Prunes old change log entries beyond retention window (retentionMs)
        /// or beyond maxRows ceiling (retaining newest maxRows).
        /// </summary>
        public int PruneChangeLog(long retentionMs = 86400000, int maxRows = 10000)
        {
            long cutoff = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - retentionMs;

            lock (_lock)
            {
                using var tx = _connection.BeginTransaction();

                long? seqThreshold = null;
                if (maxRows > 0)
                {
                    using var seqCmd = _connection.CreateCommand();
                    seqCmd.Transaction = tx;
                    seqCmd.CommandText = "SELECT seq FROM ucsa_change_log ORDER BY seq DESC LIMIT 1 OFFSET $offset;";
                    seqCmd.Parameters.AddWithValue("$offset", maxRows);
                    var seqObj = seqCmd.ExecuteScalar();
                    if (seqObj != null && seqObj != DBNull.Value)
                    {
                        seqThreshold = Convert.ToInt64(seqObj);
                    }
                }

                using var deleteCmd = _connection.CreateCommand();
                deleteCmd.Transaction = tx;
                if (seqThreshold.HasValue)
                {
                    deleteCmd.CommandText = "DELETE FROM ucsa_change_log WHERE created_at < $cutoff OR seq <= $seqThreshold;";
                    deleteCmd.Parameters.AddWithValue("$cutoff", cutoff);
                    deleteCmd.Parameters.AddWithValue("$seqThreshold", seqThreshold.Value);
                }
                else
                {
                    deleteCmd.CommandText = "DELETE FROM ucsa_change_log WHERE created_at < $cutoff;";
                    deleteCmd.Parameters.AddWithValue("$cutoff", cutoff);
                }

                int deleted = deleteCmd.ExecuteNonQuery();
                tx.Commit();
                return deleted;
            }
        }

        #endregion

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

        private static string FormatStatus(OutboxMutationStatus status) => status switch
        {
            OutboxMutationStatus.InFlight => "in_flight",
            OutboxMutationStatus.Failed => "failed",
            _ => "pending"
        };

        private static OutboxMutationStatus ParseStatus(string statusStr)
        {
            if (string.Equals(statusStr, "in_flight", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(statusStr, "InFlight", StringComparison.OrdinalIgnoreCase))
            {
                return OutboxMutationStatus.InFlight;
            }
            if (string.Equals(statusStr, "failed", StringComparison.OrdinalIgnoreCase))
            {
                return OutboxMutationStatus.Failed;
            }
            return OutboxMutationStatus.Pending;
        }

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
                        retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
                        lease_owner, lease_until
                    ) VALUES (
                        $id, $endpoint, $method, $headers, $payload, $status,
                        $retry, $created, $lastAttempt, $error, $forced, $policy,
                        $leaseOwner, $leaseUntil
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
                        conflict_policy = excluded.conflict_policy,
                        lease_owner = excluded.lease_owner,
                        lease_until = excluded.lease_until;
                ";
                cmd.Parameters.AddWithValue("$id", mutation.MutationId);
                cmd.Parameters.AddWithValue("$endpoint", mutation.Endpoint);
                cmd.Parameters.AddWithValue("$method", mutation.Method);
                cmd.Parameters.AddWithValue("$headers", (object?)headersJson ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$payload", (object?)payloadJson ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$status", FormatStatus(mutation.Status));
                cmd.Parameters.AddWithValue("$retry", mutation.RetryCount);
                cmd.Parameters.AddWithValue("$created", mutation.CreatedAt);
                cmd.Parameters.AddWithValue("$lastAttempt", (object?)mutation.LastAttemptAt ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$error", (object?)mutation.Error ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$forced", mutation.Forced ? 1 : 0);
                cmd.Parameters.AddWithValue("$policy", (object?)mutation.ConflictPolicy?.ToString() ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$leaseOwner", (object?)mutation.LeaseOwner ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$leaseUntil", (object?)mutation.LeaseUntil ?? DBNull.Value);

                cmd.ExecuteNonQuery();
            }
        }

        private OutboxMutation<T> ReadMutationFromReader<T>(SqliteDataReader reader)
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
            string? leaseOwner = reader.IsDBNull(12) ? null : reader.GetString(12);
            long? leaseUntil = reader.IsDBNull(13) ? null : reader.GetInt64(13);

            Dictionary<string, string>? headers = headersJson != null
                ? JsonSerializer.Deserialize<Dictionary<string, string>>(headersJson, SerializerOptions)
                : null;
            T? payload = payloadJson != null
                ? JsonSerializer.Deserialize<T>(payloadJson, SerializerOptions)
                : default;

            var status = ParseStatus(statusStr);
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
                policy,
                leaseOwner,
                leaseUntil
            );
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
                           retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
                           lease_owner, lease_until
                    FROM ucsa_mutation_outbox
                    WHERE mutation_id = $id;
                ";
                cmd.Parameters.AddWithValue("$id", mutationId);

                using var reader = cmd.ExecuteReader();
                if (!reader.Read()) return null;

                return ReadMutationFromReader<T>(reader);
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
                           retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
                           lease_owner, lease_until
                    FROM ucsa_mutation_outbox
                    WHERE status = 'Pending' OR status = 'pending'
                    ORDER BY created_at ASC
                    LIMIT $limit;
                ";
                cmd.Parameters.AddWithValue("$limit", limit);

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    list.Add(ReadMutationFromReader<T>(reader));
                }
            }

            return list;
        }

        /// <summary>
        /// Atomically claims pending or expired in-flight mutations for a specific worker.
        /// </summary>
        public List<OutboxMutation<T>> ClaimPendingMutations<T>(string workerId, long leaseDurationMs, int limit = 50)
        {
            var list = new List<OutboxMutation<T>>();
            lock (_lock)
            {
                using var tx = _connection.BeginTransaction();
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                long leaseUntil = now + leaseDurationMs;

                var candidateIds = new List<string>();
                using (var cmd = _connection.CreateCommand())
                {
                    cmd.Transaction = tx;
                    cmd.CommandText = @"
                        SELECT mutation_id
                        FROM ucsa_mutation_outbox
                        WHERE status = 'Pending' OR status = 'pending'
                           OR ((status = 'InFlight' OR status = 'in_flight') AND lease_until IS NOT NULL AND lease_until < $now)
                        ORDER BY created_at ASC
                        LIMIT $limit;
                    ";
                    cmd.Parameters.AddWithValue("$now", now);
                    cmd.Parameters.AddWithValue("$limit", limit);
                    using var reader = cmd.ExecuteReader();
                    while (reader.Read())
                    {
                        candidateIds.Add(reader.GetString(0));
                    }
                }

                if (candidateIds.Count == 0)
                {
                    tx.Commit();
                    return list;
                }

                var paramNames = candidateIds.Select((_, i) => $"$id{i}").ToList();
                string inClause = string.Join(", ", paramNames);

                using (var updateCmd = _connection.CreateCommand())
                {
                    updateCmd.Transaction = tx;
                    updateCmd.CommandText = $@"
                        UPDATE ucsa_mutation_outbox
                        SET status = 'in_flight',
                            lease_owner = $workerId,
                            lease_until = $leaseUntil,
                            last_attempt_at = $now
                        WHERE mutation_id IN ({inClause});
                    ";
                    updateCmd.Parameters.AddWithValue("$workerId", workerId);
                    updateCmd.Parameters.AddWithValue("$leaseUntil", leaseUntil);
                    updateCmd.Parameters.AddWithValue("$now", now);
                    for (int i = 0; i < candidateIds.Count; i++)
                    {
                        updateCmd.Parameters.AddWithValue(paramNames[i], candidateIds[i]);
                    }
                    updateCmd.ExecuteNonQuery();
                }

                using (var selectCmd = _connection.CreateCommand())
                {
                    selectCmd.Transaction = tx;
                    selectCmd.CommandText = $@"
                        SELECT mutation_id, endpoint, method, headers, payload, status,
                               retry_count, created_at, last_attempt_at, error, forced, conflict_policy,
                               lease_owner, lease_until
                        FROM ucsa_mutation_outbox
                        WHERE mutation_id IN ({inClause})
                        ORDER BY created_at ASC;
                    ";
                    for (int i = 0; i < candidateIds.Count; i++)
                    {
                        selectCmd.Parameters.AddWithValue(paramNames[i], candidateIds[i]);
                    }
                    using var reader = selectCmd.ExecuteReader();
                    while (reader.Read())
                    {
                        list.Add(ReadMutationFromReader<T>(reader));
                    }
                }

                tx.Commit();
            }

            return list;
        }

        /// <summary>
        /// Non-generic convenience overload claiming pending mutations with object payload.
        /// </summary>
        public List<OutboxMutation<object>> ClaimPendingMutations(string workerId, long leaseDurationMs, int limit = 50)
            => ClaimPendingMutations<object>(workerId, leaseDurationMs, limit);

        /// <summary>
        /// Updates status and retry metadata for an outbox mutation.
        /// </summary>
        public void UpdateMutationStatus(
            string mutationId,
            OutboxMutationStatus status,
            long? lastAttemptAt = null,
            string? error = null,
            int? retryCount = null,
            string? leaseOwner = null,
            long? leaseUntil = null)
        {
            if (string.IsNullOrEmpty(mutationId)) return;

            string statusStr = FormatStatus(status);
            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    UPDATE ucsa_mutation_outbox
                    SET status = $status,
                        last_attempt_at = COALESCE($lastAttempt, last_attempt_at),
                        error = $error,
                        retry_count = COALESCE($retry, retry_count),
                        lease_owner = CASE WHEN $status = 'pending' THEN NULL ELSE COALESCE($leaseOwner, lease_owner) END,
                        lease_until = CASE WHEN $status = 'pending' THEN NULL ELSE COALESCE($leaseUntil, lease_until) END
                    WHERE mutation_id = $id;
                ";
                cmd.Parameters.AddWithValue("$status", statusStr);
                cmd.Parameters.AddWithValue("$lastAttempt", (object?)lastAttemptAt ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$retry", (object?)retryCount ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$leaseOwner", (object?)leaseOwner ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$leaseUntil", (object?)leaseUntil ?? DBNull.Value);
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
        /// Supports rateLimitMs delay between mutation calls, batchSize limits, and distributed leases.
        /// </summary>
        public async Task<ReplayResult> ReplayOutboxAsync<T>(
            Func<OutboxMutation<T>, Task<(int status, object? data)>> executor,
            int rateLimitMs = 0,
            int batchSize = 10,
            string? workerId = null,
            long leaseDurationMs = 30000,
            Func<OutboxMutation<T>, object?, Task<string>>? conflictResolver = null,
            CancellationToken ct = default)
        {
            string effectiveWorkerId = workerId ?? $"worker-{Guid.NewGuid():N}";
            var pending = ClaimPendingMutations<T>(effectiveWorkerId, leaseDurationMs, batchSize);
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

        #region Streaming Chunk Store Methods

        /// <summary>
        /// Creates a new streaming chunk record in ucsa_streams and registers associated tags.
        /// </summary>
        public StreamRecord CreateStream(
            object[] queryKey,
            StreamEncoding encoding = StreamEncoding.Utf8,
            ResumeKind? resumeKind = null,
            string? resumeToken = null,
            string? etag = null,
            string? writerId = null,
            long? writerLeaseUntil = null,
            int payloadVersion = 1,
            long ttlMs = 300000,
            List<string>? tags = null)
        {
            if (queryKey == null) throw new ArgumentNullException(nameof(queryKey));
            string queryHash = QueryKeyHasher.Hash(queryKey);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long expiresAt = now + ttlMs;
            string serializedKey = JsonSerializer.Serialize(queryKey, SerializerOptions);

            lock (_lock)
            {
                using var tx = _connection.BeginTransaction();

                using (var cmd = _connection.CreateCommand())
                {
                    cmd.Transaction = tx;
                    cmd.CommandText = @"
                        INSERT INTO ucsa_streams (
                            query_hash, query_key, status, encoding, next_seq, byte_length,
                            resume_kind, resume_token, etag, writer_id, writer_lease_until,
                            payload_version, error, created_at, updated_at, expires_at
                        ) VALUES (
                            $hash, $key, $status, $encoding, 0, 0,
                            $resumeKind, $resumeToken, $etag, $writerId, $writerLeaseUntil,
                            $payloadVersion, NULL, $createdAt, $updatedAt, $expiresAt
                        );
                    ";
                    cmd.Parameters.AddWithValue("$hash", queryHash);
                    cmd.Parameters.AddWithValue("$key", serializedKey);
                    cmd.Parameters.AddWithValue("$status", "open");
                    cmd.Parameters.AddWithValue("$encoding", encoding == StreamEncoding.Utf8 ? "utf8" : "bytes");
                    cmd.Parameters.AddWithValue("$resumeKind", (object?)resumeKind?.ToWireString() ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("$resumeToken", (object?)resumeToken ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("$etag", (object?)etag ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("$writerId", (object?)writerId ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("$writerLeaseUntil", (object?)writerLeaseUntil ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("$payloadVersion", payloadVersion);
                    cmd.Parameters.AddWithValue("$createdAt", now);
                    cmd.Parameters.AddWithValue("$updatedAt", now);
                    cmd.Parameters.AddWithValue("$expiresAt", expiresAt);
                    cmd.ExecuteNonQuery();
                }

                if (tags != null && tags.Count > 0)
                {
                    foreach (var tag in tags)
                    {
                        using var tagCmd = _connection.CreateCommand();
                        tagCmd.Transaction = tx;
                        tagCmd.CommandText = @"
                            INSERT INTO ucsa_stream_tags (tag, query_hash)
                            VALUES ($tag, $hash)
                            ON CONFLICT(tag, query_hash) DO NOTHING;
                        ";
                        tagCmd.Parameters.AddWithValue("$tag", tag);
                        tagCmd.Parameters.AddWithValue("$hash", queryHash);
                        tagCmd.ExecuteNonQuery();
                    }
                }

                tx.Commit();
            }

            return new StreamRecord
            {
                QueryHash = queryHash,
                QueryKey = queryKey,
                Status = StreamStatus.Open,
                Encoding = encoding,
                NextSeq = 0,
                ByteLength = 0,
                ResumeKind = resumeKind,
                ResumeToken = resumeToken,
                Etag = etag,
                WriterId = writerId,
                WriterLeaseUntil = writerLeaseUntil,
                PayloadVersion = payloadVersion,
                Error = null,
                CreatedAt = now,
                UpdatedAt = now,
                ExpiresAt = expiresAt
            };
        }

        /// <summary>
        /// Appends a chunk to the stream, validating sequence contiguity and byte offsets.
        /// </summary>
        public (int Seq, int ByteOffset, int ByteLength) AppendStreamChunk(
            string queryHash,
            byte[] data,
            int? expectedSeq = null)
        {
            if (string.IsNullOrEmpty(queryHash)) throw new ArgumentNullException(nameof(queryHash));
            if (data == null) throw new ArgumentNullException(nameof(data));

            lock (_lock)
            {
                using var tx = _connection.BeginTransaction();

                string status;
                int currentNextSeq;
                int byteLength;

                using (var getCmd = _connection.CreateCommand())
                {
                    getCmd.Transaction = tx;
                    getCmd.CommandText = "SELECT status, next_seq, byte_length FROM ucsa_streams WHERE query_hash = $hash;";
                    getCmd.Parameters.AddWithValue("$hash", queryHash);
                    using var reader = getCmd.ExecuteReader();
                    if (!reader.Read())
                    {
                        throw new InvalidOperationException($"Stream not found: {queryHash}");
                    }
                    status = reader.GetString(0);
                    currentNextSeq = reader.GetInt32(1);
                    byteLength = reader.GetInt32(2);
                }

                if (!string.Equals(status, "open", StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException($"Stream is not open (status: {status})");
                }

                if (expectedSeq.HasValue && expectedSeq.Value != currentNextSeq)
                {
                    throw new InvalidOperationException(
                        $"Sequence mismatch: expected {expectedSeq.Value}, but next sequence is {currentNextSeq}");
                }

                int seq = currentNextSeq;
                int byteOffset = byteLength;
                int chunkLen = data.Length;
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                using (var insertCmd = _connection.CreateCommand())
                {
                    insertCmd.Transaction = tx;
                    insertCmd.CommandText = @"
                        INSERT INTO ucsa_stream_chunks (query_hash, seq, byte_offset, data)
                        VALUES ($hash, $seq, $byteOffset, $data);
                    ";
                    insertCmd.Parameters.AddWithValue("$hash", queryHash);
                    insertCmd.Parameters.AddWithValue("$seq", seq);
                    insertCmd.Parameters.AddWithValue("$byteOffset", byteOffset);
                    insertCmd.Parameters.AddWithValue("$data", data);
                    insertCmd.ExecuteNonQuery();
                }

                using (var updateCmd = _connection.CreateCommand())
                {
                    updateCmd.Transaction = tx;
                    updateCmd.CommandText = @"
                        UPDATE ucsa_streams
                        SET next_seq = next_seq + 1, byte_length = byte_length + $len, updated_at = $now
                        WHERE query_hash = $hash;
                    ";
                    updateCmd.Parameters.AddWithValue("$len", chunkLen);
                    updateCmd.Parameters.AddWithValue("$now", now);
                    updateCmd.Parameters.AddWithValue("$hash", queryHash);
                    updateCmd.ExecuteNonQuery();
                }

                tx.Commit();
                return (seq, byteOffset, chunkLen);
            }
        }

        /// <summary>
        /// Appends a UTF-8 text chunk to the stream.
        /// </summary>
        public (int Seq, int ByteOffset, int ByteLength) AppendStreamChunk(
            string queryHash,
            string text,
            int? expectedSeq = null)
        {
            return AppendStreamChunk(queryHash, Encoding.UTF8.GetBytes(text), expectedSeq);
        }

        /// <summary>
        /// Retrieves a stream record by its query hash.
        /// </summary>
        public StreamRecord? GetStream(string queryHash)
        {
            if (string.IsNullOrEmpty(queryHash)) return null;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    SELECT query_hash, query_key, status, encoding, next_seq, byte_length,
                           resume_kind, resume_token, etag, writer_id, writer_lease_until,
                           payload_version, error, created_at, updated_at, expires_at
                    FROM ucsa_streams
                    WHERE query_hash = $hash;
                ";
                cmd.Parameters.AddWithValue("$hash", queryHash);

                using var reader = cmd.ExecuteReader();
                if (!reader.Read()) return null;

                string hash = reader.GetString(0);
                string keyJson = reader.GetString(1);
                string statusStr = reader.GetString(2);
                string encodingStr = reader.GetString(3);
                int nextSeq = reader.GetInt32(4);
                int byteLength = reader.GetInt32(5);
                string? resumeKindStr = reader.IsDBNull(6) ? null : reader.GetString(6);
                string? resumeToken = reader.IsDBNull(7) ? null : reader.GetString(7);
                string? etag = reader.IsDBNull(8) ? null : reader.GetString(8);
                string? writerId = reader.IsDBNull(9) ? null : reader.GetString(9);
                long? writerLeaseUntil = reader.IsDBNull(10) ? null : reader.GetInt64(10);
                int payloadVersion = reader.GetInt32(11);
                string? error = reader.IsDBNull(12) ? null : reader.GetString(12);
                long createdAt = reader.GetInt64(13);
                long updatedAt = reader.GetInt64(14);
                long expiresAt = reader.GetInt64(15);

                object[] queryKey = JsonSerializer.Deserialize<object[]>(keyJson, SerializerOptions) ?? Array.Empty<object>();

                return new StreamRecord
                {
                    QueryHash = hash,
                    QueryKey = queryKey,
                    Status = StreamStatusExtensions.FromString(statusStr),
                    Encoding = StreamEncodingExtensions.FromString(encodingStr),
                    NextSeq = nextSeq,
                    ByteLength = byteLength,
                    ResumeKind = resumeKindStr != null ? ResumeKindExtensions.FromString(resumeKindStr) : null,
                    ResumeToken = resumeToken,
                    Etag = etag,
                    WriterId = writerId,
                    WriterLeaseUntil = writerLeaseUntil,
                    PayloadVersion = payloadVersion,
                    Error = error,
                    CreatedAt = createdAt,
                    UpdatedAt = updatedAt,
                    ExpiresAt = expiresAt
                };
            }
        }

        /// <summary>
        /// Retrieves sequential stream chunks starting from fromSeq.
        /// </summary>
        public List<StreamChunk> GetStreamChunks(string queryHash, int fromSeq = 0)
        {
            var list = new List<StreamChunk>();
            if (string.IsNullOrEmpty(queryHash)) return list;

            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    SELECT query_hash, seq, byte_offset, data
                    FROM ucsa_stream_chunks
                    WHERE query_hash = $hash AND seq >= $fromSeq
                    ORDER BY seq ASC;
                ";
                cmd.Parameters.AddWithValue("$hash", queryHash);
                cmd.Parameters.AddWithValue("$fromSeq", fromSeq);

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    string hash = reader.GetString(0);
                    int seq = reader.GetInt32(1);
                    int byteOffset = reader.GetInt32(2);
                    byte[] data = (byte[])reader["data"];

                    list.Add(new StreamChunk(hash, seq, byteOffset, data));
                }
            }

            return list;
        }

        /// <summary>
        /// Aborts an active stream and records optional error.
        /// </summary>
        public void AbortStream(string queryHash, string? error = null)
        {
            if (string.IsNullOrEmpty(queryHash)) return;

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                cmd.CommandText = @"
                    UPDATE ucsa_streams
                    SET status = 'aborted', error = $error, updated_at = $now
                    WHERE query_hash = $hash;
                ";
                cmd.Parameters.AddWithValue("$error", (object?)error ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$now", now);
                cmd.Parameters.AddWithValue("$hash", queryHash);
                cmd.ExecuteNonQuery();
            }
        }

        /// <summary>
        /// Resets a stream by deleting all chunks and resetting sequence counter, byte length, and status.
        /// Atomically resets next_seq = 0, byte_length = 0, status = 'open', error = NULL.
        /// </summary>
        public void ResetStream(string queryHash)
        {
            if (string.IsNullOrEmpty(queryHash)) return;

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lock (_lock)
            {
                using var tx = _connection.BeginTransaction();

                using (var delChunksCmd = _connection.CreateCommand())
                {
                    delChunksCmd.Transaction = tx;
                    delChunksCmd.CommandText = "DELETE FROM ucsa_stream_chunks WHERE query_hash = $hash;";
                    delChunksCmd.Parameters.AddWithValue("$hash", queryHash);
                    delChunksCmd.ExecuteNonQuery();
                }

                using (var updateStreamCmd = _connection.CreateCommand())
                {
                    updateStreamCmd.Transaction = tx;
                    updateStreamCmd.CommandText = @"
                        UPDATE ucsa_streams
                        SET next_seq = 0, byte_length = 0, status = 'open', error = NULL, updated_at = $now
                        WHERE query_hash = $hash;
                    ";
                    updateStreamCmd.Parameters.AddWithValue("$now", now);
                    updateStreamCmd.Parameters.AddWithValue("$hash", queryHash);
                    updateStreamCmd.ExecuteNonQuery();
                }

                tx.Commit();
            }
        }

        /// <summary>
        /// Updates the resume token (and optional resume kind) for an active or completed stream.
        /// </summary>
        public void UpdateStreamResumeToken(string queryHash, string resumeToken, ResumeKind? resumeKind = null)
        {
            if (string.IsNullOrEmpty(queryHash)) return;

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lock (_lock)
            {
                using var cmd = _connection.CreateCommand();
                if (resumeKind.HasValue)
                {
                    cmd.CommandText = @"
                        UPDATE ucsa_streams
                        SET resume_token = $token, resume_kind = $kind, updated_at = $now
                        WHERE query_hash = $hash;
                    ";
                    cmd.Parameters.AddWithValue("$token", resumeToken);
                    cmd.Parameters.AddWithValue("$kind", resumeKind.Value.ToWireString());
                    cmd.Parameters.AddWithValue("$now", now);
                    cmd.Parameters.AddWithValue("$hash", queryHash);
                }
                else
                {
                    cmd.CommandText = @"
                        UPDATE ucsa_streams
                        SET resume_token = $token, updated_at = $now
                        WHERE query_hash = $hash;
                    ";
                    cmd.Parameters.AddWithValue("$token", resumeToken);
                    cmd.Parameters.AddWithValue("$now", now);
                    cmd.Parameters.AddWithValue("$hash", queryHash);
                }
                cmd.ExecuteNonQuery();
            }
        }


        /// <summary>
        /// Compacts all chunks of a stream atomically into query cache (or CAS store if exceeding casThresholdBytes).
        /// Moves stream tags to ucsa_cache_tags and purges stream row and chunks via cascade.
        /// </summary>
        public async Task<CacheEntry<object>> CompactStreamAsync(
            string queryHash,
            CasStore? casStore = null,
            int casThresholdBytes = 1048576)
        {
            var stream = GetStream(queryHash);
            if (stream == null)
            {
                throw new InvalidOperationException($"Stream not found: {queryHash}");
            }

            var chunks = GetStreamChunks(queryHash, 0);
            int totalLength = 0;
            foreach (var c in chunks) totalLength += c.Data.Length;
            byte[] totalBytes = new byte[totalLength];
            int offset = 0;
            foreach (var c in chunks)
            {
                Buffer.BlockCopy(c.Data, 0, totalBytes, offset, c.Data.Length);
                offset += c.Data.Length;
            }

            object payload;

            if (casStore != null && totalBytes.Length > casThresholdBytes)
            {
                var casResult = await casStore.PutAsync(totalBytes).ConfigureAwait(false);
                payload = new Dictionary<string, object>
                {
                    ["__cas_ref"] = true,
                    ["hash"] = casResult.Hash,
                    ["size"] = casResult.Size
                };
            }
            else
            {
                if (stream.Encoding == StreamEncoding.Utf8)
                {
                    string text = Encoding.UTF8.GetString(totalBytes);
                    try
                    {
                        payload = JsonSerializer.Deserialize<object>(text, SerializerOptions)!;
                    }
                    catch
                    {
                        payload = text;
                    }
                }
                else
                {
                    payload = totalBytes;
                }
            }

            var tags = new List<string>();
            lock (_lock)
            {
                using var tagCmd = _connection.CreateCommand();
                tagCmd.CommandText = "SELECT tag FROM ucsa_stream_tags WHERE query_hash = $hash;";
                tagCmd.Parameters.AddWithValue("$hash", queryHash);
                using var reader = tagCmd.ExecuteReader();
                while (reader.Read())
                {
                    tags.Add(reader.GetString(0));
                }
            }

            var entry = new CacheEntry<object>(
                stream.QueryHash,
                stream.QueryKey,
                payload,
                stream.CreatedAt,
                stream.CreatedAt + 60000,
                stream.ExpiresAt,
                stream.Etag,
                stream.PayloadVersion
            );

            lock (_lock)
            {
                using var tx = _connection.BeginTransaction();

                // Save to ucsa_query_cache and move tags
                string serializedKey = JsonSerializer.Serialize(entry.QueryKey, SerializerOptions);
                string serializedPayload = JsonSerializer.Serialize(entry.DataPayload, SerializerOptions);

                using (var cmd = _connection.CreateCommand())
                {
                    cmd.Transaction = tx;
                    cmd.CommandText = @"
                        INSERT INTO ucsa_query_cache (
                            query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
                        ) VALUES ($hash, $key, $payload, $etag, $created, $stale, $expires, $payloadVersion)
                        ON CONFLICT(query_hash) DO UPDATE SET
                            query_key = excluded.query_key,
                            data_payload = excluded.data_payload,
                            etag = excluded.etag,
                            created_at = excluded.created_at,
                            stale_at = excluded.stale_at,
                            expires_at = excluded.expires_at,
                            payload_version = excluded.payload_version;
                    ";
                    cmd.Parameters.AddWithValue("$hash", entry.QueryHash);
                    cmd.Parameters.AddWithValue("$key", serializedKey);
                    cmd.Parameters.AddWithValue("$payload", serializedPayload);
                    cmd.Parameters.AddWithValue("$etag", (object?)entry.Etag ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("$created", entry.CreatedAt);
                    cmd.Parameters.AddWithValue("$stale", entry.StaleAt);
                    cmd.Parameters.AddWithValue("$expires", entry.ExpiresAt);
                    cmd.Parameters.AddWithValue("$payloadVersion", entry.PayloadVersion);
                    cmd.ExecuteNonQuery();
                }

                if (tags.Count > 0)
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

                // Delete stream row (cascades to ucsa_stream_chunks and ucsa_stream_tags)
                using (var delStreamCmd = _connection.CreateCommand())
                {
                    delStreamCmd.Transaction = tx;
                    delStreamCmd.CommandText = "DELETE FROM ucsa_streams WHERE query_hash = $hash;";
                    delStreamCmd.Parameters.AddWithValue("$hash", queryHash);
                    delStreamCmd.ExecuteNonQuery();
                }

                tx.Commit();
            }

            return entry;
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
