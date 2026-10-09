import 'dart:async';
import 'dart:convert';
import 'cas_store.dart';
import 'resume_strategy.dart';
import 'sqlite_adapter.dart';
import 'stream_handle.dart';
import 'stream_resume_fsm.dart';
import 'structural_sharing.dart';
import 'types.dart';
import 'utf8_stream_decoder.dart';

class _InternalQueryRecord {
  final QueryKey queryKey;
  final String hash;
  CacheEntry<dynamic>? entry;
  List<String>? tags;
  Duration? staleTime;
  Duration? gcTime;
  Function? queryFn;
  dynamic Function(dynamic)? dataParser;
  QueryState<dynamic> state;
  final Set<void Function()> subscribers = {};
  CancellationToken? activeToken;
  Future<dynamic>? activeFuture;
  Timer? debounceTimer;
  List<Completer<dynamic>>? debounceCompleters;

  _InternalQueryRecord({
    required this.queryKey,
    required this.hash,
    this.entry,
    this.tags,
    this.staleTime,
    this.gcTime,
    this.dataParser,
    required this.state,
  });
}

/// Reactive query watcher holding a subscription to query state.
class QueryWatcher<T> {
  final QueryEngine _engine;
  final QueryKey _queryKey;
  final Future<T> Function()? queryFn;
  final Duration? staleTime;
  final Duration? gcTime;
  final List<String>? tags;
  final T Function(dynamic)? _dataParser;

  final Set<void Function()> _listeners = {};
  final StreamController<QueryState<T>> _controller =
      StreamController<QueryState<T>>.broadcast();
  void Function()? _engineUnsubscribe;

  QueryWatcher._({
    required QueryEngine engine,
    required QueryKey queryKey,
    this.queryFn,
    this.staleTime,
    this.gcTime,
    this.tags,
    T Function(dynamic)? dataParser,
  })  : _engine = engine,
        _queryKey = queryKey,
        _dataParser = dataParser {
    _engineUnsubscribe = _engine.subscribe(_queryKey, () {
      final current = state;
      for (final listener in List<void Function()>.from(_listeners)) {
        try {
          listener();
        } catch (_) {}
      }
      if (!_controller.isClosed) {
        _controller.add(current);
      }
    });
  }

  /// Synchronously returns current query state snapshot.
  QueryState<T> get state =>
      _engine.getQueryState<T>(_queryKey, dataParser: _dataParser) ??
      QueryState<T>();

  /// Alias for [state].
  QueryState<T> getSnapshot() => state;

  /// Reactive stream of query state changes.
  Stream<QueryState<T>> get stream => _controller.stream;

  /// Refetches the query data with staleTime = 0.
  Future<T> refetch() {
    if (queryFn != null) {
      return _engine.fetchQuery<T>(
        _queryKey,
        queryFn!,
        staleTime: Duration.zero,
        gcTime: gcTime,
        tags: tags,
        dataParser: _dataParser,
      );
    }
    throw StateError('Cannot refetch query without a queryFn');
  }

  /// Subscribes listener callback, returning unsubscribe function.
  void Function() subscribe(void Function() listener) {
    _listeners.add(listener);
    return () {
      _listeners.remove(listener);
    };
  }

  /// Cancels in-flight query fetch.
  void cancel() {
    _engine.cancelQuery(_queryKey);
  }

  /// Cleans up listeners and closes stream.
  void dispose() {
    _engineUnsubscribe?.call();
    _engineUnsubscribe = null;
    _listeners.clear();
    _controller.close();
  }
}

/// Core UCSA Query Engine providing asynchronous caching, Stale-While-Revalidate (SWR),
/// structural sharing, and cancellation.
class QueryEngine {
  final SqliteAdapter? sqliteAdapter;
  final Duration defaultStaleTime;
  final Duration defaultGcTime;

  final Map<String, _InternalQueryRecord> _queries = {};

  QueryEngine({
    this.sqliteAdapter,
    this.defaultStaleTime = Duration.zero,
    this.defaultGcTime = const Duration(minutes: 5),
  });

