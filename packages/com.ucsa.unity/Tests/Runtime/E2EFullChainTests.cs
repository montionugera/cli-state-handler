using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;
using Ucsa.Unity.Transports;
using Ucsa.Unity.Unity;
using UnityEngine;

namespace Ucsa.Unity.Tests.Runtime
{
    public class PackageMetadata
    {
        public string Id { get; set; } = string.Empty;
        public string Version { get; set; } = string.Empty;
        public int Downloads { get; set; }

        public override bool Equals(object? obj)
        {
            if (obj is PackageMetadata other)
            {
                return Id == other.Id && Version == other.Version && Downloads == other.Downloads;
            }
            return false;
        }

        public override int GetHashCode() => HashCode.Combine(Id, Version, Downloads);
    }

    [TestFixture]
    public class E2EFullChainTests
    {
        private string _testDir = null!;
        private string _dbPath = null!;
        private string _walPath = null!;
        private string _casDir = null!;
        private SqliteAdapter _sqlite = null!;
        private CasStore _cas = null!;
        private QueryEngine _engine = null!;

        [SetUp]
        public async Task Setup()
        {
            _testDir = Path.Combine(Path.GetTempPath(), "ucsa_csharp_e2e_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_testDir);
            _dbPath = Path.Combine(_testDir, "state.db");
            _walPath = $"{_dbPath}-wal";
            _casDir = Path.Combine(_testDir, "cas");

            _sqlite = new SqliteAdapter(_dbPath);
            _sqlite.InitSchema();

            _cas = new CasStore(_casDir, _sqlite);
            await _cas.InitAsync();

            _engine = new QueryEngine(new QueryEngineOptions(_sqlite)
            {
                DefaultStaleTime = 30000,
                DefaultGcTime = 300000
            });
        }

        [TearDown]
        public void TearDown()
        {
            _sqlite.Dispose();
            if (Directory.Exists(_testDir))
            {
                try { Directory.Delete(_testDir, true); } catch { }
            }
        }

        [Test]
        public async Task ExecutesCompleteFullChainLifecycle()
        {
            // -----------------------------------------------------------------
            // Step 1: Ingress with SWR caching & SQLite WAL persistence
            // -----------------------------------------------------------------
            int remoteFetchCount = 0;
            var queryKey = new object[] { "packages", "pkg-core" };
            var tags = new List<string> { "pkg:core", "ecosystem" };

            var serverData = new PackageMetadata
            {
                Id = "pkg-core",
                Version = "1.0.0",
                Downloads = 100
            };

            Task<PackageMetadata> FetchRemote(CancellationToken token)
            {
                Interlocked.Increment(ref remoteFetchCount);
                return Task.FromResult(new PackageMetadata
                {
                    Id = serverData.Id,
                    Version = serverData.Version,
                    Downloads = serverData.Downloads
                });
            }

            // Initial fetch
            var initial = await _engine.FetchQueryAsync(queryKey, FetchRemote, new QueryOptions { Tags = tags });
            Assert.That(initial.Version, Is.EqualTo("1.0.0"));
            Assert.That(remoteFetchCount, Is.EqualTo(1));

            // Synchronous read within staleTime
            var cached = await _engine.FetchQueryAsync(queryKey, FetchRemote, new QueryOptions { Tags = tags });
            Assert.That(cached.Version, Is.EqualTo("1.0.0"));
            Assert.That(remoteFetchCount, Is.EqualTo(1)); // No extra network call

            // Verify SQLite persistence
            string queryHash = QueryKeyHasher.Hash(queryKey);
            var dbEntry = _sqlite.GetQuery<PackageMetadata>(queryHash);
            Assert.That(dbEntry, Is.Not.Null);
            Assert.That(dbEntry!.DataPayload.Version, Is.EqualTo("1.0.0"));

            // Verify tag indexing in SQLite
            var taggedQueries = _sqlite.GetQueryHashesByTag("pkg:core");
            Assert.That(taggedQueries, Does.Contain(queryHash));

            // -----------------------------------------------------------------
            // Step 2: Content-Addressable Storage (CAS) with SHA-256
            // -----------------------------------------------------------------
            byte[] packageBytes = Encoding.UTF8.GetBytes("BINARY_PACKAGE_PAYLOAD_UNITY_V1.0.0");
            using var sha256 = SHA256.Create();
            string expectedSha = Convert.ToHexString(sha256.ComputeHash(packageBytes)).ToLowerInvariant();

            var putResult = await _cas.PutAsync(packageBytes, expectedSha);
            Assert.That(putResult.Hash, Is.EqualTo(expectedSha));
            Assert.That(putResult.Size, Is.EqualTo(packageBytes.Length));
            Assert.That(File.Exists(putResult.Path), Is.True);

            // Retrieve from CAS
            byte[]? retrieved = await _cas.GetAsync(expectedSha);
            Assert.That(retrieved, Is.Not.Null);
            Assert.That(Encoding.UTF8.GetString(retrieved!), Is.EqualTo("BINARY_PACKAGE_PAYLOAD_UNITY_V1.0.0"));

            var casRecord = _sqlite.GetCasObject(expectedSha);
            Assert.That(casRecord, Is.Not.Null);
            Assert.That(casRecord!.Size, Is.EqualTo(packageBytes.Length));

            // -----------------------------------------------------------------
            // Step 3: Zero-Allocation UI State Observer
            // -----------------------------------------------------------------
            var observer = new StateObserver<PackageMetadata, string>(data => data.Version);
            Assert.That(observer.HasValue, Is.False);

            int uiRebuildCount = 0;
            observer.OnValueChanged += newVersion =>
            {
                uiRebuildCount++;
            };

            // Feed initial value
            observer.Update(initial);
            Assert.That(uiRebuildCount, Is.EqualTo(1));
            Assert.That(observer.CurrentValue, Is.EqualTo("1.0.0"));

            // Update with identical data -> 0 rebuilds
            observer.Update(new PackageMetadata { Id = "pkg-core", Version = "1.0.0", Downloads = 100 });
            Assert.That(uiRebuildCount, Is.EqualTo(1));

            // Update with changed unselected field (downloads 100 -> 500) -> 0 rebuilds
            observer.Update(new PackageMetadata { Id = "pkg-core", Version = "1.0.0", Downloads = 500 });
            Assert.That(uiRebuildCount, Is.EqualTo(1));

            // Update with changed version ("1.1.0") -> exactly 1 rebuild
            observer.Update(new PackageMetadata { Id = "pkg-core", Version = "1.1.0", Downloads = 500 });
            Assert.That(uiRebuildCount, Is.EqualTo(2));
            Assert.That(observer.CurrentValue, Is.EqualTo("1.1.0"));

            // -----------------------------------------------------------------
            // Step 4: Two-Tier GPU Texture Cache
            // -----------------------------------------------------------------
            int downloadCalls = 0;
            var textureCache = new TextureCache(new TextureCacheOptions
            {
                CasStore = _cas,
                SqliteAdapter = _sqlite,
                MaxMemoryTextures = 10,
                DownloadHandler = (url, ct) =>
                {
                    Interlocked.Increment(ref downloadCalls);
                    return Task.FromResult(Encoding.UTF8.GetBytes("MOCK_TEXTURE_DATA_123"));
                }
            });

            string textureUrl = "https://cdn.game.internal/assets/hero.png";
            var tex1 = await textureCache.GetTextureAsync(textureUrl);
            Assert.That(tex1, Is.Not.Null);
            Assert.That(downloadCalls, Is.EqualTo(1));
            Assert.That(textureCache.MemoryCacheCount, Is.EqualTo(1));

            // Evict from memory, retrieve from CAS without re-downloading
            textureCache.Evict(textureUrl);
            Assert.That(textureCache.MemoryCacheCount, Is.EqualTo(0));

            var tex2 = await textureCache.GetTextureAsync(textureUrl);
            Assert.That(tex2, Is.Not.Null);
            Assert.That(downloadCalls, Is.EqualTo(1)); // Served from CAS disk cache

            // -----------------------------------------------------------------
            // Step 5: Offline Mutation Outbox
            // -----------------------------------------------------------------
            var mutation = new OutboxMutation<string>(
                "mut-unity-1",
                "/api/v1/packages/pkg-core",
                "PATCH",
                payload: "{\"version\":\"1.1.1\"}",
                status: OutboxMutationStatus.Pending,
                retryCount: 0,
                createdAt: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                conflictPolicy: ConflictPolicy.ClientWins
            );
            _sqlite.SetMutation(mutation);

            var pending = _sqlite.GetPendingMutations<string>();
            Assert.That(pending.Count, Is.EqualTo(1));
            Assert.That(pending[0].MutationId, Is.EqualTo("mut-unity-1"));

            _sqlite.DeleteMutation("mut-unity-1");
            Assert.That(_sqlite.GetPendingMutations<string>().Count, Is.EqualTo(0));

            // -----------------------------------------------------------------
            // Step 6: Mobile Lifecycle Durability & WAL Truncate
            // -----------------------------------------------------------------
            var behaviour = new UcsaBehaviour
            {
                SqliteAdapter = _sqlite,
                QueryEngine = _engine,
                CheckpointOnPause = true
            };
            behaviour.Awake();

            bool checkpointFired = false;
            behaviour.OnCheckpointFlushed += () => checkpointFired = true;

            // Sentinel write to ensure WAL pages exist
            _sqlite.SetQuery(new CacheEntry<string>("sentinel", new object[] { "sentinel" }, "ok", 100, 200, 300));

            behaviour.HandlePauseState(true); // Simulate app backgrounding
            Assert.That(checkpointFired, Is.True);

            if (File.Exists(_walPath))
            {
                Assert.That(new FileInfo(_walPath).Length, Is.EqualTo(0));
            }

            behaviour.HandleQuit();

            // Reopen and verify data durability
            using var reopenDb = new SqliteAdapter(_dbPath);
            var sentinel = reopenDb.GetQuery<string>("sentinel");
            Assert.That(sentinel, Is.Not.Null);
            Assert.That(sentinel!.DataPayload, Is.EqualTo("ok"));
        }
    }
}
