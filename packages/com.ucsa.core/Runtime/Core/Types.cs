using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Ucsa.Core
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
        public int PayloadVersion { get; set; } = 1;

        public CacheEntry() { }

        public CacheEntry(
            string queryHash,
            object[] queryKey,
            T dataPayload,
            long createdAt,
            long staleAt,
            long expiresAt,
            string? etag = null,
            int payloadVersion = 1)
        {
            QueryHash = queryHash;
            QueryKey = queryKey ?? Array.Empty<object>();
            DataPayload = dataPayload;
            CreatedAt = createdAt;
            StaleAt = staleAt;
            ExpiresAt = expiresAt;
            Etag = etag;
            PayloadVersion = payloadVersion;
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
        public string? LeaseOwner { get; set; }
        public long? LeaseUntil { get; set; }

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
            ConflictPolicy? conflictPolicy = null,
            string? leaseOwner = null,
            long? leaseUntil = null)
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
            LeaseOwner = leaseOwner;
            LeaseUntil = leaseUntil;
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

    /// <summary>
    /// Category of persistent event logged to ucsa_change_log.
    /// </summary>
    public enum ChangeLogKind
    {
        Invalidate,
        Mutation,
        Stream,
        Reset
    }

    public static class ChangeLogKindExtensions
    {
        public static string ToWireString(this ChangeLogKind kind) => kind switch
        {
            ChangeLogKind.Invalidate => "invalidate",
            ChangeLogKind.Mutation => "mutation",
            ChangeLogKind.Stream => "stream",
            ChangeLogKind.Reset => "reset",
            _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null)
        };

        public static ChangeLogKind FromString(string value) => value?.ToLowerInvariant() switch
        {
            "invalidate" => ChangeLogKind.Invalidate,
            "mutation" => ChangeLogKind.Mutation,
            "stream" => ChangeLogKind.Stream,
            "reset" => ChangeLogKind.Reset,
            _ => throw new ArgumentException($"Unknown ChangeLogKind: {value}", nameof(value))
        };
    }

    /// <summary>
    /// Authoritative row in ucsa_change_log table.
    /// </summary>
    public class ChangeLogRow
    {
        public long Seq { get; set; }
        public string Origin { get; set; } = string.Empty;
        public ChangeLogKind Kind { get; set; }
        public List<string>? Tags { get; set; }
        public List<string>? QueryHashes { get; set; }
        public Dictionary<string, object>? Detail { get; set; }
        public long CreatedAt { get; set; }

        public List<string>? query_hashes => QueryHashes;
        public long created_at => CreatedAt;

        public ChangeLogRow() { }

        public ChangeLogRow(
            long seq,
            string origin,
            ChangeLogKind kind,
            List<string>? tags,
            List<string>? queryHashes,
            Dictionary<string, object>? detail,
            long createdAt)
        {
            Seq = seq;
            Origin = origin;
            Kind = kind;
            Tags = tags;
            QueryHashes = queryHashes;
            Detail = detail;
            CreatedAt = createdAt;
        }
    }

    /// <summary>
    /// Result of reading changes from ucsa_change_log with gap/truncation detection.
    /// </summary>
    public class ReadChangesResult
    {
        public List<ChangeLogRow> Rows { get; set; } = new();
        public bool Truncated { get; set; }
        public long HeadSeq { get; set; }

        public ReadChangesResult() { }

        public ReadChangesResult(List<ChangeLogRow> rows, bool truncated, long headSeq)
        {
            Rows = rows;
            Truncated = truncated;
            HeadSeq = headSeq;
        }
    }

    /// <summary>
    /// Streaming chunk store status.
    /// </summary>
    public enum StreamStatus
    {
        Open,
        Complete,
        Aborted,
        Error
    }

    public static class StreamStatusExtensions
    {
        public static string ToWireString(this StreamStatus status) => status switch
        {
            StreamStatus.Open => "open",
            StreamStatus.Complete => "complete",
            StreamStatus.Aborted => "aborted",
            StreamStatus.Error => "error",
            _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
        };

        public static StreamStatus FromString(string value) => value?.ToLowerInvariant() switch
        {
            "open" => StreamStatus.Open,
            "complete" => StreamStatus.Complete,
            "aborted" => StreamStatus.Aborted,
            "error" => StreamStatus.Error,
            _ => throw new ArgumentException($"Unknown StreamStatus: {value}", nameof(value))
        };
    }

    /// <summary>
    /// Encoding for streaming chunk payloads.
    /// </summary>
    public enum StreamEncoding
    {
        Utf8,
        Bytes
    }

    public static class StreamEncodingExtensions
    {
        public static string ToWireString(this StreamEncoding encoding) => encoding switch
        {
            StreamEncoding.Utf8 => "utf8",
            StreamEncoding.Bytes => "bytes",
            _ => throw new ArgumentOutOfRangeException(nameof(encoding), encoding, null)
        };

        public static StreamEncoding FromString(string value) => value?.ToLowerInvariant() switch
        {
            "utf8" => StreamEncoding.Utf8,
            "bytes" => StreamEncoding.Bytes,
            _ => throw new ArgumentException($"Unknown StreamEncoding: {value}", nameof(value))
        };
    }

    /// <summary>
    /// Resume strategy for reconnecting streams.
    /// </summary>
    public enum ResumeKind
    {
        Range,
        LastEventId,
        Continuation,
        Restart
    }

    public static class ResumeKindExtensions
    {
        public static string ToWireString(this ResumeKind kind) => kind switch
        {
            ResumeKind.Range => "range",
            ResumeKind.LastEventId => "last-event-id",
            ResumeKind.Continuation => "continuation",
            ResumeKind.Restart => "restart",
            _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null)
        };

        public static ResumeKind FromString(string value) => value?.ToLowerInvariant() switch
        {
            "range" => ResumeKind.Range,
            "last-event-id" or "lasteventid" => ResumeKind.LastEventId,
            "continuation" => ResumeKind.Continuation,
            "restart" => ResumeKind.Restart,
            _ => throw new ArgumentException($"Unknown ResumeKind: {value}", nameof(value))
        };
    }

    /// <summary>
    /// Authoritative stream record in ucsa_streams table.
    /// </summary>
    public class StreamRecord
    {
        public string QueryHash { get; set; } = string.Empty;
        public object[] QueryKey { get; set; } = Array.Empty<object>();
        public StreamStatus Status { get; set; } = StreamStatus.Open;
        public StreamEncoding Encoding { get; set; } = StreamEncoding.Utf8;
        public int NextSeq { get; set; }
        public int ByteLength { get; set; }
        public ResumeKind? ResumeKind { get; set; }
        public string? ResumeToken { get; set; }
        public string? Etag { get; set; }
        public string? WriterId { get; set; }
        public long? WriterLeaseUntil { get; set; }
        public int PayloadVersion { get; set; } = 1;
        public string? Error { get; set; }
        public long CreatedAt { get; set; }
        public long UpdatedAt { get; set; }
        public long ExpiresAt { get; set; }

        public StreamRecord() { }
    }

    /// <summary>
    /// Chunk of streaming payload in ucsa_stream_chunks table.
    /// </summary>
    public class StreamChunk
    {
        public string QueryHash { get; set; } = string.Empty;
        public int Seq { get; set; }
        public int ByteOffset { get; set; }
        public byte[] Data { get; set; } = Array.Empty<byte>();

        public StreamChunk() { }

        public StreamChunk(string queryHash, int seq, int byteOffset, byte[] data)
        {
            QueryHash = queryHash;
            Seq = seq;
            ByteOffset = byteOffset;
            Data = data;
        }
    }
}
