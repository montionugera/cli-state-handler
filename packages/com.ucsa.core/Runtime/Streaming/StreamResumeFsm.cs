using System;
using System.Collections.Generic;
using System.Text;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Streaming
{
    public enum StreamResumeState
    {
        Idle,
        Streaming,
        Interrupted,
        Resuming,
        Complete,
        Aborted
    }

    public class IncomingChunkResult
    {
        public bool Accepted { get; set; }
        public bool Duplicate { get; set; }
        public byte[] Slice { get; set; } = Array.Empty<byte>();
        public int Seq { get; set; }
        public int ByteOffset { get; set; }
    }

    public class HandleErrorResult
    {
        public bool CanResume { get; set; }
        public int RetryDelayMs { get; set; }
        public Dictionary<string, string>? Headers { get; set; }
        public object? ContinuationPayload { get; set; }
        public bool Restart { get; set; }
    }

    public class StreamResumeFsmOptions
    {
        public string QueryHash { get; set; } = string.Empty;
        public object[] QueryKey { get; set; } = Array.Empty<object>();
        public IResumeStrategy Strategy { get; set; } = null!;
        public int MaxRetries { get; set; } = 5;
        public int BaseDelayMs { get; set; } = 300;
        public int MaxDelayMs { get; set; } = 10000;
        public SqliteAdapter? SqliteAdapter { get; set; }
        public string? Etag { get; set; }
        public string? InitialLastEventId { get; set; }
        public Action? OnReset { get; set; }
    }

    /// <summary>
    /// Finite State Machine managing resumable stream connections, chunk deduplication,
    /// exponential backoff retry with full jitter, and strategy-driven recovery in Unity C#.
    /// </summary>
    public class StreamResumeFsm
    {
        public StreamResumeState State { get; private set; } = StreamResumeState.Idle;
        public int RetryCount { get; private set; } = 0;
        public int CommittedByteLength { get; private set; } = 0;
        public int CommittedSeq { get; private set; } = 0;
        public string? LastEventId { get; private set; }
        public string AccumulatedText { get; private set; } = string.Empty;
        public string? Etag { get; private set; }

        public string QueryHash { get; }
        public object[] QueryKey { get; }
        public IResumeStrategy Strategy { get; }
        public int MaxRetries { get; }
        public int BaseDelayMs { get; }
        public int MaxDelayMs { get; }
        public SqliteAdapter? SqliteAdapter { get; }
        public Action? OnReset { get; }

        private readonly Random _random = new();

        public StreamResumeFsm(StreamResumeFsmOptions options)
        {
            QueryHash = options.QueryHash;
            QueryKey = options.QueryKey;
            Strategy = options.Strategy ?? throw new ArgumentNullException(nameof(options.Strategy));
            MaxRetries = options.MaxRetries;
            BaseDelayMs = options.BaseDelayMs;
            MaxDelayMs = options.MaxDelayMs;
            SqliteAdapter = options.SqliteAdapter;
            Etag = options.Etag;
            LastEventId = options.InitialLastEventId;
            OnReset = options.OnReset;

            if (SqliteAdapter != null)
            {
                var existing = SqliteAdapter.GetStream(QueryHash);
                if (existing == null && QueryKeyHasher.Hash(QueryKey) == QueryHash)
                {
                    try
                    {
                        SqliteAdapter.CreateStream(
                            QueryKey,
                            etag: Etag,
                            resumeToken: LastEventId,
                            resumeKind: Strategy is LastEventIdResumeStrategy ? ResumeKind.LastEventId : null
                        );
                        existing = SqliteAdapter.GetStream(QueryHash);
                    }
                    catch
                    {
                        // Already exists or created concurrently
                    }
                }

                if (existing != null)
                {
                    CommittedByteLength = existing.ByteLength;
                    CommittedSeq = existing.NextSeq;
                    if (!string.IsNullOrEmpty(existing.ResumeToken) && LastEventId == null)
                    {
                        LastEventId = existing.ResumeToken;
                    }
                    if (!string.IsNullOrEmpty(existing.Etag) && Etag == null)
                    {
                        Etag = existing.Etag;
                    }
                    if (existing.ByteLength > 0)
                    {
                        var chunks = SqliteAdapter.GetStreamChunks(QueryHash, 0);
                        var sb = new StringBuilder();
                        foreach (var c in chunks)
                        {
                            sb.Append(Encoding.UTF8.GetString(c.Data));
                        }
                        AccumulatedText = sb.ToString();
                    }
                }
            }
        }

        public void Start()
        {
            State = StreamResumeState.Streaming;
        }

        public IncomingChunkResult HandleIncomingChunk(byte[] data, int? seq = null, int? byteOffset = null, string? eventId = null)
        {
            byte[] slice = data;

            if (byteOffset.HasValue && byteOffset.Value < CommittedByteLength)
            {
                if (byteOffset.Value + data.Length <= CommittedByteLength)
                {
                    return new IncomingChunkResult
                    {
                        Accepted = false,
                        Duplicate = true,
                        Slice = Array.Empty<byte>(),
                        Seq = seq ?? CommittedSeq,
                        ByteOffset = byteOffset.Value
                    };
                }

                int skip = CommittedByteLength - byteOffset.Value;
                int remaining = data.Length - skip;
                slice = new byte[remaining];
                Buffer.BlockCopy(data, skip, slice, 0, remaining);
            }

            if (!string.IsNullOrEmpty(eventId))
            {
                LastEventId = eventId;
                SqliteAdapter?.UpdateStreamResumeToken(QueryHash, eventId, ResumeKind.LastEventId);
            }

            int currentSeq = CommittedSeq;
            int currentOffset = CommittedByteLength;

            if (SqliteAdapter != null)
            {
                SqliteAdapter.AppendStreamChunk(QueryHash, slice, currentSeq);
            }

            CommittedByteLength += slice.Length;
            CommittedSeq += 1;
            try
            {
                AccumulatedText += Encoding.UTF8.GetString(slice);
            }
            catch { }

            if (State == StreamResumeState.Resuming || State == StreamResumeState.Interrupted || State == StreamResumeState.Idle)
            {
                State = StreamResumeState.Streaming;
                RetryCount = 0;
            }

            return new IncomingChunkResult
            {
                Accepted = true,
                Duplicate = false,
                Slice = slice,
                Seq = currentSeq,
                ByteOffset = currentOffset
            };
        }

        public IncomingChunkResult HandleIncomingChunk(string text, int? seq = null, int? byteOffset = null, string? eventId = null)
        {
            return HandleIncomingChunk(Encoding.UTF8.GetBytes(text), seq, byteOffset, eventId);
        }

        public HandleErrorResult HandleError(object error, int? statusCode = null)
        {
            if (statusCode == 416 || statusCode == 412)
            {
                PerformReset();
                return new HandleErrorResult
                {
                    CanResume = true,
                    RetryDelayMs = 0,
                    Restart = true
                };
            }

            if (RetryCount >= MaxRetries)
            {
                State = StreamResumeState.Aborted;
                SqliteAdapter?.AbortStream(QueryHash, error?.ToString());
                return new HandleErrorResult
                {
                    CanResume = false,
                    RetryDelayMs = 0,
                    Restart = false
                };
            }

            int maxExp = (int)Math.Min(int.MaxValue, BaseDelayMs * Math.Pow(2, RetryCount));
            int cap = Math.Min(MaxDelayMs, maxExp);
            int retryDelayMs = cap > 0 ? _random.Next(0, cap + 1) : 0;
            RetryCount += 1;
            State = StreamResumeState.Resuming;

            var ctx = new ResumeContext(
                QueryHash,
                QueryKey,
                CommittedByteLength,
                CommittedSeq,
                Etag,
                LastEventId,
                AccumulatedText
            );

            Dictionary<string, string>? headers = null;
            object? continuationPayload = null;
            bool restart = false;

            if (Strategy is RangeResumeStrategy rangeStrategy)
            {
                headers = rangeStrategy.BuildHeaders(ctx);
            }
            else if (Strategy is LastEventIdResumeStrategy sseStrategy)
            {
                headers = sseStrategy.BuildHeaders(ctx);
            }
            else if (Strategy is RestartResumeStrategy restartStrategy)
            {
                restartStrategy.Reset(ctx);
                PerformReset();
                restart = true;
            }
            else
            {
                var method = Strategy.GetType().GetMethod("BuildContinuation");
                if (method != null)
                {
                    continuationPayload = method.Invoke(Strategy, new object[] { ctx });
                }
            }

            return new HandleErrorResult
            {
                CanResume = true,
                RetryDelayMs = retryDelayMs,
                Headers = headers,
                ContinuationPayload = continuationPayload,
                Restart = restart
            };
        }

        public void Complete()
        {
            State = StreamResumeState.Complete;
        }

        public void Abort(string? reason = null)
        {
            State = StreamResumeState.Aborted;
            SqliteAdapter?.AbortStream(QueryHash, reason);
        }

        private void PerformReset()
        {
            SqliteAdapter?.ResetStream(QueryHash);
            CommittedByteLength = 0;
            CommittedSeq = 0;
            AccumulatedText = string.Empty;
            OnReset?.Invoke();
            State = StreamResumeState.Resuming;
        }
    }
}
