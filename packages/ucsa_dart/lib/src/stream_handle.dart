import 'dart:async';
import 'types.dart';

/// Represents an incremental slice yielded during a streaming query.
class StreamSlice<T> {
  final T delta;
  final T cumulative;
  final int seq;
  final int byteOffset;
  final bool done;
  final bool reset;

  const StreamSlice({
    required this.delta,
    required this.cumulative,
    required this.seq,
    required this.byteOffset,
    required this.done,
    this.reset = false,
  });

  @override
  String toString() =>
      'StreamSlice(seq: $seq, offset: $byteOffset, done: $done, reset: $reset)';
}

/// Represents an active or completed streaming query handle.
class StreamHandle<T> {
  final String queryHash;
  final CancellationToken cancellationToken;
  final StreamController<StreamSlice<T>> _controller =
      StreamController<StreamSlice<T>>();
  final Completer<T> _doneCompleter = Completer<T>();

  bool _isDone = false;
  bool _isCancelled = false;

  StreamHandle({
    required this.queryHash,
    CancellationToken? cancellationToken,
  }) : cancellationToken = cancellationToken ?? CancellationToken() {
    _doneCompleter.future.ignore();

    this.cancellationToken.onCancel(() {
      if (!_isCancelled) {
        cancel('Cancelled via CancellationToken');
      }
    });
  }

  /// Whether the stream has finished and completed.
  bool get isDone => _isDone;

  /// Whether the stream has been cancelled.
  bool get isCancelled => _isCancelled;

  /// Reactive stream yielding incremental [StreamSlice] instances.
  Stream<StreamSlice<T>> get stream => _controller.stream;

  /// Future resolving to the final complete payload when stream finishes.
  Future<T> get done => _doneCompleter.future;

  /// Pushes an incremental slice to the stream listeners.
  void push(StreamSlice<T> slice) {
    if (_isCancelled || (_isDone && !slice.done)) {
      return;
    }

    if (!_controller.isClosed) {
      _controller.add(slice);
    }

    if (slice.done && !_isDone) {
      end(slice.cumulative);
    }
  }

  /// Ends the stream with the final cumulative payload.
  void end(T finalPayload) {
    if (_isDone || _isCancelled) return;
    _isDone = true;

    if (!_doneCompleter.isCompleted) {
      _doneCompleter.complete(finalPayload);
    }
    if (!_controller.isClosed) {
      _controller.close();
    }
  }

  /// Aborts the stream with an error.
  void error(Object error, [StackTrace? stackTrace]) {
    if (_isDone || _isCancelled) return;
    _isDone = true;

    if (!_doneCompleter.isCompleted) {
      _doneCompleter.completeError(error, stackTrace);
    }
    if (!_controller.isClosed) {
      _controller.addError(error, stackTrace);
      _controller.close();
    }
  }

  /// Cancels the stream and stops further emission.
  void cancel([String? reason]) {
    if (_isCancelled) return;
    _isCancelled = true;
    _isDone = true;

    if (!cancellationToken.isCancelled) {
      cancellationToken.cancel();
    }

    final exception = StreamCancelledException(reason ?? 'Stream cancelled');
    if (!_doneCompleter.isCompleted) {
      _doneCompleter.completeError(exception);
    }
    if (!_controller.isClosed) {
      _controller.close();
    }
  }
}

/// Exception thrown when a stream query is cancelled before normal completion.
class StreamCancelledException implements Exception {
  final String reason;
  const StreamCancelledException([this.reason = 'Stream cancelled']);

  @override
  String toString() => 'StreamCancelledException: $reason';
}