  /// Fetches and caches a query, returning a Future resolving to the data.
  /// If fresh data is already cached, returns immediately without invoking [queryFn].
  Future<T> fetchQuery<T>(
    QueryKey queryKey,
    Future<T> Function() queryFn, {
    Duration? staleTime,
    Duration? gcTime,
    List<String>? tags,
    T Function(dynamic)? dataParser,
    Duration? debounceDuration,
  }) async {
    final hash = hashQueryKey(queryKey);
    final record = _getOrCreateRecord(
      queryKey,
      hash,
      staleTime: staleTime,
      gcTime: gcTime,
      tags: tags,
      dataParser: dataParser,
    );

    final effectiveStale = staleTime ?? record.staleTime ?? defaultStaleTime;
    final now = DateTime.now().millisecondsSinceEpoch;
    final staleThreshold = record.entry != null
        ? record.entry!.createdAt + effectiveStale.inMilliseconds
        : (record.entry?.staleAt ?? 0);

    final isFresh = record.entry != null && now < staleThreshold;

    if (isFresh && record.state.data != null) {
      return record.state.data as T;
    }

    record.queryFn = queryFn;
    if (tags != null) record.tags = tags;
    if (staleTime != null) record.staleTime = staleTime;
    if (gcTime != null) record.gcTime = gcTime;
    if (dataParser != null) record.dataParser = dataParser;

    if (debounceDuration != null && debounceDuration > Duration.zero) {
      record.debounceCompleters ??= [];
      record.debounceTimer?.cancel();

      final completer = Completer<T>();
      record.debounceCompleters!.add(completer);

      record.debounceTimer = Timer(debounceDuration, () async {
        record.debounceTimer = null;
        final completers = List<Completer<dynamic>>.from(record.debounceCompleters ?? []);
        record.debounceCompleters = null;

        try {
          final data = await _executeFetch<T>(
            record,
            record.queryFn as Future<T> Function(),
            staleTime: record.staleTime,
            gcTime: record.gcTime,
            tags: record.tags,
            dataParser: record.dataParser as T Function(dynamic)?,
          );
          for (final c in completers) {
            c.complete(data);
          }
        } catch (err, stack) {
          for (final c in completers) {
            c.completeError(err, stack);
          }
        }
      });

      return completer.future;
    }

    return _executeFetch<T>(
      record,
      queryFn,
      staleTime: staleTime,
      gcTime: gcTime,
      tags: tags,
      dataParser: dataParser,
    );
  }

  /// Reactive hook / stream compatible query watcher supporting SWR.
  /// Immediately returns cached data if available; triggers background revalidation if stale.
  QueryWatcher<T> watchQuery<T>(
    QueryKey queryKey, {
    Future<T> Function()? queryFn,
    Duration? staleTime,
    Duration? gcTime,
    List<String>? tags,
    T Function(dynamic)? dataParser,
  }) {
    final hash = hashQueryKey(queryKey);
    final record = _getOrCreateRecord(
      queryKey,
      hash,
      staleTime: staleTime,
      gcTime: gcTime,
      tags: tags,
      dataParser: dataParser,
    );

    if (queryFn != null) record.queryFn = queryFn;
    if (tags != null) record.tags = tags;
    if (staleTime != null) record.staleTime = staleTime;
    if (gcTime != null) record.gcTime = gcTime;
    if (dataParser != null) record.dataParser = dataParser;

    final effectiveStale = staleTime ?? record.staleTime ?? defaultStaleTime;
    final now = DateTime.now().millisecondsSinceEpoch;
    final staleThreshold = record.entry != null
        ? record.entry!.createdAt + effectiveStale.inMilliseconds
        : (record.entry?.staleAt ?? 0);

    final hasData = record.state.data != null;
    final isStale = record.entry == null || now >= staleThreshold;

    if (!hasData) {
      record.state = record.state.copyWith(
        status: QueryStatus.loading,
        isFetching: true,
      );
      if (queryFn != null) {
        _executeFetch<T>(
          record,
          queryFn,
          staleTime: staleTime,
          gcTime: gcTime,
          tags: tags,
          dataParser: dataParser,
        ).then((_) {}, onError: (_) {});
      }
    } else if (isStale) {
      // SWR: Cache hit! Data is present, but stale. Revalidate in the background.
      record.state = record.state.copyWith(
        isFetching: true,
      );
      if (queryFn != null) {
        _executeFetch<T>(
          record,
          queryFn,
          staleTime: staleTime,
          gcTime: gcTime,
          tags: tags,
          dataParser: dataParser,
        ).then((_) {}, onError: (_) {});
      }
    } else {
      // Cache hit and fresh.
      record.state = record.state.copyWith(
        isFetching: false,
      );
    }

    return QueryWatcher<T>._(
      engine: this,
      queryKey: queryKey,
      queryFn: queryFn,
      staleTime: staleTime,
      gcTime: gcTime,
      tags: tags,
      dataParser: dataParser,
    );
  }

