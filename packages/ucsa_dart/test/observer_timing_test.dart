import 'dart:async';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('Dart SelectorObserver Timing Controls (Throttle & Debounce)', () {
    test('throttles rapid updates to leading and trailing edge', () async {
      final engine = QueryEngine();
      final queryKey = ['stocks', 'AAPL'];

      engine.setQueryData(queryKey, {'symbol': 'AAPL', 'price': 150});

      int listenerCount = 0;
      int? lastPrice;

      final observer = createSelectorObserver<Map<String, dynamic>, int>(
        engine,
        queryKey,
        (data) => data['price'] as int,
        throttleDuration: const Duration(milliseconds: 100),
      );

      final unsubscribe = observer.subscribe(() {
        listenerCount++;
        lastPrice = observer.getSnapshot();
      });

      expect(listenerCount, equals(0));

      // 1. First update fires leading edge immediately
      engine.setQueryData(queryKey, {'symbol': 'AAPL', 'price': 151});
      expect(listenerCount, equals(1));
      expect(lastPrice, equals(151));

      // 2. Rapid updates within 100ms window are suppressed
      await Future.delayed(const Duration(milliseconds: 20));
      engine.setQueryData(queryKey, {'symbol': 'AAPL', 'price': 152});

      await Future.delayed(const Duration(milliseconds: 20));
      engine.setQueryData(queryKey, {'symbol': 'AAPL', 'price': 153});

      await Future.delayed(const Duration(milliseconds: 20));
      engine.setQueryData(queryKey, {'symbol': 'AAPL', 'price': 154});

      expect(listenerCount, equals(1));
      expect(lastPrice, equals(151));

      // 3. Wait until throttle window expires (100ms total): trailing edge fires once with latest price (154)
      await Future.delayed(const Duration(milliseconds: 60));
      expect(listenerCount, equals(2));
      expect(lastPrice, equals(154));

      unsubscribe();
    });

    test('debounces rapid updates and fires only after quiet period', () async {
      final engine = QueryEngine();
      final queryKey = ['search', 'term'];

      engine.setQueryData(queryKey, {'term': 'a'});

      int listenerCount = 0;
      String? lastTerm;

      final observer = createSelectorObserver<Map<String, dynamic>, String>(
        engine,
        queryKey,
        (data) => data['term'] as String,
        debounceDuration: const Duration(milliseconds: 60),
      );

      final unsubscribe = observer.subscribe(() {
        listenerCount++;
        lastTerm = observer.getSnapshot();
      });

      expect(listenerCount, equals(0));

      // Rapid keystrokes every 15ms
      engine.setQueryData(queryKey, {'term': 'ap'});
      await Future.delayed(const Duration(milliseconds: 15));
      expect(listenerCount, equals(0));

      engine.setQueryData(queryKey, {'term': 'app'});
      await Future.delayed(const Duration(milliseconds: 15));
      expect(listenerCount, equals(0));

      engine.setQueryData(queryKey, {'term': 'appl'});
      await Future.delayed(const Duration(milliseconds: 15));
      expect(listenerCount, equals(0));

      engine.setQueryData(queryKey, {'term': 'apple'});
      expect(listenerCount, equals(0));

      // Quiet period: wait 30ms (still not 60ms)
      await Future.delayed(const Duration(milliseconds: 30));
      expect(listenerCount, equals(0));

      // Wait remaining 40ms (exceeding 60ms)
      await Future.delayed(const Duration(milliseconds: 40));
      expect(listenerCount, equals(1));
      expect(lastTerm, equals('apple'));

      unsubscribe();
    });
  });
}
