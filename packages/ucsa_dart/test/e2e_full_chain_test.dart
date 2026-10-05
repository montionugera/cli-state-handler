import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('Full-Chain End-to-End Integration (UCSA Dart)', () {
    late Directory tempDir;
    late String dbPath;
    late String walPath;
    late String casPath;
    late SqliteAdapter sqlite;
    late CasStore cas;
    late QueryEngine engine;

    setUp(() async {
      tempDir = await Directory.systemTemp.createTemp('ucsa_dart_e2e_');
      dbPath = '${tempDir.path}/state.db';
      walPath = '$dbPath-wal';
      casPath = '${tempDir.path}/cas';

      sqlite = SqliteAdapter.file(dbPath);
      cas = CasStore(
        baseDir: casPath,
        sqliteAdapter: sqlite,
        maxSizeBytes: 10 * 1024 * 1024,
      );
      await cas.init();

      engine = QueryEngine(
        sqliteAdapter: sqlite,
        defaultStaleTime: const Duration(seconds: 30),
      );
    });

    tearDown(() {
      if (!sqlite.isClosed) {
        sqlite.close();
      }
      if (tempDir.existsSync()) {
        try {
          tempDir.deleteSync(recursive: true);
        } catch (_) {}
      }
    });

    test('executes complete full-chain lifecycle: SWR -> CAS -> Observer -> Invalidation -> Outbox -> Durability', () async {
      // -----------------------------------------------------------------------
      // Step 1: Ingress with SWR caching & SQLite WAL persistence
      // -----------------------------------------------------------------------
      int remoteFetchCount = 0;
      final queryKey = ['packages', 'pkg-core'];
      final tags = ['pkg:core', 'ecosystem'];

      Map<String, dynamic> serverData = {
        'id': 'pkg-core',
        'version': '1.0.0',
        'downloads': 100,
      };

      Future<Map<String, dynamic>> fetchRemote() async {
        remoteFetchCount++;
        return Map<String, dynamic>.from(serverData);
      }

      // Initial fetch: hits remote
      final initial = await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        fetchRemote,
        tags: tags,
      );
      expect(initial['version'], equals('1.0.0'));
      expect(remoteFetchCount, equals(1));

      // Synchronous cache hit within staleTime
      final cached = await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        fetchRemote,
        tags: tags,
      );
      expect(cached['version'], equals('1.0.0'));
      expect(remoteFetchCount, equals(1)); // No extra network call

      // Verify persisted in SQLite
      final queryHash = hashQueryKey(queryKey);
      final dbEntry = sqlite.getQuery<Map<String, dynamic>>(queryHash);
      expect(dbEntry, isNotNull);
      expect(dbEntry!.dataPayload['version'], equals('1.0.0'));

      // Verify tag index in SQLite
      final tagged = sqlite.getQueryHashesByTag('pkg:core');
      expect(tagged, contains(queryHash));

      // -----------------------------------------------------------------------
      // Step 2: Content-Addressable Storage (CAS) with SHA-256 & LRU Access
      // -----------------------------------------------------------------------
      final binaryPayload = utf8.encode('BINARY_PACKAGE_PAYLOAD_V1.0.0');
      final expectedSha = sha256.convert(binaryPayload).toString();

      final putResult = await cas.put(binaryPayload, expectedHash: expectedSha);
      expect(putResult.hash, equals(expectedSha));
      expect(putResult.size, equals(binaryPayload.length));
      expect(File(putResult.path).existsSync(), isTrue);

      // Verify retrieval and access tracking
      final retrievedBytes = await cas.get(expectedSha);
      expect(retrievedBytes, isNotNull);
      expect(utf8.decode(retrievedBytes!), equals('BINARY_PACKAGE_PAYLOAD_V1.0.0'));

      final casRecord = sqlite.getCasObject(expectedSha);
      expect(casRecord, isNotNull);
      expect(casRecord!['size'], equals(binaryPayload.length));

      // -----------------------------------------------------------------------
      // Step 3: Zero-Rebuild Selector Observer
      // -----------------------------------------------------------------------
      final observer = createSelectorObserver<Map<String, dynamic>, String>(
        engine,
        queryKey,
        (data) => data['version'] as String,
        queryFn: fetchRemote,
        tags: tags,
      );

      expect(observer.getSnapshot(), equals('1.0.0'));

      int rebuildCount = 0;
      final unsubscribe = observer.subscribe(() => rebuildCount++);

      // Revalidation with identical data: zero rebuilds
      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        fetchRemote,
        tags: tags,
      );
      expect(rebuildCount, equals(0));

      // Revalidation changing unselected field (downloads 100 -> 999): zero rebuilds
      serverData['downloads'] = 999;
      await engine.invalidateByTag('pkg:core');
      // Wait for revalidation
      await Future.delayed(const Duration(milliseconds: 50));
      expect(rebuildCount, equals(0));
      expect(observer.getSnapshot(), equals('1.0.0'));

      // Revalidation changing selected field (version 1.0.0 -> 1.1.0): exactly 1 rebuild
      serverData['version'] = '1.1.0';
      await engine.invalidateByTag('pkg:core');
      await Future.delayed(const Duration(milliseconds: 50));
      expect(rebuildCount, equals(1));
      expect(observer.getSnapshot(), equals('1.1.0'));

      unsubscribe();
      observer.dispose();

      // -----------------------------------------------------------------------
      // Step 4: Transactional Offline Mutation Outbox
      // -----------------------------------------------------------------------
      final mutation = OutboxMutation<Map<String, dynamic>>(
        mutationId: 'mut-dart-1',
        endpoint: '/api/v1/packages/pkg-core',
        method: 'PATCH',
        payload: {'version': '1.1.1'},
        status: OutboxMutationStatus.pending,
        retryCount: 0,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        conflictPolicy: ConflictPolicy.clientWins,
      );
      sqlite.setMutation(mutation);

      final pending = sqlite.getPendingMutations();
      expect(pending, hasLength(1));
      expect(pending.first.mutationId, equals('mut-dart-1'));

      // Resolve and remove mutation upon successful replay
      sqlite.deleteMutation('mut-dart-1');
      expect(sqlite.getPendingMutations(), isEmpty);

      // -----------------------------------------------------------------------
      // Step 5: Durability & WAL Truncate Checkpoint
      // -----------------------------------------------------------------------
      // Write a sentinel entry to ensure WAL pages exist
      sqlite.setQuery(CacheEntry<String>(
        queryHash: 'sentinel',
        queryKey: ['system', 'sentinel'],
        dataPayload: 'ok',
        createdAt: DateTime.now().millisecondsSinceEpoch,
        staleAt: DateTime.now().millisecondsSinceEpoch + 10000,
        expiresAt: DateTime.now().millisecondsSinceEpoch + 60000,
      ));

      // Checkpoint WAL
      sqlite.checkpoint('TRUNCATE');

      if (File(walPath).existsSync()) {
        expect(File(walPath).lengthSync(), equals(0));
      }

      sqlite.close();

      // Reopen cleanly and verify data intact
      final reopenSqlite = SqliteAdapter.file(dbPath);
      final sentinel = reopenSqlite.getQuery<String>('sentinel');
      expect(sentinel, isNotNull);
      expect(sentinel!.dataPayload, equals('ok'));
      reopenSqlite.close();
    });
  });
}
