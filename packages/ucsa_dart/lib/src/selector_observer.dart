import 'dart:async';
import 'query_engine.dart';
import 'structural_sharing.dart';
import 'types.dart';

/// Zero-rebuild selector observer that connects to a [QueryEngine] and filters
/// notifications to only trigger when the computed slice [TSelected] actually changes.
class SelectorObserver<TData, TSelected> {
  final QueryEngine engine;
  final QueryKey queryKey;
  final TSelected Function(TData data) selector;
  final Future<TData> Function()? queryFn;
  final Duration? staleTime;
  final Duration? gcTime;
  final List<String>? tags;
  final bool Function(TSelected? prev, TSelected? next)? isEqual;
  final TData Function(dynamic)? dataParser;
  final Duration? throttleDuration;
  final Duration? debounceDuration;

  TData? _currentData;
  TSelected? _currentSelected;
  final Set<void Function()> _listeners = {};
  final StreamController<TSelected?> _streamController =
      StreamController<TSelected?>.broadcast();
  void Function()? _engineUnsubscribe;

  Timer? _debounceTimer;
  Timer? _throttleTimer;
  bool _hasPendingTrailing = false;
  int _lastInvokedTime = 0;

  SelectorObserver({
    required this.engine,
    required this.queryKey,
    required this.selector,
    this.queryFn,
    this.staleTime,
    this.gcTime,
    this.tags,
    this.isEqual,
    this.dataParser,
    this.throttleDuration,
    this.debounceDuration,
  }) {
    _initCurrent();
  }

  void _initCurrent() {
    _currentData = engine.getQueryData<TData>(queryKey, dataParser: dataParser);
    _currentSelected =
        _currentData != null ? selector(_currentData as TData) : null;
  }

  /// Synchronously returns the current selected slice snapshot.
  TSelected? getSnapshot() {
    final freshData =
        engine.getQueryData<TData>(queryKey, dataParser: dataParser);
    if (!deepEqual(freshData, _currentData)) {
      _updateSelected(freshData);
    }
    return _currentSelected;
  }

  /// Alias for [getSnapshot].
  TSelected? get value => getSnapshot();

  /// Reactive stream of selected slice changes.
  Stream<TSelected?> get stream => _streamController.stream;

  bool _equal(TSelected? a, TSelected? b) {
    if (isEqual != null) return isEqual!(a, b);
    return deepEqual(a, b);
  }

  bool _updateSelected(TData? freshData) {
    if (deepEqual(freshData, _currentData) && _currentSelected != null) {
      return false;
    }
    _currentData = freshData;
    final nextSelected = freshData != null ? selector(freshData) : null;

    if (!_equal(_currentSelected, nextSelected)) {
      _currentSelected = _currentSelected != null && nextSelected != null
          ? replaceEqualDeep(_currentSelected, nextSelected)
          : nextSelected;
      return true;
    }
    return false;
  }

  void _clearTimers() {
    _debounceTimer?.cancel();
    _debounceTimer = null;
    _throttleTimer?.cancel();
    _throttleTimer = null;
    _hasPendingTrailing = false;
  }

  void _notifyListeners() {
    for (final listener in List<void Function()>.from(_listeners)) {
      try {
        listener();
      } catch (_) {}
    }
    if (!_streamController.isClosed) {
      _streamController.add(_currentSelected);
    }
  }

  void _scheduleDebounce() {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(debounceDuration!, () {
      _debounceTimer = null;
      _notifyListeners();
    });
  }

  void _scheduleThrottle() {
    final now = DateTime.now().millisecondsSinceEpoch;
    final elapsed = now - _lastInvokedTime;
    final windowMs = throttleDuration!.inMilliseconds;

    if (elapsed >= windowMs && _throttleTimer == null) {
      _lastInvokedTime = now;
      _notifyListeners();
      _throttleTimer = Timer(throttleDuration!, () {
        _throttleTimer = null;
        if (_hasPendingTrailing) {
          _hasPendingTrailing = false;
          _lastInvokedTime = DateTime.now().millisecondsSinceEpoch;
          _notifyListeners();
        }
      });
    } else {
      _hasPendingTrailing = true;
      if (_throttleTimer == null) {
        final remaining = windowMs - elapsed;
        _throttleTimer = Timer(
          Duration(milliseconds: remaining > 0 ? remaining : 0),
          () {
            _throttleTimer = null;
            if (_hasPendingTrailing) {
              _hasPendingTrailing = false;
              _lastInvokedTime = DateTime.now().millisecondsSinceEpoch;
              _notifyListeners();
            }
          },
        );
      }
    }
  }

  void _handleEngineUpdate() {
    final freshData =
        engine.getQueryData<TData>(queryKey, dataParser: dataParser);
    final changed = _updateSelected(freshData);
    if (changed) {
      if (debounceDuration != null) {
        _scheduleDebounce();
      } else if (throttleDuration != null) {
        _scheduleThrottle();
      } else {
        _notifyListeners();
      }
    }
  }

  /// Subscribes a listener to changes in the selected slice.
  /// The listener is invoked ONLY when [prevSelected != nextSelected].
  /// Returns an unsubscribe callback.
  void Function() subscribe(void Function() listener) {
    _listeners.add(listener);

    if (_listeners.length == 1) {
      final freshData =
          engine.getQueryData<TData>(queryKey, dataParser: dataParser);
      _updateSelected(freshData);

      _engineUnsubscribe = engine.subscribe(queryKey, _handleEngineUpdate);

      if (queryFn != null && _currentData == null) {
        engine
            .fetchQuery<TData>(
              queryKey,
              queryFn!,
              staleTime: staleTime,
              gcTime: gcTime,
              tags: tags,
              dataParser: dataParser,
            )
            .then((_) {}, onError: (_) {});
      }
    }

    return () {
      _listeners.remove(listener);
      if (_listeners.isEmpty) {
        _clearTimers();
        if (_engineUnsubscribe != null) {
          _engineUnsubscribe!();
          _engineUnsubscribe = null;
        }
      }
    };
  }

  /// Cleans up listeners and closes streams.
  void dispose() {
    _clearTimers();
    _listeners.clear();
    _engineUnsubscribe?.call();
    _engineUnsubscribe = null;
    _streamController.close();
  }
}

/// Factory function to create a [SelectorObserver].
SelectorObserver<TData, TSelected> createSelectorObserver<TData, TSelected>(
  QueryEngine engine,
  QueryKey queryKey,
  TSelected Function(TData data) selector, {
  Future<TData> Function()? queryFn,
  Duration? staleTime,
  Duration? gcTime,
  List<String>? tags,
  bool Function(TSelected? prev, TSelected? next)? isEqual,
  TData Function(dynamic)? dataParser,
  Duration? throttleDuration,
  Duration? debounceDuration,
}) {
  return SelectorObserver<TData, TSelected>(
    engine: engine,
    queryKey: queryKey,
    selector: selector,
    queryFn: queryFn,
    staleTime: staleTime,
    gcTime: gcTime,
    tags: tags,
    isEqual: isEqual,
    dataParser: dataParser,
    throttleDuration: throttleDuration,
    debounceDuration: debounceDuration,
  );
}
