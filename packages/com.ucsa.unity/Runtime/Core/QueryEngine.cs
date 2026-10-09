using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Ucsa.Unity.Storage;
using Ucsa.Unity.Streaming;

namespace Ucsa.Unity.Core
{
    /// <summary>
    /// Configuration options for initializing the QueryEngine.
    /// </summary>
    public class QueryEngineOptions
    {
        public UnitySqliteAdapter? SqliteAdapter { get; set; }
        public long DefaultStaleTime { get; set; } = 0;
        public long DefaultGcTime { get; set; } = 300000; // 5 minutes

        public QueryEngineOptions() { }

        public QueryEngineOptions(
            UnitySqliteAdapter? sqliteAdapter = null,
            long defaultStaleTime = 0,
            long defaultGcTime = 300000)
        {
            SqliteAdapter = sqliteAdapter;
            DefaultStaleTime = defaultStaleTime;
            DefaultGcTime = defaultGcTime;
        }
    }

    /// <summary>
    /// Configuration options for streaming queries.
    /// </summary>
    public class StreamQueryOptions
    {
        public long? StaleTime { get; set; }
        public long? GcTime { get; set; }
        public List<string>? Tags { get; set; }
        public IResumeStrategy? Strategy { get; set; }
        public UnityCasStore? CasStore { get; set; }
        public int CasThresholdBytes { get; set; } = 1048576;
        public CancellationToken CancellationToken { get; set; } = default;
        public int BaseDelayMs { get; set; } = 300;
        public int MaxRetries { get; set; } = 5;

        public StreamQueryOptions() { }

        public StreamQueryOptions(
            long? staleTime = null,
            long? gcTime = null,
            List<string>? tags = null,
            IResumeStrategy? strategy = null,
            UnityCasStore? casStore = null,
            int casThresholdBytes = 1048576,
            CancellationToken cancellationToken = default,
            int baseDelayMs = 300,
            int maxRetries = 5)
        {
            StaleTime = staleTime;
            GcTime = gcTime;
            Tags = tags;
            Strategy = strategy;
            CasStore = casStore;
            CasThresholdBytes = casThresholdBytes;
            CancellationToken = cancellationToken;
            BaseDelayMs = baseDelayMs;
            MaxRetries = maxRetries;
        }
    }

    /// <summary>
    /// Core UCSA Query Engine providing asynchronous caching, Stale-While-Revalidate (SWR),
    /// structural value equality change suppression, and query cancellation.
    /// </summary>
    public class QueryEngine
    {
        private static readonly JsonSerializerOptions SerializerOptions = new()
        {
            PropertyNameCaseInsensitive = true,
            WriteIndented = false
        };

        private readonly UnitySqliteAdapter? _sqliteAdapter;
        private readonly long _defaultStaleTime;
        private readonly long _defaultGcTime;

        private readonly Dictionary<string, IInternalQueryRecord> _queries = new();
        private readonly object _lock = new();

        public UnitySqliteAdapter? SqliteAdapter => _sqliteAdapter;
        public long DefaultStaleTime => _defaultStaleTime;
        public long DefaultGcTime => _defaultGcTime;

        public QueryEngine(QueryEngineOptions? options = null)
        {
            _sqliteAdapter = options?.SqliteAdapter;
            _defaultStaleTime = options?.DefaultStaleTime ?? 0;
            _defaultGcTime = options?.DefaultGcTime ?? 300000;
        }

        public QueryEngine(
            UnitySqliteAdapter? sqliteAdapter,
            long defaultStaleTime = 0,
            long defaultGcTime = 300000)
            : this(new QueryEngineOptions(sqliteAdapter, defaultStaleTime, defaultGcTime))
        {
        }

        #region Internal Record Definition

        private interface IInternalQueryRecord
        {
            object[] QueryKey { get; }
            string Hash { get; }
            List<string>? Tags { get; }
            int SubscriberCount { get; }
            void CancelActive();
            void MarkStale();
            Task RevalidateAsync(CancellationToken ct);
        }

        private class InternalQueryRecord<T> : IInternalQueryRecord
        {
            public object[] QueryKey { get; set; }
            public string Hash { get; set; }
            public CacheEntry<T>? Entry { get; set; }
            public List<string>? Tags { get; set; }
            public QueryOptions? Options { get; set; }
            public Func<CancellationToken, Task<T>>? QueryFn { get; set; }
            public QueryState<T> State { get; set; }
            public List<Action<QueryState<T>>> Subscribers { get; } = new();
            public CancellationTokenSource? ActiveCts { get; set; }
            public Task<T>? ActiveTask { get; set; }
            public Timer? DebounceTimer { get; set; }
            public List<TaskCompletionSource<T>> DebounceResolvers { get; } = new();
            private readonly QueryEngine _engine;

