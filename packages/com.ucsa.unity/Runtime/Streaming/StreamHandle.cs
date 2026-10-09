using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace Ucsa.Unity.Streaming
{
    /// <summary>
    /// Represents an incremental slice yielded during a streaming query.
    /// </summary>
    /// <typeparam name="T">Payload type (string or byte[]).</typeparam>
    public class StreamSlice<T>
    {
        public T Delta { get; set; } = default!;
        public T Cumulative { get; set; } = default!;
        public int Seq { get; set; }
        public int ByteOffset { get; set; }
        public bool Done { get; set; }
        public bool Reset { get; set; }

        public StreamSlice() { }

        public StreamSlice(T delta, T cumulative, int seq, int byteOffset, bool done, bool reset = false)
        {
            Delta = delta;
            Cumulative = cumulative;
            Seq = seq;
            ByteOffset = byteOffset;
            Done = done;
            Reset = reset;
        }

        public override string ToString() =>
            $"StreamSlice(seq: {Seq}, offset: {ByteOffset}, done: {Done}, reset: {Reset})";
    }

    /// <summary>
    /// Context passed to a streaming query producer.
    /// </summary>
    public class StreamFnContext
    {
        public string QueryHash { get; set; } = string.Empty;
        public CancellationToken CancellationToken { get; set; }
        public Dictionary<string, string>? ResumeHeaders { get; set; }
        public object? ContinuationPayload { get; set; }

        public StreamFnContext() { }

        public StreamFnContext(
            string queryHash,
            CancellationToken cancellationToken = default,
            Dictionary<string, string>? resumeHeaders = null,
            object? continuationPayload = null)
        {
            QueryHash = queryHash;
            CancellationToken = cancellationToken;
            ResumeHeaders = resumeHeaders;
            ContinuationPayload = continuationPayload;
        }
    }

    /// <summary>
    /// Represents an active or completed streaming query handle in Unity C#.
    /// Exposes incremental slices via IAsyncEnumerable and a completion Task.
    /// </summary>
    /// <typeparam name="T">Payload type.</typeparam>
    public class StreamHandle<T> : IAsyncEnumerable<StreamSlice<T>>
    {
        public string QueryHash { get; }
        public CancellationTokenSource CancellationTokenSource { get; }
        public CancellationToken CancellationToken => CancellationTokenSource.Token;

        public bool IsDone { get; private set; }
        public bool IsCancelled { get; private set; }

        private readonly Channel<StreamSlice<T>> _channel;
        private readonly TaskCompletionSource<T> _doneTcs;

        public Task<T> Done => _doneTcs.Task;

        public StreamHandle(string queryHash, CancellationTokenSource? cts = null)
        {
            QueryHash = queryHash;
            CancellationTokenSource = cts ?? new CancellationTokenSource();
            _channel = Channel.CreateUnbounded<StreamSlice<T>>(new UnboundedChannelOptions
            {
                SingleReader = false,
                SingleWriter = false
            });
            _doneTcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);

            CancellationToken.Register(() =>
            {
                if (!IsCancelled)
                {
                    Cancel("Cancelled via CancellationToken");
                }
            });
        }

        /// <summary>
        /// Pushes a new incremental slice to active consumers.
        /// </summary>
        public void Push(StreamSlice<T> slice)
        {
            if (IsCancelled || (IsDone && !slice.Done))
            {
                return;
            }

            _channel.Writer.TryWrite(slice);

            if (slice.Done && !IsDone)
            {
                End(slice.Cumulative);
            }
        }

        /// <summary>
        /// Completes the stream with a final cumulative payload.
        /// </summary>
        public void End(T finalPayload)
        {
            if (IsDone || IsCancelled) return;
            IsDone = true;

            _doneTcs.TrySetResult(finalPayload);
            _channel.Writer.TryComplete();
        }

        /// <summary>
        /// Aborts the stream with an error.
        /// </summary>
        public void Error(Exception ex)
        {
            if (IsDone || IsCancelled) return;
            IsDone = true;

            _doneTcs.TrySetException(ex);
            _channel.Writer.TryComplete(ex);
        }

        /// <summary>
        /// Cancels the stream and stops further emission.
        /// </summary>
        public void Cancel(string? reason = null)
        {
            if (IsCancelled) return;
            IsCancelled = true;
            IsDone = true;

            try
            {
                if (!CancellationTokenSource.IsCancellationRequested)
                {
                    CancellationTokenSource.Cancel();
                }
            }
            catch
            {
                // Ignore if already disposed
            }

            var ex = new OperationCanceledException(reason ?? "Stream cancelled", CancellationToken);
            _doneTcs.TrySetException(ex);
            _channel.Writer.TryComplete();
        }

        /// <summary>
        /// Reads all slices asynchronously.
        /// </summary>
        public async IAsyncEnumerable<StreamSlice<T>> ReadAllAsync([EnumeratorCancellation] CancellationToken ct = default)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(CancellationToken, ct);
            var reader = _channel.Reader;
            while (await reader.WaitToReadAsync(linked.Token).ConfigureAwait(false))
            {
                while (reader.TryRead(out var item))
                {
                    yield return item;
                }
            }
        }

        public IAsyncEnumerator<StreamSlice<T>> GetAsyncEnumerator(CancellationToken cancellationToken = default)
        {
            return ReadAllAsync(cancellationToken).GetAsyncEnumerator(cancellationToken);
        }
    }
}
