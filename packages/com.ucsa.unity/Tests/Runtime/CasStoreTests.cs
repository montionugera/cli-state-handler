using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Unity.Storage;

namespace Ucsa.Unity.Tests.Runtime
{
    [TestFixture]
    public class CasStoreTests
    {
        private string _tempDir = null!;
        private UnitySqliteAdapter _adapter = null!;
        private UnityCasStore _store = null!;

        [SetUp]
        public async Task SetUp()
        {
            _tempDir = Path.Combine(Path.GetTempPath(), $"ucsa_cas_test_{Guid.NewGuid():N}");
            Directory.CreateDirectory(_tempDir);
            _adapter = new UnitySqliteAdapter(":memory:");
            _store = new UnityCasStore(_tempDir, _adapter);
            await _store.InitAsync();
        }

        [TearDown]
        public void TearDown()
        {
            _adapter.Close();
            if (Directory.Exists(_tempDir))
            {
                try { Directory.Delete(_tempDir, recursive: true); } catch { }
            }
        }

        private static string ComputeHash(byte[] data)
        {
            using var sha256 = SHA256.Create();
            byte[] hashBytes = sha256.ComputeHash(data);
            return Convert.ToHexString(hashBytes).ToLowerInvariant();
        }

        [Test]
        public void DirectoryStructure_CreatedOnInit()
        {
            Assert.That(Directory.Exists(_store.ObjectsDir), Is.True);
            Assert.That(Directory.Exists(_store.TmpDir), Is.True);
        }

        [Test]
        public async Task PutAndGet_AtomicWriteAndIntegrity()
        {
            byte[] data = Encoding.UTF8.GetBytes("Unity CAS Reference POC Content");
            string expectedHash = ComputeHash(data);

            var result = await _store.PutAsync(data);
            Assert.That(result.Hash, Is.EqualTo(expectedHash));
            Assert.That(result.Size, Is.EqualTo(data.Length));
            Assert.That(File.Exists(result.Path), Is.True);

            // Verify .tmp directory is clean
            var tmpFiles = Directory.GetFiles(_store.TmpDir);
            Assert.That(tmpFiles, Is.Empty);

            // Read back via GetAsync
            byte[]? retrieved = await _store.GetAsync(expectedHash);
            Assert.That(retrieved, Is.Not.Null);
            Assert.That(Encoding.UTF8.GetString(retrieved!), Is.EqualTo("Unity CAS Reference POC Content"));

            // Verify SQLite metadata recorded
            var casObj = _adapter.GetCasObject(expectedHash);
            Assert.That(casObj, Is.Not.Null);
            Assert.That(casObj!.Size, Is.EqualTo(data.Length));
        }

        [Test]
        public async Task PutAsync_WithMatchingExpectedHash_Succeeds()
        {
            byte[] data = Encoding.UTF8.GetBytes("Verified payload");
            string expectedHash = ComputeHash(data);

            var result = await _store.PutAsync(data, expectedHash: expectedHash);
            Assert.That(result.Hash, Is.EqualTo(expectedHash));
            Assert.That(_store.Has(expectedHash), Is.True);
        }

        [Test]
        public void PutAsync_WithMismatchedExpectedHash_ThrowsIntegrityExceptionAndCleansUp()
        {
            byte[] data = Encoding.UTF8.GetBytes("Tampered payload");
            string wrongHash = new string('0', 64);

            var ex = Assert.ThrowsAsync<IntegrityException>(async () =>
            {
                await _store.PutAsync(data, expectedHash: wrongHash);
            });

            Assert.That(ex!.Expected, Is.EqualTo(wrongHash));
            Assert.That(ex.Actual, Is.EqualTo(ComputeHash(data)));

            // No leftover temp files
            var tmpFiles = Directory.GetFiles(_store.TmpDir);
            Assert.That(tmpFiles, Is.Empty);

            // Target object was not created
            Assert.That(_store.Has(ComputeHash(data)), Is.False);
        }

        [Test]
        public async Task HasAndDelete_WorkAccurately()
        {
            byte[] data = Encoding.UTF8.GetBytes("temporary asset");
            string hash = ComputeHash(data);

            Assert.That(_store.Has(hash), Is.False);
            Assert.That(await _store.GetAsync(hash), Is.Null);

            await _store.PutAsync(data);
            Assert.That(_store.Has(hash), Is.True);

            bool deleted = _store.Delete(hash);
            Assert.That(deleted, Is.True);
            Assert.That(_store.Has(hash), Is.False);
            Assert.That(await _store.GetAsync(hash), Is.Null);
            Assert.That(_adapter.GetCasObject(hash), Is.Null);
        }

