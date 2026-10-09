using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace Ucsa.Unity.Storage
{
    public class DatabaseVersionTooNewException : Exception
    {
        public int CurrentVersion { get; }
        public int SupportedVersion { get; }

        public DatabaseVersionTooNewException(int currentVersion, int supportedVersion)
            : base($"Database schema version {currentVersion} is newer than supported version {supportedVersion}. " +
                   $"Please upgrade the UCSA client to access this database.")
        {
            CurrentVersion = currentVersion;
            SupportedVersion = supportedVersion;
        }
    }

    public class MigrationChecksumMismatchException : Exception
    {
        public int Version { get; }
        public string ExpectedChecksum { get; }
        public string ActualChecksum { get; }

        public MigrationChecksumMismatchException(int version, string expectedChecksum, string actualChecksum)
            : base($"Checksum mismatch for migration version {version}: expected {expectedChecksum}, found {actualChecksum}. " +
                   $"The migration history has been tampered with or corrupted.")
        {
            Version = version;
            ExpectedChecksum = expectedChecksum;
            ActualChecksum = actualChecksum;
        }
    }

    public class MigrationException : Exception
    {
        public int Version { get; }

        public MigrationException(int version, Exception? innerException)
            : base($"Failed to apply migration version {version}: {innerException?.Message}", innerException)
        {
            Version = version;
        }
    }

    public class MigrationDefinition
    {
        public int Version { get; set; }
        public string Name { get; set; } = string.Empty;
        public string Sql { get; set; } = string.Empty;
        public string? Sha256 { get; set; }
    }

    public class AppliedMigrationRecord
    {
        public int Version { get; set; }
        public string Name { get; set; } = string.Empty;
        public long AppliedAt { get; set; }
        public string Checksum { get; set; } = string.Empty;
    }

    public class MigrationResult
    {
        public int CurrentVersion { get; set; }
        public int AppliedCount { get; set; }

        public MigrationResult() { }

        public MigrationResult(int currentVersion, int appliedCount)
        {
            CurrentVersion = currentVersion;
            AppliedCount = appliedCount;
        }
    }

    /// <summary>
    /// Canonical migration runner for Unity C# SQLite storage.
    /// Handles schema evolution, ledger tracking in ucsa_migrations, and atomic version transitions.
    /// </summary>
    public static class MigrationRunner
    {
        public const int TargetSchemaVersion = 4;

        public const string BaselineSql = @"-- Migration 0001: Baseline Canonical Schema for UCSA
-- Reconciles TypeScript, Dart, and C# schemas into a single source of truth.

CREATE TABLE IF NOT EXISTS ucsa_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  error TEXT,
  forced INTEGER DEFAULT 0,
  conflict_policy TEXT DEFAULT 'server-wins'
);
CREATE INDEX IF NOT EXISTS idx_ucsa_outbox_status ON ucsa_mutation_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS ucsa_cas_objects (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_cas_access ON ucsa_cas_objects(last_accessed_at);
";

        public const string PayloadVersionSql = @"-- Migration 0002: Add payload_version to ucsa_query_cache
ALTER TABLE ucsa_query_cache ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_ucsa_cache_payload_version ON ucsa_query_cache(payload_version);
";

        public const string ChangeLogAndBusSql = @"-- Migration 0003: Change log, bus hub election, and outbox distributed leases
-- Enables cross-process real-time event broadcasting and concurrent outbox replay protection.

CREATE TABLE IF NOT EXISTS ucsa_change_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  origin       TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('invalidate','mutation','stream','reset')),
  tags         TEXT,
  query_hashes TEXT,
  detail       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_change_log_created ON ucsa_change_log(created_at);

CREATE TABLE IF NOT EXISTS ucsa_bus_hub (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  epoch        INTEGER NOT NULL,
  pid          INTEGER NOT NULL,
  endpoint     TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  claimed_at   INTEGER NOT NULL
);

ALTER TABLE ucsa_mutation_outbox ADD COLUMN lease_owner TEXT;
ALTER TABLE ucsa_mutation_outbox ADD COLUMN lease_until INTEGER;
";

        public const string StreamingChunkStoreSql = @"-- Migration 0004: Streaming chunk store and resume tokens
-- Enables chunked append, sequence integrity, coalescing, and resumable LLM/media streams.

CREATE TABLE IF NOT EXISTS ucsa_streams (
  query_hash          TEXT PRIMARY KEY,
  query_key           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('open','complete','aborted','error')),
  encoding            TEXT NOT NULL CHECK (encoding IN ('utf8','bytes')),
  next_seq            INTEGER NOT NULL DEFAULT 0,
  byte_length         INTEGER NOT NULL DEFAULT 0,
  resume_kind         TEXT CHECK (resume_kind IN ('range','last-event-id','continuation','restart')),
  resume_token        TEXT,
  etag                TEXT,
  writer_id           TEXT,
  writer_lease_until  INTEGER,
  payload_version     INTEGER NOT NULL DEFAULT 1,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_streams_status ON ucsa_streams(status, expires_at);

CREATE TABLE IF NOT EXISTS ucsa_stream_chunks (
  query_hash          TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  byte_offset         INTEGER NOT NULL,
  data                BLOB    NOT NULL,
  PRIMARY KEY (query_hash, seq),
  FOREIGN KEY (query_hash) REFERENCES ucsa_streams(query_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucsa_stream_chunks_hash ON ucsa_stream_chunks(query_hash);

CREATE TABLE IF NOT EXISTS ucsa_stream_tags (
  tag                 TEXT NOT NULL,
  query_hash          TEXT NOT NULL,
  PRIMARY KEY (tag, query_hash),
  FOREIGN KEY (query_hash) REFERENCES ucsa_streams(query_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucsa_stream_tags_tag ON ucsa_stream_tags(tag);
";

        public static readonly IReadOnlyList<MigrationDefinition> CanonicalMigrations = new List<MigrationDefinition>
        {
            new MigrationDefinition
            {
                Version = 1,
                Name = "baseline",
                Sql = BaselineSql,
                Sha256 = "fff0ce5e68c0644c5f61b60a05d9f50f6992392ad671abd06685da5a8c34f55c"
            },
            new MigrationDefinition
            {
                Version = 2,
                Name = "payload_version",
                Sql = PayloadVersionSql,
                Sha256 = "ab2fb5ac83e34e2b7a13de446cb3cf37778dafddbce0c3c65b22906015712dc1"
            },
            new MigrationDefinition
            {
                Version = 3,
                Name = "change_log_and_bus",
                Sql = ChangeLogAndBusSql,
                Sha256 = "a79e1963523548208d42a61d3be4a08086c4866c71eb1045182eed4ac0a78c05"
            },
            new MigrationDefinition
            {
                Version = 4,
                Name = "streaming_chunk_store",
                Sql = StreamingChunkStoreSql,
                Sha256 = "8082619b731cf1a7b40c41a715c6ddcb6f3df1b162487f524775784458786641"
            }
        };

        public static string ComputeSqlChecksum(string sql)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(sql.Trim());
            byte[] hash = SHA256.HashData(bytes);
            return Convert.ToHexString(hash).ToLowerInvariant();
        }

        public static int GetUserVersion(SqliteConnection conn)
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "PRAGMA user_version;";
            var result = cmd.ExecuteScalar();
            return result != null && result != DBNull.Value ? Convert.ToInt32(result) : 0;
        }

        public static void SetUserVersion(SqliteConnection conn, int version)
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = $"PRAGMA user_version = {version};";
            cmd.ExecuteNonQuery();
        }

        public static void InitMigrationsTable(SqliteConnection conn)
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"
                CREATE TABLE IF NOT EXISTS ucsa_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at INTEGER NOT NULL,
                    checksum TEXT NOT NULL
                );
            ";
            cmd.ExecuteNonQuery();
        }

        public static Dictionary<int, AppliedMigrationRecord> GetAppliedMigrations(SqliteConnection conn)
        {
            InitMigrationsTable(conn);

            var map = new Dictionary<int, AppliedMigrationRecord>();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT version, name, applied_at, checksum FROM ucsa_migrations ORDER BY version ASC;";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var record = new AppliedMigrationRecord
                {
                    Version = reader.GetInt32(0),
                    Name = reader.GetString(1),
                    AppliedAt = reader.GetInt64(2),
                    Checksum = reader.GetString(3)
                };
                map[record.Version] = record;
            }

            return map;
        }

        public static MigrationResult Migrate(
            SqliteConnection conn,
            int targetVersion = TargetSchemaVersion,
            IReadOnlyList<MigrationDefinition>? availableMigrations = null)
        {
            var migrations = availableMigrations ?? CanonicalMigrations;
            int currentVersion = GetUserVersion(conn);

            if (currentVersion > targetVersion)
            {
                throw new DatabaseVersionTooNewException(currentVersion, targetVersion);
            }

            InitMigrationsTable(conn);
            var appliedMap = GetAppliedMigrations(conn);

            // Verify checksums of already-applied migrations
            foreach (var migration in migrations)
            {
                if (appliedMap.TryGetValue(migration.Version, out var applied))
                {
                    string expected = migration.Sha256 ?? ComputeSqlChecksum(migration.Sql);
                    if (!string.Equals(applied.Checksum, expected, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new MigrationChecksumMismatchException(migration.Version, expected, applied.Checksum);
                    }
                }
            }

            // Collect pending migrations
            var pending = new List<MigrationDefinition>();
            foreach (var m in migrations)
            {
                if (m.Version > currentVersion && m.Version <= targetVersion)
                {
                    pending.Add(m);
                }
            }
            pending.Sort((a, b) => a.Version.CompareTo(b.Version));

            if (pending.Count == 0)
            {
                return new MigrationResult(currentVersion, 0);
            }

            using var tx = conn.BeginTransaction();
            try
            {
                foreach (var m in pending)
                {
                    using (var cmd = conn.CreateCommand())
                    {
                        cmd.Transaction = tx;
                        cmd.CommandText = m.Sql;
                        cmd.ExecuteNonQuery();
                    }

                    string checksum = m.Sha256 ?? ComputeSqlChecksum(m.Sql);
                    using (var insertCmd = conn.CreateCommand())
                    {
                        insertCmd.Transaction = tx;
                        insertCmd.CommandText = @"
                            INSERT INTO ucsa_migrations (version, name, applied_at, checksum)
                            VALUES ($version, $name, $applied_at, $checksum);
                        ";
                        insertCmd.Parameters.AddWithValue("$version", m.Version);
                        insertCmd.Parameters.AddWithValue("$name", m.Name);
                        insertCmd.Parameters.AddWithValue("$applied_at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                        insertCmd.Parameters.AddWithValue("$checksum", checksum);
                        insertCmd.ExecuteNonQuery();
                    }

                    using (var verCmd = conn.CreateCommand())
                    {
                        verCmd.Transaction = tx;
                        verCmd.CommandText = $"PRAGMA user_version = {m.Version};";
                        verCmd.ExecuteNonQuery();
                    }
                }

                tx.Commit();
            }
            catch (Exception ex)
            {
                try { tx.Rollback(); } catch { }
                throw new MigrationException(pending[0].Version, ex);
            }

            return new MigrationResult(GetUserVersion(conn), pending.Count);
        }
    }
}