  /// Alias for [watchQuery].
  QueryWatcher<T> useQuery<T>(
    QueryKey queryKey,
    Future<T> Function() queryFn, {
    Duration? staleTime,
    Duration? gcTime,
    List<String>? tags,
    T Function(dynamic)? dataParser,
  }) =>
      watchQuery<T>(
        queryKey,
        queryFn: queryFn,
        staleTime: staleTime,
        gcTime: gcTime,
        tags: tags,
        dataParser: dataParser,
      );

  /// Streams a query with incremental UTF-8 slicing, automatic compaction into SQLite/CAS,
  /// failure recovery via StreamResumeFsm, and SWR caching.
  StreamHandle<T> streamQuery<T>(
    QueryKey queryKey,
    Stream<dynamic> Function(StreamFnContext ctx) streamFn, {
    Duration? staleTime,
    Duration? gcTime,
    List<String>? tags,
    ResumeStrategy? strategy,
    CasStore? casStore,
    int casThresholdBytes = 1048576,
    CancellationToken? cancellationToken,
    int? baseDelayMs,
    int? maxRetries,
  }) {
    final queryHash = hashQueryKey(queryKey);
    final record = _getOrCreateRecord(
      queryKey,
      queryHash,
      tags: tags,
      staleTime: staleTime,
      gcTime: gcTime,
    );

    // SWR check: if query is cached in SQLite or in memory and fresh
    final effectiveStale = staleTime ?? record.staleTime ?? defaultStaleTime;
    final now = DateTime.now().millisecondsSinceEpoch;
    final staleThreshold = record.entry != null
        ? record.entry!.createdAt + effectiveStale.inMilliseconds
        : (record.entry?.staleAt ?? 0);

    final isFresh = record.entry != null && now < staleThreshold;

    if (isFresh && record.state.data != null) {
      final cachedData = record.state.data as T;
      final cachedHandle = StreamHandle<T>(queryHash: queryHash);
      cachedHandle.push(StreamSlice<T>(
        delta: cachedData,
        cumulative: cachedData,
        seq: 0,
        byteOffset: 0,
        done: true,
      ));
      cachedHandle.end(cachedData);
      return cachedHandle;
    }

    // Create stream in SQLite adapter
    if (sqliteAdapter != null) {
      try {
        final existing = sqliteAdapter!.getStream(queryHash);
        if (existing != null) {
          try {
            sqliteAdapter!.db.execute(
              'DELETE FROM ucsa_streams WHERE query_hash = ?;',
              [queryHash],
            );
          } catch (_) {}
        }
        sqliteAdapter!.createStream(
          queryKey,
          encoding: StreamEncoding.utf8,
          tags: tags,
          ttlMs: gcTime?.inMilliseconds ?? 300000,
          resumeKind: strategy is LastEventIdResumeStrategy
              ? ResumeKind.lastEventId
              : null,
        );
      } catch (_) {}
    }

    final resumeStrategy = strategy ?? RangeResumeStrategy();
    final resumeFsm = StreamResumeFsm(StreamResumeFsmOptions(
      queryHash: queryHash,
      queryKey: queryKey,
      strategy: resumeStrategy,
      sqliteAdapter: sqliteAdapter,
      baseDelayMs: baseDelayMs ?? 300,
      maxRetries: maxRetries ?? 5,
    ));
    resumeFsm.start();

    final internalToken = CancellationToken();
    final handle = StreamHandle<T>(
      queryHash: queryHash,
      cancellationToken: internalToken,
    );
    record.activeToken = internalToken;

    void doCancel([String? reason]) {
      if (!internalToken.isCancelled) {
        internalToken.cancel();
      }
      if (!handle.isCancelled) {
        handle.cancel(reason);
      }
      sqliteAdapter?.abortStream(queryHash, error: reason);
      resumeFsm.abort(reason: reason);
      record.state = record.state.copyWith(isFetching: false);
      _notifySubscribers(record);
    }

    if (cancellationToken != null) {
      if (cancellationToken.isCancelled) {
        doCancel('Cancelled before start');
        return handle;
      }
      cancellationToken.onCancel(() {
        doCancel('Cancelled via cancellationToken');
      });
    }

    internalToken.onCancel(() {
      doCancel('Cancelled via internal token');
    });

    record.state = record.state.copyWith(
      status: record.state.data != null ? record.state.status : QueryStatus.loading,
      isFetching: true,
    );
    _notifySubscribers(record);

    var cumulativeText = '';
    var utf8Decoder = Utf8StreamDecoder();

    // Background pipeline execution
    () async {
      Map<String, String>? currentResumeHeaders;
      dynamic currentContinuationPayload;

      while (!handle.isDone && !handle.isCancelled && !internalToken.isCancelled) {
        try {
          final ctx = StreamFnContext(
            queryHash: queryHash,
            cancellationToken: internalToken,
            resumeHeaders: currentResumeHeaders,
            continuationPayload: currentContinuationPayload,
          );

          final stream = streamFn(ctx);

          await for (final rawChunk in stream) {
            if (handle.isCancelled || internalToken.isCancelled) {
              break;
            }

            final chunkResult = resumeFsm.handleIncomingChunk(rawChunk);
            if (!chunkResult.accepted) {
              continue;
            }

            final delta = utf8Decoder.decode(chunkResult.slice);
            cumulativeText += delta;
            if (delta.isNotEmpty) {
              handle.push(StreamSlice<T>(
                delta: delta as T,
                cumulative: cumulativeText as T,
                seq: chunkResult.seq,
                byteOffset: chunkResult.byteOffset,
                done: false,
              ));
            }
          }

          if (handle.isCancelled || internalToken.isCancelled) {
            break;
          }

          resumeFsm.complete();

          final flushed = utf8Decoder.flush();
          if (flushed.isNotEmpty) {
            cumulativeText += flushed;
            handle.push(StreamSlice<T>(
              delta: flushed as T,
              cumulative: cumulativeText as T,
              seq: resumeFsm.committedSeq,
              byteOffset: resumeFsm.committedByteLength,
              done: false,
            ));
          }

          final finalPayload = cumulativeText as T;

          CacheEntry<dynamic>? compactedEntry;
          if (sqliteAdapter != null) {
            try {
              compactedEntry = await sqliteAdapter!.compactStream(
                queryHash,
                casStore: casStore,
                casThresholdBytes: casThresholdBytes,
              );
            } catch (_) {}
          }

          final completionNow = DateTime.now().millisecondsSinceEpoch;
          final effectiveStaleAfter = staleTime ?? defaultStaleTime;
          final effectiveGcAfter = gcTime ?? defaultGcTime;

          if (compactedEntry != null && staleTime != null) {
            compactedEntry = compactedEntry.copyWith(
              staleAt: compactedEntry.createdAt + effectiveStaleAfter.inMilliseconds,
            );
            try {
              sqliteAdapter!.setQuery(compactedEntry, tags: tags);
            } catch (_) {}
          }

          final entryToStore = compactedEntry ?? CacheEntry<dynamic>(
            queryHash: queryHash,
            queryKey: queryKey,
            dataPayload: finalPayload,
            createdAt: completionNow,
            staleAt: completionNow + effectiveStaleAfter.inMilliseconds,
            expiresAt: completionNow + effectiveGcAfter.inMilliseconds,
            payloadVersion: 1,
          );

          record.entry = entryToStore;
          record.state = QueryState<dynamic>(
            status: QueryStatus.success,
            data: entryToStore.dataPayload,
            dataUpdatedAt: completionNow,
            error: null,
            errorUpdatedAt: record.state.errorUpdatedAt,
            isFetching: false,
          );
          _notifySubscribers(record);

          handle.push(StreamSlice<T>(
            delta: '' as T,
            cumulative: finalPayload,
            seq: resumeFsm.committedSeq,
            byteOffset: resumeFsm.committedByteLength,
            done: true,
          ));
          handle.end(finalPayload);
          break;
        } catch (err, stack) {
          if (handle.isCancelled || internalToken.isCancelled) {
            break;
          }

          final errorResult = resumeFsm.handleError(err);
          if (errorResult.canResume) {
            currentResumeHeaders = errorResult.headers;
            currentContinuationPayload = errorResult.continuationPayload;
            if (errorResult.restart) {
              cumulativeText = '';
              utf8Decoder = Utf8StreamDecoder();
              handle.push(StreamSlice<T>(
                delta: '' as T,
                cumulative: '' as T,
                seq: 0,
                byteOffset: 0,
                done: false,
                reset: true,
              ));
            }
            if (errorResult.retryDelayMs > 0) {
              await Future.delayed(Duration(milliseconds: errorResult.retryDelayMs));
            }
            continue;
          } else {
            resumeFsm.abort(reason: err.toString());
            handle.error(err, stack);
            record.state = record.state.copyWith(
              status: QueryStatus.error,
              error: err,
              errorUpdatedAt: DateTime.now().millisecondsSinceEpoch,
              isFetching: false,
            );
            _notifySubscribers(record);
            break;
          }
        }
      }
    }().catchError((_) {});

    return handle;
  }

