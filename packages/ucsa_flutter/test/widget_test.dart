import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ucsa_flutter/ucsa_flutter.dart';

void main() {
  group('Flutter Framework Integration (UcsaSelectorBuilder)', () {
    testWidgets('mounts real Flutter widgets and suppresses rebuilds on unselected state mutations',
        (WidgetTester tester) async {
      final engine = QueryEngine();
      final queryKey = ['users', 'user-1'];

      Map<String, dynamic> serverData = {
        'id': 'user-1',
        'name': 'Alice',
        'downloads': 100,
      };

      Future<Map<String, dynamic>> fetchUser() async {
        return Map<String, dynamic>.from(serverData);
      }

      // Pre-populate query
      await engine.fetchQuery(queryKey, fetchUser);

      int widgetBuildCount = 0;

      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: UcsaSelectorBuilder<Map<String, dynamic>, String>(
            engine: engine,
            queryKey: queryKey,
            selector: (data) => data['name'] as String,
            builder: (context, name) {
              widgetBuildCount++;
              return Column(
                children: [
                  Text(name ?? 'Loading', key: const ValueKey('name_text')),
                  Text('$widgetBuildCount', key: const ValueKey('count_text')),
                ],
              );
            },
          ),
        ),
      );

      // 1. Initial render
      expect(find.text('Alice'), findsOneWidget);
      expect(find.text('1'), findsOneWidget);
      expect(widgetBuildCount, equals(1));

      // 2. Revalidation with identical data: Flutter widget rebuilds ZERO times
      await engine.fetchQuery(queryKey, fetchUser);
      await tester.pump();
      expect(widgetBuildCount, equals(1));
      expect(find.text('1'), findsOneWidget);

      // 3. Revalidation changing unselected field (downloads 100 -> 500):
      // Flutter widget rebuilds ZERO times!
      serverData['downloads'] = 500;
      await engine.invalidateQueries(queryKey);
      await tester.pump();
      expect(widgetBuildCount, equals(1));
      expect(find.text('1'), findsOneWidget);

      // 4. Revalidation changing selected field (name: 'Alice' -> 'Alice Smith'):
      // Flutter widget rebuilds exactly ONCE and updates UI tree!
      serverData['name'] = 'Alice Smith';
      await engine.invalidateQueries(queryKey);
      await tester.pumpAndSettle();
      expect(widgetBuildCount, equals(2));
      expect(find.text('Alice Smith'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
    });
  });
}
