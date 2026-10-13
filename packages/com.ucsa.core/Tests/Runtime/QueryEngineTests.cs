using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class QueryEngineTests
    {
        private SqliteAdapter _adapter = null!;
        private QueryEngine _engine = null!;

        [SetUp]
        public void SetUp()
        {
            _adapter = new SqliteAdapter(":memory:");
            _engine = new QueryEngine(new QueryEngineOptions(_adapter, defaultStaleTime: 50, defaultGcTime: 10000));
        }

        [TearDown]
        public void TearDown()
        {
            _engine.Clear();
            _adapter.Close();
        }

        private class GameProfile
        {
            public string PlayerId { get; set; } = string.Empty;
            public string Rank { get; set; } = string.Empty;
            public int Coins { get; set; }
        }

        [Test]
        public async Task FetchQueryAsync_ColdFetchAndFreshCacheHit()
        {
            var key = new object[] { "player", "p1" };
            int fetchCount = 0;

            async Task<GameProfile> FetchFn(CancellationToken ct)
            {
                fetchCount++;
                await Task.Delay(10, ct);
                return new GameProfile { PlayerId = "p1", Rank = "Gold", Coins = 500 };
            }

            // 1. Cold fetch
            var res1 = await _engine.FetchQueryAsync(key, FetchFn, new QueryOptions { StaleTime = 1000 });
            Assert.That(res1.Coins, Is.EqualTo(500));
            Assert.That(fetchCount, Is.EqualTo(1));

            // 2. Fresh cache hit - queryFn should not be invoked
            var res2 = await _engine.FetchQueryAsync(key, FetchFn, new QueryOptions { StaleTime = 1000 });
            Assert.That(res2.Coins, Is.EqualTo(500));
            Assert.That(fetchCount, Is.EqualTo(1));
        }

        [Test]
        public async Task WatchQuery_SwrLifecycle_EmitsCachedAndRevalidatesInBackground()
        {
            var key = new object[] { "leaderboard" };
            int fetchCount = 0;

            Task<string> FetchFn(CancellationToken ct)
            {
                fetchCount++;
                return Task.FromResult($"Version-{fetchCount}");
            }

            // Seed stale cache with StaleTime = 0
            await _engine.FetchQueryAsync(key, FetchFn, new QueryOptions { StaleTime = 0 });
            Assert.That(fetchCount, Is.EqualTo(1));

            var emittedStates = new List<QueryState<string>>();
            var tcs = new TaskCompletionSource<bool>();

            using var sub = _engine.WatchQuery<string>(
                key,
                state =>
                {
                    emittedStates.Add(state);
                    if (state.Data == "Version-2")
                    {
                        tcs.TrySetResult(true);
                    }
                },
                new QueryOptions { StaleTime = 0 },
                FetchFn
            );

            // First emission must be the stale cached value "Version-1"
            Assert.That(emittedStates, Has.Count.GreaterThanOrEqualTo(1));
            Assert.That(emittedStates[0].Data, Is.EqualTo("Version-1"));

            // Wait for background revalidation
            var completed = await Task.WhenAny(tcs.Task, Task.Delay(2000));
            Assert.That(completed, Is.EqualTo(tcs.Task), "Background revalidation timed out");

            Assert.That(fetchCount, Is.EqualTo(2));
            Assert.That(_engine.GetQueryData<string>(key), Is.EqualTo("Version-2"));
        }

        [Test]
        public async Task ValueEquality_SuppressesRedundantObserverNotifications()
        {
            var key = new object[] { "stats", "hero" };
            int fetchCount = 0;

            Task<GameProfile> FetchFn(CancellationToken ct)
            {
                fetchCount++;
                // Always returns identical content
                return Task.FromResult(new GameProfile { PlayerId = "hero", Rank = "Master", Coins = 1000 });
            }

            int notificationCount = 0;
            var tcs = new TaskCompletionSource<bool>();

            using var sub = _engine.WatchQuery<GameProfile>(
                key,
                state =>
                {
                    if (state.Status == QueryStatus.Success)
                    {
                        notificationCount++;
                        if (fetchCount >= 2)
                        {
                            tcs.TrySetResult(true);
                        }
                    }
                },
                new QueryOptions { StaleTime = 0 },
                FetchFn
            );

            // Wait for initial fetch
            await Task.Delay(100);
            Assert.That(notificationCount, Is.EqualTo(1));

            // Force a re-fetch with identical payload
            await _engine.FetchQueryAsync(key, FetchFn, new QueryOptions { StaleTime = 0 });
            Assert.That(fetchCount, Is.EqualTo(2));

            // Small delay to ensure any potential notification would have arrived
            await Task.Delay(100);

            // Notification count must remain 1 because payload is structurally identical
            Assert.That(notificationCount, Is.EqualTo(1));
        }

        [Test]
        public async Task InvalidateByTag_StalesAndRevalidatesTaggedQueries()
        {
            var key1 = new object[] { "inventory", "item1" };
            var key2 = new object[] { "inventory", "item2" };
            var key3 = new object[] { "skills", "fireball" };

            int item1Fetches = 0;
            int item2Fetches = 0;
            int skillFetches = 0;

            await _engine.FetchQueryAsync(key1, ct => Task.FromResult($"item1-v{++item1Fetches}"), new QueryOptions { Tags = new List<string> { "inventory" }, StaleTime = 60000 });
            await _engine.FetchQueryAsync(key2, ct => Task.FromResult($"item2-v{++item2Fetches}"), new QueryOptions { Tags = new List<string> { "inventory" }, StaleTime = 60000 });
            await _engine.FetchQueryAsync(key3, ct => Task.FromResult($"skill-v{++skillFetches}"), new QueryOptions { Tags = new List<string> { "magic" }, StaleTime = 60000 });

            Assert.That(item1Fetches, Is.EqualTo(1));
            Assert.That(item2Fetches, Is.EqualTo(1));
            Assert.That(skillFetches, Is.EqualTo(1));

            // Watch item1 and skills
            using var sub1 = _engine.WatchQuery<string>(key1, _ => { }, new QueryOptions { Tags = new List<string> { "inventory" } }, ct => Task.FromResult($"item1-v{++item1Fetches}"));
            using var sub3 = _engine.WatchQuery<string>(key3, _ => { }, new QueryOptions { Tags = new List<string> { "magic" } }, ct => Task.FromResult($"skill-v{++skillFetches}"));

            // Invalidate tag "inventory"
            var invalidated = await _engine.InvalidateByTagAsync("inventory");

            Assert.That(invalidated, Has.Count.EqualTo(2));
            Assert.That(item1Fetches, Is.EqualTo(2)); // Revalidated
            Assert.That(skillFetches, Is.EqualTo(1)); // Untouched
        }

        [Test]
        public async Task InvalidateQueries_PrefixMatching_Works()
        {
            var key1 = new object[] { "arena", "match", 1 };
            var key2 = new object[] { "arena", "match", 2 };
            var key3 = new object[] { "shop", "items" };

            int count1 = 0, count2 = 0, count3 = 0;

            await _engine.FetchQueryAsync(key1, ct => Task.FromResult(++count1), new QueryOptions { StaleTime = 60000 });
            await _engine.FetchQueryAsync(key2, ct => Task.FromResult(++count2), new QueryOptions { StaleTime = 60000 });
            await _engine.FetchQueryAsync(key3, ct => Task.FromResult(++count3), new QueryOptions { StaleTime = 60000 });

            using var sub1 = _engine.WatchQuery<int>(key1, _ => { }, null, ct => Task.FromResult(++count1));
            using var sub2 = _engine.WatchQuery<int>(key2, _ => { }, null, ct => Task.FromResult(++count2));
            using var sub3 = _engine.WatchQuery<int>(key3, _ => { }, null, ct => Task.FromResult(++count3));

            // Invalidate prefix ["arena"]
            await _engine.InvalidateQueriesAsync(new object[] { "arena" });

            Assert.That(count1, Is.EqualTo(2));
            Assert.That(count2, Is.EqualTo(2));
            Assert.That(count3, Is.EqualTo(1)); // Untouched
        }

        [Test]
        public void Cancellation_HaltsInFlightFetch()
        {
            var key = new object[] { "long_running_fetch" };
            using var cts = new CancellationTokenSource();

            var fetchTask = _engine.FetchQueryAsync(key, async ct =>
            {
                await Task.Delay(2000, ct);
                return "completed";
            }, ct: cts.Token);

            cts.Cancel();

            Assert.ThrowsAsync<TaskCanceledException>(async () => await fetchTask);
            var state = _engine.GetQueryState<string>(key);
            Assert.That(state?.IsFetching ?? false, Is.False);
        }

        [Test]
        public async Task CancelQuery_MethodCancelsInFlightOperation()
        {
            var key = new object[] { "cancel_test" };

            var fetchTask = _engine.FetchQueryAsync(key, async ct =>
            {
                await Task.Delay(2000, ct);
                return "done";
            });

            await Task.Delay(50);
            _engine.CancelQuery(key);

            Assert.ThrowsAsync<TaskCanceledException>(async () => await fetchTask);
        }

        [Test]
        public void PersistenceToSqlite_SurvivesEngineRestart()
        {
            var key = new object[] { "persistent_player", "p99" };
            var data = new GameProfile { PlayerId = "p99", Rank = "Diamond", Coins = 9999 };

            _engine.SetQueryData(key, data, new QueryOptions { StaleTime = 60000, GcTime = 60000 });

            // Create fresh engine instance referencing same SQLite DB
            var freshEngine = new QueryEngine(new QueryEngineOptions(_adapter));
            var loadedState = freshEngine.GetQueryState<GameProfile>(key);

            Assert.That(loadedState, Is.Not.Null);
            Assert.That(loadedState!.Status, Is.EqualTo(QueryStatus.Success));
            Assert.That(loadedState.Data!.PlayerId, Is.EqualTo("p99"));
            Assert.That(loadedState.Data.Rank, Is.EqualTo("Diamond"));
            Assert.That(loadedState.Data.Coins, Is.EqualTo(9999));
        }

        [Test]
        public void FetchQueryAsync_ThrowsException_UpdatesStateToError()
        {
            var key = new object[] { "error_query" };

            var ex = Assert.ThrowsAsync<InvalidOperationException>(async () =>
            {
                await _engine.FetchQueryAsync<string>(key, ct => throw new InvalidOperationException("Backend 500 error"));
            });

            Assert.That(ex!.Message, Is.EqualTo("Backend 500 error"));

            var state = _engine.GetQueryState<string>(key);
            Assert.That(state, Is.Not.Null);
            Assert.That(state!.Status, Is.EqualTo(QueryStatus.Error));
            Assert.That(state.Error, Is.Not.Null);
            Assert.That(state.IsFetching, Is.False);
        }

        [Test]
        public void WatchQuery_Unsubscribe_StopsNotifications()
        {
            var key = new object[] { "unsub_test" };
            int notifications = 0;

            var sub = _engine.WatchQuery<string>(key, s =>
            {
                if (s.Status == QueryStatus.Success) notifications++;
            });

            _engine.SetQueryData(key, "v1");
            Assert.That(notifications, Is.EqualTo(1));

            sub.Dispose();

            _engine.SetQueryData(key, "v2");
            Assert.That(notifications, Is.EqualTo(1));
        }

        [Test]
        public void SyncOverloads_InvalidateQueriesAndInvalidateByTag_Work()
        {
            var key1 = new object[] { "zone", "east" };
            var key2 = new object[] { "zone", "west" };

            _engine.SetQueryData(key1, "east-data", new QueryOptions { Tags = new List<string> { "zone" } });
            _engine.SetQueryData(key2, "west-data", new QueryOptions { Tags = new List<string> { "zone" } });

            Assert.That(_engine.GetQueryData<string>(key1), Is.EqualTo("east-data"));
            Assert.That(_engine.GetQueryData<string>(key2), Is.EqualTo("west-data"));

            var invalidated = _engine.InvalidateByTag("zone");
            Assert.That(invalidated, Has.Count.EqualTo(2));

            _engine.InvalidateQueries(new object[] { "zone" });
        }

        [Test]
        public async Task SelectivelyEvictsCorruptedCacheEntry_AndFetchesFresh()
        {
            var key = new object[] { "corrupted_zone" };
            string hash = QueryKeyHasher.Hash(key);

            // Directly insert corrupted JSON payload into SQLite
            using (var cmd = _adapter.Connection.CreateCommand())
            {
                cmd.CommandText = @"
                    INSERT INTO ucsa_query_cache (
                        query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
                    ) VALUES ($hash, $key, $payload, null, $now, $stale, $expires);
                ";
                cmd.Parameters.AddWithValue("$hash", hash);
                cmd.Parameters.AddWithValue("$key", "[\"corrupted_zone\"]");
                cmd.Parameters.AddWithValue("$payload", "NOT_VALID_JSON_{{");
                cmd.Parameters.AddWithValue("$now", 1000L);
                cmd.Parameters.AddWithValue("$stale", 2000L);
                cmd.Parameters.AddWithValue("$expires", 3000L);
                cmd.ExecuteNonQuery();
            }

            // Fresh fetch should not throw, should evict corrupted row and return fresh data
            var data = await _engine.FetchQueryAsync<string>(key, ct => Task.FromResult("repaired_fresh_data"));
            Assert.That(data, Is.EqualTo("repaired_fresh_data"));

            // Verify entry in SQLite is now valid
            var updated = _adapter.GetQuery<string>(hash);
            Assert.That(updated, Is.Not.Null);
            Assert.That(updated!.DataPayload, Is.EqualTo("repaired_fresh_data"));
        }
    }
}