            public int SubscriberCount
            {
                get
                {
                    lock (Subscribers)
                    {
                        return Subscribers.Count;
                    }
                }
            }

            public InternalQueryRecord(QueryEngine engine, object[] queryKey, string hash)
            {
                _engine = engine;
                QueryKey = queryKey;
                Hash = hash;
                State = new QueryState<T>();
            }

            public void CancelActive()
            {
                lock (DebounceResolvers)
                {
                    if (DebounceTimer != null)
                    {
                        DebounceTimer.Dispose();
                        DebounceTimer = null;
                        foreach (var tcs in DebounceResolvers)
                        {
                            tcs.TrySetCanceled();
                        }
                        DebounceResolvers.Clear();
                    }
                }

                if (ActiveCts != null)
                {
                    ActiveCts.Cancel();
                    ActiveCts = null;
                    ActiveTask = null;
                    State.IsFetching = false;
                }
            }

            public void MarkStale()
            {
                if (Entry != null)
                {
                    Entry.StaleAt = 0;
                }
            }

            public Task RevalidateAsync(CancellationToken ct)
            {
                if (QueryFn != null && SubscriberCount > 0)
                {
                    State.IsFetching = true;
                    return _engine.ExecuteFetchAsync(this, QueryFn, Options, ct);
                }
                return Task.CompletedTask;
            }
        }

        #endregion

        #region Value Equality & Matching

        /// <summary>
        /// Checks deep structural / value equality between two values.
        /// Used to suppress UI notifications if incoming payload is identical.
        /// </summary>
        public static bool ValueEquals(object? a, object? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a is null || b is null) return false;
            if (a.Equals(b)) return true;

            if (a is System.Collections.IDictionary dictA && b is System.Collections.IDictionary dictB)
            {
                if (dictA.Count != dictB.Count) return false;
                foreach (var key in dictA.Keys)
                {
                    if (!dictB.Contains(key)) return false;
                    if (!ValueEquals(dictA[key], dictB[key])) return false;
                }
                return true;
            }

            if (a is System.Collections.IEnumerable seqA && b is System.Collections.IEnumerable seqB && !(a is string))
            {
                var listA = new List<object?>();
                foreach (var item in seqA) listA.Add(item);
                var listB = new List<object?>();
                foreach (var item in seqB) listB.Add(item);
                if (listA.Count != listB.Count) return false;
                for (int i = 0; i < listA.Count; i++)
                {
                    if (!ValueEquals(listA[i], listB[i])) return false;
                }
                return true;
            }

