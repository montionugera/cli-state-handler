import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteAdapter } from '../../src/index.js';
import type { CacheEntry } from '../../src/index.js';

describe('SQLite Concurrency & Durability', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-concurrency-'));
    dbPath = path.join(tempDir, 'state.db');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on temp dir
    }
  });

  it('handles simultaneous writes from 2 independent connections using Promise.all without SQLITE_BUSY', async () => {
    const adapter1 = new SqliteAdapter(dbPath);
    const adapter2 = new SqliteAdapter(dbPath);

    try {
      // Confirm WAL mode and busy_timeout are active
      expect(adapter1.db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(adapter2.db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(adapter1.db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(adapter2.db.pragma('busy_timeout', { simple: true })).toBe(5000);

      const writeCount = 50;
      const tasks1 = Array.from({ length: writeCount }, (_, i) => async () => {
        const entry: CacheEntry<{ index: number; adapter: number }> = {
          query_hash: `hash_conn1_${i}`,
          query_key: ['concurrent', 'adapter1', i],
          data_payload: { index: i, adapter: 1 },
          etag: `"etag-1-${i}"`,
          created_at: Date.now(),
          stale_at: Date.now() + 1000,
          expires_at: Date.now() + 5000,
        };
        adapter1.setQuery(entry, [`tag:conn1`, `tag:item:${i}`, `tag:all`]);
      });

      const tasks2 = Array.from({ length: writeCount }, (_, i) => async () => {
        const entry: CacheEntry<{ index: number; adapter: number }> = {
          query_hash: `hash_conn2_${i}`,
          query_key: ['concurrent', 'adapter2', i],
          data_payload: { index: i, adapter: 2 },
          etag: `"etag-2-${i}"`,
          created_at: Date.now(),
          stale_at: Date.now() + 1000,
          expires_at: Date.now() + 5000,
        };
        adapter2.setQuery(entry, [`tag:conn2`, `tag:item:${i}`, `tag:all`]);
      });

      // Interleave tasks into Promise.all to trigger concurrent lock contention
      const interleaved: Array<() => Promise<void>> = [];
      for (let i = 0; i < writeCount; i++) {
        interleaved.push(tasks1[i]);
        interleaved.push(tasks2[i]);
      }

      await Promise.all(interleaved.map((fn) => fn()));

      // Close adapter1
      adapter1.close();

      // Verify adapter2 sees all updates from both adapter1 and adapter2
      const allTagHashes = adapter2.getQueryHashesByTag('tag:all');
      expect(allTagHashes).toHaveLength(writeCount * 2);

      const conn1Hashes = adapter2.getQueryHashesByTag('tag:conn1');
      expect(conn1Hashes).toHaveLength(writeCount);

      const conn2Hashes = adapter2.getQueryHashesByTag('tag:conn2');
      expect(conn2Hashes).toHaveLength(writeCount);

      // Verify individual records written by adapter1 are intact in adapter2
      for (let i = 0; i < writeCount; i++) {
        const entry1 = adapter2.getQuery<{ index: number; adapter: number }>(`hash_conn1_${i}`);
        expect(entry1).not.toBeNull();
        expect(entry1?.data_payload).toEqual({ index: i, adapter: 1 });
        expect(entry1?.etag).toBe(`"etag-1-${i}"`);

        const entry2 = adapter2.getQuery<{ index: number; adapter: number }>(`hash_conn2_${i}`);
        expect(entry2).not.toBeNull();
        expect(entry2?.data_payload).toEqual({ index: i, adapter: 2 });
        expect(entry2?.etag).toBe(`"etag-2-${i}"`);
      }
    } finally {
      adapter1.close();
      adapter2.close();
    }
  });

  it('allows concurrent reader to read unblocked while writer is performing updates', async () => {
    const writerAdapter = new SqliteAdapter(dbPath);
    const readerAdapter = new SqliteAdapter(dbPath);

    try {
      // Seed initial data
      writerAdapter.setQuery(
        {
          query_hash: 'initial_hash',
          query_key: ['initial'],
          data_payload: { value: 'initial' },
          created_at: 100,
          stale_at: 200,
          expires_at: 1000,
        },
        ['tag:initial']
      );

      // Verify reader immediately sees initial data
      expect(readerAdapter.getQuery('initial_hash')?.data_payload).toEqual({ value: 'initial' });

      // Run concurrent writes and reads
      const writePromises = Array.from({ length: 25 }, async (_, i) => {
        writerAdapter.setQuery(
          {
            query_hash: `writer_${i}`,
            query_key: ['stream', i],
            data_payload: { count: i },
            created_at: 100,
            stale_at: 200,
            expires_at: 1000,
          },
          ['tag:stream']
        );
      });

      const readResults: unknown[] = [];
      const readPromises = Array.from({ length: 25 }, async () => {
        const item = readerAdapter.getQuery('initial_hash');
        readResults.push(item?.data_payload);
      });

      await Promise.all([...writePromises, ...readPromises]);

      // Reader should have cleanly read without errors
      expect(readResults).toHaveLength(25);
      expect(readResults.every((res) => (res as { value: string }).value === 'initial')).toBe(true);

      // After writes complete, reader sees the stream items
      const streamHashes = readerAdapter.getQueryHashesByTag('tag:stream');
      expect(streamHashes).toHaveLength(25);
    } finally {
      writerAdapter.close();
      readerAdapter.close();
    }
  });

  it('propagates tag invalidation from one connection to another', () => {
    const adapterA = new SqliteAdapter(dbPath);
    const adapterB = new SqliteAdapter(dbPath);

    try {
      adapterA.setQuery(
        {
          query_hash: 'shared_key',
          query_key: ['users', 'profile'],
          data_payload: { name: 'Bob' },
          created_at: 100,
          stale_at: 200,
          expires_at: 1000,
        },
        ['tag:users']
      );

      // adapterB sees the entry
      expect(adapterB.getQuery('shared_key')).not.toBeNull();

      // adapterA invalidates by tag
      const invalidated = adapterA.invalidateByTag('tag:users');
      expect(invalidated).toEqual(['shared_key']);

      // adapterB immediately observes the query is removed
      expect(adapterB.getQuery('shared_key')).toBeNull();
      expect(adapterB.getQueryHashesByTag('tag:users')).toEqual([]);
    } finally {
      adapterA.close();
      adapterB.close();
    }
  });
});
