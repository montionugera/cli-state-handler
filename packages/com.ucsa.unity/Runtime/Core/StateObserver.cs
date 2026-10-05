using System;
using System.Collections.Generic;

namespace Ucsa.Unity.Core
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
        private TSelected? _currentValue;
        private bool _hasValue;

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
            IEqualityComparer<TSelected>? comparer = null)
        {
            _selector = selector ?? throw new ArgumentNullException(nameof(selector));
            _comparer = comparer ?? EqualityComparer<TSelected>.Default;
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
            _currentValue = default;
            _hasValue = false;
        }

        public void Dispose()
        {
            OnValueChanged = null;
            Reset();
        }
    }
}
