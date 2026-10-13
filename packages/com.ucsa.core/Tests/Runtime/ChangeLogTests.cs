using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class ChangeLogTests
    {
        private string _tempDbPath = string.Empty;
        private SqliteAdapter _adapter = null!;

        [SetUp]
        public void SetUp()
        {
            _tempDbPath = Path.Combine(Path.GetTempPath(), $"ucsa_changelog_test_{Guid.NewGuid():N}.db");
            _adapter = new SqliteAdapter(_tempDbPath, origin: "test-process-1");
        }

        [TearDown]
        public void TearDown()
        {
            _adapter.Dispose();
            if (File.Exists(_tempDbPath))
            {
                try { File.Delete(_tempDbPath); } catch { }
            }
        }

        [Test]
        public void Origin_InitializesWithDefaultOrCustomOrigin()
        {
            Assert.That(_adapter.Origin, Is.EqualTo("test-process-1"));

            using var defaultAdapter = new SqliteAdapter(":memory:");
            Assert.That(defaultAdapter.Origin, Is.Not.Null);
            Assert.That(defaultAdapter.Origin, Is.Not.Empty);
            Assert.That(Guid.TryParse(defaultAdapter.Origin, out _), Is.True);
        }

        [Test]
        public void AppendChangeLog_InsertsRowsAndSerializesJson()
        {
            var detail1 = new Dictionary<string, object>
            {
                ["mutationId"] = "mut-1",
                ["entity"] = "order"
            };

            long seq1 = _adapter.AppendChangeLog(ChangeLogKind.Mutation, detail: detail1);
            Assert.That(seq1, Is.EqualTo(1));

            var detail2 = new Dictionary<string, object>
            {
                ["chunk"] = 1
            };

            long seq2 = _adapter.AppendChangeLog(
                ChangeLogKind.Stream,
                origin: "custom-emitter",
                tags: new List<string> { "tag:stream" },
                queryHashes: new List<string> { "q-stream" },
                detail: detail2
            );
            Assert.That(seq2, Is.EqualTo(2));

            var result = _adapter.ReadChangesSince(0);
            Assert.That(result.HeadSeq, Is.EqualTo(2));
            Assert.That(result.Truncated, Is.False);
            Assert.That(result.Rows.Count, Is.EqualTo(2));

            var r1 = result.Rows[0];
            Assert.That(r1.Seq, Is.EqualTo(1));
            Assert.That(r1.Origin, Is.EqualTo("test-process-1"));
            Assert.That(r1.Kind, Is.EqualTo(ChangeLogKind.Mutation));
            Assert.That(r1.Tags, Is.Null);
            Assert.That(r1.QueryHashes, Is.Null);
            Assert.That(r1.Detail, Is.Not.Null);
            Assert.That(r1.CreatedAt, Is.GreaterThan(0));

            var r2 = result.Rows[1];
            Assert.That(r2.Seq, Is.EqualTo(2));
            Assert.That(r2.Origin, Is.EqualTo("custom-emitter"));
            Assert.That(r2.Kind, Is.EqualTo(ChangeLogKind.Stream));
            Assert.That(r2.Tags, Is.EqualTo(new[] { "tag:stream" }));
            Assert.That(r2.QueryHashes, Is.EqualTo(new[] { "q-stream" }));
            Assert.That(r2.Detail, Is.Not.Null);
        }

        [Test]
        public void DeleteQuery_DeletesCacheEntryAndJournalsInvalidate()
        {
            var entry = new CacheEntry<Dictionary<string, object>>(
                "q-delete-1",
                new object[] { "items", 1 },
                new Dictionary<string, object> { ["id"] = 1, ["name"] = "Item 1" },
                1000,
                2000,
                3000
            );
            _adapter.SetQuery(entry);

            bool deleted = _adapter.DeleteQuery("q-delete-1");
            Assert.That(deleted, Is.True);
            Assert.That(_adapter.GetQuery<Dictionary<string, object>>("q-delete-1"), Is.Null);

            var changes = _adapter.ReadChangesSince(0);
            Assert.That(changes.Rows.Count, Is.EqualTo(1));
            var row = changes.Rows[0];
            Assert.That(row.Seq, Is.EqualTo(1));
            Assert.That(row.Origin, Is.EqualTo("test-process-1"));
            Assert.That(row.Kind, Is.EqualTo(ChangeLogKind.Invalidate));
            Assert.That(row.Tags, Is.Null);
            Assert.That(row.QueryHashes, Is.EqualTo(new[] { "q-delete-1" }));
            Assert.That(row.Detail, Is.Null);

            // Deleting non-existent query returns false and does not append
            bool deletedAgain = _adapter.DeleteQuery("q-delete-1");
            Assert.That(deletedAgain, Is.False);
            Assert.That(_adapter.ReadChangesSince(0).Rows.Count, Is.EqualTo(1));
        }

        [Test]
        public void DeleteQuery_AllowsCustomOriginOverride()
        {
            var entry = new CacheEntry<Dictionary<string, object>>(
                "q-custom-origin",
                new object[] { "custom" },
                new Dictionary<string, object> { ["ok"] = true },
                1000,
                2000,
                3000
            );
            _adapter.SetQuery(entry);

            bool deleted = _adapter.DeleteQuery("q-custom-origin", origin: "remote-worker");
            Assert.That(deleted, Is.True);

            var changes = _adapter.ReadChangesSince(0);
            Assert.That(changes.Rows.Count, Is.EqualTo(1));
            Assert.That(changes.Rows[0].Origin, Is.EqualTo("remote-worker"));
        }

        [Test]
        public void InvalidateByTag_AtomicallyDeletesAndJournalsInvalidateLog()
        {
            var entry1 = new CacheEntry<Dictionary<string, object>>(
                "q-tag-1",
                new object[] { "products", 1 },
                new Dictionary<string, object> { ["id"] = 1 },
                1000,
                2000,
                3000
            );
            _adapter.SetQuery(entry1, new[] { "category:electronics" });

            var entry2 = new CacheEntry<Dictionary<string, object>>(
                "q-tag-2",
                new object[] { "products", 2 },
                new Dictionary<string, object> { ["id"] = 2 },
                1000,
                2000,
                3000
            );
            _adapter.SetQuery(entry2, new[] { "category:electronics" });

            var invalidated = _adapter.InvalidateByTag("category:electronics");
            Assert.That(invalidated.OrderBy(x => x), Is.EqualTo(new[] { "q-tag-1", "q-tag-2" }.OrderBy(x => x)));
            Assert.That(_adapter.GetQuery<Dictionary<string, object>>("q-tag-1"), Is.Null);
            Assert.That(_adapter.GetQuery<Dictionary<string, object>>("q-tag-2"), Is.Null);

            var changes = _adapter.ReadChangesSince(0);
            Assert.That(changes.Rows.Count, Is.EqualTo(1));
            var r1 = changes.Rows[0];
            Assert.That(r1.Seq, Is.EqualTo(1));
            Assert.That(r1.Origin, Is.EqualTo("test-process-1"));
            Assert.That(r1.Kind, Is.EqualTo(ChangeLogKind.Invalidate));
            Assert.That(r1.Tags, Is.EqualTo(new[] { "category:electronics" }));
            Assert.That(r1.QueryHashes?.OrderBy(x => x), Is.EqualTo(new[] { "q-tag-1", "q-tag-2" }.OrderBy(x => x)));
            Assert.That(r1.Detail, Is.Null);

            // Invalidation on empty tag still logs invalidation event for cross-process catch-up
            var emptyInvalidated = _adapter.InvalidateByTag("category:books", origin: "proc-books");
            Assert.That(emptyInvalidated, Is.Empty);
            var updatedChanges = _adapter.ReadChangesSince(1);
            Assert.That(updatedChanges.Rows.Count, Is.EqualTo(1));
            var r2 = updatedChanges.Rows[0];
            Assert.That(r2.Seq, Is.EqualTo(2));
            Assert.That(r2.Origin, Is.EqualTo("proc-books"));
            Assert.That(r2.Kind, Is.EqualTo(ChangeLogKind.Invalidate));
            Assert.That(r2.Tags, Is.EqualTo(new[] { "category:books" }));
            Assert.That(r2.QueryHashes, Is.Empty);
        }

        [Test]
        public void TransactionRollback_WhenChangeLogFails_RestoresCache()
        {
            var entry = new CacheEntry<Dictionary<string, object>>(
                "q-rollback-1",
                new object[] { "rollback" },
                new Dictionary<string, object> { ["safe"] = true },
                1000,
                2000,
                3000
            );
            _adapter.SetQuery(entry, new[] { "safe-tag" });

            // Create trigger to simulate failure during change log insertion
            using (var triggerCmd = _adapter.Connection.CreateCommand())
            {
                triggerCmd.CommandText = @"
                    CREATE TRIGGER fail_change_log_insert
                    BEFORE INSERT ON ucsa_change_log
                    WHEN NEW.kind = 'invalidate'
                    BEGIN
                        SELECT RAISE(FAIL, 'Simulated change log failure');
                    END;
                ";
                triggerCmd.ExecuteNonQuery();
            }

            Assert.Throws<SqliteException>(() =>
            {
                _adapter.InvalidateByTag("safe-tag");
            });

            // Cache entry remains intact due to transaction rollback
            Assert.That(_adapter.GetQuery<Dictionary<string, object>>("q-rollback-1"), Is.Not.Null);
            Assert.That(_adapter.GetQueryHashesByTag("safe-tag"), Is.EqualTo(new[] { "q-rollback-1" }));

            // Change log has 0 entries
            var changes = _adapter.ReadChangesSince(0);
            Assert.That(changes.Rows, Is.Empty);
        }

        [Test]
        public void ReadChangesSince_RespectsLastSeqAndLimit()
        {
            for (int i = 1; i <= 5; i++)
            {
                _adapter.AppendChangeLog(
                    ChangeLogKind.Mutation,
                    detail: new Dictionary<string, object> { ["i"] = i }
                );
            }

            var page1 = _adapter.ReadChangesSince(0, limit: 2);
            Assert.That(page1.Rows.Count, Is.EqualTo(2));
            Assert.That(page1.Rows.Select(r => r.Seq), Is.EqualTo(new long[] { 1, 2 }));
            Assert.That(page1.HeadSeq, Is.EqualTo(5));
            Assert.That(page1.Truncated, Is.False);

            var page2 = _adapter.ReadChangesSince(2, limit: 2);
            Assert.That(page2.Rows.Count, Is.EqualTo(2));
            Assert.That(page2.Rows.Select(r => r.Seq), Is.EqualTo(new long[] { 3, 4 }));
            Assert.That(page2.HeadSeq, Is.EqualTo(5));

            var page3 = _adapter.ReadChangesSince(4, limit: 2);
            Assert.That(page3.Rows.Count, Is.EqualTo(1));
            Assert.That(page3.Rows.Select(r => r.Seq), Is.EqualTo(new long[] { 5 }));
            Assert.That(page3.HeadSeq, Is.EqualTo(5));

            var empty = _adapter.ReadChangesSince(5, limit: 2);
            Assert.That(empty.Rows, Is.Empty);
            Assert.That(empty.HeadSeq, Is.EqualTo(5));
        }

        [Test]
        public void ReadChangesSince_DetectsLogGapAndSetsTruncatedTrue()
        {
            for (int i = 1; i <= 10; i++)
            {
                _adapter.AppendChangeLog(
                    ChangeLogKind.Stream,
                    detail: new Dictionary<string, object> { ["i"] = i }
                );
            }

            // Manually delete rows 1..5 to simulate pruning gap
            using (var delCmd = _adapter.Connection.CreateCommand())
            {
                delCmd.CommandText = "DELETE FROM ucsa_change_log WHERE seq <= 5;";
                delCmd.ExecuteNonQuery();
            }

            // Reading from 0 (pruned sequence)
            var fromZero = _adapter.ReadChangesSince(0);
            Assert.That(fromZero.Truncated, Is.False);
            Assert.That(fromZero.Rows.Select(r => r.Seq), Is.EqualTo(new long[] { 6, 7, 8, 9, 10 }));

            // Reading from lastSeq = 3 (< minSeq - 1, minSeq = 6, 3 < 5)
            var gapResult = _adapter.ReadChangesSince(3);
            Assert.That(gapResult.Truncated, Is.True);
            Assert.That(gapResult.Rows.Select(r => r.Seq), Is.EqualTo(new long[] { 6, 7, 8, 9, 10 }));
            Assert.That(gapResult.HeadSeq, Is.EqualTo(10));

            // Reading from lastSeq = 5 (adjacent to minSeq 6, 5 >= 6 - 1)
            var adjacentResult = _adapter.ReadChangesSince(5);
            Assert.That(adjacentResult.Truncated, Is.False);
            Assert.That(adjacentResult.Rows.Select(r => r.Seq), Is.EqualTo(new long[] { 6, 7, 8, 9, 10 }));
        }

        [Test]
        public void PruneChangeLog_PrunesOldEntriesAndEnforcesMaxRows()
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            // Insert 5 old entries
            for (int i = 1; i <= 5; i++)
            {
                using var cmd = _adapter.Connection.CreateCommand();
                cmd.CommandText = @"
                    INSERT INTO ucsa_change_log (origin, kind, created_at)
                    VALUES ('old-emitter', 'mutation', $createdAt);
                ";
                cmd.Parameters.AddWithValue("$createdAt", now - 100000);
                cmd.ExecuteNonQuery();
            }

            // Insert 5 fresh entries
            for (int i = 1; i <= 5; i++)
            {
                using var cmd = _adapter.Connection.CreateCommand();
                cmd.CommandText = @"
                    INSERT INTO ucsa_change_log (origin, kind, created_at)
                    VALUES ('fresh-emitter', 'mutation', $createdAt);
                ";
                cmd.Parameters.AddWithValue("$createdAt", now);
                cmd.ExecuteNonQuery();
            }

            Assert.That(_adapter.ReadChangesSince(0).Rows.Count, Is.EqualTo(10));

            // Prune entries older than 50 seconds (should prune the 5 old entries)
            int pruneRes1 = _adapter.PruneChangeLog(retentionMs: 50000, maxRows: 100);
            Assert.That(pruneRes1, Is.EqualTo(5));

            var remaining = _adapter.ReadChangesSince(0);
            Assert.That(remaining.Rows.Count, Is.EqualTo(5));
            Assert.That(remaining.Rows.All(r => r.Origin == "fresh-emitter"), Is.True);

            // Prune with maxRows = 2 (retains newest 2 rows out of 5)
            int pruneRes2 = _adapter.PruneChangeLog(retentionMs: 1000000, maxRows: 2);
            Assert.That(pruneRes2, Is.EqualTo(3));

            var finalRemaining = _adapter.ReadChangesSince(0);
            Assert.That(finalRemaining.Rows.Count, Is.EqualTo(2));
            Assert.That(finalRemaining.Rows.Select(r => r.Seq), Is.EqualTo(new long[] { 9, 10 }));
        }
    }
}
