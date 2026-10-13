using System;
using System.Collections.Generic;

namespace Ucsa.Core
{
    /// <summary>
    /// Zero-allocation reactive state observer that projects state slices and suppresses
    /// notifications when the selected slice has not changed, preventing unnecessary
    /// Unity Canvas geometry redraws and UI repaints.
    /// </summary>
    /// <typeparam name="TData">Full state or query data type.</typeparam>
    /// <typeparam name="TSelected">Projected state slice type.</typeparam>
    public class StateObserver<TData, TSelected> : IDisposable
    {
        private readonly Func<TData, TSelected> _selector;
        private readonly IEqualityComparer<TSelected> _comparer;
        private readonly int _throttleMs;
        private readonly int _debounceMs;
        private readonly object _lock = new object();

        private TSelected? _currentValue;
        private bool _hasValue;
        private Timer? _throttleTimer;
        private Timer? _debounceTimer;
        private bool _hasPendingTrailing;
        private long _lastInvokedTick;

        /// <summary>
        /// Fires only when the projected slice <typeparamref name="TSelected"/> actually changes.
        /// </summary>
        public event Action<TSelected>? OnValueChanged;

        /// <summary>
        /// Gets the current snapshot of the projected slice.
        /// </summary>
        public TSelected? CurrentValue => _currentValue;

        /// <summary>
        /// Alias for <see cref="CurrentValue"/>.
        /// </summary>
        public TSelected? Value => _currentValue;

        /// <summary>
        /// True if an initial state has been observed.
        /// </summary>
        public bool HasValue => _hasValue;

        public StateObserver(
            Func<TData, TSelected> selector,
            IEqualityComparer<TSelected>? comparer = null,
            int throttleMs = 0,
            int debounceMs = 0)
        {
            _selector = selector ?? throw new ArgumentNullException(nameof(selector));
            _comparer = comparer ?? EqualityComparer<TSelected>.Default;
            _throttleMs = Math.Max(0, throttleMs);
            _debounceMs = Math.Max(0, debounceMs);
        }

        /// <summary>
        /// Processes a new state snapshot. Compares the selected slice using zero-allocation equality.
        /// Triggers <see cref="OnValueChanged"/> only if the value has changed or on the first emission.
        /// </summary>
        /// <param name="nextData">New full state data.</param>
        /// <returns>True if the selected slice changed and listeners were notified, false otherwise.</returns>
        public bool Update(TData nextData)
        {
            TSelected nextValue = _selector(nextData);
            if (!_hasValue || !_comparer.Equals(_currentValue!, nextValue))
            {
                _currentValue = nextValue;
                _hasValue = true;

                if (_debounceMs > 0)
                {
                    lock (_lock)
                    {
                        _debounceTimer?.Dispose();
                        _debounceTimer = new Timer(_ =>
                        {
                            TSelected? val;
                            lock (_lock)
                            {
                                _debounceTimer?.Dispose();
                                _debounceTimer = null;
                                val = _currentValue;
                            }
                            if (val != null)
                            {
                                OnValueChanged?.Invoke(val);
                            }
                        }, null, _debounceMs, Timeout.Infinite);
                    }
                    return true;
                }

                if (_throttleMs > 0)
                {
                    lock (_lock)
                    {
                        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        long elapsed = now - _lastInvokedTick;
                        if (elapsed >= _throttleMs && _throttleTimer == null)
                        {
                            _lastInvokedTick = now;
                            OnValueChanged?.Invoke(nextValue);
                            _throttleTimer = new Timer(_ =>
                            {
                                TSelected? val = default;
                                bool shouldFire = false;
                                lock (_lock)
                                {
                                    _throttleTimer?.Dispose();
                                    _throttleTimer = null;
                                    if (_hasPendingTrailing)
                                    {
                                        _hasPendingTrailing = false;
                                        _lastInvokedTick = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                        val = _currentValue;
                                        shouldFire = true;
                                    }
                                }
                                if (shouldFire && val != null)
                                {
                                    OnValueChanged?.Invoke(val);
                                }
                            }, null, _throttleMs, Timeout.Infinite);
                        }
                        else
                        {
                            _hasPendingTrailing = true;
                            if (_throttleTimer == null)
                            {
                                long remaining = Math.Max(0, _throttleMs - elapsed);
                                _throttleTimer = new Timer(_ =>
                                {
                                    TSelected? val = default;
                                    bool shouldFire = false;
                                    lock (_lock)
                                    {
                                        _throttleTimer?.Dispose();
                                        _throttleTimer = null;
                                        if (_hasPendingTrailing)
                                        {
                                            _hasPendingTrailing = false;
                                            _lastInvokedTick = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                                            val = _currentValue;
                                            shouldFire = true;
                                        }
                                    }
                                    if (shouldFire && val != null)
                                    {
                                        OnValueChanged?.Invoke(val);
                                    }
                                }, null, (int)remaining, Timeout.Infinite);
                            }
                        }
                    }
                    return true;
                }

                OnValueChanged?.Invoke(nextValue);
                return true;
            }

            return false;
        }

        /// <summary>
        /// Alias for <see cref="Update(TData)"/>.
        /// </summary>
        public bool Notify(TData nextData) => Update(nextData);

        /// <summary>
        /// Resets the observer state to uninitialized.
        /// </summary>
        public void Reset()
        {
            lock (_lock)
            {
                _debounceTimer?.Dispose();
                _debounceTimer = null;
                _throttleTimer?.Dispose();
                _throttleTimer = null;
                _hasPendingTrailing = false;
            }
            _currentValue = default;
            _hasValue = false;
        }

        public void Dispose()
        {
            Reset();
            OnValueChanged = null;
        }
    }
}
