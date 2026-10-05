import 'dart:async';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('1. Structural Sharing (replaceEqualDeep)', () {
    test('returns exact same reference when prev is identical to next', () {
      final obj = {'id': 1, 'name': 'Alice'};
      expect(identical(replaceEqualDeep(obj, obj), obj), isTrue);

      final arr = [1, 2, 3];
      expect(identical(replaceEqualDeep(arr, arr), arr), isTrue);

      expect(replaceEqualDeep(42, 42), 42);
      expect(replaceEqualDeep('str', 'str'), 'str');
    });

    test('preserves map reference when new map has identical key-values', () {
      final prev = {
        'id': 1,
        'name': 'Alice',
        'meta': {'role': 'admin'},
      };
      final next = {
        'id': 1,
        'name': 'Alice',
        'meta': {'role': 'admin'},
      };

      final result = replaceEqualDeep(prev, next);
      expect(identical(result, prev), isTrue);
      expect(identical(result['meta'], prev['meta']), isTrue);
    });

    test('preserves unchanged child references on partial map change', () {
      final prev = {
        'id': 1,
        'profile': {'name': 'Alice', 'avatar': 'pic.png'},
        'settings': {'theme': 'dark', 'notifications': true},
      };
      final next = {
        'id': 1,
        'profile': {'name': 'Alice Updated', 'avatar': 'pic.png'},
        'settings': {'theme': 'dark', 'notifications': true},
      };

      final result = replaceEqualDeep(prev, next) as Map<String, dynamic>;
      // Top level reference changed
      expect(identical(result, prev), isFalse);
      // Changed sub-map has new reference
      expect(identical(result['profile'], prev['profile']), isFalse);
      expect(result['profile']['name'], 'Alice Updated');
      // Unchanged sub-map maintains exact reference
      expect(identical(result['settings'], prev['settings']), isTrue);
    });

    test('preserves list reference when elements are identical', () {
      final prev = [
        {'id': 1, 'val': 'a'},
        {'id': 2, 'val': 'b'},
      ];
      final next = [
        {'id': 1, 'val': 'a'},
        {'id': 2, 'val': 'b'},
      ];

      final result = replaceEqualDeep(prev, next);
      expect(identical(result, prev), isTrue);
      expect(identical(result[0], prev[0]), isTrue);
      expect(identical(result[1], prev[1]), isTrue);
    });

    test('preserves unchanged list element references on partial change', () {
      final prev = [
        {'id': 1, 'val': 'a'},
        {'id': 2, 'val': 'b'},
      ];
      final next = [
        {'id': 1, 'val': 'a'},
        {'id': 2, 'val': 'b-changed'},
      ];

      final result = replaceEqualDeep(prev, next) as List;
      expect(identical(result, prev), isFalse);
      expect(identical(result[0], prev[0]), isTrue);
      expect(identical(result[1], prev[1]), isFalse);
      expect(result[1]['val'], 'b-changed');
    });
  });

  group('2. Query Key Matching (matchQueryKey)', () {
    test('matches exact keys', () {
      expect(matchQueryKey(['users'], ['users']), isTrue);
      expect(matchQueryKey(['users', 1], ['users', 1]), isTrue);
      expect(matchQueryKey(['users', 1], ['users', 2]), isFalse);
    });

    test('matches hierarchical prefix keys', () {
      expect(matchQueryKey(['users'], ['users', 'detail', '123']), isTrue);
      expect(matchQueryKey(['users'], ['posts', 1]), isFalse);
    });

    test('matches partial maps inside query keys', () {
      expect(
        matchQueryKey(
          [
            'users',
            {'role': 'admin'},
          ],
          [
            'users',
            {'role': 'admin', 'page': 1},
          ],
        ),
        isTrue,
      );
      expect(
        matchQueryKey(
          [
            'users',
            {'role': 'admin'},
          ],
          [
            'users',
            {'role': 'user', 'page': 1},
          ],
        ),
        isFalse,
      );
    });
  });

  group('3. Synchronous Cache Reads (Memory & SQLite)', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test('reads synchronously from in-memory cache with zero async ticks',
        () async {
      final engine = QueryEngine();
      final queryKey = ['test', 'sync-memory'];

      // Seed cache
      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'value': 'in-memory-data'},
        staleTime: const Duration(minutes: 1),
      );

      // Synchronous read via getQueryState
      final state = engine.getQueryState<Map<String, dynamic>>(queryKey);
      expect(state, isNotNull);
      expect(state?.status, QueryStatus.success);
      expect(state?.data, {'value': 'in-memory-data'});

      // Synchronous read via watchQuery
      var fetchCallCount = 0;
      final query = engine.watchQuery<Map<String, dynamic>>(
        queryKey,
        queryFn: () async {
          fetchCallCount++;
          return {'value': 'in-memory-data'};
        },
        staleTime: const Duration(minutes: 1),
      );

      final snapshot = query.getSnapshot();
      expect(snapshot.status, QueryStatus.success);
      expect(snapshot.data, {'value': 'in-memory-data'});
      expect(snapshot.isFetching, isFalse);
      expect(fetchCallCount, 0);

      query.dispose();
    });

    test('reads synchronously from SQLite cache on cold engine launch', () {
      final queryKey = ['users', 42];
      final hash = hashQueryKey(queryKey);
      final now = DateTime.now().millisecondsSinceEpoch;

      final entry = CacheEntry<Map<String, dynamic>>(
        queryHash: hash,
        queryKey: queryKey,
        dataPayload: {'id': 42, 'name': 'Alice from SQLite'},
        createdAt: now,
        staleAt: now + 60000,
        expiresAt: now + 300000,
      );
      adapter.setQuery(entry, tags: ['tag:user']);

      final engine = QueryEngine(sqliteAdapter: adapter);

      // Synchronous read via getQueryState
      final state = engine.getQueryState<Map<String, dynamic>>(queryKey);
      expect(state, isNotNull);
      expect(state?.status, QueryStatus.success);
      expect(state?.data, {'id': 42, 'name': 'Alice from SQLite'});

      // Synchronous read via watchQuery
      var fetchCallCount = 0;
      final query = engine.watchQuery<Map<String, dynamic>>(
        queryKey,
        queryFn: () async {
          fetchCallCount++;
          return {'id': 42, 'name': 'Alice from SQLite'};
        },
        staleTime: const Duration(minutes: 1),
      );

      final snapshot = query.getSnapshot();
      expect(snapshot.status, QueryStatus.success);
      expect(snapshot.data, {'id': 42, 'name': 'Alice from SQLite'});
      expect(snapshot.isFetching, isFalse);
      expect(fetchCallCount, 0);

      query.dispose();
    });
  });

  group('4. Stale-While-Revalidate (SWR)', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test(
        'immediately yields stale data from cache while firing background revalidation',
        () async {
      final queryKey = ['feed', 'latest'];
      final hash = hashQueryKey(queryKey);
      final now = DateTime.now().millisecondsSinceEpoch;

      final stalePayload = {
        'version': 1,
        'items': ['item1']
      };
      final entry = CacheEntry<Map<String, dynamic>>(
        queryHash: hash,
        queryKey: queryKey,
        dataPayload: stalePayload,
        createdAt: now - 10000,
        staleAt: now - 5000, // Stale!
        expiresAt: now + 60000,
      );
      adapter.setQuery(entry);

      final engine = QueryEngine(sqliteAdapter: adapter);

      final fetchCompleter = Completer<Map<String, dynamic>>();
      var fetchCalls = 0;

      final query = engine.watchQuery<Map<String, dynamic>>(
        queryKey,
        queryFn: () {
          fetchCalls++;
          return fetchCompleter.future;
        },
        staleTime: const Duration(seconds: 5),
      );

      // SWR: 1. Synchronously returns stale data immediately with isFetching: true
      final initialSnapshot = query.getSnapshot();
      expect(initialSnapshot.status, QueryStatus.success);
      expect(initialSnapshot.data, stalePayload);
      expect(initialSnapshot.isFetching, isTrue);
      expect(fetchCalls, 1);

      // Subscribe to updates
      var listenerCalls = 0;
      final unsubscribe = query.subscribe(() {
        listenerCalls++;
      });

      // 2. Background revalidation resolves with fresh data
      final freshPayload = {
        'version': 2,
        'items': ['item1', 'item2']
      };
      fetchCompleter.complete(freshPayload);
      await fetchCompleter.future;

      // Allow event loop to process microtasks
      await Future<void>.delayed(const Duration(milliseconds: 15));

      expect(listenerCalls, 1);
      final updatedSnapshot = query.getSnapshot();
      expect(updatedSnapshot.status, QueryStatus.success);
      expect(updatedSnapshot.data, freshPayload);
      expect(updatedSnapshot.isFetching, isFalse);

      // Verify SQLite was updated with fresh data
      final saved = adapter.getQuery<dynamic>(hash);
      expect(saved?.dataPayload, freshPayload);

      unsubscribe();
      query.dispose();
    });

    test('cold load transitions from loading to success', () async {
      final engine = QueryEngine();
      final queryKey = ['posts', 1];

      final query = engine.watchQuery<Map<String, dynamic>>(
        queryKey,
        queryFn: () async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          return {'id': 1, 'title': 'Hello'};
        },
      );

      final initialSnapshot = query.getSnapshot();
      expect(initialSnapshot.status, QueryStatus.loading);
      expect(initialSnapshot.isFetching, isTrue);

      var notified = false;
      final unsubscribe = query.subscribe(() {
        notified = true;
      });

      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(notified, isTrue);
      final finalSnapshot = query.getSnapshot();
      expect(finalSnapshot.status, QueryStatus.success);
      expect(finalSnapshot.data, {'id': 1, 'title': 'Hello'});
      expect(finalSnapshot.isFetching, isFalse);

      unsubscribe();
      query.dispose();
    });

    test('fetchQuery returns cached data immediately when fresh', () async {
      final engine = QueryEngine();
      final queryKey = ['system', 'metrics'];
      var fetchCount = 0;

      final res1 = await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async {
          fetchCount++;
          return {'usage': 42};
        },
        staleTime: const Duration(seconds: 5),
      );

      expect(res1, {'usage': 42});
      expect(fetchCount, 1);

      // Second fetch within staleTime: should return cached data immediately
      final res2 = await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async {
          fetchCount++;
          return {'usage': 999};
        },
        staleTime: const Duration(seconds: 5),
      );

      expect(res2, {'usage': 42});
      expect(fetchCount, 1);
    });

    test('refetches when staleTime has elapsed', () async {
      final engine = QueryEngine();
      final queryKey = ['ticker', 'aapl'];
      var fetchCount = 0;

      final fetcher = () async {
        fetchCount++;
        return {'price': 150 + fetchCount};
      };

      final res1 = await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        fetcher,
        staleTime: const Duration(milliseconds: 20),
      );
      expect(res1, {'price': 151});
      expect(fetchCount, 1);

      // Wait for staleTime to expire
      await Future<void>.delayed(const Duration(milliseconds: 30));

      final res2 = await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        fetcher,
        staleTime: const Duration(milliseconds: 20),
      );
      expect(res2, {'price': 152});
      expect(fetchCount, 2);
    });
  });

  group('5. Tag Invalidation', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test(
        'invalidateByTag marks matching queries as stale and triggers revalidation',
        () async {
      final engine = QueryEngine(sqliteAdapter: adapter);

      var user1Calls = 0;
      var user2Calls = 0;
      var orderCalls = 0;

      final qUser1 = engine.watchQuery<Map<String, dynamic>>(
        ['user', 1],
        queryFn: () async {
          user1Calls++;
          return {'id': 1, 'name': 'Alice v$user1Calls'};
        },
        staleTime: const Duration(minutes: 1),
        tags: ['tag:user'],
      );

      final qUser2 = engine.watchQuery<Map<String, dynamic>>(
        ['user', 2],
        queryFn: () async {
          user2Calls++;
          return {'id': 2, 'name': 'Bob v$user2Calls'};
        },
        staleTime: const Duration(minutes: 1),
        tags: ['tag:user'],
      );

      final qOrder = engine.watchQuery<Map<String, dynamic>>(
        ['order', 99],
        queryFn: () async {
          orderCalls++;
          return {'orderId': 99, 'status': 'open'};
        },
        staleTime: const Duration(minutes: 1),
        tags: ['tag:order'],
      );

      await Future<void>.delayed(const Duration(milliseconds: 25));

      expect(qUser1.getSnapshot().data, {'id': 1, 'name': 'Alice v1'});
      expect(qUser2.getSnapshot().data, {'id': 2, 'name': 'Bob v1'});
      expect(qOrder.getSnapshot().data, {'orderId': 99, 'status': 'open'});
      expect(user1Calls, 1);
      expect(user2Calls, 1);
      expect(orderCalls, 1);

      // Invalidate by tag 'tag:user'
      final invalidated = await engine.invalidateByTag('tag:user');
      expect(invalidated.length, 2);

      // User queries revalidated to v2
      expect(user1Calls, 2);
      expect(user2Calls, 2);
      expect(qUser1.getSnapshot().data, {'id': 1, 'name': 'Alice v2'});
      expect(qUser2.getSnapshot().data, {'id': 2, 'name': 'Bob v2'});

      // Order query was untouched
      expect(orderCalls, 1);
      expect(qOrder.getSnapshot().data, {'orderId': 99, 'status': 'open'});

      qUser1.dispose();
      qUser2.dispose();
      qOrder.dispose();
    });

    test(
        'invalidateQueries invalidates by prefix and revalidates active queries',
        () async {
      final engine = QueryEngine(sqliteAdapter: adapter);

      var listCalls = 0;
      var detailCalls = 0;
      var configCalls = 0;

      final qList = engine.watchQuery<List<dynamic>>(
        ['items', 'list'],
        queryFn: () async {
          listCalls++;
          return listCalls == 1 ? ['a', 'b'] : ['a', 'b', 'c'];
        },
        staleTime: const Duration(minutes: 1),
      );

      final qDetail = engine.watchQuery<Map<String, dynamic>>(
        ['items', 'detail', 'a'],
        queryFn: () async {
          detailCalls++;
          return detailCalls == 1 ? {'id': 'a'} : {'id': 'a', 'updated': true};
        },
        staleTime: const Duration(minutes: 1),
      );

      final qConfig = engine.watchQuery<Map<String, dynamic>>(
        ['config', 'app'],
        queryFn: () async {
          configCalls++;
          return {'theme': 'dark'};
        },
        staleTime: const Duration(minutes: 1),
      );

      await Future<void>.delayed(const Duration(milliseconds: 25));

      expect(listCalls, 1);
      expect(detailCalls, 1);
      expect(configCalls, 1);

      // Invalidate all queries starting with ['items']
      await engine.invalidateQueries(['items']);

      expect(listCalls, 2);
      expect(detailCalls, 2);
      expect(qList.getSnapshot().data, ['a', 'b', 'c']);
      expect(qDetail.getSnapshot().data, {'id': 'a', 'updated': true});

      // Config was not invalidated
      expect(configCalls, 1);

      qList.dispose();
      qDetail.dispose();
      qConfig.dispose();
    });
  });

  group('6. Query Deduplication, Cancellation & Error Handling', () {
    test(
        'deduplicates simultaneous in-flight fetchQuery requests for the same key',
        () async {
      final engine = QueryEngine();
      final queryKey = ['dedup', 1];

      var fetchCount = 0;
      final fetcher = () async {
        fetchCount++;
        await Future<void>.delayed(const Duration(milliseconds: 30));
        return {'count': fetchCount};
      };

      final results = await Future.wait([
        engine.fetchQuery(queryKey, fetcher),
        engine.fetchQuery(queryKey, fetcher),
        engine.fetchQuery(queryKey, fetcher),
      ]);

      expect(fetchCount, 1);
      expect(results[0], {'count': 1});
      expect(results[1], {'count': 1});
      expect(results[2], {'count': 1});
    });

    test('captures errors, sets status to error, and notifies subscribers',
        () async {
      final engine = QueryEngine();
      final queryKey = ['failing', 'query'];

      final query = engine.watchQuery<dynamic>(
        queryKey,
        queryFn: () async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          throw Exception('Network offline');
        },
      );

      var errorNotified = false;
      final unsubscribe = query.subscribe(() {
        errorNotified = true;
      });

      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(errorNotified, isTrue);
      final snapshot = query.getSnapshot();
      expect(snapshot.status, QueryStatus.error);
      expect(snapshot.error.toString(), contains('Network offline'));
      expect(snapshot.isFetching, isFalse);

      unsubscribe();
      query.dispose();
    });

    test('cancelQuery stops in-flight fetch and resets isFetching', () async {
      final engine = QueryEngine();
      final queryKey = ['cancellable', 1];

      var finished = false;
      final query = engine.watchQuery<String>(
        queryKey,
        queryFn: () async {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          finished = true;
          return 'result';
        },
      );

      expect(query.getSnapshot().isFetching, isTrue);

      // Cancel immediately
      engine.cancelQuery(queryKey);

      expect(query.getSnapshot().isFetching, isFalse);

      await Future<void>.delayed(const Duration(milliseconds: 70));

      expect(finished, isTrue);
      // After wait, data was not written to query state because query was cancelled
      expect(query.getSnapshot().data, isNull);

      query.dispose();
    });

    test(
        'setQueryData updates cache and notifies subscribers only on actual change',
        () async {
      final engine = QueryEngine();
      final queryKey = ['manual', 'data'];

      var notificationCount = 0;
      final unsubscribe = engine.subscribe(queryKey, () {
        notificationCount++;
      });

      engine.setQueryData(queryKey, {'count': 1});
      expect(notificationCount, 1);
      expect(engine.getQueryData(queryKey), {'count': 1});

      // Same payload -> structural sharing returns old reference -> 0 notifications
      engine.setQueryData(queryKey, {'count': 1});
      expect(notificationCount, 1);

      // Different payload -> notifications incremented
      engine.setQueryData(queryKey, {'count': 2});
      expect(notificationCount, 2);
      expect(engine.getQueryData(queryKey), {'count': 2});

      unsubscribe();
    });
  });
}
