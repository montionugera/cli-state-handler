import 'dart:async';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('Dart QueryEngine Debouncing & Cancellation', () {
    test('collapses rapid fetchQuery calls into a single execution', () async {
      final engine = QueryEngine();
      final queryKey = ['search', 'users'];

      int executionCount = 0;
      Future<Map<String, dynamic>> fetchFn(String term) async {
        executionCount++;
        return {'term': term};
      }

      // Call 1 at t=0
      final f1 = engine.fetchQuery(
        queryKey,
        () => fetchFn('a'),
        debounceDuration: const Duration(milliseconds: 120),
      );
      expect(executionCount, equals(0));

      // Call 2 at t=20
      await Future.delayed(const Duration(milliseconds: 20));
      final f2 = engine.fetchQuery(
        queryKey,
        () => fetchFn('ab'),
        debounceDuration: const Duration(milliseconds: 120),
      );
      expect(executionCount, equals(0));

      // Call 3 at t=40
      await Future.delayed(const Duration(milliseconds: 20));
      final f3 = engine.fetchQuery(
        queryKey,
        () => fetchFn('abc'),
        debounceDuration: const Duration(milliseconds: 120),
      );
      expect(executionCount, equals(0));

      // Wait 40ms (still within quiet period)
      await Future.delayed(const Duration(milliseconds: 40));
      expect(executionCount, equals(0));

      // Wait remaining 100ms (exceeding 120ms quiet period)
      await Future.delayed(const Duration(milliseconds: 100));
      expect(executionCount, equals(1));

      final results = await Future.wait([f1, f2, f3]);
      expect(results[0]['term'], equals('abc'));
      expect(results[1]['term'], equals('abc'));
      expect(results[2]['term'], equals('abc'));
    });

    test('cancelQuery aborts pending debounce timer', () async {
      final engine = QueryEngine();
      final queryKey = ['search', 'canceled'];

      bool executed = false;
      final f = engine.fetchQuery(
        queryKey,
        () async {
          executed = true;
          return {'status': 'ok'};
        },
        debounceDuration: const Duration(milliseconds: 150),
      );
      final expectFuture = expectLater(f, throwsA(anything));

      await Future.delayed(const Duration(milliseconds: 20));
      expect(executed, isFalse);

      engine.cancelQuery(queryKey);

      await expectFuture;
      expect(executed, isFalse);
    });
  });
}
