import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { MigrationRunner } from '../../src/storage/migration-runner.js';

describe('Cross-Language Migration & Storage Fixtures', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ucsa-cross-lang-'));
    dbPath = join(tempDir, 'canonical_v1.db');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('generates canonical v2 database conforming to cross-language specification', () => {
    const adapter = new SqliteAdapter(dbPath);

    expect(adapter.getSchemaVersion()).toBe(2);

    // Populate standard UCSA records
    adapter.setQuery(
      {
        query_hash: 'user_100',
        query_key: ['users', 100],
        data_payload: { id: 100, name: 'Alice', active: true },
        created_at: 1700000000000,
        stale_at: 1700000060000,
        expires_at: 1700000600000,
        etag: 'w/"user-100-v1"',
      },
      ['tag:users', 'tag:tenant:1']
    );

    adapter.upsertCasObject('a1b2c3d4e5f6', 2048, 1700000000000);

    adapter.close();

    // Verify using raw SQLite connection as external Dart/C# engines would
    const rawDb = new Database(dbPath);
    const userVersion = rawDb.pragma('user_version', { simple: true });
    expect(userVersion).toBe(2);

    // Verify ucsa_migrations ledger
    const migration1 = rawDb
      .prepare('SELECT version, name, checksum FROM ucsa_migrations WHERE version = 1')
      .get() as { version: number; name: string; checksum: string };
    expect(migration1).toBeDefined();
    expect(migration1.version).toBe(1);
    expect(migration1.name).toBe('baseline');
    expect(migration1.checksum).toBe('fff0ce5e68c0644c5f61b60a05d9f50f6992392ad671abd06685da5a8c34f55c');

    const migration2 = rawDb
      .prepare('SELECT version, name, checksum FROM ucsa_migrations WHERE version = 2')
      .get() as { version: number; name: string; checksum: string };
    expect(migration2).toBeDefined();
    expect(migration2.version).toBe(2);
    expect(migration2.name).toBe('payload_version');
    expect(migration2.checksum).toBe('ab2fb5ac83e34e2b7a13de446cb3cf37778dafddbce0c3c65b22906015712dc1');

    // Verify query cache including payload_version column
    const query = rawDb
      .prepare('SELECT query_key, data_payload, etag, payload_version FROM ucsa_query_cache WHERE query_hash = ?')
      .get('user_100') as { query_key: string; data_payload: string; etag: string; payload_version: number };
    expect(JSON.parse(query.query_key)).toEqual(['users', 100]);
    expect(JSON.parse(query.data_payload)).toEqual({ id: 100, name: 'Alice', active: true });
    expect(query.etag).toBe('w/"user-100-v1"');
    expect(query.payload_version).toBe(1);

    // Verify tag indexing
    const tags = rawDb
      .prepare('SELECT tag FROM ucsa_cache_tags WHERE query_hash = ? ORDER BY tag ASC')
      .all('user_100') as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(['tag:tenant:1', 'tag:users']);

    // Verify CAS object record
    const cas = rawDb
      .prepare('SELECT size, last_accessed_at FROM ucsa_cas_objects WHERE hash = ?')
      .get('a1b2c3d4e5f6') as { size: number; last_accessed_at: number };
    expect(cas.size).toBe(2048);
    expect(cas.last_accessed_at).toBe(1700000000000);

    rawDb.close();

    // Reopen with new adapter instance -> should recognize version 2 and 0 pending migrations
    const reloadedAdapter = new SqliteAdapter(dbPath);
    expect(reloadedAdapter.getSchemaVersion()).toBe(2);
    const retrieved = reloadedAdapter.getQuery('user_100');
    expect(retrieved).toBeDefined();
    expect(retrieved?.data_payload).toEqual({ id: 100, name: 'Alice', active: true });
    reloadedAdapter.close();
  });

  it('rejects foreign database with future schema version', () => {
    // Manually create DB with user_version = 42
    const rawDb = new Database(dbPath);
    rawDb.pragma('user_version = 42');
    rawDb.close();

    expect(() => new SqliteAdapter(dbPath)).toThrow(/newer than supported version/);
  });
});