  /// Subscribes a listener to state changes for the specified query key.
  /// Returns an unsubscribe function.
  void Function() subscribe(QueryKey queryKey, void Function() callback) {
    final hash = hashQueryKey(queryKey);
    final record = _getOrCreateRecord(queryKey, hash);
    record.subscribers.add(callback);
    return () {
      record.subscribers.remove(callback);
    };
  }

  /// Cancels any active in-flight fetch operation or pending debounce timer for the specified query key.
  void cancelQuery(QueryKey queryKey) {
    final hash = hashQueryKey(queryKey);
    final record = _queries[hash];
    if (record != null) {
      if (record.debounceTimer != null) {
        record.debounceTimer!.cancel();
        record.debounceTimer = null;
        final completers = List<Completer<dynamic>>.from(record.debounceCompleters ?? []);
        record.debounceCompleters = null;
        for (final c in completers) {
          if (!c.isCompleted) {
            c.completeError(Exception('Query was cancelled'));
          }
        }
      }
      if (record.activeToken != null) {
        record.activeToken!.cancel();
        record.activeToken = null;
        record.activeFuture = null;
        record.state = record.state.copyWith(isFetching: false);
        _notifySubscribers(record);
      }
    }
  }

  /// Invalidates all queries matching the query key prefix.
  /// Marks matching queries as stale and triggers revalidation for active queries.
  Future<void> invalidateQueries(QueryKey queryKeyOrPrefix) async {
    final matchedHashes = <String>{};

    for (final entry in _queries.entries) {
      if (matchQueryKey(queryKeyOrPrefix, entry.value.queryKey)) {
        matchedHashes.add(entry.key);
      }
    }

    if (sqliteAdapter != null) {
      try {
        final rows = sqliteAdapter!.db
            .select('SELECT query_hash, query_key FROM ucsa_query_cache;');
        for (final row in rows) {
          try {
            final parsedKey = jsonDecode(row['query_key'] as String) as List;
            if (matchQueryKey(queryKeyOrPrefix, parsedKey.cast<Object?>())) {
              final hash = row['query_hash'] as String;
              matchedHashes.add(hash);
              sqliteAdapter!.deleteQuery(hash);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    final revalidations = <Future<dynamic>>[];

    for (final hash in matchedHashes) {
      final record = _queries[hash];
      if (record != null) {
        if (record.entry != null) {
          record.entry = record.entry!.copyWith(staleAt: 0);
        }
        if (record.queryFn != null) {
          record.state = record.state.copyWith(isFetching: true);
          _notifySubscribers(record);
          final fn = record.queryFn!;
          revalidations.add(
            _executeFetch<dynamic>(
              record,
              () => fn() as Future<dynamic>,
              staleTime: record.staleTime,
              gcTime: record.gcTime,
              tags: record.tags,
              dataParser: record.dataParser,
            ).catchError((_) {}),
          );
        }
      }
    }

    if (revalidations.isNotEmpty) {
      await Future.wait(revalidations);
    }
  }

  /// Invalidates all queries tagged with the specified tag.
  /// Returns the list of query hashes that were invalidated.
  Future<List<String>> invalidateByTag(String tag) async {
    final invalidatedHashes = <String>{};

    if (sqliteAdapter != null) {
      final dbHashes = sqliteAdapter!.invalidateByTag(tag);
      invalidatedHashes.addAll(dbHashes);
    }

    for (final entry in _queries.entries) {
      if (entry.value.tags?.contains(tag) == true ||
          invalidatedHashes.contains(entry.key)) {
        invalidatedHashes.add(entry.key);
      }
    }

    final revalidations = <Future<dynamic>>[];

    for (final hash in invalidatedHashes) {
      final record = _queries[hash];
      if (record != null) {
        if (record.entry != null) {
          record.entry = record.entry!.copyWith(staleAt: 0);
        }
        if (record.queryFn != null) {
          record.state = record.state.copyWith(isFetching: true);
          _notifySubscribers(record);
          final fn = record.queryFn!;
          revalidations.add(
            _executeFetch<dynamic>(
              record,
              () => fn() as Future<dynamic>,
              staleTime: record.staleTime,
              gcTime: record.gcTime,
              tags: record.tags,
              dataParser: record.dataParser,
            ).catchError((_) {}),
          );
        }
      }
    }

    if (revalidations.isNotEmpty) {
      await Future.wait(revalidations);
    }

    return invalidatedHashes.toList();
  }

  /// Synchronously reads the query state for a query key from memory or SQLite.
  QueryState<T>? getQueryState<T>(
    QueryKey queryKey, {
    T Function(dynamic)? dataParser,
  }) {
    final hash = hashQueryKey(queryKey);
    final record = _queries[hash];
    if (record != null) {
      return QueryState<T>(
        status: record.state.status,
        data: record.state.data as T?,
        error: record.state.error,
        dataUpdatedAt: record.state.dataUpdatedAt,
        errorUpdatedAt: record.state.errorUpdatedAt,
        isFetching: record.state.isFetching,
      );
    }

    if (sqliteAdapter != null) {
      try {
        final entry = sqliteAdapter!.getQuery<T>(
          hash,
          dataParser: dataParser,
        );
        if (entry != null &&
            DateTime.now().millisecondsSinceEpoch <= entry.expiresAt) {
          final newRecord = _InternalQueryRecord(
            queryKey: queryKey,
            hash: hash,
            entry: entry,
            dataParser: dataParser,
            state: QueryState<dynamic>(
              status: QueryStatus.success,
              data: entry.dataPayload,
              dataUpdatedAt: entry.createdAt,
              isFetching: false,
            ),
          );
          _queries[hash] = newRecord;
          return QueryState<T>(
            status: QueryStatus.success,
            data: entry.dataPayload,
            dataUpdatedAt: entry.createdAt,
            isFetching: false,
          );
        }
      } catch (_) {
        _queries.remove(hash);
        try {
          sqliteAdapter!.deleteQuery(hash);
        } catch (_) {}
        return null;
      }
    }

    return null;
  }

  /// Synchronously reads query data if present.
  T? getQueryData<T>(
    QueryKey queryKey, {
    T Function(dynamic)? dataParser,
  }) {
    return getQueryState<T>(queryKey, dataParser: dataParser)?.data;
  }

  /// Manually sets or updates cached query data.
  void setQueryData<T>(
    QueryKey queryKey,
    T data, {
    Duration? staleTime,
    Duration? gcTime,
    List<String>? tags,
  }) {
    final hash = hashQueryKey(queryKey);
    final record = _getOrCreateRecord(
      queryKey,
      hash,
      staleTime: staleTime,
      gcTime: gcTime,
      tags: tags,
    );

    final now = DateTime.now().millisecondsSinceEpoch;
    final effectiveStale = staleTime ?? record.staleTime ?? defaultStaleTime;
    final effectiveGc = gcTime ?? record.gcTime ?? defaultGcTime;

    final oldData = record.state.data;
    final sharedData = oldData != null ? replaceEqualDeep(oldData, data) : data;
    final dataChanged = oldData == null ||
        (!identical(oldData, sharedData) && !deepEqual(oldData, sharedData));

    record.state = QueryState<dynamic>(
      status: QueryStatus.success,
      data: sharedData,
      dataUpdatedAt: now,
      error: null,
      errorUpdatedAt: record.state.errorUpdatedAt,
      isFetching: false,
    );

    final entry = CacheEntry<dynamic>(
      queryHash: hash,
      queryKey: queryKey,
      dataPayload: sharedData,
      createdAt: now,
      staleAt: now + effectiveStale.inMilliseconds,
      expiresAt: now + effectiveGc.inMilliseconds,
    );
    record.entry = entry;

    if (sqliteAdapter != null) {
      final queryTags = tags ?? record.tags;
      sqliteAdapter!.setQuery(entry, tags: queryTags);
    }

    if (dataChanged) {
      _notifySubscribers(record);
    }
  }

  /// Clears the in-memory cache and aborts any active fetch operations.
  void clear() {
    for (final record in _queries.values) {
      record.activeToken?.cancel();
    }
    _queries.clear();
  }

  /// Disposes resources held by the query engine.
  void dispose() {
    clear();
  }

  Future<T> _executeFetch<T>(
    _InternalQueryRecord record,
    Future<T> Function() queryFn, {
    Duration? staleTime,
    Duration? gcTime,
    List<String>? tags,
    T Function(dynamic)? dataParser,
  }) {
    if (record.activeFuture != null) {
      return record.activeFuture!.then((val) => val as T);
    }

    final token = CancellationToken();
    record.activeToken = token;
    record.queryFn = queryFn;
    if (tags != null) record.tags = tags;
    if (staleTime != null) record.staleTime = staleTime;
    if (gcTime != null) record.gcTime = gcTime;
    if (dataParser != null) record.dataParser = dataParser;

    final completer = Completer<T>();

    () async {
      final prevStatus = record.state.status;
      final oldData = record.state.data;

      try {
        final rawData = await queryFn();

        if (token.isCancelled) {
          record.state = record.state.copyWith(isFetching: false);
          completer.completeError(
            Exception('Query cancelled: ${record.queryKey}'),
          );
          return;
        }

        final now = DateTime.now().millisecondsSinceEpoch;
        final effectiveStale =
            staleTime ?? record.staleTime ?? defaultStaleTime;
        final effectiveGc = gcTime ?? record.gcTime ?? defaultGcTime;

        // Apply structural sharing
        final sharedData =
            oldData != null ? replaceEqualDeep(oldData, rawData) : rawData;

        final dataChanged = oldData == null ||
            (!identical(oldData, sharedData) &&
                !deepEqual(oldData, sharedData));
        final statusChanged = prevStatus != QueryStatus.success;

        record.state = QueryState<dynamic>(
          status: QueryStatus.success,
          data: sharedData,
          dataUpdatedAt: now,
          error: null,
          errorUpdatedAt: record.state.errorUpdatedAt,
          isFetching: false,
        );

        final entry = CacheEntry<dynamic>(
          queryHash: record.hash,
          queryKey: record.queryKey,
          dataPayload: sharedData,
          createdAt: now,
          staleAt: now + effectiveStale.inMilliseconds,
          expiresAt: now + effectiveGc.inMilliseconds,
        );
        record.entry = entry;

        if (sqliteAdapter != null) {
          final queryTags = tags ?? record.tags;
          sqliteAdapter!.setQuery(entry, tags: queryTags);
        }

        if (dataChanged || statusChanged) {
          _notifySubscribers(record);
        }

        completer.complete(sharedData as T);
      } catch (err) {
        if (token.isCancelled) {
          record.state = record.state.copyWith(isFetching: false);
          completer.completeError(err);
          return;
        }

        final now = DateTime.now().millisecondsSinceEpoch;
        record.state = QueryState<dynamic>(
          status: QueryStatus.error,
          data: record.state.data,
          error: err,
          errorUpdatedAt: now,
          dataUpdatedAt: record.state.dataUpdatedAt,
          isFetching: false,
        );

        _notifySubscribers(record);
        completer.completeError(err);
      } finally {
        if (record.activeToken == token) {
          record.activeToken = null;
          record.activeFuture = null;
        }
      }
    }();

    record.activeFuture = completer.future;
    return completer.future;
  }

  _InternalQueryRecord _getOrCreateRecord(
    QueryKey queryKey,
    String hash, {
    Duration? staleTime,
    Duration? gcTime,
    List<String>? tags,
    dynamic Function(dynamic)? dataParser,
  }) {
    var record = _queries[hash];
    if (record != null) {
      if (tags != null) record.tags = tags;
      if (staleTime != null) record.staleTime = staleTime;
      if (gcTime != null) record.gcTime = gcTime;
      if (dataParser != null) record.dataParser = dataParser;
      return record;
    }

    if (sqliteAdapter != null) {
      try {
        final entry = sqliteAdapter!.getQuery<dynamic>(
          hash,
          dataParser: dataParser != null ? (j) => dataParser(j) : null,
        );
        if (entry != null) {
          final now = DateTime.now().millisecondsSinceEpoch;
          if (now <= entry.expiresAt) {
            record = _InternalQueryRecord(
              queryKey: queryKey,
              hash: hash,
              entry: entry,
              tags: tags,
              staleTime: staleTime,
              gcTime: gcTime,
              dataParser: dataParser,
              state: QueryState<dynamic>(
                status: QueryStatus.success,
                data: entry.dataPayload,
                dataUpdatedAt: entry.createdAt,
                isFetching: false,
              ),
            );
            _queries[hash] = record;
            return record;
          } else {
            sqliteAdapter!.deleteQuery(hash);
          }
        }
      } catch (_) {
        _queries.remove(hash);
        try {
          sqliteAdapter!.deleteQuery(hash);
        } catch (_) {}
      }
    }

    record = _InternalQueryRecord(
      queryKey: queryKey,
      hash: hash,
      tags: tags,
      staleTime: staleTime,
      gcTime: gcTime,
      dataParser: dataParser,
      state: const QueryState<dynamic>(
        status: QueryStatus.idle,
        isFetching: false,
      ),
    );
    _queries[hash] = record;
    return record;
  }

  void _notifySubscribers(_InternalQueryRecord record) {
    for (final sub in List<void Function()>.from(record.subscribers)) {
      try {
        sub();
      } catch (_) {}
    }
  }
}
