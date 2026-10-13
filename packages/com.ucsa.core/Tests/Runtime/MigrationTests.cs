using System;
using System.IO;
using Microsoft.Data.Sqlite;
using NUnit.Framework;
using Ucsa.Storage;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class MigrationTests
    {
        private string _tempDbPath = string.Empty;

        [SetUp]
        public void SetUp()
        {
            _tempDbPath = Path.Combine(Path.GetTempPath(), $"ucsa_migration_test_{Guid.NewGuid():N}.db");
        }

        [TearDown]
        public void TearDown()
        {
            if (File.Exists(_tempDbPath))
            {
                try { File.Delete(_tempDbPath); } catch { }
            }
        }

        [Test]
        public void Migrate_FreshDatabase_UpgradesToTargetVersionAndInitializesTables()
        {
            using var conn = new SqliteConnection($"Data Source={_tempDbPath}");
            conn.Open();

            int initialVersion = MigrationRunner.GetUserVersion(conn);
            Assert.That(initialVersion, Is.EqualTo(0));

            var result = MigrationRunner.Migrate(conn);
            Assert.That(result.CurrentVersion, Is.EqualTo(4));
            Assert.That(result.AppliedCount, Is.EqualTo(4));

            int newVersion = MigrationRunner.GetUserVersion(conn);
            Assert.That(newVersion, Is.EqualTo(4));

            // Verify ucsa_migrations table has records for v1, v2, v3, v4
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT version, name, checksum FROM ucsa_migrations WHERE version = 1;";
            using (var reader = cmd.ExecuteReader())
            {
                Assert.That(reader.Read(), Is.True);
                Assert.That(reader.GetInt32(0), Is.EqualTo(1));
                Assert.That(reader.GetString(1), Is.EqualTo("baseline"));
                Assert.That(reader.GetString(2), Is.EqualTo(MigrationRunner.CanonicalMigrations[0].Sha256));
            }

            cmd.CommandText = "SELECT version, name, checksum FROM ucsa_migrations WHERE version = 2;";
            using (var reader = cmd.ExecuteReader())
            {
                Assert.That(reader.Read(), Is.True);
                Assert.That(reader.GetInt32(0), Is.EqualTo(2));
                Assert.That(reader.GetString(1), Is.EqualTo("payload_version"));
                Assert.That(reader.GetString(2), Is.EqualTo(MigrationRunner.CanonicalMigrations[1].Sha256));
            }

            cmd.CommandText = "SELECT version, name, checksum FROM ucsa_migrations WHERE version = 3;";
            using (var reader = cmd.ExecuteReader())
            {
                Assert.That(reader.Read(), Is.True);
                Assert.That(reader.GetInt32(0), Is.EqualTo(3));
                Assert.That(reader.GetString(1), Is.EqualTo("change_log_and_bus"));
                Assert.That(reader.GetString(2), Is.EqualTo(MigrationRunner.CanonicalMigrations[2].Sha256));
            }

            cmd.CommandText = "SELECT version, name, checksum FROM ucsa_migrations WHERE version = 4;";
            using (var reader = cmd.ExecuteReader())
            {
                Assert.That(reader.Read(), Is.True);
                Assert.That(reader.GetInt32(0), Is.EqualTo(4));
                Assert.That(reader.GetString(1), Is.EqualTo("streaming_chunk_store"));
                Assert.That(reader.GetString(2), Is.EqualTo(MigrationRunner.CanonicalMigrations[3].Sha256));
            }

            // Verify ucsa_meta, ucsa_query_cache, ucsa_change_log, ucsa_bus_hub, and streaming tables exist
            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='ucsa_meta';";
            var metaName = cmd.ExecuteScalar() as string;
            Assert.That(metaName, Is.EqualTo("ucsa_meta"));

            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='ucsa_change_log';";
            var changeLogName = cmd.ExecuteScalar() as string;
            Assert.That(changeLogName, Is.EqualTo("ucsa_change_log"));

            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='ucsa_bus_hub';";
            var busHubName = cmd.ExecuteScalar() as string;
            Assert.That(busHubName, Is.EqualTo("ucsa_bus_hub"));

            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='ucsa_streams';";
            var streamsName = cmd.ExecuteScalar() as string;
            Assert.That(streamsName, Is.EqualTo("ucsa_streams"));

            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='ucsa_stream_chunks';";
            var streamChunksName = cmd.ExecuteScalar() as string;
            Assert.That(streamChunksName, Is.EqualTo("ucsa_stream_chunks"));

            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='ucsa_stream_tags';";
            var streamTagsName = cmd.ExecuteScalar() as string;
            Assert.That(streamTagsName, Is.EqualTo("ucsa_stream_tags"));

            // Verify payload_version column exists on ucsa_query_cache
            cmd.CommandText = "PRAGMA table_info(ucsa_query_cache);";
            bool hasPayloadVersion = false;
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read())
                {
                    if (reader.GetString(1) == "payload_version")
                    {
                        hasPayloadVersion = true;
                        break;
                    }
                }
            }
            Assert.That(hasPayloadVersion, Is.True);

            // Verify lease columns on ucsa_mutation_outbox
            cmd.CommandText = "PRAGMA table_info(ucsa_mutation_outbox);";
            bool hasLeaseOwner = false;
            bool hasLeaseUntil = false;
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read())
                {
                    string colName = reader.GetString(1);
                    if (colName == "lease_owner") hasLeaseOwner = true;
                    if (colName == "lease_until") hasLeaseUntil = true;
                }
            }
            Assert.That(hasLeaseOwner, Is.True);
            Assert.That(hasLeaseUntil, Is.True);
        }

        [Test]
        public void Migrate_Incremental_MigratesFromV1ToV2WithDefaultPayloadVersion()
        {
            using var conn = new SqliteConnection($"Data Source={_tempDbPath}");
            conn.Open();

            // 1. Migrate to v1
            var v1Result = MigrationRunner.Migrate(conn, targetVersion: 1);
            Assert.That(v1Result.CurrentVersion, Is.EqualTo(1));
            Assert.That(MigrationRunner.GetUserVersion(conn), Is.EqualTo(1));

            // 2. Insert v1 row
            using (var insertCmd = conn.CreateCommand())
            {
                insertCmd.CommandText = @"
                    INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at)
                    VALUES ('user_v1', '[""users"", 1]', '{""name"":""Alice""}', 'etag1', 1000, 2000, 3000);
                ";
                insertCmd.ExecuteNonQuery();
            }

            // 3. Migrate to v2
            var v2Result = MigrationRunner.Migrate(conn, targetVersion: 2);
            Assert.That(v2Result.CurrentVersion, Is.EqualTo(2));
            Assert.That(v2Result.AppliedCount, Is.EqualTo(1));
            Assert.That(MigrationRunner.GetUserVersion(conn), Is.EqualTo(2));

            // 4. Verify preexisting row has payload_version = 1
            using (var queryCmd = conn.CreateCommand())
            {
                queryCmd.CommandText = "SELECT payload_version FROM ucsa_query_cache WHERE query_hash = 'user_v1';";
                var pv = Convert.ToInt32(queryCmd.ExecuteScalar());
                Assert.That(pv, Is.EqualTo(1));
            }
        }

        [Test]
        public void Migrate_Idempotent_DoesNotReapply()
        {
            using var conn = new SqliteConnection($"Data Source={_tempDbPath}");
            conn.Open();

            var firstResult = MigrationRunner.Migrate(conn);
            Assert.That(firstResult.AppliedCount, Is.EqualTo(4));
            Assert.That(firstResult.CurrentVersion, Is.EqualTo(4));

            var secondResult = MigrationRunner.Migrate(conn);
            Assert.That(secondResult.AppliedCount, Is.EqualTo(0));
            Assert.That(secondResult.CurrentVersion, Is.EqualTo(4));
        }

        [Test]
        public void Migrate_FailureRollback_RestoresPreviousVersionAndSchema()
        {
            using var conn = new SqliteConnection($"Data Source={_tempDbPath}");
            conn.Open();

            var badMigration = new MigrationDefinition
            {
                Version = 5,
                Name = "bad_migration",
                Sql = "CREATE TABLE broken_table (id INT; INVALID SYNTAX HERE"
            };

            // Migrate to version 4 first
            MigrationRunner.Migrate(conn, targetVersion: 4);
            Assert.That(MigrationRunner.GetUserVersion(conn), Is.EqualTo(4));

            var customMigrations = new[]
            {
                MigrationRunner.CanonicalMigrations[0],
                MigrationRunner.CanonicalMigrations[1],
                MigrationRunner.CanonicalMigrations[2],
                MigrationRunner.CanonicalMigrations[3],
                badMigration
            };

            var ex = Assert.Throws<MigrationException>(() =>
            {
                MigrationRunner.Migrate(conn, targetVersion: 5, availableMigrations: customMigrations);
            });

            Assert.That(ex!.Version, Is.EqualTo(5));
            Assert.That(MigrationRunner.GetUserVersion(conn), Is.EqualTo(4));

            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name='broken_table';";
            var broken = cmd.ExecuteScalar();
            Assert.That(broken, Is.Null);
        }

        [Test]
        public void Migrate_FutureVersion_ThrowsDatabaseVersionTooNewException()
        {
            using var conn = new SqliteConnection($"Data Source={_tempDbPath}");
            conn.Open();

            MigrationRunner.SetUserVersion(conn, 99);

            var ex = Assert.Throws<DatabaseVersionTooNewException>(() =>
            {
                MigrationRunner.Migrate(conn, targetVersion: MigrationRunner.TargetSchemaVersion);
            });

            Assert.That(ex!.CurrentVersion, Is.EqualTo(99));
            Assert.That(ex.SupportedVersion, Is.EqualTo(4));
        }

        [Test]
        public void Migrate_ChecksumMismatch_ThrowsMigrationChecksumMismatchException()
        {
            using var conn = new SqliteConnection($"Data Source={_tempDbPath}");
            conn.Open();

            MigrationRunner.InitMigrationsTable(conn);
            using (var insertCmd = conn.CreateCommand())
            {
                insertCmd.CommandText = @"
                    INSERT INTO ucsa_migrations (version, name, applied_at, checksum)
                    VALUES (1, 'baseline', 123456789, 'tampered_or_corrupt_checksum');
                ";
                insertCmd.ExecuteNonQuery();
            }

            var ex = Assert.Throws<MigrationChecksumMismatchException>(() =>
            {
                MigrationRunner.Migrate(conn);
            });

            Assert.That(ex!.Version, Is.EqualTo(1));
            Assert.That(ex.ExpectedChecksum, Is.EqualTo(MigrationRunner.CanonicalMigrations[0].Sha256));
            Assert.That(ex.ActualChecksum, Is.EqualTo("tampered_or_corrupt_checksum"));
        }

        [Test]
        public void Migrate_LegacyUnversionedDatabase_PreservesExistingDataAndAdoptsVersion1()
        {
            using var conn = new SqliteConnection($"Data Source={_tempDbPath}");
            conn.Open();

            // Simulate legacy v1.4 unversioned schema
            using (var setupCmd = conn.CreateCommand())
            {
                setupCmd.CommandText = @"
                    CREATE TABLE ucsa_query_cache (
                        query_hash TEXT PRIMARY KEY,
                        query_key TEXT NOT NULL,
                        data_payload TEXT NOT NULL,
                        etag TEXT,
                        created_at INTEGER NOT NULL,
                        stale_at INTEGER NOT NULL,
                        expires_at INTEGER NOT NULL
                    );

                    INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at)
                    VALUES ('hash_1', '[""legacy""]', '{""key"":""val""}', 'etag1', 1000, 2000, 3000);
                ";
                setupCmd.ExecuteNonQuery();
            }

            Assert.That(MigrationRunner.GetUserVersion(conn), Is.EqualTo(0));

            var result = MigrationRunner.Migrate(conn);
            Assert.That(result.CurrentVersion, Is.EqualTo(4));
            Assert.That(result.AppliedCount, Is.EqualTo(4));
            Assert.That(MigrationRunner.GetUserVersion(conn), Is.EqualTo(4));

            // Verify legacy row is preserved intact
            using var checkCmd = conn.CreateCommand();
            checkCmd.CommandText = "SELECT data_payload, etag FROM ucsa_query_cache WHERE query_hash = 'hash_1';";
            using var reader = checkCmd.ExecuteReader();
            Assert.That(reader.Read(), Is.True);
            Assert.That(reader.GetString(0), Is.EqualTo("{\"key\":\"val\"}"));
            Assert.That(reader.GetString(1), Is.EqualTo("etag1"));
        }

        [Test]
        public void SqliteAdapter_InitSchema_AutomaticallyRunsMigrations()
        {
            using var adapter = new SqliteAdapter(_tempDbPath);

            Assert.That(adapter.GetSchemaVersion(), Is.EqualTo(4));

            // Verify tables and migration ledger exist
            using var cmd = adapter.Connection.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM ucsa_migrations;";
            long count = Convert.ToInt64(cmd.ExecuteScalar());
            Assert.That(count, Is.EqualTo(4));
        }
    }
}
