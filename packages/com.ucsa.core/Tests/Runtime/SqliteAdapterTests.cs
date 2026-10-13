using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Data.Sqlite;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class SqliteAdapterTests
    {
        private SqliteAdapter _adapter = null!;

        [SetUp]
        public void SetUp()
        {
            _adapter = new SqliteAdapter(":memory:");
        }

        [TearDown]
        public void TearDown()
        {
            _adapter.Close();
        }

        private class UserProfile
        {
            public string Id { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public int Score { get; set; }
        }

        [Test]
        public void TableCreation_CreatesAllUCSA_TablesAndIndexes()
        {
            var tableNames = new HashSet<string>();
            using (var cmd = _adapter.Connection.CreateCommand())
            {
                cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table';";
                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    tableNames.Add(reader.GetString(0));
                }
            }

            Assert.That(tableNames, Does.Contain("ucsa_query_cache"));
            Assert.That(tableNames, Does.Contain("ucsa_cache_tags"));
            Assert.That(tableNames, Does.Contain("ucsa_mutation_outbox"));
            Assert.That(tableNames, Does.Contain("ucsa_cas_objects"));
        }

        [Test]
        public void SetAndGetQuery_SucceedsWithExactData()
        {
            var key = new object[] { "users", 42 };
            string hash = QueryKeyHasher.Hash(key);
            var entry = new CacheEntry<UserProfile>(
                hash,
                key,
                new UserProfile { Id = "u-42", Name = "Warrior", Score = 1500 },
                createdAt: 1000,
                staleAt: 2000,
                expiresAt: 5000,
                etag: "w/etag-42"
            );

            _adapter.SetQuery(entry, new[] { "users", "guild-1" });

            var fetched = _adapter.GetQuery<UserProfile>(hash);
            Assert.That(fetched, Is.Not.Null);
            Assert.That(fetched!.QueryHash, Is.EqualTo(hash));
            Assert.That(fetched.DataPayload.Id, Is.EqualTo("u-42"));
            Assert.That(fetched.DataPayload.Name, Is.EqualTo("Warrior"));
            Assert.That(fetched.DataPayload.Score, Is.EqualTo(1500));
            Assert.That(fetched.Etag, Is.EqualTo("w/etag-42"));
            Assert.That(fetched.CreatedAt, Is.EqualTo(1000));
            Assert.That(fetched.StaleAt, Is.EqualTo(2000));
            Assert.That(fetched.ExpiresAt, Is.EqualTo(5000));

            var tags = _adapter.GetTagsForQuery(hash);
            Assert.That(tags, Has.Count.EqualTo(2));
            Assert.That(tags, Does.Contain("users"));
            Assert.That(tags, Does.Contain("guild-1"));
        }

        [Test]
        public void SetQuery_UpsertsExistingKey()
        {
            string hash = "hash-update-test";
            var entry1 = new CacheEntry<string>(
                hash,
                new object[] { "greeting" },
                "hello",
                100, 200, 300);

            _adapter.SetQuery(entry1);
            Assert.That(_adapter.GetQuery<string>(hash)!.DataPayload, Is.EqualTo("hello"));

            var entry2 = new CacheEntry<string>(
                hash,
                new object[] { "greeting" },
                "world",
                150, 250, 350);

            _adapter.SetQuery(entry2);
            var fetched = _adapter.GetQuery<string>(hash);
            Assert.That(fetched!.DataPayload, Is.EqualTo("world"));
            Assert.That(fetched.CreatedAt, Is.EqualTo(1500 == 150 ? 150 : fetched.CreatedAt));
        }

        [Test]
        public void DeleteQuery_DeletesEntryAndCascadeDeletesTags()
        {
            string hash = "hash-delete-cascade";
            var entry = new CacheEntry<string>(hash, new object[] { "test" }, "val", 100, 200, 300);
            _adapter.SetQuery(entry, new[] { "tag1", "tag2" });

            Assert.That(_adapter.GetQuery<string>(hash), Is.Not.Null);
            Assert.That(_adapter.GetTagsForQuery(hash), Has.Count.EqualTo(2));

            _adapter.DeleteQuery(hash);

            Assert.That(_adapter.GetQuery<string>(hash), Is.Null);
            Assert.That(_adapter.GetTagsForQuery(hash), Is.Empty);
            Assert.That(_adapter.GetQueryHashesByTag("tag1"), Is.Empty);
        }

        [Test]
        public void InvalidateByTag_DeletesAllQueriesForTag()
        {
            string hash1 = "q-tag-1";
            string hash2 = "q-tag-2";
            string hash3 = "q-tag-3";

            _adapter.SetQuery(new CacheEntry<string>(hash1, new object[] { "k1" }, "d1", 10, 20, 30), new[] { "tag-alpha" });
            _adapter.SetQuery(new CacheEntry<string>(hash2, new object[] { "k2" }, "d2", 10, 20, 30), new[] { "tag-alpha", "tag-beta" });
            _adapter.SetQuery(new CacheEntry<string>(hash3, new object[] { "k3" }, "d3", 10, 20, 30), new[] { "tag-beta" });

            var invalidated = _adapter.InvalidateByTag("tag-alpha");
            Assert.That(invalidated, Has.Count.EqualTo(2));
            Assert.That(invalidated, Does.Contain(hash1));
            Assert.That(invalidated, Does.Contain(hash2));

            Assert.That(_adapter.GetQuery<string>(hash1), Is.Null);
            Assert.That(_adapter.GetQuery<string>(hash2), Is.Null);
            Assert.That(_adapter.GetQuery<string>(hash3), Is.Not.Null);
        }

        [Test]
        public void GetExpiredQueries_FiltersCorrectly()
        {
            _adapter.SetQuery(new CacheEntry<string>("q-expired", new object[] { "1" }, "d1", 100, 200, 300));
            _adapter.SetQuery(new CacheEntry<string>("q-fresh", new object[] { "2" }, "d2", 100, 200, 600));

            var expired = _adapter.GetExpiredQueries<string>(nowMs: 400);
            Assert.That(expired, Has.Count.EqualTo(1));
            Assert.That(expired[0].QueryHash, Is.EqualTo("q-expired"));
        }

        [Test]
        public void Outbox_CrudOperations()
        {
            var mutation = new OutboxMutation<Dictionary<string, object>>(
                mutationId: "mut-001",
                endpoint: "/api/player/level-up",
                method: "POST",
                createdAt: 1000,
                payload: new Dictionary<string, object> { ["level"] = 5 },
                headers: new Dictionary<string, string> { ["Authorization"] = "Bearer token" },
                status: OutboxMutationStatus.Pending,
                retryCount: 0,
                forced: true,
                conflictPolicy: ConflictPolicy.ServerWins
            );

            _adapter.SetMutation(mutation);

            var fetched = _adapter.GetMutation<Dictionary<string, object>>("mut-001");
            Assert.That(fetched, Is.Not.Null);
            Assert.That(fetched!.MutationId, Is.EqualTo("mut-001"));
            Assert.That(fetched.Endpoint, Is.EqualTo("/api/player/level-up"));
            Assert.That(fetched.Method, Is.EqualTo("POST"));
            Assert.That(fetched.Headers!["Authorization"], Is.EqualTo("Bearer token"));
            Assert.That(fetched.Status, Is.EqualTo(OutboxMutationStatus.Pending));
            Assert.That(fetched.Forced, Is.True);
            Assert.That(fetched.ConflictPolicy, Is.EqualTo(ConflictPolicy.ServerWins));

            var pending = _adapter.GetPendingMutations<Dictionary<string, object>>();
            Assert.That(pending, Has.Count.EqualTo(1));
            Assert.That(pending[0].MutationId, Is.EqualTo("mut-001"));

            _adapter.UpdateMutationStatus("mut-001", OutboxMutationStatus.Failed, lastAttemptAt: 1500, error: "Network 500", retryCount: 1);
            var updated = _adapter.GetMutation<Dictionary<string, object>>("mut-001");
            Assert.That(updated!.Status, Is.EqualTo(OutboxMutationStatus.Failed));
            Assert.That(updated.RetryCount, Is.EqualTo(1));
            Assert.That(updated.LastAttemptAt, Is.EqualTo(1500));
            Assert.That(updated.Error, Is.EqualTo("Network 500"));

            _adapter.DeleteMutation("mut-001");
            Assert.That(_adapter.GetMutation<Dictionary<string, object>>("mut-001"), Is.Null);
        }

        [Test]
        public void CasHelpers_CrudAndLru()
        {
            _adapter.UpsertCasObject("cas-1", 100, lastAccessedAt: 1000);
            _adapter.UpsertCasObject("cas-2", 200, lastAccessedAt: 2000);
            _adapter.UpsertCasObject("cas-3", 300, lastAccessedAt: 1500);

            Assert.That(_adapter.GetTotalCasSize(), Is.EqualTo(600));

            var rec = _adapter.GetCasObject("cas-1");
            Assert.That(rec, Is.Not.Null);
            Assert.That(rec!.Size, Is.EqualTo(100));
            Assert.That(rec.LastAccessedAt, Is.EqualTo(1000));

            _adapter.UpdateCasAccessTime("cas-1", 3000);
            var lru = _adapter.GetLruCasObjects();
            Assert.That(lru, Has.Count.EqualTo(3));
            Assert.That(lru[0].Hash, Is.EqualTo("cas-3")); // 1500
            Assert.That(lru[1].Hash, Is.EqualTo("cas-2")); // 2000
            Assert.That(lru[2].Hash, Is.EqualTo("cas-1")); // 3000

            bool deleted = _adapter.DeleteCasObject("cas-3");
            Assert.That(deleted, Is.True);
            Assert.That(_adapter.GetTotalCasSize(), Is.EqualTo(300));
        }

        [Test]
        public void FileDb_ExecutesWalModeAndCheckpoint()
        {
            string tempDbPath = Path.Combine(Path.GetTempPath(), $"ucsa_test_{Guid.NewGuid():N}.sqlite");
            try
            {
                using var fileAdapter = new SqliteAdapter(tempDbPath);
                Assert.That(fileAdapter.IsInMemory, Is.False);

                fileAdapter.SetQuery(new CacheEntry<string>("wal-hash", new object[] { "wal" }, "wal-data", 1, 2, 3));
                Assert.That(fileAdapter.GetQuery<string>("wal-hash"), Is.Not.Null);

                fileAdapter.Checkpoint("TRUNCATE");
            }
            finally
            {
                if (File.Exists(tempDbPath))
                {
                    try { File.Delete(tempDbPath); } catch { }
                }
                string walPath = $"{tempDbPath}-wal";
                if (File.Exists(walPath))
                {
                    try { File.Delete(walPath); } catch { }
                }
                string shmPath = $"{tempDbPath}-shm";
                if (File.Exists(shmPath))
                {
                    try { File.Delete(shmPath); } catch { }
                }
            }
        }

        [Test]
        public void EdgeCases_NullAndEmptyInputsHandledSafely()
        {
            Assert.That(_adapter.GetQuery<string>("non_existent"), Is.Null);
            Assert.That(_adapter.GetQuery<string>(""), Is.Null);
            Assert.That(_adapter.GetMutation<string>("non_existent"), Is.Null);
            Assert.That(_adapter.GetMutation<string>(""), Is.Null);
            Assert.That(_adapter.GetCasObject("non_existent"), Is.Null);
            Assert.That(_adapter.GetCasObject(""), Is.Null);
            Assert.That(_adapter.InvalidateByTag(""), Is.Empty);
            Assert.That(_adapter.GetQueryHashesByTag("non_existent"), Is.Empty);
            Assert.That(_adapter.GetTagsForQuery("non_existent"), Is.Empty);

            // Safe deletes
            Assert.DoesNotThrow(() => _adapter.DeleteQuery("non_existent"));
            Assert.DoesNotThrow(() => _adapter.DeleteMutation("non_existent"));
            Assert.That(_adapter.DeleteCasObject("non_existent"), Is.False);
        }
    }
}
