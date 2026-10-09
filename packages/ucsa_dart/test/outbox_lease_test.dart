import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('Dart Outbox Distributed Leases & Claim Engine', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
      adapter.initSchema();
    });

    tearDown(() {
      adapter.close();
    });

    test('concurrent workers claiming mutations claim non-overlapping subsets', () {
      final now = DateTime.now().millisecondsSinceEpoch;
      for (int i = 1; i <= 6; i++) {
        adapter.setMutation(
          OutboxMutation<dynamic>(
            mutationId: 'mut-$i',
            endpoint: '/api/v1/items/$i',
            method: 'POST',
            createdAt: now + i,
            payload: {'index': i},
          ),
        );
      }

      // Worker 1 claims first 3
      final claimed1 = adapter.claimPendingMutations('worker-1', 10000, limit: 3);
      expect(claimed1.length, equals(3));
      for (final m in claimed1) {
        expect(m.leaseOwner, equals('worker-1'));
        expect(m.leaseUntil, isNotNull);
        expect(m.status, equals(OutboxMutationStatus.inFlight));
      }

      // Worker 2 claims next 3
      final claimed2 = adapter.claimPendingMutations('worker-2', 10000, limit: 3);
      expect(claimed2.length, equals(3));
      for (final m in claimed2) {
        expect(m.leaseOwner, equals('worker-2'));
        expect(m.leaseUntil, isNotNull);
        expect(m.status, equals(OutboxMutationStatus.inFlight));
      }

      // Verify claimed subsets are completely disjoint
      final ids1 = claimed1.map((m) => m.mutationId).toSet();
      final ids2 = claimed2.map((m) => m.mutationId).toSet();
      expect(ids1.intersection(ids2), isEmpty);
      expect(ids1.union(ids2), equals({'mut-1', 'mut-2', 'mut-3', 'mut-4', 'mut-5', 'mut-6'}));

      // Worker 3 attempts to claim while leases are active -> gets none
      final claimed3 = adapter.claimPendingMutations('worker-3', 10000, limit: 3);
      expect(claimed3, isEmpty);
    });

    test('expired lease can be reclaimed by another worker', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      adapter.setMutation(
        OutboxMutation<dynamic>(
          mutationId: 'mut-expire',
          endpoint: '/api/v1/expire',
          method: 'PUT',
          createdAt: now,
          payload: {'msg': 'expiring-soon'},
        ),
      );

      // Worker 1 claims with lease of 500ms
      final claimed1 = adapter.claimPendingMutations('worker-1', 500, limit: 1);
      expect(claimed1.length, equals(1));
      expect(claimed1.first.mutationId, equals('mut-expire'));
      expect(claimed1.first.leaseOwner, equals('worker-1'));

      // Worker 2 immediately tries to claim -> returns empty
      final claimedEarly = adapter.claimPendingMutations('worker-2', 5000, limit: 1);
      expect(claimedEarly, isEmpty);

      // Wait for lease to expire
      await Future.delayed(const Duration(milliseconds: 600));

      // Worker 2 tries again -> reclaims expired in-flight mutation
      final reclaimed = adapter.claimPendingMutations('worker-2', 5000, limit: 1);
      expect(reclaimed.length, equals(1));
      expect(reclaimed.first.mutationId, equals('mut-expire'));
      expect(reclaimed.first.leaseOwner, equals('worker-2'));
      expect(reclaimed.first.status, equals(OutboxMutationStatus.inFlight));
    });

    test('replayOutbox utilizes distributed lease claims to prevent duplicate replay', () async {
      final executed = <String>[];
      final now = DateTime.now().millisecondsSinceEpoch;

      for (int i = 1; i <= 4; i++) {
        adapter.setMutation(
          OutboxMutation<dynamic>(
            mutationId: 'mut-replay-$i',
            endpoint: '/api/v1/replay/$i',
            method: 'POST',
            createdAt: now + i,
            payload: {'val': i},
          ),
        );
      }

      // Worker 1 replays 2 mutations with lease
      final r1 = await adapter.replayOutbox(
        (m) async {
          executed.add('worker-1:${m.mutationId}');
          return {'status': 200};
        },
        workerId: 'worker-1',
        leaseDurationMs: 10000,
        batchSize: 2,
      );

      // Worker 2 replays remaining 2 mutations
      final r2 = await adapter.replayOutbox(
        (m) async {
          executed.add('worker-2:${m.mutationId}');
          return {'status': 200};
        },
        workerId: 'worker-2',
        leaseDurationMs: 10000,
        batchSize: 2,
      );

      expect(r1.successful, equals(2));
      expect(r2.successful, equals(2));
      expect(executed, equals([
        'worker-1:mut-replay-1',
        'worker-1:mut-replay-2',
        'worker-2:mut-replay-3',
        'worker-2:mut-replay-4',
      ]));

      expect(adapter.getPendingMutations(), isEmpty);
    });
  });
}
