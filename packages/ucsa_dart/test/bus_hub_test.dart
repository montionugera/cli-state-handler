import 'dart:io';
import 'package:test/test.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  late Directory tempDir;
  late String dbPath;
  late SqliteAdapter adapter;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('ucsa_dart_bus_hub_test_');
    dbPath = '${tempDir.path}/test.db';
    adapter = SqliteAdapter.file(dbPath, origin: 'test-hub-process');
  });

  tearDown(() {
    adapter.close();
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  group('resolveBusEndpoint', () {
    test('produces valid deterministic path under 100 characters', () {
      final endpoint = resolveBusEndpoint(dbPath);
      expect(endpoint, isNotEmpty);
      expect(endpoint.length, lessThan(100));

      // Deterministic: multiple calls produce identical endpoint
      final endpoint2 = resolveBusEndpoint(dbPath);
      expect(endpoint, equals(endpoint2));

      if (Platform.isWindows) {
        expect(endpoint, startsWith(r'\\.\pipe\ucsa-'));
      } else {
        expect(endpoint, contains('/ucsa/ucsa-'));
        expect(endpoint, endsWith('.sock'));
      }
    });

    test('generates different endpoints for different database paths', () {
      final endpoint1 = resolveBusEndpoint('/path/to/db1.sqlite');
      final endpoint2 = resolveBusEndpoint('/path/to/db2.sqlite');
      expect(endpoint1, isNot(equals(endpoint2)));
      expect(endpoint1.length, lessThan(100));
      expect(endpoint2.length, lessThan(100));
    });
  });

  group('HubRecord & BusHub storage operations', () {
    test('getHubRecord returns null when table is empty', () {
      final hub = BusHub(adapter: adapter, endpoint: resolveBusEndpoint(dbPath));
      final record = hub.getHubRecord();
      expect(record, isNull);
    });

    test('writeHubRecord and getHubRecord store and retrieve HubRecord correctly', () {
      final hub = BusHub(adapter: adapter, endpoint: resolveBusEndpoint(dbPath));
      final testRecord = HubRecord(
        id: 1,
        epoch: 42,
        pid: pid,
        endpoint: resolveBusEndpoint(dbPath),
        token: 'secret-token-1234',
        claimedAt: 1700000000000,
      );

      hub.writeHubRecord(testRecord);

      final loaded = hub.getHubRecord();
      expect(loaded, isNotNull);
      expect(loaded!.id, equals(1));
      expect(loaded.epoch, equals(42));
      expect(loaded.pid, equals(pid));
      expect(loaded.endpoint, equals(resolveBusEndpoint(dbPath)));
      expect(loaded.token, equals('secret-token-1234'));
      expect(loaded.claimedAt, equals(1700000000000));
      expect(loaded, equals(testRecord));
    });

    test('HubRecord serializes to and from Map', () {
      final record = HubRecord(
        id: 1,
        epoch: 5,
        pid: 12345,
        endpoint: '/tmp/ucsa/ucsa-test.sock',
        token: 'auth-token-xyz',
        claimedAt: 1728000000000,
      );

      final map = record.toMap();
      expect(map['id'], equals(1));
      expect(map['epoch'], equals(5));
      expect(map['pid'], equals(12345));
      expect(map['endpoint'], equals('/tmp/ucsa/ucsa-test.sock'));
      expect(map['token'], equals('auth-token-xyz'));
      expect(map['claimed_at'], equals(1728000000000));

      final restored = HubRecord.fromMap(map);
      expect(restored, equals(record));
    });

    test('elect promotes to hub role and increments epoch', () {
      final hub1 = BusHub(adapter: adapter, endpoint: resolveBusEndpoint(dbPath));
      final res1 = hub1.elect(token: 'hub-token-1');

      expect(res1.role, equals(BusHubRole.hub));
      expect(res1.epoch, equals(1));
      expect(res1.token, equals('hub-token-1'));
      expect(hub1.role, equals(BusHubRole.hub));
      expect(hub1.epoch, equals(1));
      expect(hub1.token, equals('hub-token-1'));

      final record = hub1.getHubRecord();
      expect(record, isNotNull);
      expect(record!.epoch, equals(1));
      expect(record.token, equals('hub-token-1'));

      // Elect again increments epoch
      final hub2 = BusHub(adapter: adapter, endpoint: resolveBusEndpoint(dbPath));
      final res2 = hub2.elect(token: 'hub-token-2');

      expect(res2.role, equals(BusHubRole.hub));
      expect(res2.epoch, equals(2));
      expect(res2.token, equals('hub-token-2'));
      expect(hub2.epoch, equals(2));

      final record2 = hub2.getHubRecord();
      expect(record2!.epoch, equals(2));
      expect(record2.token, equals('hub-token-2'));
    });

    test('connectAsClient retrieves existing hub record and adopts client role', () {
      final hubMaster = BusHub(adapter: adapter, endpoint: resolveBusEndpoint(dbPath));
      hubMaster.elect(token: 'master-token-abc');

      final hubClient = BusHub(adapter: adapter, endpoint: resolveBusEndpoint(dbPath));
      final clientRes = hubClient.connectAsClient();

      expect(clientRes, isNotNull);
      expect(clientRes!.role, equals(BusHubRole.client));
      expect(clientRes.epoch, equals(1));
      expect(clientRes.token, equals('master-token-abc'));
      expect(hubClient.role, equals(BusHubRole.client));
    });

    test('connectAsClient returns null when no hub record exists', () {
      final hubClient = BusHub(adapter: adapter, endpoint: resolveBusEndpoint(dbPath));
      final clientRes = hubClient.connectAsClient();
      expect(clientRes, isNull);
      expect(hubClient.role, equals(BusHubRole.idle));
    });
  });
}
