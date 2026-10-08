import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:sqlite3/sqlite3.dart';

class DatabaseVersionTooNewException implements Exception {
  final int currentVersion;
  final int supportedVersion;

  DatabaseVersionTooNewException(this.currentVersion, this.supportedVersion);

  @override
  String toString() =>
      'DatabaseVersionTooNewException: Database schema version $currentVersion is '
      'newer than supported version $supportedVersion. Please upgrade the UCSA client.';
}

class MigrationChecksumMismatchException implements Exception {
  final int version;
  final String expectedChecksum;
  final String actualChecksum;

  MigrationChecksumMismatchException(
      this.version, this.expectedChecksum, this.actualChecksum);

  @override
  String toString() =>
      'MigrationChecksumMismatchException: Checksum mismatch for migration $version: '
      'expected $expectedChecksum, found $actualChecksum.';
}

class MigrationException implements Exception {
  final int version;
  final Object cause;

  MigrationException(this.version, this.cause);

  @override
  String toString() => 'MigrationException: Failed to apply migration $version: $cause';
}

class AppliedMigrationRecord {
  final int version;
  final String name;
  final int appliedAt;
  final String checksum;

  AppliedMigrationRecord({
    required this.version,
    required this.name,
    required this.appliedAt,
    required this.checksum,
  });
}

class MigrationDefinition {
  final int version;
  final String name;
  final String sql;
  final String? sha256;

  const MigrationDefinition({
    required this.version,
    required this.name,
    required this.sql,
    this.sha256,
  });
}

const int targetSchemaVersion = 2;

const String baselineSql = '''-- Migration 0001: Baseline Canonical Schema for UCSA
CREATE TABLE IF NOT EXISTS ucsa_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ucsa_query_cache (
  query_hash TEXT PRIMARY KEY,
  query_key TEXT NOT NULL,
  data_payload TEXT NOT NULL,
  etag TEXT,
  created_at INTEGER NOT NULL,
  stale_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_cache_expires ON ucsa_query_cache(expires_at);

CREATE TABLE IF NOT EXISTS ucsa_cache_tags (
  tag TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  PRIMARY KEY (tag, query_hash),
  FOREIGN KEY (query_hash) REFERENCES ucsa_query_cache(query_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucsa_tags_hash ON ucsa_cache_tags(query_hash);
CREATE INDEX IF NOT EXISTS idx_ucsa_tags_tag ON ucsa_cache_tags(tag);

CREATE TABLE IF NOT EXISTS ucsa_mutation_outbox (
  mutation_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  headers TEXT,
  payload TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  error TEXT,
  forced INTEGER DEFAULT 0,
  conflict_policy TEXT DEFAULT 'server-wins'
);
CREATE INDEX IF NOT EXISTS idx_ucsa_outbox_status ON ucsa_mutation_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS ucsa_cas_objects (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ucsa_cas_access ON ucsa_cas_objects(last_accessed_at);
''';

const String payloadVersionSql = '''-- Migration 0002: Add payload_version to ucsa_query_cache
ALTER TABLE ucsa_query_cache ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_ucsa_cache_payload_version ON ucsa_query_cache(payload_version);
''';

const List<MigrationDefinition> canonicalMigrations = [
  MigrationDefinition(
    version: 1,
    name: 'baseline',
    sql: baselineSql,
    sha256: 'fff0ce5e68c0644c5f61b60a05d9f50f6992392ad671abd06685da5a8c34f55c',
  ),
  MigrationDefinition(
    version: 2,
    name: 'payload_version',
    sql: payloadVersionSql,
    sha256: 'ab2fb5ac83e34e2b7a13de446cb3cf37778dafddbce0c3c65b22906015712dc1',
  ),
];

class MigrationResult {
  final int currentVersion;
  final int appliedCount;

  MigrationResult({required this.currentVersion, required this.appliedCount});
}

class MigrationRunner {
  static int getUserVersion(Database db) {
    final result = db.select('PRAGMA user_version;');
    if (result.isEmpty) return 0;
    return result.first.values.first as int? ?? 0;
  }

  static void setUserVersion(Database db, int version) {
    db.execute('PRAGMA user_version = $version;');
  }

  static void initMigrationsTable(Database db) {
    db.execute('''
      CREATE TABLE IF NOT EXISTS ucsa_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
    ''');
  }

  static Map<int, AppliedMigrationRecord> getAppliedMigrations(Database db) {
    initMigrationsTable(db);
    final rows = db.select(
        'SELECT version, name, applied_at, checksum FROM ucsa_migrations ORDER BY version ASC;');
    final map = <int, AppliedMigrationRecord>{};
    for (final row in rows) {
      final v = row['version'] as int;
      map[v] = AppliedMigrationRecord(
        version: v,
        name: row['name'] as String,
        appliedAt: row['applied_at'] as int,
        checksum: row['checksum'] as String,
      );
    }
    return map;
  }

  static String computeChecksum(String sql) {
    return sha256.convert(utf8.encode(sql.trim())).toString();
  }

  static MigrationResult migrate(
    Database db, {
    int targetVersion = targetSchemaVersion,
    List<MigrationDefinition> availableMigrations = canonicalMigrations,
  }) {
    final currentVersion = getUserVersion(db);

    if (currentVersion > targetVersion) {
      throw DatabaseVersionTooNewException(currentVersion, targetVersion);
    }

    initMigrationsTable(db);
    final appliedMap = getAppliedMigrations(db);

    // Verify existing checksums
    for (final migration in availableMigrations) {
      if (appliedMap.containsKey(migration.version)) {
        final applied = appliedMap[migration.version]!;
        final expected = migration.sha256 ?? computeChecksum(migration.sql);
        if (applied.checksum != expected) {
          throw MigrationChecksumMismatchException(
              migration.version, expected, applied.checksum);
        }
      }
    }

    // Filter pending migrations
    final pending = availableMigrations
        .where((m) => m.version > currentVersion && m.version <= targetVersion)
        .toList()
      ..sort((a, b) => a.version.compareTo(b.version));

    if (pending.isEmpty) {
      return MigrationResult(currentVersion: currentVersion, appliedCount: 0);
    }

    // Execute in a transaction
    db.execute('BEGIN IMMEDIATE;');
    try {
      final insertStmt = db.prepare(
          'INSERT INTO ucsa_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?);');

      for (final m in pending) {
        db.execute(m.sql);
        final checksum = m.sha256 ?? computeChecksum(m.sql);
        insertStmt.execute([m.version, m.name, DateTime.now().millisecondsSinceEpoch, checksum]);
        setUserVersion(db, m.version);
      }
      insertStmt.dispose();
      db.execute('COMMIT;');
    } catch (err) {
      db.execute('ROLLBACK;');
      throw MigrationException(pending.first.version, err);
    }

    return MigrationResult(
      currentVersion: getUserVersion(db),
      appliedCount: pending.length,
    );
  }
}
