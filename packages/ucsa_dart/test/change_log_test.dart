import 'dart:io';
import 'package:test/test.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  late Directory tempDir;
  late String dbPath;
  late SqliteAdapter adapter;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('ucsa_dart_change_log_test_');
    dbPath = '${tempDir.path}/test.db';
    adapter = SqliteAdapter.file(dbPath, origin: 'test-process-1');
  });

  tearDown(() {
    adapter.close();
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  test('initializes with custom or default origin', () {
    expect(adapter.origin, equals('test-process-1'));

    final defaultAdapter = SqliteAdapter.inMemory();
    expect(defaultAdapter.origin, isNotEmpty);
    expect(defaultAdapter.origin.length, greaterThan(0));
    defaultAdapter.close();
  });

  test('appendChangeLog inserts rows and serializes json payloads', () {
    final seq1 = adapter.appendChangeLog(
      ChangeLogKind.mutation,
      detail: {'mutationId': 'mut-1', 'entity': 'order'},
    );
    expect(seq1, equals(1));

    final seq2 = adapter.appendChangeLog(
      ChangeLogKind.stream,
      origin: 'custom-emitter',
      tags: ['tag:stream'],
      queryHashes: ['q-stream'],
      detail: {'chunk': 1},
    );
    expect(seq2, equals(2));

    final result = adapter.readChangesSince(0);
    expect(result.headSeq, equals(2));
    expect(result.truncated, isFalse);
    expect(result.rows.length, equals(2));

    final r1 = result.rows[0];
    expect(r1.seq, equals(1));
    expect(r1.origin, equals('test-process-1'));
    expect(r1.kind, equals(ChangeLogKind.mutation));
    expect(r1.tags, isNull);
    expect(r1.queryHashes, isNull);
    expect(r1.detail, equals({'mutationId': 'mut-1', 'entity': 'order'}));
    expect(r1.createdAt, greaterThan(0));

    final r2 = result.rows[1];
    expect(r2.seq, equals(2));
    expect(r2.origin, equals('custom-emitter'));
    expect(r2.kind, equals(ChangeLogKind.stream));
    expect(r2.tags, equals(['tag:stream']));
    expect(r2.queryHashes, equals(['q-stream']));
    expect(r2.detail, equals({'chunk': 1}));
  });

  test('deleteQuery deletes cache entry and inserts an invalidate log with queryHashes', () {
    adapter.setQuery(
      CacheEntry<Map<String, dynamic>>(
        queryHash: 'q-delete-1',
        queryKey: ['items', 1],
        dataPayload: {'id': 1, 'name': 'Item 1'},
        createdAt: 1000,
        staleAt: 2000,
        expiresAt: 3000,
      ),
    );

    final deleted = adapter.deleteQuery('q-delete-1');
    expect(deleted, isTrue);
    expect(adapter.getQuery<dynamic>('q-delete-1'), isNull);

    final changes = adapter.readChangesSince(0);
    expect(changes.rows.length, equals(1));
    final row = changes.rows.first;
    expect(row.seq, equals(1));
    expect(row.origin, equals('test-process-1'));
    expect(row.kind, equals(ChangeLogKind.invalidate));
    expect(row.tags, isNull);
    expect(row.queryHashes, equals(['q-delete-1']));
    expect(row.detail, isNull);

    // Deleting non-existent query returns false and does not append to log
    final deletedAgain = adapter.deleteQuery('q-delete-1');
    expect(deletedAgain, isFalse);
    expect(adapter.readChangesSince(0).rows.length, equals(1));
  });

  test('deleteQuery allows custom origin override', () {
    adapter.setQuery(
      CacheEntry<Map<String, dynamic>>(
        queryHash: 'q-custom-origin',
        queryKey: ['custom'],
        dataPayload: {'ok': true},
        createdAt: 1000,
        staleAt: 2000,
        expiresAt: 3000,
      ),
    );

    final deleted = adapter.deleteQuery('q-custom-origin', origin: 'remote-worker');
    expect(deleted, isTrue);

    final changes = adapter.readChangesSince(0);
    expect(changes.rows.length, equals(1));
    expect(changes.rows.first.origin, equals('remote-worker'));
  });

  test('invalidateByTag deletes cache entries and inserts invalidate log with tag and queryHashes in one transaction', () {
    adapter.setQuery(
      CacheEntry<Map<String, dynamic>>(
        queryHash: 'q-tag-1',
        queryKey: ['products', 1],
        dataPayload: {'id': 1},
        createdAt: 1000,
        staleAt: 2000,
        expiresAt: 3000,
      ),
      tags: ['category:electronics'],
    );

    adapter.setQuery(
      CacheEntry<Map<String, dynamic>>(
        queryHash: 'q-tag-2',
        queryKey: ['products', 2],
        dataPayload: {'id': 2},
        createdAt: 1000,
        staleAt: 2000,
        expiresAt: 3000,
      ),
      tags: ['category:electronics'],
    );

    final invalidated = adapter.invalidateByTag('category:electronics');
    expect(invalidated..sort(), equals(['q-tag-1', 'q-tag-2']..sort()));
    expect(adapter.getQuery<dynamic>('q-tag-1'), isNull);
    expect(adapter.getQuery<dynamic>('q-tag-2'), isNull);

    final changes = adapter.readChangesSince(0);
    expect(changes.rows.length, equals(1));
    final r1 = changes.rows.first;
    expect(r1.seq, equals(1));
    expect(r1.origin, equals('test-process-1'));
    expect(r1.kind, equals(ChangeLogKind.invalidate));
    expect(r1.tags, equals(['category:electronics']));
    expect(r1.queryHashes?..sort(), equals(['q-tag-1', 'q-tag-2']..sort()));
    expect(r1.detail, isNull);

    // Invalidation on empty tag still logs invalidation event for cross-process catch-up
    final emptyInvalidated = adapter.invalidateByTag('category:books', origin: 'proc-books');
    expect(emptyInvalidated, isEmpty);
    final updatedChanges = adapter.readChangesSince(1);
    expect(updatedChanges.rows.length, equals(1));
    final r2 = updatedChanges.rows.first;
    expect(r2.seq, equals(2));
    expect(r2.origin, equals('proc-books'));
    expect(r2.kind, equals(ChangeLogKind.invalidate));
    expect(r2.tags, equals(['category:books']));
    expect(r2.queryHashes, isEmpty);
  });

  test('enforces atomic rollback: if an error occurs during invalidation or log insert, both are rolled back', () {
    adapter.setQuery(
      CacheEntry<Map<String, dynamic>>(
        queryHash: 'q-rollback-1',
        queryKey: ['rollback'],
        dataPayload: {'safe': true},
        createdAt: 1000,
        staleAt: 2000,
        expiresAt: 3000,
      ),
      tags: ['safe-tag'],
    );

    // Install trigger to simulate failure during change log insertion
    adapter.db.execute('''
      CREATE TRIGGER fail_change_log_insert
      BEFORE INSERT ON ucsa_change_log
      WHEN NEW.kind = 'invalidate'
      BEGIN
        SELECT RAISE(FAIL, 'Simulated change log failure');
      END;
    ''');

    expect(
      () => adapter.invalidateByTag('safe-tag'),
      throwsA(isA<SqliteException>()),
    );

    // Cache entry remains intact due to transaction rollback
    expect(adapter.getQuery<dynamic>('q-rollback-1'), isNotNull);
    expect(adapter.getQueryHashesByTag('safe-tag'), equals(['q-rollback-1']));

    // Change log has 0 entries
    final changes = adapter.readChangesSince(0);
    expect(changes.rows, isEmpty);
  });

  test('readChangesSince respects lastSeq and limit', () {
    for (var i = 1; i <= 5; i++) {
      adapter.appendChangeLog(
        ChangeLogKind.mutation,
        detail: {'i': i},
      );
    }

    final page1 = adapter.readChangesSince(0, limit: 2);
    expect(page1.rows.length, equals(2));
    expect(page1.rows.map((r) => r.seq).toList(), equals([1, 2]));
    expect(page1.headSeq, equals(5));
    expect(page1.truncated, isFalse);

    final page2 = adapter.readChangesSince(2, limit: 2);
    expect(page2.rows.length, equals(2));
    expect(page2.rows.map((r) => r.seq).toList(), equals([3, 4]));
    expect(page2.headSeq, equals(5));

    final page3 = adapter.readChangesSince(4, limit: 2);
    expect(page3.rows.length, equals(1));
    expect(page3.rows.map((r) => r.seq).toList(), equals([5]));
    expect(page3.headSeq, equals(5));

    final empty = adapter.readChangesSince(5, limit: 2);
    expect(empty.rows, isEmpty);
    expect(empty.headSeq, equals(5));
  });

  test('detects log gap and returns truncated true when lastSeq has been pruned', () {
    for (var i = 1; i <= 10; i++) {
      adapter.appendChangeLog(
        ChangeLogKind.stream,
        detail: {'i': i},
      );
    }

    // Manually delete rows 1..5 to simulate pruning gap
    adapter.db.execute('DELETE FROM ucsa_change_log WHERE seq <= 5;');

    // Reading from 0 (pruned sequence)
    final fromZero = adapter.readChangesSince(0);
    expect(fromZero.truncated, isFalse); // lastSeq == 0 means full read, not truncated
    expect(fromZero.rows.map((r) => r.seq).toList(), equals([6, 7, 8, 9, 10]));

    // Reading from lastSeq = 3 (< minSeq - 1, minSeq = 6, 3 < 5)
    final gapResult = adapter.readChangesSince(3);
    expect(gapResult.truncated, isTrue);
    expect(gapResult.rows.map((r) => r.seq).toList(), equals([6, 7, 8, 9, 10]));
    expect(gapResult.headSeq, equals(10));

    // Reading from lastSeq = 5 (adjacent to minSeq 6, 5 >= 6 - 1)
    final adjacentResult = adapter.readChangesSince(5);
    expect(adjacentResult.truncated, isFalse);
    expect(adjacentResult.rows.map((r) => r.seq).toList(), equals([6, 7, 8, 9, 10]));
  });

  test('pruneChangeLog prunes entries older than retention window and enforces maxRows ceiling', () {
    final now = DateTime.now().millisecondsSinceEpoch;

    // Insert 5 old entries
    for (var i = 1; i <= 5; i++) {
      adapter.db.execute(
        '''
        INSERT INTO ucsa_change_log (origin, kind, created_at)
        VALUES ('old-emitter', 'mutation', ?);
        ''',
        [now - 100000],
      );
    }

    // Insert 5 fresh entries
    for (var i = 1; i <= 5; i++) {
      adapter.db.execute(
        '''
        INSERT INTO ucsa_change_log (origin, kind, created_at)
        VALUES ('fresh-emitter', 'mutation', ?);
        ''',
        [now],
      );
    }

    expect(adapter.readChangesSince(0).rows.length, equals(10));

    // Prune entries older than 50 seconds (should prune the 5 old entries)
    final pruneRes1 = adapter.pruneChangeLog(retentionMs: 50000, maxRows: 100);
    expect(pruneRes1, equals(5));

    final remaining = adapter.readChangesSince(0);
    expect(remaining.rows.length, equals(5));
    expect(remaining.rows.every((r) => r.origin == 'fresh-emitter'), isTrue);

    // Prune with maxRows = 2 (retains newest 2 rows out of 5)
    final pruneRes2 = adapter.pruneChangeLog(retentionMs: 1000000, maxRows: 2);
    expect(pruneRes2, equals(3));

    final finalRemaining = adapter.readChangesSince(0);
    expect(finalRemaining.rows.length, equals(2));
    expect(finalRemaining.rows.map((r) => r.seq).toList(), equals([9, 10]));
  });
}
