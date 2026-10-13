using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Godot;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Godot
{
    /// <summary>
    /// Configuration options for TextureCache.
    /// </summary>
    public class TextureCacheOptions
    {
        public CasStore? CasStore { get; set; }
        public SqliteAdapter? SqliteAdapter { get; set; }
        public int MaxMemoryTextures { get; set; } = 100;
        public Func<string, CancellationToken, Task<byte[]>>? DownloadHandler { get; set; }
        public Func<byte[], ImageTexture>? TextureDecoder { get; set; }
    }

    /// <summary>
    /// Two-tier texture cache for Godot, the counterpart of the Unity TextureCache:
    /// - Tier 1: In-memory ImageTexture cache (limited by MaxMemoryTextures, least recently used evicted first).
    /// - Tier 2: Persistent Content-Addressable Storage (CAS) with SHA-256 integrity and LRU disk pruning.
    /// Call GetTextureAsync from the main thread: the awaits in it resume on the caller's
    /// context, so the ImageTexture is created on the thread that asked for it.
    /// </summary>
    public class TextureCache : IDisposable
    {
        private static readonly System.Net.Http.HttpClient SharedHttpClient = new();

        private readonly CasStore? _casStore;
        private readonly SqliteAdapter? _sqliteAdapter;
        private readonly int _maxMemoryTextures;
        private readonly Func<string, CancellationToken, Task<byte[]>> _downloadHandler;
        private readonly Func<byte[], ImageTexture> _textureDecoder;

        // In-memory LRU texture cache
        private readonly Dictionary<string, ImageTexture> _memoryCache = new(StringComparer.Ordinal);
        private readonly LinkedList<string> _lruOrder = new();

        // URL -> CAS Content Hash mapping cache
        private readonly Dictionary<string, string> _urlToCasHash = new(StringComparer.Ordinal);
        private readonly object _lock = new();

        public int MaxMemoryTextures => _maxMemoryTextures;
        public int MemoryCacheCount
        {
            get
            {
                lock (_lock)
                {
                    return _memoryCache.Count;
                }
            }
        }

        public TextureCache(TextureCacheOptions? options = null)
        {
            _casStore = options?.CasStore;
            _sqliteAdapter = options?.SqliteAdapter;
            _maxMemoryTextures = options?.MaxMemoryTextures > 0 ? options.MaxMemoryTextures : 100;
            _downloadHandler = options?.DownloadHandler ?? DefaultDownloaderAsync;
            _textureDecoder = options?.TextureDecoder ?? DefaultDecoder;
        }

        public TextureCache(
            CasStore? casStore,
            SqliteAdapter? sqliteAdapter = null,
            int maxMemoryTextures = 100)
            : this(new TextureCacheOptions
            {
                CasStore = casStore,
                SqliteAdapter = sqliteAdapter,
                MaxMemoryTextures = maxMemoryTextures
            })
        {
        }

        /// <summary>
        /// Retrieves an ImageTexture by URL.
        /// Checks the in-memory cache first, then CAS disk storage, and falls back to download.
        /// </summary>
        public async Task<ImageTexture?> GetTextureAsync(string url, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(url)) throw new ArgumentNullException(nameof(url));

            // 1. Check in-memory cache
            lock (_lock)
            {
                if (_memoryCache.TryGetValue(url, out var memoryTex))
                {
                    TouchMemoryLru(url);
                    return memoryTex;
                }
            }

            // 2. Resolve CAS content hash for this URL (from memory mapping or SQLite index)
            string? contentHash = ResolveCasHash(url);
            byte[]? rawBytes = null;
            bool fromDisk = false;

            // 3. Check CAS store on disk
            if (contentHash != null && _casStore != null)
            {
                rawBytes = await _casStore.GetAsync(contentHash, ct);
                if (rawBytes != null)
                {
                    fromDisk = true;
                }
            }

            // 4. Download if not found in CAS
            if (rawBytes == null)
            {
                rawBytes = await _downloadHandler(url, ct);
                if (rawBytes == null || rawBytes.Length == 0)
                {
                    return null;
                }
            }

            // 5. Decode into an ImageTexture (on the caller's context, see class summary)
            ImageTexture texture;
            try
            {
                texture = _textureDecoder(rawBytes);
            }
            catch
            {
                if (fromDisk)
                {
                    DropUrlMapping(url);
                }
                throw;
            }

            if (!fromDisk && _casStore != null)
            {
                // Store into CAS asynchronously (atomic .tmp write and SHA-256 validation)
                var putResult = await _casStore.PutAsync(rawBytes, expectedHash: null, ct);
                RecordUrlMapping(url, putResult.Hash);
            }

            // 6. Promote to in-memory cache
            lock (_lock)
            {
                SetMemoryCache(url, texture);
            }

            return texture;
        }

        /// <summary>
        /// Preloads texture binary data into the CAS disk store without creating a texture.
        /// </summary>
        public async Task PreloadAsync(string url, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(url)) throw new ArgumentNullException(nameof(url));

            string? contentHash = ResolveCasHash(url);
            if (contentHash != null && _casStore != null && _casStore.Has(contentHash))
            {
                return; // Already cached on disk
            }

            byte[] bytes = await _downloadHandler(url, ct).ConfigureAwait(false);
            if (bytes != null && bytes.Length > 0 && _casStore != null)
            {
                var putResult = await _casStore.PutAsync(bytes, expectedHash: null, ct).ConfigureAwait(false);
                RecordUrlMapping(url, putResult.Hash);
            }
        }

        /// <summary>
        /// Evicts a texture from in-memory cache.
        /// </summary>
        public bool Evict(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;

            lock (_lock)
            {
                if (_memoryCache.Remove(url))
                {
                    _lruOrder.Remove(url);
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Clears all textures from in-memory cache.
        /// </summary>
        public void Clear()
        {
            lock (_lock)
            {
                _memoryCache.Clear();
                _lruOrder.Clear();
            }
        }

        /// <summary>
        /// Determines if the URL is cached in memory.
        /// </summary>
        public bool ContainsInMemory(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;
            lock (_lock)
            {
                return _memoryCache.ContainsKey(url);
            }
        }

        private string? ResolveCasHash(string url)
        {
            lock (_lock)
            {
                if (_urlToCasHash.TryGetValue(url, out var hash))
                {
                    return hash;
                }
            }

            if (_sqliteAdapter != null)
            {
                string queryHash = QueryKeyHasher.Hash("texture", url);
                var entry = _sqliteAdapter.GetQuery<string>(queryHash);
                if (entry != null && !string.IsNullOrEmpty(entry.DataPayload))
                {
                    lock (_lock)
                    {
                        _urlToCasHash[url] = entry.DataPayload;
                    }
                    return entry.DataPayload;
                }
            }

            return null;
        }

        private void RecordUrlMapping(string url, string contentHash)
        {
            lock (_lock)
            {
                _urlToCasHash[url] = contentHash;
            }

            if (_sqliteAdapter != null)
            {
                string queryHash = QueryKeyHasher.Hash("texture", url);
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var entry = new CacheEntry<string>(
                    queryHash,
                    new object[] { "texture", url },
                    contentHash,
                    createdAt: now,
                    staleAt: now + (30L * 24 * 3600 * 1000), // 30 days
                    expiresAt: now + (90L * 24 * 3600 * 1000) // 90 days
                );
                _sqliteAdapter.SetQuery(entry, new[] { "texture" });
            }
        }

        private void DropUrlMapping(string url)
        {
            lock (_lock)
            {
                _urlToCasHash.Remove(url);
            }

            if (_sqliteAdapter != null && !_sqliteAdapter.IsClosed)
            {
                string queryHash = QueryKeyHasher.Hash("texture", url);
                _sqliteAdapter.DeleteQuery(queryHash);
            }
        }

        private void TouchMemoryLru(string url)
        {
            _lruOrder.Remove(url);
            _lruOrder.AddLast(url);
        }

        private void SetMemoryCache(string url, ImageTexture texture)
        {
            if (_memoryCache.ContainsKey(url))
            {
                _memoryCache[url] = texture;
                TouchMemoryLru(url);
                return;
            }

            while (_memoryCache.Count >= _maxMemoryTextures && _lruOrder.First != null)
            {
                string oldest = _lruOrder.First.Value;
                _lruOrder.RemoveFirst();
                _memoryCache.Remove(oldest);
            }

            _memoryCache[url] = texture;
            _lruOrder.AddLast(url);
        }

        private static async Task<byte[]> DefaultDownloaderAsync(string url, CancellationToken ct)
        {
            return await SharedHttpClient.GetByteArrayAsync(url, ct).ConfigureAwait(false);
        }

        // PNG and JPEG, the same two formats Unity's LoadImage accepts.
        private static ImageTexture DefaultDecoder(byte[] bytes)
        {
            using var image = new Image();
            bool isJpeg = bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
            Error err = isJpeg ? image.LoadJpgFromBuffer(bytes) : image.LoadPngFromBuffer(bytes);
            if (err != Error.Ok)
            {
                throw new InvalidDataException($"[UCSA] Texture decode failed: {err}");
            }
            return ImageTexture.CreateFromImage(image);
        }

        public void Dispose()
        {
            Clear();
        }
    }
}
