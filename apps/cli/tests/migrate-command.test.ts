import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { runMigrate } from '../src/commands/migrate.js';
import { parseArgs, dispatchCommand, getHelpText } from '../src/router.js';

describe('CLI Migrate Command Suite', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-cli-migrate-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports migration status with user_version, applied and pending migrations', async () => {
    // Fresh unmigrated DB
    const freshResult = await runMigrate('status', { db: dbPath });
    expect(freshResult.action).toBe('status');
    expect(freshResult.currentVersion).toBe(0);
    expect(freshResult.targetVersion).toBe(2);
    expect(freshResult.pendingCount).toBe(2);
    expect(freshResult.appliedCount).toBe(0);

    // After migration
    await runMigrate('up', { db: dbPath });
    const migratedResult = await runMigrate('status', { db: dbPath });
    expect(migratedResult.currentVersion).toBe(2);
    expect(migratedResult.appliedCount).toBe(2);
    expect(migratedResult.pendingCount).toBe(0);
  });

  it('runs pending migrations and upgrades schema version with runMigrate("up")', async () => {
    // 1. Create a database at version 1 manually
    const rawDb = new Database(dbPath);
    rawDb.pragma('user_version = 1');
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS ucsa_query_cache (
        query_hash TEXT PRIMARY KEY,
        query_key TEXT NOT NULL,
        data_payload TEXT NOT NULL,
        etag TEXT,
        created_at INTEGER NOT NULL,
        stale_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ucsa_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO ucsa_migrations (version, name, checksum, applied_at)
      VALUES (1, '0001_baseline.sql', 'fff0ce5e68c0644c5f61b60a05d9f50f6992392ad671abd06685da5a8c34f55c', 1000);
    `);
    rawDb.close();

    const result = await runMigrate('up', { db: dbPath });

    expect(result.action).toBe('up');
    expect(result.currentVersion).toBe(2);
    expect(result.appliedCount).toBe(1); // 0002_payload_version applied
  });

  it('checks schema integrity returning upToDate status', async () => {
    // Create fully migrated database
    await runMigrate('up', { db: dbPath });

    const checkResult = await runMigrate('check', { db: dbPath });
    expect(checkResult.action).toBe('check');
    expect(checkResult.upToDate).toBe(true);
    expect(checkResult.currentVersion).toBe(2);

    // Create an unmigrated database
    const oldDbPath = path.join(tempDir, 'old.db');
    const rawDb = new Database(oldDbPath);
    rawDb.pragma('user_version = 0');
    rawDb.close();

    const pendingResult = await runMigrate('check', { db: oldDbPath });
    expect(pendingResult.upToDate).toBe(false);
    expect(pendingResult.pendingCount).toBeGreaterThan(0);
  });

  it('clean-incompatible selectively evicts corrupted/un-upcastable cache entries while preserving 100% of outbox mutations', async () => {
    // Initialize DB with schema v2
    await runMigrate('up', { db: dbPath });

    const rawDb = new Database(dbPath);
    // 1. Insert 2 valid entries
    rawDb
      .prepare(
        `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('valid-1', '["valid",1]', JSON.stringify({ ok: true }), Date.now(), Date.now() + 1000, Date.now() + 2000, 2);
    rawDb
      .prepare(
        `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('valid-2', '["valid",2]', JSON.stringify({ ok: true }), Date.now(), Date.now() + 1000, Date.now() + 2000, 1);

    // 2. Insert 2 corrupted entries
    rawDb
      .prepare(
        `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('corrupt-json', '["bad"]', 'NOT_JSON_{{', Date.now(), Date.now() + 1000, Date.now() + 2000, 1);
    rawDb
      .prepare(
        `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('future-version', '["future"]', JSON.stringify({ foo: 'bar' }), Date.now(), Date.now() + 1000, Date.now() + 2000, 999);

    // 3. Insert 3 pending mutations in outbox
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS ucsa_mutation_outbox (
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
      INSERT INTO ucsa_mutation_outbox (mutation_id, endpoint, method, status, retry_count, created_at)
      VALUES
        ('mut-1', '/api/orders/1', 'POST', 'pending', 0, 1000),
        ('mut-2', '/api/orders/2', 'POST', 'pending', 0, 1001),
        ('mut-3', '/api/orders/3', 'POST', 'pending', 0, 1002);
    `);
    rawDb.close();

    // 4. Run clean-incompatible
    const cleanResult = await runMigrate('clean-incompatible', { db: dbPath, targetVersion: 2 });
    expect(cleanResult.action).toBe('clean-incompatible');
    expect(cleanResult.evictedCount).toBe(2);
    expect(cleanResult.outboxMutationsCount).toBe(3);

    // Verify SQLite contents directly
    const verifyDb = new Database(dbPath);
    const remainingQueries = verifyDb.prepare('SELECT query_hash FROM ucsa_query_cache').all() as any[];
    expect(remainingQueries).toHaveLength(2);
    expect(remainingQueries.map((r) => r.query_hash).sort()).toEqual(['valid-1', 'valid-2']);

    const remainingMutations = verifyDb.prepare('SELECT mutation_id FROM ucsa_mutation_outbox').all() as any[];
    expect(remainingMutations).toHaveLength(3);
    verifyDb.close();
  });

  it('parses CLI commands and flags correctly in router', () => {
    expect(parseArgs(['migrate', 'status'])).toEqual({
      command: 'migrate status',
      args: [],
      options: {},
    });

    expect(parseArgs(['migrate', 'up', '--db', 'prod.db'])).toEqual({
      command: 'migrate up',
      args: [],
      options: { db: 'prod.db' },
    });

    expect(parseArgs(['migrate:check'])).toEqual({
      command: 'migrate check',
      args: [],
      options: {},
    });

    expect(
      parseArgs(['migrate', 'clean-incompatible', '--target-version', '2'])
    ).toEqual({
      command: 'migrate clean-incompatible',
      args: [],
      options: { 'target-version': '2', targetVersion: '2' },
    });
  });

  it('dispatches migrate commands through dispatchCommand without throwing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dispatchCommand({
      command: 'migrate status',
      args: [],
      options: { db: dbPath },
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
