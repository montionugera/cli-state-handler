import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('CasStore Core & Atomic Operations', () {
    late Directory tempDir;
    late SqliteAdapter adapter;
    late CasStore store;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('ucsa_cas_test_');
      adapter = SqliteAdapter.inMemory();
      store = CasStore(
        baseDir: tempDir.path,
        sqliteAdapter: adapter,
      );
      await store.init();
    });

    tearDown(() async {
      adapter.close();
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    });

    test('initializes objects and tmp directories', () async {
      expect(await Directory(store.objectsDir).exists(), isTrue);
      expect(await Directory(store.tmpDir).exists(), isTrue);
    });

    test('writes data atomically and returns valid CasPutResult', () async {
      final payload = utf8.encode('Hello UCSA CAS');
      final expectedHash = sha256.convert(payload).toString();

      final result = await store.put(payload);

      expect(result.hash, expectedHash);
      expect(result.size, payload.length);
      expect(result.path, store.getPath(expectedHash));
      expect(await File(result.path).exists(), isTrue);

      // Verify temp dir is clean (no leftover .tmp files)
      final tmpFiles = Directory(store.tmpDir).listSync();
      expect(tmpFiles, isEmpty);

      // Read back via get
      final retrieved = await store.get(expectedHash);
      expect(retrieved, isNotNull);
      expect(utf8.decode(retrieved!), 'Hello UCSA CAS');
    });

    test('verifies SHA-256 integrity when expectedHash matches', () async {
      final payload = utf8.encode('checksum-payload');
      final expectedHash = sha256.convert(payload).toString();

      final result = await store.put(payload, expectedHash: expectedHash);
      expect(result.hash, expectedHash);
      expect(await store.has(expectedHash), isTrue);
    });

    test(
        'throws IntegrityException and cleans up temp file when expectedHash mismatches',
        () async {
      final payload = utf8.encode('corrupted data');
      final wrongHash =
          '0000000000000000000000000000000000000000000000000000000000000000';

      expect(
        () => store.put(payload, expectedHash: wrongHash),
        throwsA(isA<IntegrityException>().having(
          (e) => e.expected,
          'expected',
          wrongHash,
        )),
      );

      // No leftover tmp files
      final tmpFiles = Directory(store.tmpDir).listSync();
      expect(tmpFiles, isEmpty);

      // Object was never promoted
      final actualHash = sha256.convert(payload).toString();
      expect(await store.has(actualHash), isFalse);
    });

    test('has and get return correct existence and content', () async {
      final payload = utf8.encode('probe existence');
      final hash = sha256.convert(payload).toString();

      expect(await store.has(hash), isFalse);
      expect(await store.get(hash), isNull);

      await store.put(payload);

      expect(await store.has(hash), isTrue);
      final bytes = await store.get(hash);
      expect(bytes, equals(payload));
    });

    test('delete removes object from both disk and SQLite', () async {
      final payload = utf8.encode('to-be-deleted');
      final result = await store.put(payload);

      expect(await store.has(result.hash), isTrue);
      expect(adapter.getCasObject(result.hash), isNotNull);

      final deleted = await store.delete(result.hash);
      expect(deleted, isTrue);

      expect(await store.has(result.hash), isFalse);
      expect(await store.get(result.hash), isNull);
      expect(adapter.getCasObject(result.hash), isNull);

      // Second delete returns false
      expect(await store.delete(result.hash), isFalse);
    });

    test('get touches access timestamp in SQLite', () async {
      final payload = utf8.encode('touch-test');
      final result = await store.put(payload);

      final initialMeta = adapter.getCasObject(result.hash);
      final initialAccess = initialMeta?['last_accessed_at'] as int;

      // Small delay to ensure timestamp progression
      await Future<void>.delayed(const Duration(milliseconds: 10));

      final readBytes = await store.get(result.hash);
      expect(readBytes, isNotNull);

      final updatedMeta = adapter.getCasObject(result.hash);
      final updatedAccess = updatedMeta?['last_accessed_at'] as int;

      expect(updatedAccess, greaterThanOrEqualTo(initialAccess));
    });

    test('getTotalSize returns total bytes tracked in SQLite', () async {
      expect(await store.getTotalSize(), 0);

      await store.put(List.filled(50, 1));
      expect(await store.getTotalSize(), 50);

      await store.put(List.filled(75, 2));
      expect(await store.getTotalSize(), 125);
    });
  });

  group('CasStore Quota & LRU Pruning', () {
    late Directory tempDir;
    late SqliteAdapter adapter;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('ucsa_cas_prune_');
      adapter = SqliteAdapter.inMemory();
    });

    tearDown(() async {
      adapter.close();
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    });

    test(
        'auto-prunes least recently accessed objects when maxSizeBytes exceeded',
        () async {
      // 300 bytes quota, target ratio = 0.7 -> targets 210 bytes on breach
      final store = CasStore(
        baseDir: tempDir.path,
        sqliteAdapter: adapter,
        maxSizeBytes: 300,
      );
      await store.init();

      // Put obj1 (100 bytes), obj2 (100 bytes), obj3 (100 bytes) = 300 bytes (within quota)
      final p1 = await store.put(List.filled(100, 1));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      final p2 = await store.put(List.filled(100, 2));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      final p3 = await store.put(List.filled(100, 3));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(await store.getTotalSize(), 300);
      expect(await store.has(p1.hash), isTrue);
      expect(await store.has(p2.hash), isTrue);
      expect(await store.has(p3.hash), isTrue);

      // Touch p1 so p2 becomes the oldest unaccessed!
      await store.get(p1.hash);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // Put p4 (100 bytes) -> total would be 400 bytes > 300 bytes max!
      // Prune should reduce below target 210 bytes (evicts p2, then p3)
      final p4 = await store.put(List.filled(100, 4));

      // p2 was oldest, so it was evicted
      expect(await store.has(p2.hash), isFalse);
      expect(adapter.getCasObject(p2.hash), isNull);

      // p1 was touched, so it was preserved
      expect(await store.has(p1.hash), isTrue);
      // p4 was just added, so it exists
      expect(await store.has(p4.hash), isTrue);

      // Total size is within target limit (<= 210 bytes)
      final totalSize = await store.getTotalSize();
      expect(totalSize, lessThanOrEqualTo(210));
    });

    test('manual prune with targetRatio deletes oldest entries', () async {
      final store = CasStore(
        baseDir: tempDir.path,
        sqliteAdapter: adapter,
        maxSizeBytes: 400,
      );
      await store.init();

      final p1 = await store.put(List.filled(100, 10));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      final p2 = await store.put(List.filled(100, 20));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      final p3 = await store.put(List.filled(100, 30));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(await store.getTotalSize(), 300);

      // Explicitly prune down to 50% of 400 = 200 bytes
      // Needs to free 100 bytes -> 1 object (p1)
      final pruneResult = await store.prune(targetRatio: 0.5);
      expect(pruneResult.prunedCount, 1);
      expect(pruneResult.bytesFreed, 100);

      expect(await store.has(p1.hash), isFalse);
      expect(await store.has(p2.hash), isTrue);
      expect(await store.has(p3.hash), isTrue);
      expect(await store.getTotalSize(), 200);
    });

    test('prune returns zero when within quota', () async {
      final store = CasStore(
        baseDir: tempDir.path,
        sqliteAdapter: adapter,
        maxSizeBytes: 1000,
      );
      await store.init();

      await store.put(List.filled(100, 1));
      final result = await store.prune();

      expect(result.prunedCount, 0);
      expect(result.bytesFreed, 0);
    });
  });
}
