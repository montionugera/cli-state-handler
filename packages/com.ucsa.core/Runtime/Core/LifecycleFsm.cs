using System;

namespace Ucsa.Core
{
    /// <summary>
    /// 5-Stage deterministic finite state machine (FSM) for query lifecycles with full jitter backoff.
    /// States: Idle -> Loading -> Retrying -> Success | Error.
    /// </summary>
    /// <typeparam name="TData">Data payload type.</typeparam>
    /// <typeparam name="TError">Error payload type.</typeparam>
    public class LifecycleFsm<TData, TError>
    {
        private readonly object _randomLock = new();
        private readonly Random _random;

        public QueryStatus State { get; private set; } = QueryStatus.Idle;
        public int RetryCount { get; private set; }
        public TData? Data { get; private set; }
        public TError? Error { get; private set; }

        public int MaxRetries { get; set; }
        public int BaseDelayMs { get; set; }
        public int MaxDelayMs { get; set; }

        public event Action<QueryStatus>? OnStateChanged;

        public bool IsIdle => State == QueryStatus.Idle;
        public bool IsLoading => State == QueryStatus.Loading;
        public bool IsSuccess => State == QueryStatus.Success;
        public bool IsError => State == QueryStatus.Error;
        public bool IsRetrying => State == QueryStatus.Retrying;

        public LifecycleFsm(
            int maxRetries = 4,
            int baseDelayMs = 500,
            int maxDelayMs = 30000,
            Random? random = null)
        {
            MaxRetries = maxRetries;
            BaseDelayMs = baseDelayMs;
            MaxDelayMs = maxDelayMs;
            _random = random ?? new Random();
        }

        public LifecycleFsm(
            TData initialData,
            int maxRetries = 4,
            int baseDelayMs = 500,
            int maxDelayMs = 30000,
            Random? random = null)
            : this(maxRetries, baseDelayMs, maxDelayMs, random)
        {
            Data = initialData;
            State = QueryStatus.Success;
        }

        /// <summary>
        /// Transitions to Loading state.
        /// </summary>
        public QueryStatus StartLoading()
        {
            State = QueryStatus.Loading;
            OnStateChanged?.Invoke(State);
            return State;
        }

        /// <summary>
        /// Transitions to Success state, updating data and resetting retry count.
        /// </summary>
        public QueryStatus RecordSuccess(TData data)
        {
            Data = data;
            Error = default;
            RetryCount = 0;
            State = QueryStatus.Success;
            OnStateChanged?.Invoke(State);
            return State;
        }

        /// <summary>
        /// Records an error, transitioning to Retrying if RetryCount &lt; MaxRetries, or Error if retries exhausted.
        /// </summary>
        public QueryStatus RecordError(TError error, int? attempt = null)
        {
            Error = error;
            int currentAttempt = attempt ?? RetryCount;
            if (currentAttempt < MaxRetries)
            {
                RetryCount = currentAttempt + 1;
                State = QueryStatus.Retrying;
            }
            else
            {
                RetryCount = currentAttempt;
                State = QueryStatus.Error;
            }

            OnStateChanged?.Invoke(State);
            return State;
        }

        /// <summary>
        /// Resets the FSM back to Idle state.
        /// </summary>
        public void Reset()
        {
            State = QueryStatus.Idle;
            RetryCount = 0;
            Data = default;
            Error = default;
            OnStateChanged?.Invoke(State);
        }

        /// <summary>
        /// Computes exponential backoff with full jitter avoiding integer overflow.
        /// Returns a random delay in [0, min(maxDelayMs, baseDelayMs * 2^attempt)] inclusive.
        /// </summary>
        public int CalculateBackoffDelayMs(int attempt, int baseDelayMs = 500, int maxDelayMs = 30000)
        {
            if (baseDelayMs <= 0) return 0;
            int max = maxDelayMs > 0 ? maxDelayMs : 30000;
            int effectiveAttempt = attempt < 0 ? 0 : attempt;

            long multiplier = effectiveAttempt >= 30 ? (1L << 30) : (1L << effectiveAttempt);
            long calculated = (long)baseDelayMs * multiplier;
            long capped = Math.Min((long)max, calculated);
            if (capped <= 0) return 0;
            if (capped >= int.MaxValue) capped = int.MaxValue - 1;

            lock (_randomLock)
            {
                return _random.Next(0, (int)capped + 1);
            }
        }
    }
}
