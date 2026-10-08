import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

void main() {
  late Directory tempDir;

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('ucsa_dart_migration_test_');
  });

  tearDown(() {
    if (tempDir.existsSync()) {
      tempDir.deleteSync(recursive: true);
    }
  });

  test('migrates fresh database from user_version 0 to target version 2 by default', () {
    final dbFile = File('${tempDir.path}/fresh.db');
    final db = sqlite3.open(dbFile.path);

    expect(MigrationRunner.getUserVersion(db), equals(0));

    final result = MigrationRunner.migrate(db);
    expect(result.currentVersion, equals(2));
    expect(result.appliedCount, equals(2));
    expect(MigrationRunner.getUserVersion(db), equals(2));

    // Verify ucsa_migrations table
    final migrations = MigrationRunner.getAppliedMigrations(db);
    expect(migrations.length, equals(2));
    expect(migrations[1]?.name, equals('baseline'));
    expect(migrations[1]?.checksum, equals(canonicalMigrations[0].sha256));
    expect(migrations[2]?.name, equals('payload_version'));
    expect(migrations[2]?.checksum, equals(canonicalMigrations[1].sha256));

    // Verify tables exist
    final tables = db
        .select("SELECT name FROM sqlite_master WHERE type='table';")
        .map((r) => r['name'] as String)
        .toList();

    expect(tables, contains('ucsa_migrations'));
    expect(tables, contains('ucsa_query_cache'));
    expect(tables, contains('ucsa_cache_tags'));
    expect(tables, contains('ucsa_mutation_outbox'));
    expect(tables, contains('ucsa_cas_objects'));
    expect(tables, contains('ucsa_meta'));

    // Verify payload_version column exists on ucsa_query_cache
    final columns = db
        .select("PRAGMA table_info(ucsa_query_cache);")
        .map((r) => r['name'] as String)
        .toList();
    expect(columns, contains('payload_version'));

    db.dispose();
  });

  test('migrates incrementally from version 1 to version 2 with default payload_version', () {
    final dbFile = File('${tempDir.path}/incremental.db');
    final db = sqlite3.open(dbFile.path);

    // 1. Migrate to v1
    final v1Result = MigrationRunner.migrate(db, targetVersion: 1);
    expect(v1Result.currentVersion, equals(1));
    expect(MigrationRunner.getUserVersion(db), equals(1));

    // 2. Insert row in v1
    db.execute('''
      INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at)
      VALUES ('user_v1', '["users", 1]', '{"name":"Alice"}', 'etag1', 1000, 2000, 3000);
    ''');

    // 3. Migrate to v2
    final v2Result = MigrationRunner.migrate(db, targetVersion: 2);
    expect(v2Result.currentVersion, equals(2));
    expect(v2Result.appliedCount, equals(1));
    expect(MigrationRunner.getUserVersion(db), equals(2));

    // 4. Assert preexisting row has payload_version = 1
    final rows = db.select("SELECT payload_version, data_payload FROM ucsa_query_cache WHERE query_hash = 'user_v1';");
    expect(rows.length, equals(1));
    expect(rows.first['payload_version'], equals(1));

    db.dispose();
  });

  test('executes idempotently when already up-to-date', () {
    final dbFile = File('${tempDir.path}/idempotent.db');
    final db = sqlite3.open(dbFile.path);

    MigrationRunner.migrate(db);
    expect(MigrationRunner.getUserVersion(db), equals(2));

    final rerun = MigrationRunner.migrate(db);
    expect(rerun.currentVersion, equals(2));
    expect(rerun.appliedCount, equals(0));

    db.dispose();
  });

  test('rolls back atomically if a migration step fails', () {
    final dbFile = File('${tempDir.path}/rollback.db');
    final db = sqlite3.open(dbFile.path);

    final customMigrations = [
      ...canonicalMigrations,
      const MigrationDefinition(
        version: 3,
        name: 'failing_step',
        sql: 'INVALID SYNTAX SQL STATEMENT THAT WILL FAIL;',
      ),
    ];

    MigrationRunner.migrate(db, targetVersion: 2);
    expect(MigrationRunner.getUserVersion(db), equals(2));

    expect(
      () => MigrationRunner.migrate(db,
          targetVersion: 3, availableMigrations: customMigrations),
      throwsA(isA<MigrationException>()),
    );

    expect(MigrationRunner.getUserVersion(db), equals(2));
    final applied = MigrationRunner.getAppliedMigrations(db);
    expect(applied.length, equals(2));
    expect(applied.containsKey(3), isFalse);

    db.dispose();
  });

  test('throws DatabaseVersionTooNewException when opening future database version', () {
    final dbFile = File('${tempDir.path}/future.db');
    final db = sqlite3.open(dbFile.path);

    MigrationRunner.setUserVersion(db, 99);

    expect(
      () => MigrationRunner.migrate(db, targetVersion: targetSchemaVersion),
      throwsA(isA<DatabaseVersionTooNewException>()),
    );

    db.dispose();
  });

  test('adopts legacy unversioned UCSA v1.4 database with zero data loss', () {
    final dbFile = File('${tempDir.path}/legacy.db');
    final legacyDb = sqlite3.open(dbFile.path);

    legacyDb.execute('''
      CREATE TABLE ucsa_query_cache (
        query_hash TEXT PRIMARY KEY,
        query_key TEXT NOT NULL,
        data_payload TEXT NOT NULL,
        etag TEXT,
        created_at INTEGER NOT NULL,
        stale_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE ucsa_cache_tags (
        tag TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        PRIMARY KEY (tag, query_hash),
        FOREIGN KEY (query_hash) REFERENCES ucsa_query_cache(query_hash) ON DELETE CASCADE
      );
    ''');

    legacyDb.execute('''
      INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at)
      VALUES ('h_legacy_dart', '["dart", 10]', '{"status":"ok"}', '"etag-dart"', 1000, 2000, 5000);
    ''');
    legacyDb.execute('''
      INSERT INTO ucsa_cache_tags (tag, query_hash) VALUES ('tag:dart_legacy', 'h_legacy_dart');
    ''');

    legacyDb.dispose();

    final adapter = SqliteAdapter.file(dbFile.path);
    expect(adapter.getSchemaVersion(), equals(2));

    final entry = adapter.getQuery<Map<String, dynamic>>('h_legacy_dart');
    expect(entry, isNotNull);
    expect(entry?.dataPayload['status'], equals('ok'));
    expect(entry?.etag, equals('"etag-dart"'));

    final hashes = adapter.getQueryHashesByTag('tag:dart_legacy');
    expect(hashes, equals(['h_legacy_dart']));

    adapter.close();
  });
}