            try
            {
                string jsonA = JsonSerializer.Serialize(a, SerializerOptions);
                string jsonB = JsonSerializer.Serialize(b, SerializerOptions);
                return jsonA == jsonB;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Checks if targetQueryKey matches prefixQueryKey.
        /// </summary>
        public static bool MatchQueryKey(object[]? prefix, object[]? target)
        {
            if (prefix == null || prefix.Length == 0) return true;
            if (target == null || target.Length < prefix.Length) return false;

            for (int i = 0; i < prefix.Length; i++)
            {
                if (!ValueEquals(prefix[i], target[i]))
                {
                    return false;
                }
            }
            return true;
        }

        #endregion

        #region Public Query API

        /// <summary>
        /// Fetches and caches a query, returning a Task resolving to the data.
        /// If fresh data is already cached, returns immediately without invoking queryFn.
        /// </summary>
        public async Task<T> FetchQueryAsync<T>(
            object[] queryKey,
            Func<CancellationToken, Task<T>> queryFn,
            QueryOptions? options = null,
            CancellationToken ct = default)
        {
            if (queryKey == null) throw new ArgumentNullException(nameof(queryKey));
            if (queryFn == null) throw new ArgumentNullException(nameof(queryFn));

            string hash = QueryKeyHasher.Hash(queryKey);
            InternalQueryRecord<T> record;

            lock (_lock)
            {
                record = GetOrCreateRecord<T>(queryKey, hash, options);
                record.QueryFn = queryFn;
                record.Options = options;
                if (options?.Tags != null)
                {
                    record.Tags = options.Tags;
                }
            }

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long staleThreshold = options?.StaleTime != null && record.Entry != null
                ? record.Entry.CreatedAt + options.StaleTime.Value
                : record.Entry?.StaleAt ?? 0;

            bool isFresh = record.Entry != null && now < staleThreshold;

            if (isFresh && record.State.Data != null)
            {
                return record.State.Data;
            }

            if (options?.DebounceMs > 0)
            {
                int debounceMs = options.DebounceMs;
                TaskCompletionSource<T> tcs;

                lock (record.DebounceResolvers)
                {
                    if (record.DebounceTimer != null)
                    {
                        record.DebounceTimer.Dispose();
                        record.DebounceTimer = null;
                    }

                    tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
                    record.DebounceResolvers.Add(tcs);

                    if (ct.CanBeCanceled)
                    {
                        ct.Register(() =>
                        {
                            lock (record.DebounceResolvers)
                            {
                                if (record.DebounceResolvers.Remove(tcs))
                                {
                                    tcs.TrySetCanceled(ct);
                                }
                            }
                        });
                    }

                    record.DebounceTimer = new Timer(async _ =>
                    {
                        List<TaskCompletionSource<T>> resolvers;
                        lock (record.DebounceResolvers)
                        {
                            record.DebounceTimer?.Dispose();
                            record.DebounceTimer = null;
                            resolvers = new List<TaskCompletionSource<T>>(record.DebounceResolvers);
                            record.DebounceResolvers.Clear();
                        }

                        if (resolvers.Count == 0) return;

                        try
                        {
                            T result = await ExecuteFetchAsync(record, queryFn, options, CancellationToken.None).ConfigureAwait(false);
                            foreach (var r in resolvers)
                            {
                                r.TrySetResult(result);
                            }
                        }
                        catch (OperationCanceledException oce)
                        {
                            foreach (var r in resolvers)
                            {
                                r.TrySetCanceled(oce.CancellationToken);
                            }
                        }
                        catch (Exception ex)
                        {
                            foreach (var r in resolvers)
                            {
                                r.TrySetException(ex);
                            }
                        }
                    }, null, debounceMs, Timeout.Infinite);
                }

                return await tcs.Task.ConfigureAwait(false);
            }

            return await ExecuteFetchAsync(record, queryFn, options, ct).ConfigureAwait(false);
        }

        /// <summary>
        /// Debounces a query fetch execution by the specified delay in milliseconds.
        /// Collapses rapid calls for the same query key into a single execution.
        /// </summary>
        public Task<T> DebounceQueryAsync<T>(
            object[] queryKey,
            Func<CancellationToken, Task<T>> queryFn,
            int debounceMs,
            QueryOptions? options = null,
            CancellationToken ct = default)
        {
            var opt = options ?? new QueryOptions();
            opt.DebounceMs = debounceMs;
            return FetchQueryAsync(queryKey, queryFn, opt, ct);
        }

        /// <summary>
        /// Reactive subscription supporting Stale-While-Revalidate (SWR).
        /// Emits cached entry immediately if available; revalidates in the background if stale.
        /// Observers are notified only when the data payload value changes.
        /// </summary>
        public IDisposable WatchQuery<T>(
            object[] queryKey,
            Action<QueryState<T>> onStateChanged,
            QueryOptions? options = null,
            Func<CancellationToken, Task<T>>? queryFn = null,
            CancellationToken ct = default)
        {
            if (queryKey == null) throw new ArgumentNullException(nameof(queryKey));
            if (onStateChanged == null) throw new ArgumentNullException(nameof(onStateChanged));

            string hash = QueryKeyHasher.Hash(queryKey);
            InternalQueryRecord<T> record;

            lock (_lock)
            {
                record = GetOrCreateRecord<T>(queryKey, hash, options);
                if (queryFn != null) record.QueryFn = queryFn;
                if (options != null) record.Options = options;
                if (options?.Tags != null) record.Tags = options.Tags;

                record.Subscribers.Add(onStateChanged);
            }

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long staleThreshold = options?.StaleTime != null && record.Entry != null
                ? record.Entry.CreatedAt + options.StaleTime.Value
                : record.Entry?.StaleAt ?? 0;

            bool hasData = record.State.Data != null;
            bool isStale = record.Entry == null || now >= staleThreshold;

            if (!hasData)
            {
                record.State.Status = QueryStatus.Loading;
                record.State.IsFetching = queryFn != null;
                onStateChanged(record.State.Clone());

                if (queryFn != null)
                {
                    _ = ExecuteFetchAsync(record, queryFn, options, ct);
                }
            }
            else if (isStale)
            {
                // SWR: Cache hit! Return data immediately, revalidate in background
                record.State.IsFetching = queryFn != null;
                onStateChanged(record.State.Clone());

                if (queryFn != null)
                {
                    _ = ExecuteFetchAsync(record, queryFn, options, ct);
                }
            }
            else
            {
                // Fresh cache hit
                record.State.IsFetching = false;
                onStateChanged(record.State.Clone());
            }

            return new Subscription(() =>
            {
                lock (_lock)
                {
                    record.Subscribers.Remove(onStateChanged);
                }
            });
        }

        /// <summary>
        /// Streams a query with incremental UTF-8 slicing, automatic compaction into SQLite/CAS,
        /// failure recovery via StreamResumeFsm, and SWR caching.
        /// </summary>
        public StreamHandle<T> StreamQueryAsync<T>(
            object[] queryKey,
            Func<StreamFnContext, IAsyncEnumerable<byte[]>> streamFn,
            StreamQueryOptions? options = null)
        {
            if (queryKey == null) throw new ArgumentNullException(nameof(queryKey));
            if (streamFn == null) throw new ArgumentNullException(nameof(streamFn));

            string hash = QueryKeyHasher.Hash(queryKey);
            InternalQueryRecord<T> record;

            lock (_lock)
            {
                record = GetOrCreateRecord<T>(queryKey, hash, new QueryOptions(options?.StaleTime, options?.GcTime, options?.Tags));
            }

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long effectiveStale = options?.StaleTime ?? record.Options?.StaleTime ?? _defaultStaleTime;
            long staleThreshold = record.Entry != null
                ? record.Entry.CreatedAt + effectiveStale
                : record.Entry?.StaleAt ?? 0;

            bool isFresh = record.Entry != null && now < staleThreshold;

            if (isFresh && record.State.Data != null)
            {
                var cachedData = record.State.Data;
                var cachedHandle = new StreamHandle<T>(hash);
                cachedHandle.Push(new StreamSlice<T>(
                    delta: cachedData,
                    cumulative: cachedData,
                    seq: 0,
                    byteOffset: 0,
                    done: true
                ));
                cachedHandle.End(cachedData);
                return cachedHandle;
            }

            if (_sqliteAdapter != null)
            {
                try
                {
                    var existing = _sqliteAdapter.GetStream(hash);
                    if (existing != null)
                    {
                        try
                        {
                            _sqliteAdapter.ResetStream(hash);
                        }
                        catch { }
                    }
                    else
                    {
                        _sqliteAdapter.CreateStream(
                            queryKey,
                            encoding: StreamEncoding.Utf8,
                            tags: options?.Tags,
                            ttlMs: (int)(options?.GcTime ?? 300000),
                            resumeKind: options?.Strategy is LastEventIdResumeStrategy ? ResumeKind.LastEventId : null
                        );
                    }
                }
                catch { }
            }

            var resumeStrategy = options?.Strategy ?? new RangeResumeStrategy();
            var resumeFsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = hash,
                QueryKey = queryKey,
                Strategy = resumeStrategy,
                SqliteAdapter = _sqliteAdapter,
                BaseDelayMs = options?.BaseDelayMs ?? 300,
                MaxDelayMs = 10000,
                MaxRetries = options?.MaxRetries ?? 5
            });
            resumeFsm.Start();

