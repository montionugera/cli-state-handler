import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteAdapter,
  insertTags,
  getQueryHashesByTag,
  deleteTagsForQuery,
} from '../../src/index.js';
import type { CacheEntry } from '../../src/index.js';


describe('SQLite Persistence Adapter & Tag Index Engine', () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    adapter = new SqliteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('creates tables: ucsa_query_cache, ucsa_cache_tags, and ucsa_mutation_outbox', () => {
    const tables = adapter.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ucsa_%' ORDER BY name ASC"
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('ucsa_query_cache');
    expect(tableNames).toContain('ucsa_cache_tags');
    expect(tableNames).toContain('ucsa_mutation_outbox');
  });

  it('declares explicit TEXT column types for query_key and data_payload to avoid NUMERIC coercion', () => {
    const tableInfo = adapter.db
      .prepare('PRAGMA table_info(ucsa_query_cache)')
      .all() as Array<{ name: string; type: string }>;

    const queryKeyCol = tableInfo.find((c) => c.name === 'query_key');
    const dataPayloadCol = tableInfo.find((c) => c.name === 'data_payload');
    const queryHashCol = tableInfo.find((c) => c.name === 'query_hash');

    expect(queryKeyCol).toBeDefined();
    expect(queryKeyCol?.type).toBe('TEXT');

    expect(dataPayloadCol).toBeDefined();
    expect(dataPayloadCol?.type).toBe('TEXT');

    expect(queryHashCol).toBeDefined();
    expect(queryHashCol?.type).toBe('TEXT');
  });

  it('configures PRAGMA busy_timeout = 5000', () => {
    const busyTimeout = adapter.db.pragma('busy_timeout', { simple: true });
    expect(busyTimeout).toBe(5000);
  });

  it('serializes numeric array query keys to JSON string and deserializes with types intact', () => {
    const queryKey = ['users', 100, { id: 200 }];
    const entry: CacheEntry<{ name: string }> = {
      query_hash: 'hash_numeric_key_1',
      query_key: queryKey,
      data_payload: { name: 'Alice' },
      etag: '"v1"',
      created_at: 1000,
      stale_at: 2000,
      expires_at: 5000,
    };

    adapter.setQuery(entry);

    // Verify raw storage in SQLite
    const rawRow = adapter.db
      .prepare('SELECT query_key, data_payload FROM ucsa_query_cache WHERE query_hash = ?')
      .get(entry.query_hash) as { query_key: string; data_payload: string };

    expect(typeof rawRow.query_key).toBe('string');
    expect(rawRow.query_key).toBe(JSON.stringify(queryKey));

    // Verify deserialization via getQuery
    const loaded = adapter.getQuery<{ name: string }>(entry.query_hash);
    expect(loaded).not.toBeNull();
    expect(loaded?.query_key).toEqual(['users', 100, { id: 200 }]);

    // Strict type checks on deserialized elements
    expect(typeof loaded?.query_key[0]).toBe('string');
    expect(loaded?.query_key[0]).toBe('users');
    expect(typeof loaded?.query_key[1]).toBe('number');
    expect(loaded?.query_key[1]).toBe(100);

    const objElement = loaded?.query_key[2] as { id: number };
    expect(typeof objElement).toBe('object');
    expect(typeof objElement.id).toBe('number');
    expect(objElement.id).toBe(200);

    expect(loaded?.data_payload).toEqual({ name: 'Alice' });
  });

  it('inserts tag index records and getQueryHashesByTag(tag) returns matching hashes', () => {
    const entry1: CacheEntry<string> = {
      query_hash: 'hash_1',
      query_key: ['item', 1],
      data_payload: 'item 1',
      created_at: 100,
      stale_at: 200,
      expires_at: 1000,
    };

    const entry2: CacheEntry<string> = {
      query_hash: 'hash_2',
      query_key: ['item', 2],
      data_payload: 'item 2',
      created_at: 100,
      stale_at: 200,
      expires_at: 1000,
    };

    adapter.setQuery(entry1, ['tag-shared', 'tag-single-1']);
    adapter.setQuery(entry2, ['tag-shared', 'tag-single-2']);

    const sharedHashes = adapter.getQueryHashesByTag('tag-shared');
    expect(sharedHashes.sort()).toEqual(['hash_1', 'hash_2'].sort());

    const single1Hashes = adapter.getQueryHashesByTag('tag-single-1');
    expect(single1Hashes).toEqual(['hash_1']);

    const nonexistentHashes = adapter.getQueryHashesByTag('tag-nonexistent');
    expect(nonexistentHashes).toEqual([]);

    // Also test standalone tag-index helper function
    const standaloneHashes = getQueryHashesByTag(adapter.db, 'tag-shared');
    expect(standaloneHashes.sort()).toEqual(['hash_1', 'hash_2'].sort());
  });

  it('cascades and cleans up ucsa_cache_tags when a query is deleted from ucsa_query_cache', () => {
    const entry: CacheEntry<{ val: number }> = {
      query_hash: 'hash_cascade_test',
      query_key: ['cascade', 'test'],
      data_payload: { val: 42 },
      created_at: 100,
      stale_at: 200,
      expires_at: 1000,
    };

    adapter.setQuery(entry, ['tag:a', 'tag:b', 'tag:c']);

    // Check tags exist before deletion
    const tagsBefore = adapter.db
      .prepare('SELECT tag FROM ucsa_cache_tags WHERE query_hash = ?')
      .all(entry.query_hash) as Array<{ tag: string }>;
    expect(tagsBefore).toHaveLength(3);

    // Delete query via adapter
    adapter.deleteQuery(entry.query_hash);

    // Verify query is gone
    expect(adapter.getQuery(entry.query_hash)).toBeNull();

    // Verify foreign key cascade removed tag associations
    const tagsAfter = adapter.db
      .prepare('SELECT tag FROM ucsa_cache_tags WHERE query_hash = ?')
      .all(entry.query_hash);
    expect(tagsAfter).toEqual([]);
  });

  it('correctly filters expired entries with getExpiredQueries(now)', () => {
    const entryExpired1: CacheEntry<string> = {
      query_hash: 'hash_expired_1',
      query_key: ['expired', 1],
      data_payload: 'exp1',
      created_at: 1000,
      stale_at: 1500,
      expires_at: 2000,
    };

    const entryExpired2: CacheEntry<string> = {
      query_hash: 'hash_expired_2',
      query_key: ['expired', 2],
      data_payload: 'exp2',
      created_at: 1000,
      stale_at: 1800,
      expires_at: 2500,
    };

    const entryFresh: CacheEntry<string> = {
      query_hash: 'hash_fresh',
      query_key: ['fresh'],
      data_payload: 'fresh_data',
      created_at: 1000,
      stale_at: 2000,
      expires_at: 5000,
    };

    adapter.setQuery(entryExpired1);
    adapter.setQuery(entryExpired2);
    adapter.setQuery(entryFresh);

    // At now = 1000, none are expired
    expect(adapter.getExpiredQueries(1000)).toEqual([]);

    // At now = 2200, only hash_expired_1 is expired
    const expiredAt2200 = adapter.getExpiredQueries(2200);
    expect(expiredAt2200).toHaveLength(1);
    expect(expiredAt2200[0].query_hash).toBe('hash_expired_1');
    expect(expiredAt2200[0].data_payload).toBe('exp1');

    // At now = 3000, both expired entries should be returned, but not the fresh one
    const expiredAt3000 = adapter.getExpiredQueries(3000);
    const hashesAt3000 = expiredAt3000.map((e) => e.query_hash).sort();
    expect(hashesAt3000).toEqual(['hash_expired_1', 'hash_expired_2'].sort());

    // At now = 6000, all entries are expired
    const expiredAt6000 = adapter.getExpiredQueries(6000);
    expect(expiredAt6000).toHaveLength(3);
  });

  it('invalidates queries by tag and returns invalidated query hashes', () => {
    const entryA: CacheEntry<string> = {
      query_hash: 'hash_a',
      query_key: ['a'],
      data_payload: 'data_a',
      created_at: 100,
      stale_at: 200,
      expires_at: 1000,
    };

    const entryB: CacheEntry<string> = {
      query_hash: 'hash_b',
      query_key: ['b'],
      data_payload: 'data_b',
      created_at: 100,
      stale_at: 200,
      expires_at: 1000,
    };

    adapter.setQuery(entryA, ['tag:users', 'tag:org:1']);
    adapter.setQuery(entryB, ['tag:posts', 'tag:org:1']);

    // Invalidate by specific tag
    const invalidated = adapter.invalidateByTag('tag:users');
    expect(invalidated).toEqual(['hash_a']);

    // Entry A should be deleted
    expect(adapter.getQuery('hash_a')).toBeNull();
    // Entry B should remain
    expect(adapter.getQuery('hash_b')).not.toBeNull();

    // Invalidate by shared tag
    const invalidatedRemaining = adapter.invalidateByTag('tag:org:1');
    expect(invalidatedRemaining).toEqual(['hash_b']);
    expect(adapter.getQuery('hash_b')).toBeNull();

    // Invalidation on nonexistent tag returns empty array
    expect(adapter.invalidateByTag('tag:empty')).toEqual([]);
  });

  it('updates existing query and replaces tag associations on setQuery update', () => {
    const entry: CacheEntry<{ count: number }> = {
      query_hash: 'hash_update_test',
      query_key: ['counter'],
      data_payload: { count: 1 },
      created_at: 100,
      stale_at: 200,
      expires_at: 1000,
    };

    adapter.setQuery(entry, ['initial-tag']);
    expect(adapter.getQueryHashesByTag('initial-tag')).toEqual(['hash_update_test']);

    // Update payload and change tags
    const updatedEntry: CacheEntry<{ count: number }> = {
      ...entry,
      data_payload: { count: 2 },
    };
    adapter.setQuery(updatedEntry, ['new-tag-1', 'new-tag-2']);

    const loaded = adapter.getQuery<{ count: number }>('hash_update_test');
    expect(loaded?.data_payload.count).toBe(2);

    expect(adapter.getQueryHashesByTag('initial-tag')).toEqual([]);
    expect(adapter.getQueryHashesByTag('new-tag-1')).toEqual(['hash_update_test']);
    expect(adapter.getQueryHashesByTag('new-tag-2')).toEqual(['hash_update_test']);
  });

  it('supports direct tag-index helper functions: insertTags, getQueryHashesByTag, deleteTagsForQuery', () => {
    const rawDb = new Database(':memory:');
    rawDb.pragma('foreign_keys = ON');
    rawDb.exec(`
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
    `);

    rawDb
      .prepare('INSERT INTO ucsa_query_cache VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('direct_hash', '["k"]', '{"ok":true}', null, 1, 2, 3);

    insertTags(rawDb, 'direct_hash', ['t1', 't2']);
    expect(getQueryHashesByTag(rawDb, 't1')).toEqual(['direct_hash']);
    expect(getQueryHashesByTag(rawDb, 't2')).toEqual(['direct_hash']);

    deleteTagsForQuery(rawDb, 'direct_hash');
    expect(getQueryHashesByTag(rawDb, 't1')).toEqual([]);
    expect(getQueryHashesByTag(rawDb, 't2')).toEqual([]);

    rawDb.close();
  });

  it('creates the required performance indexes on cache, tags, and outbox tables', () => {
    const indexes = adapter.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ucsa_%'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain('idx_ucsa_cache_expires');
    expect(indexNames).toContain('idx_ucsa_tags_hash');
    expect(indexNames).toContain('idx_ucsa_outbox_status');
  });

  it('configures PRAGMA synchronous = NORMAL (1)', () => {
    const synchronous = adapter.db.pragma('synchronous', { simple: true });
    expect(synchronous).toBe(1);
  });

  it('sets WAL journal mode when opened with a file-backed path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-test-'));
    const tempDbPath = path.join(tempDir, 'test-wal.db');

    try {
      const fileAdapter = new SqliteAdapter(tempDbPath);
      const journalMode = fileAdapter.db.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');

      const busyTimeout = fileAdapter.db.pragma('busy_timeout', { simple: true });
      expect(busyTimeout).toBe(5000);

      fileAdapter.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

