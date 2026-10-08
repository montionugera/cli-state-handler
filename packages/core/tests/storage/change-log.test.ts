import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqliteAdapter,
  type ChangeLogKind,
  type ChangeLogRow,
  type ReadChangesResult,
} from '../../src/index.js';

describe('Atomic Change Log Journaling & Catch-up Reader', () => {
  let tempDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ucsa-change-log-'));
    dbPath = join(tempDir, 'test.db');
    adapter = new SqliteAdapter(dbPath, { origin: 'test-process-1' });
  });

  afterEach(() => {
    adapter.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes with custom or default origin', () => {
    expect(adapter.origin).toBe('test-process-1');

    const defaultAdapter = new SqliteAdapter(':memory:');
    expect(defaultAdapter.origin).toBeDefined();
    expect(typeof defaultAdapter.origin).toBe('string');
    expect(defaultAdapter.origin.length).toBeGreaterThan(0);
    defaultAdapter.close();
  });

  it('appendChangeLog inserts rows and serializes json payloads', () => {
    const seq1 = adapter.appendChangeLog('mutation', {
      detail: { mutationId: 'mut-1', entity: 'order' },
    });
    expect(seq1).toBe(1);

    const seq2 = adapter.appendChangeLog('stream', {
      origin: 'custom-emitter',
      tags: ['tag:stream'],
      queryHashes: ['q-stream'],
      detail: { chunk: 1 },
    });
    expect(seq2).toBe(2);

    const result = adapter.readChangesSince(0);
    expect(result.headSeq).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(2);

    expect(result.rows[0]).toMatchObject({
      seq: 1,
      origin: 'test-process-1',
      kind: 'mutation',
      tags: null,
      query_hashes: null,
      detail: { mutationId: 'mut-1', entity: 'order' },
    });
    expect(typeof result.rows[0].created_at).toBe('number');

    expect(result.rows[1]).toMatchObject({
      seq: 2,
      origin: 'custom-emitter',
      kind: 'stream',
      tags: ['tag:stream'],
      query_hashes: ['q-stream'],
      detail: { chunk: 1 },
    });
  });

  it('deleteQuery deletes cache entry and inserts an invalidate log with query_hashes', () => {
    adapter.setQuery({
      query_hash: 'q-delete-1',
      query_key: ['items', 1],
      data_payload: { id: 1, name: 'Item 1' },
      created_at: 1000,
      stale_at: 2000,
      expires_at: 3000,
    });

    const deleted = adapter.deleteQuery('q-delete-1');
    expect(deleted).toBe(true);
    expect(adapter.getQuery('q-delete-1')).toBeNull();

    const changes = adapter.readChangesSince(0);
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0]).toMatchObject({
      seq: 1,
      origin: 'test-process-1',
      kind: 'invalidate',
      tags: null,
      query_hashes: ['q-delete-1'],
      detail: null,
    });

    // Deleting non-existent query returns false and does not append to log
    const deletedAgain = adapter.deleteQuery('q-delete-1');
    expect(deletedAgain).toBe(false);
    expect(adapter.readChangesSince(0).rows).toHaveLength(1);
  });

  it('deleteQuery allows custom origin override', () => {
    adapter.setQuery({
      query_hash: 'q-custom-origin',
      query_key: ['custom'],
      data_payload: { ok: true },
      created_at: 1000,
      stale_at: 2000,
      expires_at: 3000,
    });

    const deleted = adapter.deleteQuery('q-custom-origin', 'remote-worker');
    expect(deleted).toBe(true);

    const changes = adapter.readChangesSince(0);
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0].origin).toBe('remote-worker');
  });

  it('invalidateByTag deletes cache entries and inserts invalidate log with tag and query_hashes in one transaction', () => {
    adapter.setQuery(
      {
        query_hash: 'q-tag-1',
        query_key: ['products', 1],
        data_payload: { id: 1 },
        created_at: 1000,
        stale_at: 2000,
        expires_at: 3000,
      },
      ['category:electronics']
    );

    adapter.setQuery(
      {
        query_hash: 'q-tag-2',
        query_key: ['products', 2],
        data_payload: { id: 2 },
        created_at: 1000,
        stale_at: 2000,
        expires_at: 3000,
      },
      ['category:electronics']
    );

    const invalidated = adapter.invalidateByTag('category:electronics');
    expect(invalidated.sort()).toEqual(['q-tag-1', 'q-tag-2'].sort());
    expect(adapter.getQuery('q-tag-1')).toBeNull();
    expect(adapter.getQuery('q-tag-2')).toBeNull();

    const changes = adapter.readChangesSince(0);
    expect(changes.rows).toHaveLength(1);
    expect(changes.rows[0]).toMatchObject({
      seq: 1,
      origin: 'test-process-1',
      kind: 'invalidate',
      tags: ['category:electronics'],
      query_hashes: expect.arrayContaining(['q-tag-1', 'q-tag-2']),
      detail: null,
    });

    // Invalidation on empty tag still logs invalidation event for cross-process catch-up
    const emptyInvalidated = adapter.invalidateByTag('category:books', 'proc-books');
    expect(emptyInvalidated).toEqual([]);
    const updatedChanges = adapter.readChangesSince(1);
    expect(updatedChanges.rows).toHaveLength(1);
    expect(updatedChanges.rows[0]).toMatchObject({
      seq: 2,
      origin: 'proc-books',
      kind: 'invalidate',
      tags: ['category:books'],
      query_hashes: [],
    });
  });

  it('enforces atomic rollback: if an error occurs during invalidation or log insert, both are rolled back', () => {
    adapter.setQuery({
      query_hash: 'q-rollback-1',
      query_key: ['rollback'],
      data_payload: { safe: true },
      created_at: 1000,
      stale_at: 2000,
      expires_at: 3000,
    });

    // Simulate a failure during change log insertion by sabotaging the ucsa_change_log table temporarily
    adapter.db.exec(`
      CREATE TRIGGER fail_change_log_insert
      BEFORE INSERT ON ucsa_change_log
      WHEN NEW.kind = 'invalidate'
      BEGIN
        SELECT RAISE(FAIL, 'Simulated change log failure');
      END;
    `);

    expect(() => {
      adapter.deleteQuery('q-rollback-1');
    }).toThrow(/Simulated change log failure/);

    // The query MUST still exist in cache due to rollback
    expect(adapter.getQuery('q-rollback-1')).not.toBeNull();

    // Clean up trigger
    adapter.db.exec('DROP TRIGGER fail_change_log_insert');
  });

  it('readChangesSince returns entries in ascending sequence order and respects limit', () => {
    for (let i = 1; i <= 10; i++) {
      adapter.appendChangeLog('mutation', { detail: { i } });
    }

    const firstPage = adapter.readChangesSince(0, 4);
    expect(firstPage.headSeq).toBe(10);
    expect(firstPage.truncated).toBe(false);
    expect(firstPage.rows).toHaveLength(4);
    expect(firstPage.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);

    const secondPage = adapter.readChangesSince(4, 4);
    expect(secondPage.headSeq).toBe(10);
    expect(secondPage.truncated).toBe(false);
    expect(secondPage.rows).toHaveLength(4);
    expect(secondPage.rows.map((r) => r.seq)).toEqual([5, 6, 7, 8]);

    const thirdPage = adapter.readChangesSince(8, 4);
    expect(thirdPage.headSeq).toBe(10);
    expect(thirdPage.truncated).toBe(false);
    expect(thirdPage.rows).toHaveLength(2);
    expect(thirdPage.rows.map((r) => r.seq)).toEqual([9, 10]);

    const emptyPage = adapter.readChangesSince(10, 4);
    expect(emptyPage.headSeq).toBe(10);
    expect(emptyPage.truncated).toBe(false);
    expect(emptyPage.rows).toHaveLength(0);
  });

  it('detects truncation when lastSeq has been pruned', () => {
    for (let i = 1; i <= 10; i++) {
      adapter.appendChangeLog('stream', { detail: { i } });
    }

    // Prune so that seq 1..5 are deleted, minSeq becomes 6
    adapter.db.exec('DELETE FROM ucsa_change_log WHERE seq <= 5');

    // Reader asking with lastSeq = 5 (exactly minSeq - 1) has NOT missed any unread rows
    const exact = adapter.readChangesSince(5);
    expect(exact.truncated).toBe(false);
    expect(exact.rows[0].seq).toBe(6);

    // Reader asking with lastSeq = 4 (< minSeq - 1) has a gap because seq 5 was lost!
    const gapped = adapter.readChangesSince(4);
    expect(gapped.truncated).toBe(true);
    expect(gapped.rows[0].seq).toBe(6);

    // Initial sync reader (lastSeq = 0) is never marked truncated
    const initialSync = adapter.readChangesSince(0);
    expect(initialSync.truncated).toBe(false);
  });

  it('pruneChangeLog removes old entries beyond retention while preserving recent rows', () => {
    const now = Date.now();
    const oldTimestamp = now - 100_000_000; // ~27 hours ago

    // Insert old rows
    for (let i = 1; i <= 5; i++) {
      adapter.db
        .prepare(`
          INSERT INTO ucsa_change_log (origin, kind, created_at)
          VALUES ('test', 'invalidate', ?)
        `)
        .run(oldTimestamp);
    }

    // Insert recent rows
    for (let i = 6; i <= 10; i++) {
      adapter.db
        .prepare(`
          INSERT INTO ucsa_change_log (origin, kind, created_at)
          VALUES ('test', 'mutation', ?)
        `)
        .run(now);
    }

    expect(adapter.readChangesSince(0).rows).toHaveLength(10);

    // Retention of 24 hours (86_400_000 ms) should prune the 5 old rows
    const pruneResult = adapter.pruneChangeLog(86_400_000, 10_000);
    expect(pruneResult.prunedCount).toBe(5);

    const remaining = adapter.readChangesSince(0);
    expect(remaining.rows).toHaveLength(5);
    expect(remaining.rows.every((r) => r.created_at >= now - 1000)).toBe(true);
  });

  it('pruneChangeLog enforces maxRows ceiling even for recent entries', () => {
    const now = Date.now();
    for (let i = 1; i <= 20; i++) {
      adapter.db
        .prepare(`
          INSERT INTO ucsa_change_log (origin, kind, created_at)
          VALUES ('test', 'mutation', ?)
        `)
        .run(now + i);
    }

    expect(adapter.readChangesSince(0).rows).toHaveLength(20);

    // Prune with maxRows = 5 and high retentionMs
    const pruneResult = adapter.pruneChangeLog(100_000_000, 5);
    expect(pruneResult.prunedCount).toBe(15);

    const remaining = adapter.readChangesSince(0);
    expect(remaining.rows).toHaveLength(5);
    expect(remaining.rows.map((r) => r.seq)).toEqual([16, 17, 18, 19, 20]);
  });
});