            var internalCts = new CancellationTokenSource();
            var handle = new StreamHandle<T>(hash, internalCts);

            void DoCancel(string? reason)
            {
                try
                {
                    if (!internalCts.IsCancellationRequested)
                    {
                        internalCts.Cancel();
                    }
                }
                catch { }

                if (!handle.IsCancelled)
                {
                    handle.Cancel(reason);
                }
                _sqliteAdapter?.AbortStream(hash, reason);
                resumeFsm.Abort(reason);

                lock (_lock)
                {
                    record.State.IsFetching = false;
                    NotifySubscribers(record);
                }
            }

            if (options != null && options.CancellationToken.IsCancellationRequested)
            {
                DoCancel("Cancelled before start");
                return handle;
            }

            if (options != null && options.CancellationToken.CanBeCanceled)
            {
                options.CancellationToken.Register(() => DoCancel("Cancelled via cancellationToken"));
            }

            internalCts.Token.Register(() => DoCancel("Cancelled via handle"));

            lock (_lock)
            {
                record.ActiveCts = internalCts;
                record.State.Status = record.State.Data != null ? record.State.Status : QueryStatus.Loading;
                record.State.IsFetching = true;
                NotifySubscribers(record);
            }

            _ = Task.Run(async () =>
            {
                Dictionary<string, string>? currentResumeHeaders = null;
                object? currentContinuationPayload = null;
                string cumulativeText = string.Empty;
                var utf8Decoder = new Utf8StreamDecoder();

                while (!handle.IsDone && !handle.IsCancelled && !internalCts.IsCancellationRequested)
                {
                    try
                    {
                        var ctx = new StreamFnContext(
                            hash,
                            internalCts.Token,
                            currentResumeHeaders,
                            currentContinuationPayload
                        );

                        var stream = streamFn(ctx);

                        await foreach (var rawChunk in stream.WithCancellation(internalCts.Token).ConfigureAwait(false))
                        {
                            if (handle.IsCancelled || internalCts.IsCancellationRequested)
                            {
                                break;
                            }

                            var chunkResult = resumeFsm.HandleIncomingChunk(rawChunk);
                            if (!chunkResult.Accepted)
                            {
                                continue;
                            }

                            string delta = utf8Decoder.Decode(chunkResult.Slice);
                            cumulativeText += delta;
                            if (!string.IsNullOrEmpty(delta))
                            {
                                T deltaT = typeof(T) == typeof(string) ? (T)(object)delta : (T)(object)chunkResult.Slice;
                                T cumulativeT = typeof(T) == typeof(string) ? (T)(object)cumulativeText : (T)(object)chunkResult.Slice;

                                handle.Push(new StreamSlice<T>(
                                    delta: deltaT,
                                    cumulative: cumulativeT,
                                    seq: chunkResult.Seq,
                                    byteOffset: chunkResult.ByteOffset,
                                    done: false
                                ));
                            }
                        }

                        if (handle.IsCancelled || internalCts.IsCancellationRequested)
                        {
                            break;
                        }

                        resumeFsm.Complete();

                        string flushed = utf8Decoder.Flush();
                        if (!string.IsNullOrEmpty(flushed))
                        {
                            cumulativeText += flushed;
                            T flushedDelta = typeof(T) == typeof(string) ? (T)(object)flushed : default!;
                            T flushedCumulative = typeof(T) == typeof(string) ? (T)(object)cumulativeText : default!;

                            handle.Push(new StreamSlice<T>(
                                delta: flushedDelta,
                                cumulative: flushedCumulative,
                                seq: resumeFsm.CommittedSeq,
                                byteOffset: resumeFsm.CommittedByteLength,
                                done: false
                            ));
                        }

                        T finalPayload = typeof(T) == typeof(string) ? (T)(object)cumulativeText : default!;

                        CacheEntry<object>? compactedEntry = null;
                        if (_sqliteAdapter != null)
                        {
                            try
                            {
                                compactedEntry = await _sqliteAdapter.CompactStreamAsync(
                                    hash,
                                    options?.CasStore,
                                    options?.CasThresholdBytes ?? 1048576
                                ).ConfigureAwait(false);
                            }
                            catch { }
                        }

                        long completionNow = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        long effectiveStaleAfter = options?.StaleTime ?? _defaultStaleTime;
                        long effectiveGcAfter = options?.GcTime ?? _defaultGcTime;

                        if (compactedEntry != null && options?.StaleTime != null)
                        {
                            compactedEntry.StaleAt = compactedEntry.CreatedAt + effectiveStaleAfter;
                            try
                            {
                                _sqliteAdapter?.SetQuery(compactedEntry, options?.Tags);
                            }
                            catch { }
                        }

                        lock (_lock)
                        {
                            record.Entry = new CacheEntry<T>(
                                hash,
                                queryKey,
                                finalPayload,
                                completionNow,
                                completionNow + effectiveStaleAfter,
                                completionNow + effectiveGcAfter,
                                compactedEntry?.Etag,
                                1
                            );
                            record.State.Status = QueryStatus.Success;
                            record.State.Data = finalPayload;
                            record.State.DataUpdatedAt = completionNow;
                            record.State.Error = null;
                            record.State.IsFetching = false;
                            NotifySubscribers(record);
                        }

                        T emptyDelta = typeof(T) == typeof(string) ? (T)(object)string.Empty : default!;
                        handle.Push(new StreamSlice<T>(
                            delta: emptyDelta,
                            cumulative: finalPayload,
                            seq: resumeFsm.CommittedSeq,
                            byteOffset: resumeFsm.CommittedByteLength,
                            done: true
                        ));
                        handle.End(finalPayload);
                        break;
                    }
                    catch (Exception ex)
                    {
                        if (handle.IsCancelled || internalCts.IsCancellationRequested)
                        {
                            break;
                        }

                        var errorResult = resumeFsm.HandleError(ex);
                        if (errorResult.CanResume)
                        {
                            currentResumeHeaders = errorResult.Headers;
                            currentContinuationPayload = errorResult.ContinuationPayload;
                            if (errorResult.Restart)
                            {
                                cumulativeText = string.Empty;
                                utf8Decoder = new Utf8StreamDecoder();
                                T emptyT = typeof(T) == typeof(string) ? (T)(object)string.Empty : default!;
                                handle.Push(new StreamSlice<T>(
                                    delta: emptyT,
                                    cumulative: emptyT,
                                    seq: 0,
                                    byteOffset: 0,
                                    done: false,
                                    reset: true
                                ));
                            }
                            if (errorResult.RetryDelayMs > 0)
                            {
                                await Task.Delay(errorResult.RetryDelayMs, internalCts.Token).ConfigureAwait(false);
                            }
                            continue;
                        }
                        else
                        {
                            resumeFsm.Abort(ex.Message);
                            handle.Error(ex);
                            lock (_lock)
                            {
                                record.State.Status = QueryStatus.Error;
                                record.State.Error = ex;
                                record.State.ErrorUpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                record.State.IsFetching = false;
                                NotifySubscribers(record);
                            }
                            break;
                        }
                    }
                }
            });