        [Test]
        public async Task LruQuotaPruning_AutoPrunesOldestEntries()
        {
            // Limit to 300 bytes quota
            var storeWithQuota = new UnityCasStore(_tempDir, _adapter, maxSizeBytes: 300);
            await storeWithQuota.InitAsync();

            byte[] chunk1 = new byte[100]; Array.Fill(chunk1, (byte)1);
            byte[] chunk2 = new byte[100]; Array.Fill(chunk2, (byte)2);
            byte[] chunk3 = new byte[100]; Array.Fill(chunk3, (byte)3);
            byte[] chunk4 = new byte[100]; Array.Fill(chunk4, (byte)4);

            string hash1 = ComputeHash(chunk1);
            string hash2 = ComputeHash(chunk2);
            string hash3 = ComputeHash(chunk3);
            string hash4 = ComputeHash(chunk4);

            await storeWithQuota.PutAsync(chunk1);
            _adapter.UpdateCasAccessTime(hash1, 1000);

            await storeWithQuota.PutAsync(chunk2);
            _adapter.UpdateCasAccessTime(hash2, 2000);

            await storeWithQuota.PutAsync(chunk3);
            _adapter.UpdateCasAccessTime(hash3, 3000);

            Assert.That(storeWithQuota.GetTotalSize(), Is.EqualTo(300));
            Assert.That(storeWithQuota.Has(hash1), Is.True);
            Assert.That(storeWithQuota.Has(hash2), Is.True);
            Assert.That(storeWithQuota.Has(hash3), Is.True);

            // Adding 4th chunk exceeds 300 bytes quota (400 > 300), triggering auto-pruning to 300 * 0.7 = 210 bytes
            await storeWithQuota.PutAsync(chunk4);

            // Oldest chunk1 (access time 1000) and chunk2 (access time 2000) should be pruned
            // 400 - 100 = 300; 300 - 100 = 200 <= 210
            Assert.That(storeWithQuota.Has(hash1), Is.False);
            Assert.That(storeWithQuota.Has(hash2), Is.False);
            Assert.That(storeWithQuota.Has(hash3), Is.True);
            Assert.That(storeWithQuota.Has(hash4), Is.True);
            Assert.That(storeWithQuota.GetTotalSize(), Is.LessThanOrEqualTo(210));
        }

        [Test]
        public async Task ExplicitPruneAsync_ReturnsCorrectPruneResult()
        {
            var storeWithQuota = new UnityCasStore(_tempDir, _adapter, maxSizeBytes: 200);
            await storeWithQuota.InitAsync();

            byte[] dataA = new byte[100]; Array.Fill(dataA, (byte)10);
            byte[] dataB = new byte[100]; Array.Fill(dataB, (byte)20);

            string hashA = ComputeHash(dataA);
            string hashB = ComputeHash(dataB);

            await storeWithQuota.PutAsync(dataA);
            _adapter.UpdateCasAccessTime(hashA, 100);

            await storeWithQuota.PutAsync(dataB);
            _adapter.UpdateCasAccessTime(hashB, 200);

            // Target ratio 0.5 -> 200 * 0.5 = 100 bytes target
            var pruneResult = await storeWithQuota.PruneAsync(targetRatio: 0.5);

            Assert.That(pruneResult.PrunedCount, Is.EqualTo(1));
            Assert.That(pruneResult.BytesFreed, Is.EqualTo(100));
            Assert.That(storeWithQuota.Has(hashA), Is.False);
            Assert.That(storeWithQuota.Has(hashB), Is.True);
            Assert.That(storeWithQuota.GetTotalSize(), Is.EqualTo(100));
        }

        [Test]
        public async Task EdgeCases_EmptyByteArrayAndNonExistentHandledSafely()
        {
            byte[] emptyData = Array.Empty<byte>();
            string emptyHash = ComputeHash(emptyData);

            var putResult = await _store.PutAsync(emptyData);
            Assert.That(putResult.Hash, Is.EqualTo(emptyHash));
            Assert.That(putResult.Size, Is.EqualTo(0));
            Assert.That(_store.Has(emptyHash), Is.True);

            byte[]? retrieved = await _store.GetAsync(emptyHash);
            Assert.That(retrieved, Is.Not.Null);
            Assert.That(retrieved!.Length, Is.EqualTo(0));

            // Non-existent operations
            Assert.That(_store.Has("non_existent"), Is.False);
            Assert.That(_store.Has(""), Is.False);
            Assert.That(await _store.GetAsync("non_existent"), Is.Null);
            Assert.That(await _store.GetAsync(""), Is.Null);
            Assert.That(_store.Delete("non_existent"), Is.False);
            Assert.That(_store.Delete(""), Is.False);
        }
    }
}
