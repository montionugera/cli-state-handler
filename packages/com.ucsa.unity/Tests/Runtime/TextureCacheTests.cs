using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Unity.Storage;
using Ucsa.Unity.Transports;
using UnityEngine;

namespace Ucsa.Unity.Tests.Runtime
{
    [TestFixture]
    public class TextureCacheTests
    {
        private string _testDir = null!;
        private string _dbPath = null!;
        private string _casDir = null!;
        private UnitySqliteAdapter _sqlite = null!;
        private UnityCasStore _casStore = null!;

        [SetUp]
        public async Task Setup()
        {
            _testDir = Path.Combine(Path.GetTempPath(), "ucsa_tex_test_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_testDir);
            _dbPath = Path.Combine(_testDir, "test.db");
            _casDir = Path.Combine(_testDir, "cas");

            _sqlite = new UnitySqliteAdapter(_dbPath);
            _sqlite.InitSchema();

            _casStore = new UnityCasStore(_casDir, _sqlite);
            await _casStore.InitAsync();
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
        public async Task GetTextureAsync_DownloadsAndCachesInMemory()
        {
            int downloadCalls = 0;
            byte[] mockPng = Encoding.UTF8.GetBytes("FAKE_PNG_BINARY_DATA");

            var cache = new TextureCache(new TextureCacheOptions
            {
                CasStore = _casStore,
                SqliteAdapter = _sqlite,
                MaxMemoryTextures = 10,
                DownloadHandler = (url, ct) =>
                {
                    Interlocked.Increment(ref downloadCalls);
                    return Task.FromResult(mockPng);
                }
            });

            string url = "https://example.com/hero.png";

            // 1. Initial fetch: downloads and populates memory and CAS
            var tex1 = await cache.GetTextureAsync(url);
            Assert.That(tex1, Is.Not.Null);
            Assert.That(downloadCalls, Is.EqualTo(1));
            Assert.That(cache.MemoryCacheCount, Is.EqualTo(1));
            Assert.That(cache.ContainsInMemory(url), Is.True);

            // 2. Second fetch: served immediately from memory without network
            var tex2 = await cache.GetTextureAsync(url);
            Assert.That(tex2, Is.Not.Null);
            Assert.That(downloadCalls, Is.EqualTo(1)); // Still 1 call
        }

        [Test]
        public async Task GetTextureAsync_ServesFromCasWhenEvictedFromMemory()
        {
            int downloadCalls = 0;
            byte[] mockPng = Encoding.UTF8.GetBytes("PERSISTED_TEXTURE_DATA");

            var cache = new TextureCache(new TextureCacheOptions
            {
                CasStore = _casStore,
                SqliteAdapter = _sqlite,
                MaxMemoryTextures = 10,
                DownloadHandler = (url, ct) =>
                {
                    Interlocked.Increment(ref downloadCalls);
                    return Task.FromResult(mockPng);
                }
            });

            string url = "https://example.com/avatar.png";

            // 1. First fetch
            var tex1 = await cache.GetTextureAsync(url);
            Assert.That(tex1, Is.Not.Null);
            Assert.That(downloadCalls, Is.EqualTo(1));

            // 2. Evict from memory
            cache.Evict(url);
            Assert.That(cache.ContainsInMemory(url), Is.False);
            Assert.That(cache.MemoryCacheCount, Is.EqualTo(0));

            // 3. Second fetch: retrieves from CAS disk store without re-downloading
            var tex2 = await cache.GetTextureAsync(url);
            Assert.That(tex2, Is.Not.Null);
            Assert.That(downloadCalls, Is.EqualTo(1)); // Network wasn't called
            Assert.That(cache.ContainsInMemory(url), Is.True);
        }

        [Test]
        public async Task MemoryLru_EvictsOldestWhenMaxMemoryTexturesReached()
        {
            int downloadCalls = 0;
            var cache = new TextureCache(new TextureCacheOptions
            {
                CasStore = _casStore,
                SqliteAdapter = _sqlite,
                MaxMemoryTextures = 2, // Only hold 2 in memory
                DownloadHandler = (url, ct) =>
                {
                    Interlocked.Increment(ref downloadCalls);
                    return Task.FromResult(Encoding.UTF8.GetBytes("DATA_" + url));
                }
            });

            await cache.GetTextureAsync("url_1");
            await cache.GetTextureAsync("url_2");
            Assert.That(cache.MemoryCacheCount, Is.EqualTo(2));
            Assert.That(cache.ContainsInMemory("url_1"), Is.True);
            Assert.That(cache.ContainsInMemory("url_2"), Is.True);

            // Adding a 3rd texture pushes out url_1
            await cache.GetTextureAsync("url_3");
            Assert.That(cache.MemoryCacheCount, Is.EqualTo(2));
            Assert.That(cache.ContainsInMemory("url_1"), Is.False); // Evicted
            Assert.That(cache.ContainsInMemory("url_2"), Is.True);
            Assert.That(cache.ContainsInMemory("url_3"), Is.True);
        }

        [Test]
        public async Task PreloadAsync_StoresInCasWithoutPopulatingMemory()
        {
            int downloadCalls = 0;
            var cache = new TextureCache(new TextureCacheOptions
            {
                CasStore = _casStore,
                SqliteAdapter = _sqlite,
                MaxMemoryTextures = 10,
                DownloadHandler = (url, ct) =>
                {
                    Interlocked.Increment(ref downloadCalls);
                    return Task.FromResult(Encoding.UTF8.GetBytes("PRELOAD_DATA"));
                }
            });

            string url = "https://example.com/preload.png";
            await cache.PreloadAsync(url);

            Assert.That(downloadCalls, Is.EqualTo(1));
            Assert.That(cache.ContainsInMemory(url), Is.False); // Not in memory yet

            // Next GetTextureAsync should load from CAS without re-downloading
            var tex = await cache.GetTextureAsync(url);
            Assert.That(tex, Is.Not.Null);
            Assert.That(downloadCalls, Is.EqualTo(1));
            Assert.That(cache.ContainsInMemory(url), Is.True);
        }

        [Test]
        public async Task Clear_EmptiesMemoryCache()
        {
            var cache = new TextureCache(new TextureCacheOptions
            {
                CasStore = _casStore,
                MaxMemoryTextures = 5,
                DownloadHandler = (url, ct) => Task.FromResult(Encoding.UTF8.GetBytes("DATA"))
            });

            await cache.GetTextureAsync("url1");
            await cache.GetTextureAsync("url2");
            Assert.That(cache.MemoryCacheCount, Is.EqualTo(2));

            cache.Clear();
            Assert.That(cache.MemoryCacheCount, Is.EqualTo(0));
            Assert.That(cache.ContainsInMemory("url1"), Is.False);
        }
    }
}