            return handle;
        }

        /// <summary>
        /// Streams a text query with incremental token chunks.
        /// </summary>
        public StreamHandle<string> StreamQueryAsync(
            object[] queryKey,
            Func<StreamFnContext, IAsyncEnumerable<string>> streamFn,
            StreamQueryOptions? options = null)
        {
            async IAsyncEnumerable<byte[]> ByteStreamWrapper(StreamFnContext ctx)
            {
                await foreach (var str in streamFn(ctx).ConfigureAwait(false))
                {
                    yield return Encoding.UTF8.GetBytes(str);
                }
            }

            return StreamQueryAsync<string>(queryKey, ByteStreamWrapper, options);
        }

        /// <summary>
        /// Alias for StreamQueryAsync.
        /// </summary>
        public StreamHandle<T> StreamQuery<T>(
            object[] queryKey,
            Func<StreamFnContext, IAsyncEnumerable<byte[]>> streamFn,
            StreamQueryOptions? options = null)
            => StreamQueryAsync<T>(queryKey, streamFn, options);

        /// <summary>
        /// Invalidates all queries matching the query key prefix.
        /// Marks matching entries as stale and revalidates active watched queries.
        /// </summary>
        public async Task InvalidateQueriesAsync(object[]? prefix = null, CancellationToken ct = default)
        {
            var matchedRecords = new List<IInternalQueryRecord>();

            lock (_lock)
            {
                foreach (var kvp in _queries)
                {
                    var rec = kvp.Value;
                    if (MatchQueryKey(prefix, rec.QueryKey))
                    {
                        matchedRecords.Add(rec);
                        rec.MarkStale();
                    }
                }
            }

            // Invalidate in SQLite
            if (_sqliteAdapter != null)
            {
                try
                {
                    var expired = _sqliteAdapter.GetExpiredQueries<object>(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 365L * 24 * 3600 * 1000);
                    foreach (var entry in expired)
                    {
                        if (MatchQueryKey(prefix, entry.QueryKey))
                        {
                            _sqliteAdapter.DeleteQuery(entry.QueryHash);
                        }
                    }
                }
                catch { }
            }

            // Trigger revalidation for active records
            var tasks = new List<Task>();
            foreach (var rec in matchedRecords)
            {
                if (rec.SubscriberCount > 0)
                {
                    tasks.Add(rec.RevalidateAsync(ct));
                }
            }

            if (tasks.Count > 0)
            {
                await Task.WhenAll(tasks).ConfigureAwait(false);
            }
        }

