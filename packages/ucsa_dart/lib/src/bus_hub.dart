import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/sqlite3.dart';
import 'sqlite_adapter.dart';

/// Resolves a deterministic IPC bus endpoint (Unix domain socket or Windows named pipe)
/// based on the SQLite database path. Path is kept short (<100 chars) via SHA-256 hash.
String resolveBusEndpoint(String dbPath) {
  final normalized = p.normalize(p.absolute(dbPath));
  final hashBytes = sha256.convert(utf8.encode(normalized)).bytes;
  final shortHash = hashBytes
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join()
      .substring(0, 16);

  if (Platform.isWindows) {
    return r'\\.\pipe\ucsa-' + shortHash;
  }

  final xdg = Platform.environment['XDG_RUNTIME_DIR'];
  final basePath = (xdg != null && xdg.isNotEmpty) ? xdg : '/tmp';
  final socketDir = p.join(basePath, 'ucsa');
  try {
    final dir = Directory(socketDir);
    if (!dir.existsSync()) {
      dir.createSync(recursive: true);
    }
  } catch (_) {
    // Ignore directory creation failure (e.g. read-only filesystem or in-memory tests)
  }
  return p.join(socketDir, 'ucsa-$shortHash.sock');
}

/// Represents a row in the `ucsa_bus_hub` table (id = 1).
class HubRecord {
  final int id;
  final int epoch;
  final int pid;
  final String endpoint;
  final String token;
  final int claimedAt;

  const HubRecord({
    required this.id,
    required this.epoch,
    required this.pid,
    required this.endpoint,
    required this.token,
    required this.claimedAt,
  });

  factory HubRecord.fromMap(Map<String, dynamic> map) {
    return HubRecord(
      id: map['id'] as int,
      epoch: map['epoch'] as int,
      pid: map['pid'] as int,
      endpoint: map['endpoint'] as String,
      token: map['token'] as String,
      claimedAt: (map['claimed_at'] ?? map['claimedAt']) as int,
    );
  }

  factory HubRecord.fromRow(Row row) {
    return HubRecord(
      id: row['id'] as int,
      epoch: row['epoch'] as int,
      pid: row['pid'] as int,
      endpoint: row['endpoint'] as String,
      token: row['token'] as String,
      claimedAt: row['claimed_at'] as int,
    );
  }

  Map<String, dynamic> toMap() => {
    'id': id,
    'epoch': epoch,
    'pid': pid,
    'endpoint': endpoint,
    'token': token,
    'claimed_at': claimedAt,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is HubRecord &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          epoch == other.epoch &&
          pid == other.pid &&
          endpoint == other.endpoint &&
          token == other.token &&
          claimedAt == other.claimedAt;

  @override
  int get hashCode =>
      id.hashCode ^
      epoch.hashCode ^
      pid.hashCode ^
      endpoint.hashCode ^
      token.hashCode ^
      claimedAt.hashCode;

  @override
  String toString() =>
      'HubRecord(id: $id, epoch: $epoch, pid: $pid, endpoint: $endpoint, token: $token, claimedAt: $claimedAt)';
}

/// Role of the bus node in the election protocol.
enum BusHubRole { idle, hub, client }

/// Result of an election or connection attempt.
class ElectionResult {
  final BusHubRole role;
  final String endpoint;
  final String token;
  final int epoch;

  const ElectionResult({
    required this.role,
    required this.endpoint,
    required this.token,
    required this.epoch,
  });
}

/// In-process bus hub coordination and election model using `ucsa_bus_hub` table.
class BusHub {
  final SqliteAdapter adapter;
  final String endpoint;
  BusHubRole role = BusHubRole.idle;
  int? epoch;
  String? token;

  BusHub({
    required this.adapter,
    String? endpoint,
    String? dbPath,
  }) : endpoint = endpoint ??
            (dbPath != null
                ? resolveBusEndpoint(dbPath)
                : (adapter.path != null
                    ? resolveBusEndpoint(adapter.path!)
                    : '/tmp/ucsa/ucsa-default.sock'));

  /// Reads current hub record from ucsa_bus_hub table (id = 1).
  HubRecord? getHubRecord() {
    try {
      final rows = adapter.db.select(
        'SELECT id, epoch, pid, endpoint, token, claimed_at FROM ucsa_bus_hub WHERE id = 1;',
      );
      if (rows.isEmpty) return null;
      return HubRecord.fromRow(rows.first);
    } catch (_) {
      return null;
    }
  }

  /// Writes or replaces the hub record in the `ucsa_bus_hub` table.
  void writeHubRecord(HubRecord record) {
    adapter.db.execute(
      '''
      INSERT OR REPLACE INTO ucsa_bus_hub (id, epoch, pid, endpoint, token, claimed_at)
      VALUES (1, ?, ?, ?, ?, ?);
      ''',
      [record.epoch, record.pid, record.endpoint, record.token, record.claimedAt],
    );
  }

  /// Elects the current process as hub, incrementing epoch and updating `ucsa_bus_hub`.
  ElectionResult elect({String? token}) {
    final current = getHubRecord();
    final newEpoch = (current?.epoch ?? 0) + 1;
    final generatedToken = token ?? _generateToken();
    final record = HubRecord(
      id: 1,
      epoch: newEpoch,
      pid: pid,
      endpoint: endpoint,
      token: generatedToken,
      claimedAt: DateTime.now().millisecondsSinceEpoch,
    );
    writeHubRecord(record);
    role = BusHubRole.hub;
    epoch = newEpoch;
    this.token = generatedToken;

    return ElectionResult(
      role: BusHubRole.hub,
      endpoint: endpoint,
      token: generatedToken,
      epoch: newEpoch,
    );
  }

  /// Connects to an existing hub as client using the stored record in `ucsa_bus_hub`.
  ElectionResult? connectAsClient() {
    final current = getHubRecord();
    if (current == null) return null;

    role = BusHubRole.client;
    epoch = current.epoch;
    token = current.token;

    return ElectionResult(
      role: BusHubRole.client,
      endpoint: current.endpoint,
      token: current.token,
      epoch: current.epoch,
    );
  }

  static String _generateToken() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
