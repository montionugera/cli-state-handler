import 'dart:async';
import 'package:test/test.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  group('Zero-Rebuild SelectorObserver Benchmark', () {
    test(
        'verifies exact notification counts across initial fetch, identical revalidations, unselected updates, selected updates, and rapid bursts',
        () async {
      final engine = QueryEngine();
      final queryKey = ['users', 'profile', 'usr_001'];

      // Selector only extracts user.name
      final observer = createSelectorObserver<Map<String, dynamic>, String>(
        engine,
        queryKey,
        (data) => (data['user'] as Map<String, dynamic>)['name'] as String,
      );

      var renderCount = 0;
      final renders = <String>[];

      final unsubscribe = observer.subscribe(() {
        renderCount++;
        final val = observer.getSnapshot();
        if (val != null) {
          renders.add(val);
        }
      });

      // 0. Before initial fetch: snapshot is null, renderCount is 0
      expect(renderCount, 0);
      expect(observer.getSnapshot(), isNull);

      // 1. Initial fetch: listener called 1 time on data load
      await engine.fetchQuery<Map<String, dynamic>>(
          queryKey,
          () async => {
                'user': {'id': 'usr_001', 'name': 'Alice', 'role': 'admin'},
                'settings': {'theme': 'dark', 'notifications': true},
                'timestamp': 1000,
              });

      expect(renderCount, 1);
      expect(observer.getSnapshot(), 'Alice');
      expect(renders, ['Alice']);

      // 2. Background revalidation bringing identical payload: listener called 0 additional times
      await engine.fetchQuery<Map<String, dynamic>>(
          queryKey,
          () async => {
                'user': {'id': 'usr_001', 'name': 'Alice', 'role': 'admin'},
                'settings': {'theme': 'dark', 'notifications': true},
                'timestamp': 1000,
              });

      expect(renderCount, 1);
      expect(observer.getSnapshot(), 'Alice');
      expect(renders, ['Alice']);

      // 3. Background revalidation changing an unselected field (timestamp & theme changed):
      // listener called 0 additional times (renderCount stays 1)
      await engine.fetchQuery<Map<String, dynamic>>(
          queryKey,
          () async => {
                'user': {'id': 'usr_001', 'name': 'Alice', 'role': 'admin'},
                'settings': {'theme': 'light', 'notifications': true},
                'timestamp': 2000,
              });

      expect(renderCount, 1);
      expect(observer.getSnapshot(), 'Alice');
      expect(renders, ['Alice']);

      // 4. Background revalidation changing the selected field (user.name changed to Bob):
      // listener called exactly 1 additional time (renderCount becomes 2)
      await engine.fetchQuery<Map<String, dynamic>>(
          queryKey,
          () async => {
                'user': {'id': 'usr_001', 'name': 'Bob', 'role': 'admin'},
                'settings': {'theme': 'light', 'notifications': true},
                'timestamp': 3000,
              });

      expect(renderCount, 2);
      expect(observer.getSnapshot(), 'Bob');
      expect(renders, ['Alice', 'Bob']);

      // 5. Rapid bursts: 10 background revalidations in sequence with identical data result in 0 re-renders
      for (var i = 0; i < 10; i++) {
        await engine.fetchQuery<Map<String, dynamic>>(
            queryKey,
            () async => {
                  'user': {'id': 'usr_001', 'name': 'Bob', 'role': 'admin'},
                  'settings': {'theme': 'light', 'notifications': true},
                  'timestamp': 3000,
                });
      }

      expect(renderCount, 2);
      expect(observer.getSnapshot(), 'Bob');
      expect(renders, ['Alice', 'Bob']);

      unsubscribe();
      observer.dispose();
    });

    test(
        'multiple observers on different slices only fire for their own changes',
        () async {
      final engine = QueryEngine();
      final queryKey = ['app', 'state'];

      final nameObserver = createSelectorObserver<Map<String, dynamic>, String>(
        engine,
        queryKey,
        (data) => data['name'] as String,
      );

      final themeObserver =
          createSelectorObserver<Map<String, dynamic>, String>(
        engine,
        queryKey,
        (data) => data['theme'] as String,
      );

      var nameNotifications = 0;
      var themeNotifications = 0;

      final unsubName = nameObserver.subscribe(() => nameNotifications++);
      final unsubTheme = themeObserver.subscribe(() => themeNotifications++);

      // Seed
      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'name': 'Alice', 'theme': 'dark'},
      );

      expect(nameNotifications, 1);
      expect(themeNotifications, 1);
      expect(nameObserver.getSnapshot(), 'Alice');
      expect(themeObserver.getSnapshot(), 'dark');

      // Update ONLY theme
      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'name': 'Alice', 'theme': 'light'},
      );

      // nameNotifications must remain 1!
      expect(nameNotifications, 1);
      // themeNotifications increments to 2
      expect(themeNotifications, 2);
      expect(themeObserver.getSnapshot(), 'light');

      // Update ONLY name
      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'name': 'Charlie', 'theme': 'light'},
      );

      // nameNotifications increments to 2
      expect(nameNotifications, 2);
      expect(nameObserver.getSnapshot(), 'Charlie');
      // themeNotifications must remain 2!
      expect(themeNotifications, 2);

      unsubName();
      unsubTheme();
      nameObserver.dispose();
      themeObserver.dispose();
    });

    test('observer stream emits updates only on slice changes', () async {
      final engine = QueryEngine();
      final queryKey = ['counter'];

      final observer = createSelectorObserver<Map<String, dynamic>, int>(
        engine,
        queryKey,
        (data) => data['count'] as int,
      );

      final emissions = <int>[];
      final sub = observer.stream.listen((val) {
        if (val != null) emissions.add(val);
      });

      // Observer subscribe triggers engine connection
      final unsub = observer.subscribe(() {});

      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'count': 1, 'noise': 'a'},
      );

      // Same count, noise changes
      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'count': 1, 'noise': 'b'},
      );

      // Count changes to 2
      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'count': 2, 'noise': 'c'},
      );

      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(emissions, [1, 2]);

      unsub();
      await sub.cancel();
      observer.dispose();
    });

    test('unsubscribe stops notifications immediately', () async {
      final engine = QueryEngine();
      final queryKey = ['toggle'];

      final observer = createSelectorObserver<Map<String, dynamic>, bool>(
        engine,
        queryKey,
        (data) => data['active'] as bool,
      );

      var callCount = 0;
      final unsub = observer.subscribe(() => callCount++);

      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'active': true},
      );
      expect(callCount, 1);

      unsub();

      await engine.fetchQuery<Map<String, dynamic>>(
        queryKey,
        () async => {'active': false},
      );
      // After unsub, callCount stays 1
      expect(callCount, 1);

      observer.dispose();
    });
  });
}