        /// <summary>
        /// Synchronously invalidates all queries matching the query key prefix.
        /// </summary>
        public void InvalidateQueries(object[]? prefix = null)
        {
            InvalidateQueriesAsync(prefix).GetAwaiter().GetResult();
        }

        /// <summary>
        /// Invalidates all queries associated with the specified tag in SQLite and memory.
        /// Returns the list of query hashes that were invalidated.
        /// </summary>
        public async Task<List<string>> InvalidateByTagAsync(string tag, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(tag)) return new List<string>();

            var invalidatedHashes = new HashSet<string>();

            // 1. Invalidate in SQLite
            if (_sqliteAdapter != null)
            {
                var dbHashes = _sqliteAdapter.InvalidateByTag(tag);
                foreach (var h in dbHashes)
                {
                    invalidatedHashes.Add(h);
                }
            }

            // 2. Invalidate in memory
            var revalidateRecords = new List<IInternalQueryRecord>();

            lock (_lock)
            {
                foreach (var kvp in _queries)
                {
                    var rec = kvp.Value;
                    bool hasTag = rec.Tags != null && rec.Tags.Contains(tag);
                    if (hasTag || invalidatedHashes.Contains(kvp.Key))
                    {
                        invalidatedHashes.Add(kvp.Key);
                        rec.MarkStale();
                        if (rec.SubscriberCount > 0)
                        {
                            revalidateRecords.Add(rec);
                        }
                    }
                }
            }

