using System;
using System.Collections.Generic;
using Ucsa.Core;

namespace Ucsa.Streaming
{
    /// <summary>
    /// Context provided to a resume strategy when reconnecting an interrupted stream.
    /// </summary>
    public class ResumeContext
    {
        public string QueryHash { get; set; } = string.Empty;
        public object[] QueryKey { get; set; } = Array.Empty<object>();
        public int ByteLength { get; set; }
        public int NextSeq { get; set; }
        public string? Etag { get; set; }
        public string? LastEventId { get; set; }
        public string? AccumulatedText { get; set; }

        public ResumeContext() { }

        public ResumeContext(
            string queryHash,
            object[] queryKey,
            int byteLength,
            int nextSeq,
            string? etag = null,
            string? lastEventId = null,
            string? accumulatedText = null)
        {
            QueryHash = queryHash;
            QueryKey = queryKey;
            ByteLength = byteLength;
            NextSeq = nextSeq;
            Etag = etag;
            LastEventId = lastEventId;
            AccumulatedText = accumulatedText;
        }
    }

    /// <summary>
    /// Base interface for resume strategies.
    /// </summary>
    public interface IResumeStrategy
    {
        string Kind { get; }
    }

    /// <summary>
    /// HTTP Range resume strategy generating Range and optional If-Range headers.
    /// </summary>
    public class RangeResumeStrategy : IResumeStrategy
    {
        public string Kind => "range";

        public Dictionary<string, string> BuildHeaders(ResumeContext ctx)
        {
            var headers = new Dictionary<string, string>
            {
                ["Range"] = $"bytes={ctx.ByteLength}-"
            };

            if (!string.IsNullOrEmpty(ctx.Etag))
            {
                headers["If-Range"] = ctx.Etag;
            }

            return headers;
        }
    }

    /// <summary>
    /// SSE Last-Event-ID resume strategy passing Last-Event-ID header upon reconnection.
    /// </summary>
    public class LastEventIdResumeStrategy : IResumeStrategy
    {
        public string Kind => "last-event-id";

        public Dictionary<string, string> BuildHeaders(ResumeContext ctx)
        {
            var headers = new Dictionary<string, string>();
            if (!string.IsNullOrEmpty(ctx.LastEventId))
            {
                headers["Last-Event-ID"] = ctx.LastEventId;
            }
            return headers;
        }
    }

    /// <summary>
    /// Application-level continuation resume strategy invoking custom continuation factory.
    /// </summary>
    public class ContinuationResumeStrategy<TContinuation> : IResumeStrategy
    {
        public string Kind => "continuation";

        private readonly Func<ResumeContext, TContinuation> _builder;

        public ContinuationResumeStrategy(Func<ResumeContext, TContinuation> builder)
        {
            _builder = builder ?? throw new ArgumentNullException(nameof(builder));
        }

        public TContinuation BuildContinuation(ResumeContext ctx) => _builder(ctx);
    }

    /// <summary>
    /// Non-generic continuation resume strategy convenience wrapper.
    /// </summary>
    public class ContinuationResumeStrategy : ContinuationResumeStrategy<object>
    {
        public ContinuationResumeStrategy(Func<ResumeContext, object> builder) : base(builder) { }
    }

    /// <summary>
    /// Reset signal returned by restart strategy.
    /// </summary>
    public class RestartResetSignal
    {
        public bool Reset { get; set; } = true;
        public int Seq { get; set; } = 0;
        public int ByteOffset { get; set; } = 0;
    }

    /// <summary>
    /// Restart resume strategy resetting chunk sequence and byte offset to zero.
    /// </summary>
    public class RestartResumeStrategy : IResumeStrategy
    {
        public string Kind => "restart";

        public RestartResetSignal Reset(ResumeContext ctx)
        {
            return new RestartResetSignal { Reset = true, Seq = 0, ByteOffset = 0 };
        }
    }

    /// <summary>
    /// Factory helpers for resume strategies.
    /// </summary>
    public static class ResumeStrategies
    {
        public static RangeResumeStrategy CreateRange() => new();
        public static LastEventIdResumeStrategy CreateLastEventId() => new();
        public static ContinuationResumeStrategy<T> CreateContinuation<T>(Func<ResumeContext, T> builder) => new(builder);
        public static ContinuationResumeStrategy CreateContinuation(Func<ResumeContext, object> builder) => new(builder);
        public static RestartResumeStrategy CreateRestart() => new();
    }
}
