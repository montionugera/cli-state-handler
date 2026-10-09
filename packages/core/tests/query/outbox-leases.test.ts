import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  SqliteAdapter,
  MutationOutbox,
  type OutboxMutation,
} from '../../src/index.js';

describe('Feature F-022 - Outbox Distributed Leases & WAL Checkpointing', () => {
  let tempDir: string;
  let dbPath: string;
  let adapterA: SqliteAdapter;
  let adapterB: SqliteAdapter;
  let workerA: MutationOutbox;
  let workerB: MutationOutbox;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-lease-test-'));
    dbPath = path.join(tempDir, 'leases.db');

    adapterA = new SqliteAdapter(dbPath, { origin: 'worker-node-a', busyTimeout: 100 });
    adapterB = new SqliteAdapter(dbPath, { origin: 'worker-node-b', busyTimeout: 100 });

    workerA = new MutationOutbox({
      sqliteAdapter: adapterA,
      workerId: 'worker-a',
      defaultLeaseDurationMs: 30000,
      maxRetries: 3,
    });

    workerB = new MutationOutbox({
      sqliteAdapter: adapterB,
      workerId: 'worker-b',
      defaultLeaseDurationMs: 30000,
      maxRetries: 3,
    });
  });

  afterEach(() => {
    adapterA.close();
    adapterB.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Concurrent Workers & Zero Duplicate Replay', () => {
    it('processes 10 queued mutations across two concurrent workers with zero duplicates', async () => {
      // 1. Enqueue 10 mutations
      for (let i = 1; i <= 10; i++) {
        workerA.enqueue({
          mutation_id: `mut-${i.toString().padStart(2, '0')}`,
          endpoint: `/api/v1/items/${i}`,
          method: 'POST',
          payload: { itemIndex: i },
        });
      }

      expect(workerA.getPendingMutations()).toHaveLength(10);

      const workerAExecuted: string[] = [];
      const workerBExecuted: string[] = [];
      const allExecuted: string[] = [];

      const executorA = vi.fn().mockImplementation(async (mutation: OutboxMutation) => {
        workerAExecuted.push(mutation.mutation_id);
        allExecuted.push(mutation.mutation_id);
        // Small delay simulating network latency
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { status: 200, data: { processedBy: 'worker-a' } };
      });

      const executorB = vi.fn().mockImplementation(async (mutation: OutboxMutation) => {
        workerBExecuted.push(mutation.mutation_id);
        allExecuted.push(mutation.mutation_id);
        // Small delay simulating network latency
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { status: 200, data: { processedBy: 'worker-b' } };
      });

      // 2. Run Worker A and Worker B concurrently with batchSize: 5 and small stagger
      const runA = workerA.replay(executorA, { batchSize: 5 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const runB = workerB.replay(executorB, { batchSize: 5 });

      const [resA, resB] = await Promise.all([runA, runB]);

      // Assert each worker processed 5 mutations
      expect(resA.successful).toBe(5);
      expect(resB.successful).toBe(5);
      expect(resA.failed).toBe(0);
      expect(resB.failed).toBe(0);

      // Assert all 10 mutations were processed exactly once
      expect(allExecuted).toHaveLength(10);
      expect(new Set(allExecuted).size).toBe(10);

      // Assert 0 mutations were executed twice (disjoint execution sets)
      const duplicateIds = workerAExecuted.filter((id) => workerBExecuted.includes(id));
      expect(duplicateIds).toHaveLength(0);

      // Both workers combined cover all 10 mutation IDs
      const combined = [...workerAExecuted, ...workerBExecuted].sort();
      const expected = Array.from({ length: 10 }, (_, i) => `mut-${(i + 1).toString().padStart(2, '0')}`);
      expect(combined).toEqual(expected);

      // Outbox is fully drained
      expect(workerA.getPendingMutations()).toHaveLength(0);
      expect(workerB.getPendingMutations()).toHaveLength(0);
    });

    it('sets lease_owner and lease_until on claimed mutations', () => {
      workerA.enqueue({
        mutation_id: 'mut-lease-check',
        endpoint: '/api/test',
        method: 'POST',
      });

      const claimed = workerA.claimPendingMutations('worker-a', 5000, 1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].mutation_id).toBe('mut-lease-check');
      expect(claimed[0].status).toBe('in_flight');
      expect(claimed[0].lease_owner).toBe('worker-a');
      expect(claimed[0].lease_until).toBeGreaterThan(Date.now());

      // Worker B cannot claim the same mutation while lease is active
      const claimedByB = workerB.claimPendingMutations('worker-b', 5000, 1);
      expect(claimedByB).toHaveLength(0);
    });
  });

  describe('Dead Worker Lease Recovery', () => {
    it('allows Worker B to claim and replay abandoned mutation after short lease expires', async () => {
      // 1. Enqueue mutation
      workerA.enqueue({
        mutation_id: 'mut-abandoned-1',
        endpoint: '/api/tasks/retry',
        method: 'POST',
        payload: { task: 'critical-work' },
      });

      // 2. Worker A claims mutation with a 500ms lease and "dies" (does not complete)
      const claimedByA = workerA.claimPendingMutations('worker-a', 500, 1);
      expect(claimedByA).toHaveLength(1);
      expect(claimedByA[0].mutation_id).toBe('mut-abandoned-1');
      expect(claimedByA[0].lease_owner).toBe('worker-a');

      // Verify that immediately, Worker B cannot claim it
      const initialClaimB = workerB.claimPendingMutations('worker-b', 5000, 1);
      expect(initialClaimB).toHaveLength(0);

      // 3. Wait 600ms (greater than 500ms lease duration)
      await new Promise((resolve) => setTimeout(resolve, 600));

      // 4. Worker B runs replay()
      const workerBExecuted: string[] = [];
      const executorB = vi.fn().mockImplementation(async (mutation: OutboxMutation) => {
        workerBExecuted.push(mutation.mutation_id);
        return { status: 200, data: { recovered: true } };
      });

      const resB = await workerB.replay(executorB);

      // 5. Worker B successfully claims and replays the abandoned mutation
      expect(resB).toEqual({ processed: 1, successful: 1, failed: 0 });
      expect(workerBExecuted).toEqual(['mut-abandoned-1']);
      expect(workerA.getMutation('mut-abandoned-1')).toBeNull();
      expect(workerB.getPendingMutations()).toHaveLength(0);
    });

    it('transient failure releases lease back to pending with lease_owner and lease_until cleared', async () => {
      workerA.enqueue({
        mutation_id: 'mut-transient-lease',
        endpoint: '/api/unstable',
        method: 'POST',
      });

      const server500Executor = vi.fn().mockResolvedValue({
        status: 503,
        data: { error: 'Service Unavailable' },
      });

      // Worker A attempts replay and gets 503
      const res = await workerA.replay(server500Executor);
      expect(res).toEqual({ processed: 1, successful: 0, failed: 0 });

      // Row should be back to pending with cleared lease
      const mut = workerA.getMutation('mut-transient-lease');
      expect(mut?.status).toBe('pending');
      expect(mut?.retry_count).toBe(1);
      expect(mut?.lease_owner).toBeNull();
      expect(mut?.lease_until).toBeNull();

      // Worker B can immediately claim and successfully execute it
      const successExecutor = vi.fn().mockResolvedValue({ status: 200 });
      const resB = await workerB.replay(successExecutor);
      expect(resB).toEqual({ processed: 1, successful: 1, failed: 0 });
      expect(workerB.getMutation('mut-transient-lease')).toBeNull();
    });
  });

  describe('WAL Checkpoint Fallback Under Concurrent Readers', () => {
    it('gracefully falls back from TRUNCATE to PASSIVE without throwing error when active reader exists', () => {
      // 1. Populate some data into SQLite database
      adapterA.setQuery({
        query_hash: 'hash-checkpoint-1',
        query_key: ['checkpoint', 1],
        data_payload: { content: 'test-wal-data' },
        created_at: Date.now(),
        stale_at: Date.now() + 10000,
        expires_at: Date.now() + 60000,
      });

      // 2. Open secondary read transaction on a separate Database connection
      const readerDb = new Database(dbPath);
      readerDb.pragma('busy_timeout = 50');
      readerDb.exec('BEGIN DEFERRED; SELECT * FROM ucsa_query_cache;');

      // 3. Call checkpoint('TRUNCATE') on adapterA - verifies fallback to PASSIVE without throwing error
      expect(() => {
        adapterA.checkpoint('TRUNCATE');
      }).not.toThrow();

      // Clean up reader transaction
      readerDb.exec('ROLLBACK;');
      readerDb.close();
    });

    it('catches thrown SQLITE_BUSY error on TRUNCATE and invokes PASSIVE checkpoint fallback', () => {
      const adapter = new SqliteAdapter(':memory:');
      const pragmaSpy = vi.spyOn(adapter.db, 'pragma').mockImplementation((sql: string) => {
        if (sql === 'wal_checkpoint(TRUNCATE)') {
          const err = new Error('database is locked') as Error & { code: string };
          err.code = 'SQLITE_BUSY';
          throw err;
        }
        return [{ busy: 0, log: 0, checkpointed: 0 }];
      });

      expect(() => {
        adapter.checkpoint('TRUNCATE');
      }).not.toThrow();

      expect(pragmaSpy).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
      expect(pragmaSpy).toHaveBeenCalledWith('wal_checkpoint(PASSIVE)');

      pragmaSpy.mockRestore();
      adapter.close();
    });

    it('rethrows unexpected errors for non-TRUNCATE modes', () => {
      const adapter = new SqliteAdapter(':memory:');
      vi.spyOn(adapter.db, 'pragma').mockImplementation((sql: string) => {
        if (sql === 'wal_checkpoint(RESTART)') {
          throw new Error('Disk I/O error');
        }
        return [];
      });

      expect(() => {
        adapter.checkpoint('RESTART');
      }).toThrow('Disk I/O error');

      adapter.close();
    });
  });
});