            // Revalidate watched queries
            var tasks = new List<Task>();
            foreach (var rec in revalidateRecords)
            {
                tasks.Add(rec.RevalidateAsync(ct));
            }

            if (tasks.Count > 0)
            {
                await Task.WhenAll(tasks).ConfigureAwait(false);
            }

            return new List<string>(invalidatedHashes);
        }

        /// <summary>
        /// Synchronously invalidates all queries tagged with the specified tag.
        /// </summary>
        public List<string> InvalidateByTag(string tag)
        {
            return InvalidateByTagAsync(tag).GetAwaiter().GetResult();
        }

        /// <summary>
        /// Cancels any active in-flight fetch operation for the specified query key.
        /// </summary>
        public void CancelQuery(object[] queryKey)
        {
            if (queryKey == null) return;
            string hash = QueryKeyHasher.Hash(queryKey);

            lock (_lock)
            {
                if (_queries.TryGetValue(hash, out var rec))
                {
                    rec.CancelActive();
                }
            }
        }

        /// <summary>
        /// Synchronously reads the query state for a query key from memory or SQLite.
        /// </summary>
        public QueryState<T>? GetQueryState<T>(object[] queryKey)
        {
            if (queryKey == null) return null;
            string hash = QueryKeyHasher.Hash(queryKey);

            lock (_lock)
            {
                if (_queries.TryGetValue(hash, out var recObj) && recObj is InternalQueryRecord<T> rec)
                {
                    return rec.State.Clone();
                }
            }

            if (_sqliteAdapter != null)
            {
                try
                {
                    var entry = _sqliteAdapter.GetQuery<T>(hash);
                    if (entry != null && !entry.IsExpired())
                    {
                        var record = new InternalQueryRecord<T>(this, queryKey, hash)
                        {
                            Entry = entry,
                            State = new QueryState<T>(
                                QueryStatus.Success,
                                entry.DataPayload,
                                dataUpdatedAt: entry.CreatedAt,
                                isFetching: false)
                        };

                        lock (_lock)
                        {
                            _queries[hash] = record;
                        }

                        return record.State.Clone();
                    }
                }
                catch
                {
                    lock (_lock)
                    {
                        _queries.Remove(hash);
                    }
                    try { _sqliteAdapter.DeleteQuery(hash); } catch { }
                    return null;
                }
            }

            return null;
        }

        /// <summary>
        /// Synchronously reads query data if present.
        /// </summary>
        public T? GetQueryData<T>(object[] queryKey)
        {
            return GetQueryState<T>(queryKey) != null ? GetQueryState<T>(queryKey)!.Data : default;
        }

        /// <summary>
        /// Manually sets or updates cached query data.
        /// Notifies observers only if the value actually changed.
        /// </summary>
        public void SetQueryData<T>(object[] queryKey, T data, QueryOptions? options = null)
        {
            if (queryKey == null) throw new ArgumentNullException(nameof(queryKey));

            string hash = QueryKeyHasher.Hash(queryKey);
            InternalQueryRecord<T> record;

            lock (_lock)
            {
                record = GetOrCreateRecord<T>(queryKey, hash, options);
            }

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long staleTime = options?.StaleTime ?? _defaultStaleTime;
            long gcTime = options?.GcTime ?? _defaultGcTime;

            T? oldData = record.State.Data;
            bool dataChanged = oldData == null || !ValueEquals(oldData, data);

            record.State.Status = QueryStatus.Success;
            record.State.Data = data;
            record.State.DataUpdatedAt = now;
            record.State.Error = null;
            record.State.IsFetching = false;

            var entry = new CacheEntry<T>(
                hash,
                queryKey,
                data,
                createdAt: now,
                staleAt: now + staleTime,
                expiresAt: now + gcTime
            );
            record.Entry = entry;

            if (_sqliteAdapter != null)
            {
                var tags = options?.Tags ?? record.Tags;
                _sqliteAdapter.SetQuery(entry, tags);
            }

            if (dataChanged)
            {
                NotifySubscribers(record);
            }
        }

        /// <summary>
        /// Clears the in-memory cache and aborts any active fetch operations.
        /// </summary>
        public void Clear()
        {
            lock (_lock)
            {
                foreach (var rec in _queries.Values)
                {
                    rec.CancelActive();
                }
                _queries.Clear();
            }
        }

        #endregion

        #region Private Fetch & Notification

        private async Task<T> ExecuteFetchAsync<T>(
            InternalQueryRecord<T> record,
            Func<CancellationToken, Task<T>> queryFn,
            QueryOptions? options,
            CancellationToken ct)
        {
            Task<T>? existingTask;
            CancellationTokenSource linkedCts;

            lock (_lock)
            {
                existingTask = record.ActiveTask;
                if (existingTask == null)
                {
                    linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    record.ActiveCts = linkedCts;
                }
                else
                {
                    linkedCts = null!;
                }
            }

            if (existingTask != null)
            {
                return await existingTask.ConfigureAwait(false);
            }

            var fetchTask = Task.Run(async () =>
            {
                var prevStatus = record.State.Status;
                var oldData = record.State.Data;
                record.State.IsFetching = true;

                try
                {
                    T rawData = await queryFn(linkedCts.Token).ConfigureAwait(false);
                    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    long staleTime = options?.StaleTime ?? _defaultStaleTime;
                    long gcTime = options?.GcTime ?? _defaultGcTime;

                    bool dataChanged = oldData == null || !ValueEquals(oldData, rawData);
                    bool statusChanged = prevStatus != QueryStatus.Success;

                    record.State.Status = QueryStatus.Success;
                    record.State.Data = rawData;
                    record.State.DataUpdatedAt = now;
                    record.State.Error = null;
                    record.State.IsFetching = false;

                    var entry = new CacheEntry<T>(
                        record.Hash,
                        record.QueryKey,
                        rawData,
                        createdAt: now,
                        staleAt: now + staleTime,
                        expiresAt: now + gcTime
                    );
                    record.Entry = entry;

                    if (_sqliteAdapter != null)
                    {
                        var tags = options?.Tags ?? record.Tags;
                        _sqliteAdapter.SetQuery(entry, tags);
                    }

                    // Structural sharing / value equality check: notifies observers only when data value changes
                    if (dataChanged || statusChanged)
                    {
                        NotifySubscribers(record);
                    }

                    return rawData;
                }
                catch (OperationCanceledException)
                {
                    record.State.IsFetching = false;
                    throw;
                }
                catch (Exception ex)
                {
                    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    record.State.Status = QueryStatus.Error;
                    record.State.Error = ex;
                    record.State.ErrorUpdatedAt = now;
                    record.State.IsFetching = false;

                    NotifySubscribers(record);
                    throw;
                }
                finally
                {
                    lock (_lock)
                    {
                        if (record.ActiveCts == linkedCts)
                        {
                            record.ActiveTask = null;
                            record.ActiveCts = null;
                        }
                    }
                }
            });

            lock (_lock)
            {
                record.ActiveTask = fetchTask;
            }

            return await fetchTask.ConfigureAwait(false);
        }

        private InternalQueryRecord<T> GetOrCreateRecord<T>(
            object[] queryKey,
            string hash,
            QueryOptions? options = null)
        {
            if (_queries.TryGetValue(hash, out var existing))
            {
                return (InternalQueryRecord<T>)existing;
            }

            // Check SQLite on cold start
            if (_sqliteAdapter != null)
            {
                try
                {
                    var entry = _sqliteAdapter.GetQuery<T>(hash);
                    if (entry != null)
                    {
                        if (!entry.IsExpired())
                        {
                            var rec = new InternalQueryRecord<T>(this, queryKey, hash)
                            {
                                Entry = entry,
                                Tags = options?.Tags,
                                Options = options,
                                State = new QueryState<T>(
                                    QueryStatus.Success,
                                    entry.DataPayload,
                                    dataUpdatedAt: entry.CreatedAt,
                                    isFetching: false)
                            };
                            _queries[hash] = rec;
                            return rec;
                        }
                        else
                        {
                            _sqliteAdapter.DeleteQuery(hash);
                        }
                    }
                }
                catch
                {
                    _queries.Remove(hash);
                    try { _sqliteAdapter.DeleteQuery(hash); } catch { }
                }
            }

            var newRecord = new InternalQueryRecord<T>(this, queryKey, hash)
            {
                Tags = options?.Tags,
                Options = options
            };
            _queries[hash] = newRecord;
            return newRecord;
        }

        private static void NotifySubscribers<T>(InternalQueryRecord<T> record)
        {
            List<Action<QueryState<T>>> subs;
            QueryState<T> snapshot;

            lock (record.Subscribers)
            {
                subs = new List<Action<QueryState<T>>>(record.Subscribers);
                snapshot = record.State.Clone();
            }

            foreach (var sub in subs)
            {
                try
                {
                    sub(snapshot);
                }
                catch { }
            }
        }

        private class Subscription : IDisposable
        {
            private Action? _unsubscribe;

            public Subscription(Action unsubscribe)
            {
                _unsubscribe = unsubscribe;
            }

            public void Dispose()
            {
                Interlocked.Exchange(ref _unsubscribe, null)?.Invoke();
            }
        }

        #endregion
    }
}
