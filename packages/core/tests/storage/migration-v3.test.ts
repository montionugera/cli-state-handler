import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MigrationRunner,
  MigrationError,
  CANONICAL_MIGRATIONS,
  TARGET_SCHEMA_VERSION,
  CHANGE_LOG_AND_BUS_SQL,
} from '../../src/storage/migration-runner.js';

describe('Schema Migration v3 (ucsa_change_log, ucsa_bus_hub, outbox lease columns)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-migration-v3-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrating a fresh database applies v1, v2, v3, sets user_version = 3, and creates all tables and columns', () => {
    const dbPath = path.join(tmpDir, 'fresh_v3.db');
    const db = new Database(dbPath);

    expect(MigrationRunner.getUserVersion(db)).toBe(0);

    const result = MigrationRunner.migrate(db, 3);
    expect(result.currentVersion).toBe(3);
    expect(result.appliedCount).toBe(3);
    expect(MigrationRunner.getUserVersion(db)).toBe(3);

    // Verify ucsa_migrations ledger has all 3 migrations
    const migrations = MigrationRunner.getAppliedMigrations(db);
    expect(migrations.size).toBe(3);

    const m3 = migrations.get(3);
    expect(m3).toBeDefined();
    expect(m3?.name).toBe('change_log_and_bus');
    expect(m3?.checksum).toBe(CANONICAL_MIGRATIONS[2].sha256);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain('ucsa_change_log');
    expect(tables).toContain('ucsa_bus_hub');
    expect(tables).toContain('ucsa_mutation_outbox');

    // Verify index on ucsa_change_log exists
    const indices = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: any) => r.name);
    expect(indices).toContain('idx_ucsa_change_log_created');

    // Verify lease columns on ucsa_mutation_outbox
    const outboxColumns = db
      .prepare('PRAGMA table_info(ucsa_mutation_outbox)')
      .all()
      .map((c: any) => c.name);

    expect(outboxColumns).toContain('lease_owner');
    expect(outboxColumns).toContain('lease_until');

    // Verify ucsa_change_log columns
    const changeLogColumns = db
      .prepare('PRAGMA table_info(ucsa_change_log)')
      .all()
      .map((c: any) => c.name);
    expect(changeLogColumns).toEqual(['seq', 'origin', 'kind', 'tags', 'query_hashes', 'detail', 'created_at']);

    // Verify ucsa_bus_hub columns
    const busHubColumns = db
      .prepare('PRAGMA table_info(ucsa_bus_hub)')
      .all()
      .map((c: any) => c.name);
    expect(busHubColumns).toEqual(['id', 'epoch', 'pid', 'endpoint', 'token', 'claimed_at']);

    db.close();
  });

  it('migrating an existing v2 database seamlessly applies v3 and preserves existing data', () => {
    const dbPath = path.join(tmpDir, 'v2_to_v3.db');
    const db = new Database(dbPath);

    // Step 1: Migrate up to v2
    const v2Result = MigrationRunner.migrate(db, 2);
    expect(v2Result.currentVersion).toBe(2);
    expect(v2Result.appliedCount).toBe(2);
    expect(MigrationRunner.getUserVersion(db)).toBe(2);

    // Insert preexisting outbox mutation without lease columns
    db.prepare(`
      INSERT INTO ucsa_mutation_outbox (mutation_id, endpoint, method, headers, payload, status, retry_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mut_pre_v3', '/api/v1/update', 'POST', null, '{"title":"Test"}', 'pending', 0, 1000);

    // Step 2: Migrate to v3
    const v3Result = MigrationRunner.migrate(db, 3);
    expect(v3Result.currentVersion).toBe(3);
    expect(v3Result.appliedCount).toBe(1);
    expect(MigrationRunner.getUserVersion(db)).toBe(3);

    // Verify preexisting record retained data and has NULL lease fields
    const row = db
      .prepare('SELECT mutation_id, status, lease_owner, lease_until FROM ucsa_mutation_outbox WHERE mutation_id = ?')
      .get('mut_pre_v3') as { mutation_id: string; status: string; lease_owner: string | null; lease_until: number | null };

    expect(row).toBeDefined();
    expect(row.mutation_id).toBe('mut_pre_v3');
    expect(row.status).toBe('pending');
    expect(row.lease_owner).toBeNull();
    expect(row.lease_until).toBeNull();

    // Verify lease columns can be updated
    db.prepare(`
      UPDATE ucsa_mutation_outbox
      SET lease_owner = ?, lease_until = ?
      WHERE mutation_id = ?
    `).run('worker-alpha', 2000, 'mut_pre_v3');

    const updated = db
      .prepare('SELECT lease_owner, lease_until FROM ucsa_mutation_outbox WHERE mutation_id = ?')
      .get('mut_pre_v3') as { lease_owner: string; lease_until: number };

    expect(updated.lease_owner).toBe('worker-alpha');
    expect(updated.lease_until).toBe(2000);

    db.close();
  });

  it('checks that ucsa_change_log rejects invalid kind values via CHECK constraint', () => {
    const dbPath = path.join(tmpDir, 'change_log_check.db');
    const db = new Database(dbPath);

    MigrationRunner.migrate(db, 3);

    const insertStmt = db.prepare(`
      INSERT INTO ucsa_change_log (origin, kind, tags, query_hashes, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Valid kinds: 'invalidate', 'mutation', 'stream', 'reset'
    for (const validKind of ['invalidate', 'mutation', 'stream', 'reset']) {
      expect(() => {
        insertStmt.run('client-1', validKind, '["tag1"]', '["q1"]', '{"ok":true}', Date.now());
      }).not.toThrow();
    }

    // Invalid kinds must fail CHECK constraint
    for (const invalidKind of ['delete', 'update', 'INVALID', '', 'random']) {
      expect(() => {
        insertStmt.run('client-1', invalidKind, null, null, null, Date.now());
      }).toThrow(/CHECK constraint failed/i);
    }

    db.close();
  });

  it('checks that ucsa_bus_hub rejects id != 1 via CHECK constraint', () => {
    const dbPath = path.join(tmpDir, 'bus_hub_check.db');
    const db = new Database(dbPath);

    MigrationRunner.migrate(db, 3);

    const insertStmt = db.prepare(`
      INSERT INTO ucsa_bus_hub (id, epoch, pid, endpoint, token, claimed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // id = 1 succeeds
    expect(() => {
      insertStmt.run(1, 1, 1234, 'ipc:///tmp/ucsa-bus.sock', 'auth-token-xyz', Date.now());
    }).not.toThrow();

    // id != 1 must fail CHECK constraint
    expect(() => {
      insertStmt.run(2, 1, 5678, 'ipc:///tmp/ucsa-bus.sock', 'auth-token-abc', Date.now());
    }).toThrow(/CHECK constraint failed/i);

    expect(() => {
      insertStmt.run(0, 1, 5678, 'ipc:///tmp/ucsa-bus.sock', 'auth-token-abc', Date.now());
    }).toThrow(/CHECK constraint failed/i);

    expect(() => {
      insertStmt.run(-1, 1, 5678, 'ipc:///tmp/ucsa-bus.sock', 'auth-token-abc', Date.now());
    }).toThrow(/CHECK constraint failed/i);

    db.close();
  });

  it('verifies transaction rollback on failure', () => {
    const dbPath = path.join(tmpDir, 'rollback_v3.db');
    const db = new Database(dbPath);

    // Apply migrations up to v2
    MigrationRunner.migrate(db, 2);
    expect(MigrationRunner.getUserVersion(db)).toBe(2);

    const failingMigrations = [
      CANONICAL_MIGRATIONS[0],
      CANONICAL_MIGRATIONS[1],
      {
        version: 3,
        name: 'failing_change_log_and_bus',
        sql: `
          CREATE TABLE ucsa_change_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            origin TEXT NOT NULL
          );
          THIS IS INVALID SQL TO TRIGGER IMMEDIATE SYNTAX FAILURE;
        `,
      },
    ];

    expect(() => {
      MigrationRunner.migrate(db, 3, failingMigrations);
    }).toThrow(MigrationError);

    // Assert user_version rolled back and remained 2
    expect(MigrationRunner.getUserVersion(db)).toBe(2);

    // Assert ucsa_change_log was rolled back and does NOT exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(tables).not.toContain('ucsa_change_log');
    expect(tables).not.toContain('ucsa_bus_hub');

    // Assert ucsa_migrations ledger does not record version 3
    const applied = MigrationRunner.getAppliedMigrations(db);
    expect(applied.size).toBe(2);
    expect(applied.has(3)).toBe(false);

    db.close();
  });
});
