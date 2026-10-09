import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MigrationRunner,
  DatabaseVersionTooNewError,
  MigrationChecksumMismatchError,
  MigrationError,
  CANONICAL_MIGRATIONS,
  TARGET_SCHEMA_VERSION,
  computeSqlChecksum,
} from '../../src/storage/migration-runner.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';

describe('Schema Migration Runner & Versioning Engine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-migration-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates fresh database from user_version 0 to target version 4 by default', () => {
    const dbPath = path.join(tmpDir, 'fresh.db');
    const db = new Database(dbPath);

    expect(MigrationRunner.getUserVersion(db)).toBe(0);

    const result = MigrationRunner.migrate(db);
    expect(result.currentVersion).toBe(4);
    expect(result.appliedCount).toBe(4);
    expect(MigrationRunner.getUserVersion(db)).toBe(4);

    // Verify ucsa_migrations ledger
    const migrations = MigrationRunner.getAppliedMigrations(db);
    expect(migrations.size).toBe(4);
    const m1 = migrations.get(1);
    expect(m1).toBeDefined();
    expect(m1?.name).toBe('baseline');
    expect(m1?.checksum).toBe(CANONICAL_MIGRATIONS[0].sha256);

    const m2 = migrations.get(2);
    expect(m2).toBeDefined();
    expect(m2?.name).toBe('payload_version');
    expect(m2?.checksum).toBe(CANONICAL_MIGRATIONS[1].sha256);

    const m3 = migrations.get(3);
    expect(m3).toBeDefined();
    expect(m3?.name).toBe('change_log_and_bus');
    expect(m3?.checksum).toBe(CANONICAL_MIGRATIONS[2].sha256);

    const m4 = migrations.get(4);
    expect(m4).toBeDefined();
    expect(m4?.name).toBe('streaming_chunk_store');
    expect(m4?.checksum).toBe(CANONICAL_MIGRATIONS[3].sha256);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain('ucsa_migrations');
    expect(tables).toContain('ucsa_query_cache');
    expect(tables).toContain('ucsa_cache_tags');
    expect(tables).toContain('ucsa_mutation_outbox');
    expect(tables).toContain('ucsa_cas_objects');
    expect(tables).toContain('ucsa_meta');
    expect(tables).toContain('ucsa_change_log');
    expect(tables).toContain('ucsa_bus_hub');
    expect(tables).toContain('ucsa_streams');
    expect(tables).toContain('ucsa_stream_chunks');
    expect(tables).toContain('ucsa_stream_tags');

    // Verify payload_version column exists on ucsa_query_cache
    const columns = db
      .prepare("PRAGMA table_info(ucsa_query_cache)")
      .all()
      .map((c: any) => c.name);
    expect(columns).toContain('payload_version');

    db.close();
  });

  it('migrates fresh database to version 1 when explicitly targeted', () => {
    const dbPath = path.join(tmpDir, 'v1_targeted.db');
    const db = new Database(dbPath);

    const result = MigrationRunner.migrate(db, 1);
    expect(result.currentVersion).toBe(1);
    expect(result.appliedCount).toBe(1);
    expect(MigrationRunner.getUserVersion(db)).toBe(1);

    const columns = db
      .prepare("PRAGMA table_info(ucsa_query_cache)")
      .all()
      .map((c: any) => c.name);
    expect(columns).not.toContain('payload_version');

    db.close();
  });

  it('migrates incrementally from version 1 to version 2 with default payload_version on preexisting rows', () => {
    const dbPath = path.join(tmpDir, 'incremental.db');
    const db = new Database(dbPath);

    // 1. Migrate to v1
    const v1Result = MigrationRunner.migrate(db, 1);
    expect(v1Result.currentVersion).toBe(1);
    expect(MigrationRunner.getUserVersion(db)).toBe(1);

    // 2. Insert row in v1 schema
    db.prepare(`
      INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('user_v1', '["users", 1]', JSON.stringify({ name: 'Alice' }), 'etag1', 1000, 2000, 3000);

    // 3. Migrate incrementally to v2
    const v2Result = MigrationRunner.migrate(db, 2);
    expect(v2Result.currentVersion).toBe(2);
    expect(v2Result.appliedCount).toBe(1);
    expect(MigrationRunner.getUserVersion(db)).toBe(2);

    // 4. Assert preexisting row has payload_version = 1
    const row = db
      .prepare('SELECT query_hash, payload_version, data_payload FROM ucsa_query_cache WHERE query_hash = ?')
      .get('user_v1') as { query_hash: string; payload_version: number; data_payload: string };

    expect(row).toBeDefined();
    expect(row.payload_version).toBe(1);
    expect(JSON.parse(row.data_payload)).toEqual({ name: 'Alice' });

    db.close();
  });

  it('executes idempotently when already up-to-date', () => {
    const dbPath = path.join(tmpDir, 'idempotent.db');
    const db = new Database(dbPath);

    MigrationRunner.migrate(db);
    expect(MigrationRunner.getUserVersion(db)).toBe(4);

    const rerun = MigrationRunner.migrate(db);
    expect(rerun.currentVersion).toBe(4);
    expect(rerun.appliedCount).toBe(0);

    db.close();
  });

  it('rolls back atomically if a migration step fails', () => {
    const dbPath = path.join(tmpDir, 'rollback.db');
    const db = new Database(dbPath);

    const customMigrations = [
      CANONICAL_MIGRATIONS[0],
      CANONICAL_MIGRATIONS[1],
      {
        version: 3,
        name: 'failing_step',
        sql: 'INVALID SYNTAX SQL STATEMENT THAT WILL FAIL;',
      },
    ];

    // First apply canonical migrations up to v2
    MigrationRunner.migrate(db, 2);
    expect(MigrationRunner.getUserVersion(db)).toBe(2);

    // Try applying failing migration v3
    expect(() => {
      MigrationRunner.migrate(db, 3, customMigrations);
    }).toThrow(MigrationError);

    // Assert user_version rolled back and remained 2
    expect(MigrationRunner.getUserVersion(db)).toBe(2);
    const applied = MigrationRunner.getAppliedMigrations(db);
    expect(applied.size).toBe(2);
    expect(applied.has(3)).toBe(false);

    db.close();
  });

  it('throws DatabaseVersionTooNewError when opening a database with future version', () => {
    const dbPath = path.join(tmpDir, 'future.db');
    const db = new Database(dbPath);

    MigrationRunner.setUserVersion(db, 99);

    expect(() => {
      MigrationRunner.migrate(db, TARGET_SCHEMA_VERSION);
    }).toThrow(DatabaseVersionTooNewError);

    db.close();
  });

  it('throws MigrationChecksumMismatchError if recorded checksum has been tampered with', () => {
    const dbPath = path.join(tmpDir, 'tampered.db');
    const db = new Database(dbPath);

    MigrationRunner.migrate(db, 2);

    // Tamper with the recorded checksum
    db.prepare("UPDATE ucsa_migrations SET checksum = 'corrupted_hash' WHERE version = 1").run();

    expect(() => {
      MigrationRunner.migrate(db, 2);
    }).toThrow(MigrationChecksumMismatchError);

    db.close();
  });

  it('adopts legacy unversioned UCSA v1.4 database with zero data loss', () => {
    const dbPath = path.join(tmpDir, 'legacy_v1_4.db');
    const legacyDb = new Database(dbPath);

    // Simulate v1.4 database created without user_version
    legacyDb.exec(`
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
      CREATE TABLE ucsa_mutation_outbox (
        mutation_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        headers TEXT,
        payload TEXT,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        error TEXT,
        forced INTEGER DEFAULT 0
      );
      CREATE TABLE ucsa_cas_objects (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
    `);

    // Populate pre-existing data
    legacyDb.prepare(`
      INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('hash_legacy_1', '["legacy", 1]', JSON.stringify({ message: 'Legacy v1.4 Data' }), '"etag-1"', 1000, 2000, 5000);

    legacyDb.prepare(`
      INSERT INTO ucsa_cache_tags (tag, query_hash) VALUES (?, ?)
    `).run('tag:legacy', 'hash_legacy_1');

    legacyDb.prepare(`
      INSERT INTO ucsa_mutation_outbox (mutation_id, endpoint, method, headers, payload, status, retry_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mut_legacy_1', '/api/v1/legacy', 'POST', null, '{"action":"sync"}', 'pending', 0, 1000);

    legacyDb.prepare(`
      INSERT INTO ucsa_cas_objects (hash, size, last_accessed_at)
      VALUES (?, ?, ?)
    `).run('cas_hash_1', 1024, 1500);

    legacyDb.close();

    // Now open via SqliteAdapter
    const adapter = new SqliteAdapter(dbPath);
    expect(adapter.getSchemaVersion()).toBe(4);

    // Verify pre-existing data is preserved 100%
    const query = adapter.getQuery<{ message: string }>('hash_legacy_1');
    expect(query).toBeDefined();
    expect(query?.data_payload.message).toBe('Legacy v1.4 Data');
    expect(query?.etag).toBe('"etag-1"');

    const tags = adapter.getQueryHashesByTag('tag:legacy');
    expect(tags).toEqual(['hash_legacy_1']);

    const casObj = adapter.getCasObject('cas_hash_1');
    expect(casObj).toBeDefined();
    expect(casObj?.size).toBe(1024);

    adapter.close();
  });

  it('supports multiple concurrent SqliteAdapter connections to the same file', () => {
    const dbPath = path.join(tmpDir, 'concurrent.db');

    const adapter1 = new SqliteAdapter(dbPath);
    const adapter2 = new SqliteAdapter(dbPath);

    expect(adapter1.getSchemaVersion()).toBe(4);
    expect(adapter2.getSchemaVersion()).toBe(4);

    adapter1.setQuery({
      query_hash: 'q1',
      query_key: ['concurrent', 1],
      data_payload: { active: true },
      created_at: 1000,
      stale_at: 2000,
      expires_at: 5000,
    });

    const cached = adapter2.getQuery<{ active: boolean }>('q1');
    expect(cached?.data_payload.active).toBe(true);

    adapter1.close();
    adapter2.close();
  });
});
