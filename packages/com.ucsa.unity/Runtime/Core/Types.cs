using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Ucsa.Unity.Core
{
    /// <summary>
    /// 5-stage lifecycle state for queries.
    /// </summary>
    public enum QueryStatus
    {
        Idle,
        Loading,
        Success,
        Error,
        Retrying
    }

    /// <summary>
    /// Configuration options for query execution.
    /// </summary>
    public class QueryOptions
    {
        public long? StaleTime { get; set; }
        public long? GcTime { get; set; }
        public List<string>? Tags { get; set; }
        public int DebounceMs { get; set; } = 0;

        public QueryOptions() { }

        public QueryOptions(long? staleTime = null, long? gcTime = null, List<string>? tags = null, int debounceMs = 0)
        {
            StaleTime = staleTime;
            GcTime = gcTime;
            Tags = tags;
            DebounceMs = debounceMs;
        }
    }

    /// <summary>
    /// Reactive query state snapshot containing status, data, error, and timestamps.
    /// </summary>
    /// <typeparam name="T">Data payload type.</typeparam>
    public class QueryState<T>
    {
        public QueryStatus Status { get; set; } = QueryStatus.Idle;
        public T? Data { get; set; }
        public object? Error { get; set; }
        public long? DataUpdatedAt { get; set; }
        public long? ErrorUpdatedAt { get; set; }
        public bool IsFetching { get; set; }

        public bool IsIdle => Status == QueryStatus.Idle;
        public bool IsLoading => Status == QueryStatus.Loading;
        public bool IsSuccess => Status == QueryStatus.Success;
        public bool IsError => Status == QueryStatus.Error;
        public bool IsRetrying => Status == QueryStatus.Retrying;

        public QueryState() { }

        public QueryState(
            QueryStatus status = QueryStatus.Idle,
            T? data = default,
            object? error = null,
            long? dataUpdatedAt = null,
            long? errorUpdatedAt = null,
            bool isFetching = false)
        {
            Status = status;
            Data = data;
            Error = error;
            DataUpdatedAt = dataUpdatedAt;
            ErrorUpdatedAt = errorUpdatedAt;
            IsFetching = isFetching;
        }

        public QueryState<T> Clone()
        {
            return new QueryState<T>(Status, Data, Error, DataUpdatedAt, ErrorUpdatedAt, IsFetching);
        }
    }

    /// <summary>
    /// Conflict resolution policy for mutations.
    /// </summary>
    public enum ConflictPolicy
    {
        ServerWins,
        ClientWins,
        Merge
    }

    /// <summary>
    /// Lifecycle status of an outbox mutation.
    /// </summary>
    public enum OutboxMutationStatus
    {
        Pending,
        InFlight,
        Failed
    }

    /// <summary>
    /// Cached query data entry with expiration metadata.
    /// </summary>
    /// <typeparam name="T">Payload type.</typeparam>
    public class CacheEntry<T>
    {
        public string QueryHash { get; set; } = string.Empty;
        public object[] QueryKey { get; set; } = Array.Empty<object>();
        public T DataPayload { get; set; } = default!;
        public string? Etag { get; set; }
        public long CreatedAt { get; set; }
        public long StaleAt { get; set; }
        public long ExpiresAt { get; set; }

        public CacheEntry() { }

        public CacheEntry(
            string queryHash,
            object[] queryKey,
            T dataPayload,
            long createdAt,
            long staleAt,
            long expiresAt,
            string? etag = null)
        {
            QueryHash = queryHash;
            QueryKey = queryKey ?? Array.Empty<object>();
            DataPayload = dataPayload;
            CreatedAt = createdAt;
            StaleAt = staleAt;
            ExpiresAt = expiresAt;
            Etag = etag;
        }

        public bool IsStale(long? nowMs = null)
        {
            long now = nowMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return now >= StaleAt;
        }

        public bool IsExpired(long? nowMs = null)
        {
            long now = nowMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return now >= ExpiresAt;
        }
    }

    /// <summary>
    /// Persistent outbox record for asynchronous replay.
    /// </summary>
    /// <typeparam name="T">Payload type.</typeparam>
    public class OutboxMutation<T>
    {
        public string MutationId { get; set; } = string.Empty;
        public string Endpoint { get; set; } = string.Empty;
        public string Method { get; set; } = "POST";
        public Dictionary<string, string>? Headers { get; set; }
        public T? Payload { get; set; }
        public OutboxMutationStatus Status { get; set; } = OutboxMutationStatus.Pending;
        public int RetryCount { get; set; }
        public long CreatedAt { get; set; }
        public long? LastAttemptAt { get; set; }
        public string? Error { get; set; }
        public bool Forced { get; set; }
        public ConflictPolicy? ConflictPolicy { get; set; }

        public bool IsPending => Status == OutboxMutationStatus.Pending;
        public bool IsInFlight => Status == OutboxMutationStatus.InFlight;
        public bool Failed => Status == OutboxMutationStatus.Failed;

        public OutboxMutation() { }

        public OutboxMutation(
            string mutationId,
            string endpoint,
            string method,
            long createdAt,
            T? payload = default,
            Dictionary<string, string>? headers = null,
            OutboxMutationStatus status = OutboxMutationStatus.Pending,
            int retryCount = 0,
            long? lastAttemptAt = null,
            string? error = null,
            bool forced = false,
            ConflictPolicy? conflictPolicy = null)
        {
            MutationId = mutationId;
            Endpoint = endpoint;
            Method = method;
            CreatedAt = createdAt;
            Payload = payload;
            Headers = headers;
            Status = status;
            RetryCount = retryCount;
            LastAttemptAt = lastAttemptAt;
            Error = error;
            Forced = forced;
            ConflictPolicy = conflictPolicy;
        }
    }

    /// <summary>
    /// Result of an outbox replay execution.
    /// </summary>
    public class ReplayResult
    {
        public int Processed { get; set; }
        public int Successful { get; set; }
        public int Failed { get; set; }

        public ReplayResult() { }

        public ReplayResult(int processed, int successful, int failed)
        {
            Processed = processed;
            Successful = successful;
            Failed = failed;
        }
    }

    /// <summary>
    /// Deterministic query key hasher producing SHA-256 hex string.
    /// </summary>
    public static class QueryKeyHasher
    {
        public static string Hash(params object[] keys)
        {
            string normalized;
            if (keys == null || keys.Length == 0)
            {
                normalized = "[]";
            }
            else
            {
                normalized = Normalize(keys);
            }

            using var sha256 = SHA256.Create();
            byte[] bytes = Encoding.UTF8.GetBytes(normalized);
            byte[] hashBytes = sha256.ComputeHash(bytes);
            var sb = new StringBuilder(64);
            foreach (byte b in hashBytes)
            {
                sb.Append(b.ToString("x2"));
            }
            return sb.ToString();
        }

        private static string Normalize(object? obj)
        {
            if (obj == null) return "null";
            if (obj is bool b) return b ? "true" : "false";
            if (obj is string s) return EscapeString(s);
            if (obj is sbyte or byte or short or ushort or int or uint or long or ulong)
                return Convert.ToString(obj, CultureInfo.InvariantCulture)!;
            if (obj is float f)
                return f.ToString("R", CultureInfo.InvariantCulture);
            if (obj is double d)
                return d.ToString("R", CultureInfo.InvariantCulture);
            if (obj is decimal dec)
                return dec.ToString(CultureInfo.InvariantCulture);
            if (obj is IDictionary dict)
            {
                var entries = new List<(string Key, string Value)>();
                foreach (DictionaryEntry entry in dict)
                {
                    string keyStr = entry.Key?.ToString() ?? "";
                    string valStr = Normalize(entry.Value);
                    entries.Add((keyStr, valStr));
                }
                entries.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));
                var sb = new StringBuilder();
                sb.Append('{');
                for (int i = 0; i < entries.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append(EscapeString(entries[i].Key));
                    sb.Append(':');
                    sb.Append(entries[i].Value);
                }
                sb.Append('}');
                return sb.ToString();
            }
            if (obj is IEnumerable seq)
            {
                var items = new List<string>();
                foreach (var item in seq)
                {
                    items.Add(Normalize(item));
                }
                return "[" + string.Join(",", items) + "]";
            }

            return EscapeString(obj.ToString() ?? "");
        }

        private static string EscapeString(string s)
        {
            var sb = new StringBuilder();
            sb.Append('\"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (char.IsControl(c))
                        {
                            sb.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c);
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('\"');
            return sb.ToString();
        }
    }
}
