import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('Dart Outbox Batch Replay & Rate-Limiting', () {
    late SqliteAdapter adapter;

    setUp(() {
      adapter = SqliteAdapter.inMemory();
      adapter.initSchema();
    });

    tearDown(() {
      adapter.close();
    });

    test('respects rateLimit delay between sequential mutation replays',
        () async {
      final order = <String>[];
      final timestamps = <int>[];

      for (int i = 1; i <= 4; i++) {
        adapter.setMutation(
          OutboxMutation<dynamic>(
            mutationId: 'dart-mut-$i',
            endpoint: '/api/v1/items/$i',
            method: 'POST',
            createdAt: DateTime.now().millisecondsSinceEpoch + i,
            payload: {'index': i},
          ),
        );
      }

      final sw = Stopwatch()..start();
      final result = await adapter.replayOutbox(
        (m) async {
          order.add(m.mutationId);
          timestamps.add(DateTime.now().millisecondsSinceEpoch);
          return {'status': 200, 'data': {'ok': true}};
        },
        rateLimit: const Duration(milliseconds: 25),
      );
      sw.stop();

      expect(result.processed, equals(4));
      expect(result.successful, equals(4));
      expect(result.failed, equals(0));
      expect(order, equals(['dart-mut-1', 'dart-mut-2', 'dart-mut-3', 'dart-mut-4']));
      expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(70));

      for (int i = 1; i < timestamps.length; i++) {
        final delta = timestamps[i] - timestamps[i - 1];
        expect(delta, greaterThanOrEqualTo(20));
      }
    });

    test('limits processed mutations per run when batchSize is specified',
        () async {
      for (int i = 1; i <= 5; i++) {
        adapter.setMutation(
          OutboxMutation<dynamic>(
            mutationId: 'dart-batch-$i',
            endpoint: '/api/v1/batch/$i',
            method: 'POST',
            createdAt: DateTime.now().millisecondsSinceEpoch + i,
            payload: {'val': i},
          ),
        );
      }

      expect(adapter.getPendingMutations().length, equals(5));

      // Batch 1: size 2
      final b1 = await adapter.replayOutbox(
        (m) async => {'status': 200},
        batchSize: 2,
      );
      expect(b1, equals(const ReplayResult(processed: 2, successful: 2, failed: 0)));
      expect(adapter.getPendingMutations().length, equals(3));

      // Batch 2: size 2
      final b2 = await adapter.replayOutbox(
        (m) async => {'status': 200},
        batchSize: 2,
      );
      expect(b2, equals(const ReplayResult(processed: 2, successful: 2, failed: 0)));
      expect(adapter.getPendingMutations().length, equals(1));

      // Batch 3: size 2 (1 remaining)
      final b3 = await adapter.replayOutbox(
        (m) async => {'status': 200},
        batchSize: 2,
      );
      expect(b3, equals(const ReplayResult(processed: 1, successful: 1, failed: 0)));
      expect(adapter.getPendingMutations().length, equals(0));
    });
  });
}
