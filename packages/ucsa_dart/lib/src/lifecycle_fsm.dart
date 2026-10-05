import 'dart:math';
import 'types.dart';

/// Sealed class hierarchy representing exhaustive FSM states for queries.
sealed class FsmState<TData, TError> {
  const FsmState();

  QueryStatus get status;
}

/// Initial or reset state when no query operation is running.
final class IdleState<TData, TError> extends FsmState<TData, TError> {
  const IdleState();

  @override
  QueryStatus get status => QueryStatus.idle;

  @override
  String toString() => 'IdleState()';
}

/// Active state while query data is being fetched.
final class LoadingState<TData, TError> extends FsmState<TData, TError> {
  final TData? previousData;

  const LoadingState({this.previousData});

  @override
  QueryStatus get status => QueryStatus.loading;

  @override
  String toString() => 'LoadingState(previousData: $previousData)';
}

/// Transient state when an attempt failed and a backoff delay is in progress.
final class RetryingState<TData, TError> extends FsmState<TData, TError> {
  final int attempt;
  final TError error;
  final int delayMs;

  const RetryingState({
    required this.attempt,
    required this.error,
    required this.delayMs,
  });

  @override
  QueryStatus get status => QueryStatus.retrying;

  @override
  String toString() =>
      'RetryingState(attempt: $attempt, delayMs: ${delayMs}ms, error: $error)';
}

/// Terminal success state when query data has successfully resolved.
final class SuccessState<TData, TError> extends FsmState<TData, TError> {
  final TData data;

  const SuccessState(this.data);

  @override
  QueryStatus get status => QueryStatus.success;

  @override
  String toString() => 'SuccessState($data)';
}

/// Terminal error state when maximum retries have been exhausted or fatal error occurred.
final class ErrorState<TData, TError> extends FsmState<TData, TError> {
  final TError error;
  final int attempt;

  const ErrorState(this.error, {this.attempt = 0});

  @override
  QueryStatus get status => QueryStatus.error;

  @override
  String toString() => 'ErrorState($error, attempt: $attempt)';
}

/// 5-Stage Lifecycle State Machine for query operations with exponential jitter backoff.
/// States: idle -> loading -> retrying -> success | error.
class LifecycleFSM<TData, TError> {
  QueryStatus state = QueryStatus.idle;
  int retryCount = 0;
  TData? data;
  TError? error;

  final int maxRetries;
  final int baseDelayMs;
  final int maxDelayMs;
  final Random _random;

  FsmState<TData, TError> fsmState = const IdleState();

  LifecycleFSM({
    this.maxRetries = 4,
    this.baseDelayMs = 500,
    this.maxDelayMs = 30000,
    Random? random,
  }) : _random = random ?? Random();

  LifecycleFSM.withData(
    TData initialData, {
    this.maxRetries = 4,
    this.baseDelayMs = 500,
    this.maxDelayMs = 30000,
    Random? random,
  })  : _random = random ?? Random(),
        state = QueryStatus.success,
        data = initialData,
        fsmState = SuccessState(initialData);

  /// Transition to 'loading' state when a query fetch starts.
  QueryStatus startLoading() {
    state = QueryStatus.loading;
    fsmState = LoadingState(previousData: data);
    return state;
  }

  /// Transition to 'success' state, storing the payload and resetting retry count.
  QueryStatus recordSuccess(TData data) {
    state = QueryStatus.success;
    this.data = data;
    error = null;
    retryCount = 0;
    fsmState = SuccessState(data);
    return state;
  }

  /// Transition to 'retrying' if attempt < maxRetries, or 'error' if attempt >= maxRetries.
  /// Increments retry count on retry transitions.
  QueryStatus recordError(TError error, [int? attempt]) {
    this.error = error;
    final currentAttempt = attempt ?? retryCount;
    if (currentAttempt < maxRetries) {
      retryCount = currentAttempt + 1;
      state = QueryStatus.retrying;
      final delay = calculateBackoffDelay(
        retryCount,
        baseDelayMs: baseDelayMs,
        maxDelayMs: maxDelayMs,
      );
      fsmState = RetryingState(
        attempt: retryCount,
        error: error,
        delayMs: delay,
      );
    } else {
      retryCount = currentAttempt;
      state = QueryStatus.error;
      fsmState = ErrorState(error, attempt: retryCount);
    }
    return state;
  }

  /// Computes exponential backoff with full jitter:
  /// delay = random(0, min(maxDelay, baseDelay * 2^attempt))
  int calculateBackoffDelay(
    int attempt, {
    int baseDelayMs = 500,
    int maxDelayMs = 30000,
  }) {
    final effectiveAttempt = attempt < 0 ? 0 : attempt;
    final base = baseDelayMs > 0 ? baseDelayMs : 500;
    final max = maxDelayMs > 0 ? maxDelayMs : 30000;

    // Guard against 32/64-bit overflow on large attempt values
    final num multiplier =
        effectiveAttempt >= 30 ? (1 << 30) : (1 << effectiveAttempt);
    final calculated = base * multiplier;
    final capped = calculated > max ? max : calculated.toInt();
    if (capped <= 0) return 0;

    // Full jitter: random integer in range [0, capped] inclusive
    return _random.nextInt(capped + 1);
  }

  /// Restores the state machine back to its initial 'idle' state.
  void reset() {
    state = QueryStatus.idle;
    retryCount = 0;
    data = null;
    error = null;
    fsmState = const IdleState();
  }

  bool get isIdle => state == QueryStatus.idle;
  bool get isLoading => state == QueryStatus.loading;
  bool get isSuccess => state == QueryStatus.success;
  bool get isError => state == QueryStatus.error;
  bool get isRetrying => state == QueryStatus.retrying;
}
