using System;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Ucsa.Storage
{
    /// <summary>
    /// Thrown when a CAS operation fails an integrity checksum verification.
    /// </summary>
    public class IntegrityException : Exception
    {
        public string? Expected { get; }
        public string Actual { get; }

        public IntegrityException(string message, string? expected, string actual)
            : base(message)
        {
            Expected = expected;
            Actual = actual;
        }
    }

    /// <summary>
    /// Result metadata returned after successfully storing an object in CAS.
    /// </summary>
    public record CasPutResult(string Hash, long Size, string Path);

    /// <summary>
    /// Summary of objects pruned and bytes freed during cache eviction.
    /// </summary>
    public record CasPruneResult(int PrunedCount, long BytesFreed);

    /// <summary>
    /// Content-Addressable Storage (CAS) engine with SHA-256 addressing,
    /// atomic promotions via temporary file renames, and LRU quota pruning.
    /// </summary>
    public class CasStore
    {
        private readonly string _baseDir;
        private readonly string _objectsDir;
        private readonly string _tmpDir;
        private readonly SqliteAdapter? _sqliteAdapter;
        private readonly long? _maxSizeBytes;
        private bool _initialized;
        private readonly SemaphoreSlim _initLock = new(1, 1);

        public string BaseDir => _baseDir;
        public string ObjectsDir => _objectsDir;
        public string TmpDir => _tmpDir;
        public SqliteAdapter? SqliteAdapter => _sqliteAdapter;
        public long? MaxSizeBytes => _maxSizeBytes;

        public CasStore(
            string baseDir,
            SqliteAdapter? sqliteAdapter = null,
            long? maxSizeBytes = null)
        {
            _baseDir = baseDir ?? throw new ArgumentNullException(nameof(baseDir));
            _objectsDir = Path.Combine(_baseDir, "objects");
            _tmpDir = Path.Combine(_baseDir, ".tmp");
            _sqliteAdapter = sqliteAdapter;
            _maxSizeBytes = maxSizeBytes;
        }

        /// <summary>
        /// Initializes CAS storage directories and database tables.
        /// </summary>
        public async Task InitAsync()
        {
            if (_initialized) return;

            await _initLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_initialized) return;

                Directory.CreateDirectory(_objectsDir);
                Directory.CreateDirectory(_tmpDir);
                Directory.CreateDirectory(Path.Combine(_baseDir, "tmp"));

                _sqliteAdapter?.InitSchema();

                _initialized = true;
            }
            finally
            {
                _initLock.Release();
            }
        }

        /// <summary>
        /// Returns the deterministic file system path for a given SHA-256 hash.
        /// </summary>
        public string GetPath(string hash)
        {
            if (string.IsNullOrEmpty(hash)) return string.Empty;
            string prefix = hash.Length >= 2 ? hash[..2] : hash;
            return Path.Combine(_objectsDir, prefix, hash);
        }

        /// <summary>
        /// Writes data atomically to the CAS store and verifies SHA-256 checksum integrity.
        /// </summary>
        public async Task<CasPutResult> PutAsync(
            byte[] data,
            string? expectedHash = null,
            CancellationToken ct = default)
        {
            if (data == null) throw new ArgumentNullException(nameof(data));

            await InitAsync().ConfigureAwait(false);

            // Compute SHA-256 hash
            using var sha256 = SHA256.Create();
            byte[] hashBytes = sha256.ComputeHash(data);
            string actualHash = Convert.ToHexString(hashBytes).ToLowerInvariant();

            // Write to temporary file in .tmp/<uuid>
            string tempFileName = $"{Guid.NewGuid():N}.tmp";
            string tempFilePath = Path.Combine(_tmpDir, tempFileName);

            await File.WriteAllBytesAsync(tempFilePath, data, ct).ConfigureAwait(false);

            // Verify checksum integrity if expectedHash was specified
            if (expectedHash != null && !string.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    if (File.Exists(tempFilePath))
                    {
                        File.Delete(tempFilePath);
                    }
                }
                catch { }

                throw new IntegrityException(
                    $"Checksum mismatch: expected {expectedHash}, computed {actualHash}",
                    expectedHash,
                    actualHash);
            }

            // Create partitioned target directory: objects/<prefix>/<hash>
            string prefix = actualHash.Length >= 2 ? actualHash[..2] : actualHash;
            string targetDir = Path.Combine(_objectsDir, prefix);
            Directory.CreateDirectory(targetDir);

            string targetPath = Path.Combine(targetDir, actualHash);

            try
            {
                File.Move(tempFilePath, targetPath, overwrite: true);
            }
            catch
            {
                try
                {
                    if (File.Exists(tempFilePath))
                    {
                        File.Delete(tempFilePath);
                    }
                }
                catch { }
                throw;
            }

            // Record in SQLite and trigger pruning if quota is exceeded
            if (_sqliteAdapter != null)
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                _sqliteAdapter.UpsertCasObject(actualHash, data.Length, now);

                if (_maxSizeBytes.HasValue && _maxSizeBytes.Value > 0)
                {
                    long totalSize = _sqliteAdapter.GetTotalCasSize();
                    if (totalSize > _maxSizeBytes.Value)
                    {
                        await PruneAsync(0.7, ct).ConfigureAwait(false);
                    }
                }
            }

            return new CasPutResult(actualHash, data.Length, targetPath);
        }

        /// <summary>
        /// Retrieves the raw bytes for an object by its SHA-256 hash.
        /// On cache hit, touches access time in file metadata and SQLite.
        /// Returns null if the object does not exist.
        /// </summary>
        public async Task<byte[]?> GetAsync(string hash, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(hash)) return null;

            string filePath = GetPath(hash);
            if (!File.Exists(filePath))
            {
                return null;
            }

            byte[] bytes = await File.ReadAllBytesAsync(filePath, ct).ConfigureAwait(false);

            // Touch last write time
            try
            {
                File.SetLastWriteTimeUtc(filePath, DateTime.UtcNow);
            }
            catch { }

            // Update SQLite access timestamp
            if (_sqliteAdapter != null)
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (!_sqliteAdapter.UpdateCasAccessTime(hash, now))
                {
                    _sqliteAdapter.UpsertCasObject(hash, bytes.Length, now);
                }
            }

            return bytes;
        }

        /// <summary>
        /// Checks whether an object exists in the CAS store on disk.
        /// </summary>
        public bool Has(string hash)
        {
            if (string.IsNullOrEmpty(hash)) return false;
            string filePath = GetPath(hash);
            return File.Exists(filePath);
        }

        /// <summary>
        /// Deletes an object by its SHA-256 hash from both disk and SQLite index.
        /// Returns true if deleted from either disk or database.
        /// </summary>
        public bool Delete(string hash)
        {
            if (string.IsNullOrEmpty(hash)) return false;

            string filePath = GetPath(hash);
            bool diskDeleted = false;
            if (File.Exists(filePath))
            {
                try
                {
                    File.Delete(filePath);
                    diskDeleted = true;
                }
                catch { }
            }

            bool dbDeleted = _sqliteAdapter?.DeleteCasObject(hash) ?? false;
            return diskDeleted || dbDeleted;
        }

        /// <summary>
        /// Returns total size of all CAS objects tracked in SQLite.
        /// </summary>
        public long GetTotalSize()
        {
            return _sqliteAdapter?.GetTotalCasSize() ?? 0;
        }

        /// <summary>
        /// Prunes least recently accessed objects when total storage exceeds limit.
        /// Deletes oldest unaccessed files until total size <= quota * targetRatio.
        /// </summary>
        public async Task<CasPruneResult> PruneAsync(double targetRatio = 0.7, CancellationToken ct = default)
        {
            if (_sqliteAdapter == null)
            {
                return new CasPruneResult(0, 0);
            }

            long? limit = _maxSizeBytes;
            if (!limit.HasValue || limit.Value <= 0)
            {
                return new CasPruneResult(0, 0);
            }

            long currentSize = _sqliteAdapter.GetTotalCasSize();
            long targetSize = (long)(limit.Value * targetRatio);
            if (currentSize <= targetSize)
            {
                return new CasPruneResult(0, 0);
            }

            var candidates = _sqliteAdapter.GetLruCasObjects();
            int prunedCount = 0;
            long bytesFreed = 0;

            foreach (var candidate in candidates)
            {
                if (currentSize <= targetSize || ct.IsCancellationRequested)
                {
                    break;
                }

                string filePath = GetPath(candidate.Hash);
                if (File.Exists(filePath))
                {
                    try
                    {
                        File.Delete(filePath);
                    }
                    catch { }
                }

                _sqliteAdapter.DeleteCasObject(candidate.Hash);
                prunedCount++;
                bytesFreed += candidate.Size;
                currentSize -= candidate.Size;
            }

            await Task.Yield();
            return new CasPruneResult(prunedCount, bytesFreed);
        }
    }
}
