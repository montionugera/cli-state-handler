import 'dart:io';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('SqliteAdapter Schema & Lifecycle', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test('creates required UCSA tables and indexes on initialization', () {
      final rows = adapter.db.select(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
      );
      final tableNames = rows.map((r) => r['name'] as String).toSet();

      expect(tableNames, contains('ucsa_query_cache'));
      expect(tableNames, contains('ucsa_cache_tags'));
      expect(tableNames, contains('ucsa_mutation_outbox'));
      expect(tableNames, contains('ucsa_cas_objects'));
    });

    test('reentrant transactions work without throwing', () {
      expect(() {
        adapter.transaction(() {
          adapter.transaction(() {
            adapter.upsertCasObject('hash1', 100);
          });
        });
      }, returnsNormally);

      final cas = adapter.getCasObject('hash1');
      expect(cas?['size'], 100);
    });

    test('transaction rollback on failure restores previous state', () {
      expect(() {
        adapter.transaction(() {
          adapter.upsertCasObject('rollback_test', 500);
          throw Exception('Forced abort');
        });
      }, throwsException);

      expect(adapter.getCasObject('rollback_test'), isNull);
    });
  });

  group('SqliteAdapter Query Cache CRUD', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test('setQuery persists and getQuery retrieves exact entry', () {
      final key = [
        'users',
        {'id': 'u-42'}
      ];
      final hash = hashQueryKey(key);
      final entry = CacheEntry<Map<String, dynamic>>(
        queryHash: hash,
        queryKey: key,
        dataPayload: {'id': 'u-42', 'name': 'Bob', 'role': 'engineer'},
        etag: 'w/112233',
        createdAt: 1000,
        staleAt: 1500,
        expiresAt: 2000,
      );

      adapter.setQuery(entry);

      final retrieved = adapter.getQuery<Map<String, dynamic>>(hash);
      expect(retrieved, isNotNull);
      expect(retrieved!.queryHash, hash);
      expect(retrieved.queryKey, equals(key));
      expect(retrieved.dataPayload,
          equals({'id': 'u-42', 'name': 'Bob', 'role': 'engineer'}));
      expect(retrieved.etag, 'w/112233');
      expect(retrieved.createdAt, 1000);
      expect(retrieved.staleAt, 1500);
      expect(retrieved.expiresAt, 2000);
    });

    test('setQuery updates existing entry (upsert)', () {
      final hash = 'q-update';
      final entry1 = CacheEntry<String>(
        queryHash: hash,
        queryKey: const ['greeting'],
        dataPayload: 'hello',
        createdAt: 10,
        staleAt: 20,
        expiresAt: 30,
      );
      adapter.setQuery(entry1);

      final entry2 = CacheEntry<String>(
        queryHash: hash,
        queryKey: const ['greeting'],
        dataPayload: 'world',
        etag: 'w/new',
        createdAt: 15,
        staleAt: 25,
        expiresAt: 35,
      );
      adapter.setQuery(entry2);

      final updated = adapter.getQuery<String>(hash);
      expect(updated, isNotNull);
      expect(updated!.dataPayload, 'world');
      expect(updated.etag, 'w/new');
      expect(updated.createdAt, 15);
      expect(updated.staleAt, 25);
      expect(updated.expiresAt, 35);
    });

    test('deleteQuery removes entry from cache', () {
      final hash = 'q-del';
      adapter.setQuery(CacheEntry<int>(
        queryHash: hash,
        queryKey: const ['count'],
        dataPayload: 99,
        createdAt: 1,
        staleAt: 2,
        expiresAt: 3,
      ));

      expect(adapter.getQuery<int>(hash), isNotNull);
      adapter.deleteQuery(hash);
      expect(adapter.getQuery<int>(hash), isNull);
    });

    test('getExpiredQueries returns items past cutoff timestamp', () {
      adapter.setQuery(CacheEntry<String>(
        queryHash: 'q-expired',
        queryKey: const ['old'],
        dataPayload: 'old',
        createdAt: 100,
        staleAt: 150,
        expiresAt: 200,
      ));
      adapter.setQuery(CacheEntry<String>(
        queryHash: 'q-valid',
        queryKey: const ['fresh'],
        dataPayload: 'fresh',
        createdAt: 200,
        staleAt: 250,
        expiresAt: 400,
      ));

      final expired = adapter.getExpiredQueries(now: 250);
      expect(expired.length, 1);
      expect(expired.first.queryHash, 'q-expired');
    });
  });

  group('SqliteAdapter Tag Invalidation & Cascade Deletion', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test('setQuery associates tags and getQueryHashesByTag locates them', () {
      final q1 = CacheEntry<String>(
        queryHash: 'q1',
        queryKey: const ['item', 1],
        dataPayload: 'one',
        createdAt: 1,
        staleAt: 2,
        expiresAt: 3,
      );
      final q2 = CacheEntry<String>(
        queryHash: 'q2',
        queryKey: const ['item', 2],
        dataPayload: 'two',
        createdAt: 1,
        staleAt: 2,
        expiresAt: 3,
      );

      adapter.setQuery(q1, tags: ['items', 'collection-A']);
      adapter.setQuery(q2, tags: ['items', 'collection-B']);

      expect(
          adapter.getQueryHashesByTag('items'), unorderedEquals(['q1', 'q2']));
      expect(adapter.getQueryHashesByTag('collection-A'), equals(['q1']));
      expect(adapter.getQueryHashesByTag('collection-B'), equals(['q2']));
      expect(adapter.getTagsForQuery('q1'),
          unorderedEquals(['items', 'collection-A']));
    });

    test(
        'invalidateByTag deletes all matching queries and returns affected hashes',
        () {
      adapter.setQuery(
        CacheEntry<String>(
          queryHash: 'q1',
          queryKey: const [1],
          dataPayload: 'a',
          createdAt: 1,
          staleAt: 2,
          expiresAt: 3,
        ),
        tags: ['shared-tag'],
      );
      adapter.setQuery(
        CacheEntry<String>(
          queryHash: 'q2',
          queryKey: const [2],
          dataPayload: 'b',
          createdAt: 1,
          staleAt: 2,
          expiresAt: 3,
        ),
        tags: ['shared-tag'],
      );
      adapter.setQuery(
        CacheEntry<String>(
          queryHash: 'q3',
          queryKey: const [3],
          dataPayload: 'c',
          createdAt: 1,
          staleAt: 2,
          expiresAt: 3,
        ),
        tags: ['other-tag'],
      );

      final invalidated = adapter.invalidateByTag('shared-tag');
      expect(invalidated, unorderedEquals(['q1', 'q2']));

      expect(adapter.getQuery<String>('q1'), isNull);
      expect(adapter.getQuery<String>('q2'), isNull);
      expect(adapter.getQuery<String>('q3'), isNotNull);
      expect(adapter.getQueryHashesByTag('shared-tag'), isEmpty);
    });

    test(
        'foreign key cascade delete removes tags when query is deleted directly',
        () {
      adapter.setQuery(
        CacheEntry<String>(
          queryHash: 'q-cascade',
          queryKey: const ['cascade'],
          dataPayload: 'val',
          createdAt: 1,
          staleAt: 2,
          expiresAt: 3,
        ),
        tags: ['tag-x', 'tag-y'],
      );

      expect(adapter.getTagsForQuery('q-cascade'),
          unorderedEquals(['tag-x', 'tag-y']));

      // Direct deletion of query cache entry
      adapter.deleteQuery('q-cascade');

      // Tag table rows must be cascaded and deleted automatically
      expect(adapter.getTagsForQuery('q-cascade'), isEmpty);
      expect(adapter.getQueryHashesByTag('tag-x'), isEmpty);
    });

    test('re-setting query with updated tags replaces old tags', () {
      final entry = CacheEntry<String>(
        queryHash: 'q-swap',
        queryKey: const ['swap'],
        dataPayload: 'v',
        createdAt: 1,
        staleAt: 2,
        expiresAt: 3,
      );

      adapter.setQuery(entry, tags: ['tag1', 'tag2']);
      expect(
          adapter.getTagsForQuery('q-swap'), unorderedEquals(['tag1', 'tag2']));

      adapter.setQuery(entry, tags: ['tag3']);
      expect(adapter.getTagsForQuery('q-swap'), equals(['tag3']));
      expect(adapter.getQueryHashesByTag('tag1'), isEmpty);
    });
  });

  group('SqliteAdapter Outbox Mutation Storage', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test('setMutation, getMutation, and getPendingMutations work correctly',
        () {
      final mutation1 = OutboxMutation<Map<String, dynamic>>(
        mutationId: 'mut-1',
        endpoint: '/todos',
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        payload: {'title': 'Buy milk'},
        status: OutboxMutationStatus.pending,
        retryCount: 0,
        createdAt: 100,
        conflictPolicy: ConflictPolicy.clientWins,
      );
      final mutation2 = OutboxMutation<Map<String, dynamic>>(
        mutationId: 'mut-2',
        endpoint: '/todos/1',
        method: 'PUT',
        payload: {'title': 'Buy oat milk'},
        status: OutboxMutationStatus.pending,
        retryCount: 1,
        createdAt: 200,
      );

      adapter.setMutation(mutation1);
      adapter.setMutation(mutation2);

      final retrieved = adapter.getMutation<Map<String, dynamic>>('mut-1');
      expect(retrieved, isNotNull);
      expect(retrieved!.mutationId, 'mut-1');
      expect(retrieved.endpoint, '/todos');
      expect(retrieved.method, 'POST');
      expect(retrieved.headers, {'Content-Type': 'application/json'});
      expect(retrieved.payload, {'title': 'Buy milk'});
      expect(retrieved.conflictPolicy, ConflictPolicy.clientWins);

      final pending = adapter.getPendingMutations();
      expect(pending.length, 2);
      expect(pending[0].mutationId, 'mut-1');
      expect(pending[1].mutationId, 'mut-2');
    });

    test('updateMutationStatus changes status, retry count, and error metadata',
        () {
      final mutation = OutboxMutation<String>(
        mutationId: 'mut-update',
        endpoint: '/submit',
        method: 'POST',
        payload: 'test',
        status: OutboxMutationStatus.pending,
        createdAt: 100,
      );
      adapter.setMutation(mutation);

      adapter.updateMutationStatus(
        'mut-update',
        OutboxMutationStatus.inFlight,
        lastAttemptAt: 150,
      );
      var current = adapter.getMutation<String>('mut-update');
      expect(current!.status, OutboxMutationStatus.inFlight);
      expect(current.lastAttemptAt, 150);

      adapter.updateMutationStatus(
        'mut-update',
        OutboxMutationStatus.failed,
        lastAttemptAt: 200,
        error: '503 Service Unavailable',
        retryCount: 1,
      );
      current = adapter.getMutation<String>('mut-update');
      expect(current!.status, OutboxMutationStatus.failed);
      expect(current.error, '503 Service Unavailable');
      expect(current.retryCount, 1);
    });

    test('deleteMutation removes the record', () {
      final mutation = OutboxMutation<void>(
        mutationId: 'mut-del',
        endpoint: '/del',
        method: 'DELETE',
        createdAt: 100,
      );
      adapter.setMutation(mutation);
      expect(adapter.getMutation('mut-del'), isNotNull);

      adapter.deleteMutation('mut-del');
      expect(adapter.getMutation('mut-del'), isNull);
    });
  });

  group('SqliteAdapter CAS Metadata & LRU Management', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() {
      adapter.close();
    });

    test('upsertCasObject and getTotalCasSize calculate cumulative storage',
        () {
      adapter.upsertCasObject('hash-a', 1024, lastAccessedAt: 100);
      adapter.upsertCasObject('hash-b', 2048, lastAccessedAt: 200);

      expect(adapter.getTotalCasSize(), 3072);
      final objA = adapter.getCasObject('hash-a');
      expect(objA?['size'], 1024);
      expect(objA?['last_accessed_at'], 100);
    });

    test('getLruCasObjects returns records sorted by access time ascending',
        () {
      adapter.upsertCasObject('first', 10, lastAccessedAt: 100);
      adapter.upsertCasObject('third', 30, lastAccessedAt: 300);
      adapter.upsertCasObject('second', 20, lastAccessedAt: 200);

      final lru = adapter.getLruCasObjects();
      expect(lru.map((o) => o['hash']), equals(['first', 'second', 'third']));

      final limited = adapter.getLruCasObjects(limit: 2);
      expect(limited.map((o) => o['hash']), equals(['first', 'second']));
    });

    test('updateCasAccessTime touches timestamp and updates LRU order', () {
      adapter.upsertCasObject('first', 10, lastAccessedAt: 100);
      adapter.upsertCasObject('second', 20, lastAccessedAt: 200);

      adapter.updateCasAccessTime('first', lastAccessedAt: 500);

      final lru = adapter.getLruCasObjects();
      expect(lru.map((o) => o['hash']), equals(['second', 'first']));
    });

    test('deleteCasObject removes record and decreases total size', () {
      adapter.upsertCasObject('to-del', 500);
      adapter.upsertCasObject('keep', 300);
      expect(adapter.getTotalCasSize(), 800);

      final deleted = adapter.deleteCasObject('to-del');
      expect(deleted, isTrue);
      expect(adapter.getTotalCasSize(), 300);
      expect(adapter.getCasObject('to-del'), isNull);
    });
  });

  group('SqliteAdapter File Persistence & WAL Checkpointing', () {
    test('file-backed database persists entries and handles checkpointing', () {
      final tempDir = Directory.systemTemp.createTempSync('ucsa_test_');
      final dbPath = '${tempDir.path}/test_cache.db';

      try {
        final adapter1 = SqliteAdapter.file(dbPath);
        adapter1.setQuery(
          CacheEntry<String>(
            queryHash: 'persisted-query',
            queryKey: const ['persistent'],
            dataPayload: 'persisted-payload',
            createdAt: 100,
            staleAt: 200,
            expiresAt: 300,
          ),
          tags: ['file-tag'],
        );
        adapter1.checkpoint('TRUNCATE');
        adapter1.close();

        // Reopen with new adapter instance pointing to same file
        final adapter2 = SqliteAdapter.file(dbPath);
        final entry = adapter2.getQuery<String>('persisted-query');
        expect(entry, isNotNull);
        expect(entry!.dataPayload, 'persisted-payload');
        expect(adapter2.getQueryHashesByTag('file-tag'),
            equals(['persisted-query']));
        adapter2.close();
      } finally {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      }
    });
  });
}
