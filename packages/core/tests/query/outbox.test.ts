import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SqliteAdapter,
  MutationOutbox,
  type OutboxMutation,
} from '../../src/index.js';

describe('MutationOutbox - Offline Mutation Queue & Conflict Resolution', () => {
  let adapter: SqliteAdapter;
  let outbox: MutationOutbox;

  beforeEach(() => {
    adapter = new SqliteAdapter(':memory:');
    outbox = new MutationOutbox({ sqliteAdapter: adapter, maxRetries: 3 });
  });

  afterEach(() => {
    adapter.close();
  });

  describe('Initialization and Setup', () => {
    it('initializes MutationOutbox with SqliteAdapter and defaults', () => {
      const defaultOutbox = new MutationOutbox({ sqliteAdapter: adapter });
      expect(defaultOutbox.sqliteAdapter).toBe(adapter);
      expect(defaultOutbox.maxRetries).toBe(3);
    });

    it('accepts custom maxRetries option', () => {
      const customOutbox = new MutationOutbox({
        sqliteAdapter: adapter,
        maxRetries: 5,
      });
      expect(customOutbox.maxRetries).toBe(5);
    });
  });

  describe('enqueue()', () => {
    it('stores pending mutation in ucsa_mutation_outbox table in SQLite', () => {
      const mutation = outbox.enqueue({
        mutation_id: 'mut-001',
        endpoint: '/api/v1/posts',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        payload: { title: 'First Post', author: 'Alice' },
      });

      expect(mutation.mutation_id).toBe('mut-001');
      expect(mutation.endpoint).toBe('/api/v1/posts');
      expect(mutation.method).toBe('POST');
      expect(mutation.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(mutation.payload).toEqual({ title: 'First Post', author: 'Alice' });
      expect(mutation.status).toBe('pending');
      expect(mutation.retry_count).toBe(0);
      expect(mutation.created_at).toBeGreaterThan(0);

      // Verify directly in SQLite table
      const row = adapter.db
        .prepare('SELECT * FROM ucsa_mutation_outbox WHERE mutation_id = ?')
        .get('mut-001') as any;

      expect(row).toBeDefined();
      expect(row.mutation_id).toBe('mut-001');
      expect(row.endpoint).toBe('/api/v1/posts');
      expect(row.method).toBe('POST');
      expect(JSON.parse(row.headers)).toEqual({
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(row.payload)).toEqual({
        title: 'First Post',
        author: 'Alice',
      });
      expect(row.status).toBe('pending');
      expect(row.retry_count).toBe(0);
      expect(row.forced).toBe(0);
    });

    it('auto-generates mutation_id and defaults method to POST when not specified', () => {
      const mutation = outbox.enqueue({
        endpoint: '/api/v1/items',
      } as any);

      expect(mutation.mutation_id).toBeDefined();
      expect(mutation.mutation_id.startsWith('mut_')).toBe(true);
      expect(mutation.method).toBe('POST');
      expect(mutation.status).toBe('pending');
    });
  });

  describe('Querying outbox: getPendingMutations()', () => {
    it('returns ordered list by created_at ASC', async () => {
      // Insert mutations with explicit timestamps
      adapter.db
        .prepare(`
          INSERT INTO ucsa_mutation_outbox (
            mutation_id, endpoint, method, status, retry_count, created_at, forced
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run('mut-3', '/api/3', 'POST', 'pending', 0, 3000, 0);

      adapter.db
        .prepare(`
          INSERT INTO ucsa_mutation_outbox (
            mutation_id, endpoint, method, status, retry_count, created_at, forced
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run('mut-1', '/api/1', 'POST', 'pending', 0, 1000, 0);

      adapter.db
        .prepare(`
          INSERT INTO ucsa_mutation_outbox (
            mutation_id, endpoint, method, status, retry_count, created_at, forced
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run('mut-2', '/api/2', 'POST', 'pending', 0, 2000, 0);

      const pending = outbox.getPendingMutations();

      expect(pending).toHaveLength(3);
      expect(pending[0].mutation_id).toBe('mut-1');
      expect(pending[0].created_at).toBe(1000);
      expect(pending[1].mutation_id).toBe('mut-2');
      expect(pending[1].created_at).toBe(2000);
      expect(pending[2].mutation_id).toBe('mut-3');
      expect(pending[2].created_at).toBe(3000);
    });

    it('excludes mutations with status other than pending', () => {
      outbox.enqueue({
        mutation_id: 'mut-pending',
        endpoint: '/api/pending',
        method: 'POST',
      });

      outbox.enqueue({
        mutation_id: 'mut-failed',
        endpoint: '/api/failed',
        method: 'POST',
      });
      outbox.markStatus('mut-failed', 'failed', 'Network timeout');

      outbox.enqueue({
        mutation_id: 'mut-in-flight',
        endpoint: '/api/in-flight',
        method: 'POST',
      });
      outbox.markStatus('mut-in-flight', 'in_flight');

      const pending = outbox.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].mutation_id).toBe('mut-pending');

      const all = outbox.getAllMutations();
      expect(all).toHaveLength(3);
    });
  });

  describe('markStatus() and remove()', () => {
    it('updates status, last_attempt_at, and optional error message', () => {
      outbox.enqueue({
        mutation_id: 'mut-status-test',
        endpoint: '/api/status',
        method: 'PATCH',
      });

      outbox.markStatus('mut-status-test', 'in_flight');
      let mutation = outbox.getMutation('mut-status-test');
      expect(mutation?.status).toBe('in_flight');
      expect(mutation?.last_attempt_at).toBeGreaterThan(0);

      outbox.markStatus('mut-status-test', 'failed', 'Unauthorized 401');
      mutation = outbox.getMutation('mut-status-test');
      expect(mutation?.status).toBe('failed');
      expect(mutation?.error).toBe('Unauthorized 401');
    });

    it('removes mutation from SQLite and cleans up handlers', () => {
      outbox.enqueue({
        mutation_id: 'mut-to-delete',
        endpoint: '/api/delete',
        method: 'DELETE',
      });

      expect(outbox.getMutation('mut-to-delete')).not.toBeNull();
      outbox.remove('mut-to-delete');
      expect(outbox.getMutation('mut-to-delete')).toBeNull();
    });
  });

  describe('replay() - Execution and Transient Failures', () => {
    it('executes pending mutations sequentially via handler function and removes on success', async () => {
      outbox.enqueue({
        mutation_id: 'mut-1',
        endpoint: '/api/items',
        method: 'POST',
        payload: { name: 'Item 1' },
      });
      outbox.enqueue({
        mutation_id: 'mut-2',
        endpoint: '/api/items',
        method: 'POST',
        payload: { name: 'Item 2' },
      });

      const executedIds: string[] = [];
      const executor = vi.fn().mockImplementation(async (mutation: OutboxMutation) => {
        executedIds.push(mutation.mutation_id);
        return { status: 200, data: { success: true } };
      });

      const result = await outbox.replay(executor);

      expect(result).toEqual({ processed: 2, successful: 2, failed: 0 });
      expect(executedIds).toEqual(['mut-1', 'mut-2']);
      expect(outbox.getPendingMutations()).toHaveLength(0);
      expect(outbox.getAllMutations()).toHaveLength(0);
    });

    it('on transient failure (500): increments retry_count and keeps status pending until maxRetries is reached', async () => {
      outbox.enqueue({
        mutation_id: 'mut-transient-500',
        endpoint: '/api/flaky',
        method: 'POST',
        payload: { amount: 100 },
      });

      const server500Executor = vi.fn().mockResolvedValue({
        status: 500,
        data: { error: 'Internal Server Error' },
      });

      // Attempt 1: retry_count becomes 1, status pending
      const res1 = await outbox.replay(server500Executor);
      expect(res1).toEqual({ processed: 1, successful: 0, failed: 0 });

      let mut = outbox.getMutation('mut-transient-500');
      expect(mut?.status).toBe('pending');
      expect(mut?.retry_count).toBe(1);
      expect(mut?.error).toBe('HTTP 500');

      // Attempt 2: retry_count becomes 2, status pending
      const res2 = await outbox.replay(server500Executor);
      expect(res2).toEqual({ processed: 1, successful: 0, failed: 0 });

      mut = outbox.getMutation('mut-transient-500');
      expect(mut?.status).toBe('pending');
      expect(mut?.retry_count).toBe(2);

      // Attempt 3: retry_count reaches maxRetries (3), status marked 'failed'
      const res3 = await outbox.replay(server500Executor);
      expect(res3).toEqual({ processed: 1, successful: 0, failed: 1 });

      mut = outbox.getMutation('mut-transient-500');
      expect(mut?.status).toBe('failed');
      expect(mut?.retry_count).toBe(3);
      expect(mut?.error).toBe('HTTP 500');

      // No longer pending
      expect(outbox.getPendingMutations()).toHaveLength(0);
    });

    it('on network drop (thrown error): increments retry_count and marks failed at maxRetries', async () => {
      outbox.enqueue({
        mutation_id: 'mut-network-drop',
        endpoint: '/api/offline',
        method: 'POST',
      });

      const networkDropExecutor = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      // Attempt 1
      await outbox.replay(networkDropExecutor);
      let mut = outbox.getMutation('mut-network-drop');
      expect(mut?.status).toBe('pending');
      expect(mut?.retry_count).toBe(1);
      expect(mut?.error).toBe('ECONNREFUSED');

      // Attempt 2
      await outbox.replay(networkDropExecutor);
      mut = outbox.getMutation('mut-network-drop');
      expect(mut?.status).toBe('pending');
      expect(mut?.retry_count).toBe(2);

      // Attempt 3: reaches maxRetries -> failed
      const res = await outbox.replay(networkDropExecutor);
      expect(res.failed).toBe(1);
      mut = outbox.getMutation('mut-network-drop');
      expect(mut?.status).toBe('failed');
      expect(mut?.retry_count).toBe(3);
    });
  });

  describe('replay() - Conflict Resolution (409 Conflict)', () => {
    it('server-wins: invokes onRollback callback and marks mutation resolved/removed', async () => {
      const onRollback = vi.fn();

      outbox.enqueue({
        mutation_id: 'mut-server-wins',
        endpoint: '/api/docs/1',
        method: 'PUT',
        payload: { title: 'Local Version' },
        conflictPolicy: 'server-wins',
        onRollback,
      });

      const conflictExecutor = vi.fn().mockResolvedValue({
        status: 409,
        data: { title: 'Server Authoritative Version', revision: 5 },
      });

      // Replay with server-wins resolver returning 'rollback'
      const result = await outbox.replay(
        conflictExecutor,
        async (mutation, conflictData) => {
          expect(mutation.mutation_id).toBe('mut-server-wins');
          expect(conflictData).toEqual({
            title: 'Server Authoritative Version',
            revision: 5,
          });
          return 'rollback';
        }
      );

      // Mutation is resolved via rollback
      expect(result.processed).toBe(1);
      expect(result.successful).toBe(1);
      expect(result.failed).toBe(0);

      // onRollback callback was invoked
      expect(onRollback).toHaveBeenCalledTimes(1);
      expect(onRollback).toHaveBeenCalledWith(
        expect.objectContaining({ mutation_id: 'mut-server-wins' })
      );

      // Mutation is marked resolved and removed from SQLite
      expect(outbox.getPendingMutations()).toHaveLength(0);
      expect(outbox.getMutation('mut-server-wins')).toBeNull();
    });

    it('server-wins: supports options.onRollback if not defined per mutation', async () => {
      const globalRollback = vi.fn();
      const customOutbox = new MutationOutbox({
        sqliteAdapter: adapter,
        onRollback: globalRollback,
      });

      customOutbox.enqueue({
        mutation_id: 'mut-global-rollback',
        endpoint: '/api/docs/2',
        method: 'PUT',
        conflictPolicy: 'server-wins',
      });

      const conflictExecutor = vi.fn().mockResolvedValue({
        status: 409,
        data: { message: 'Conflict' },
      });

      await customOutbox.replay(conflictExecutor);

      expect(globalRollback).toHaveBeenCalledTimes(1);
      expect(customOutbox.getMutation('mut-global-rollback')).toBeNull();
    });

    it('client-wins: re-queues with forced flag', async () => {
      outbox.enqueue({
        mutation_id: 'mut-client-wins',
        endpoint: '/api/docs/1',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        payload: { title: 'Client Dominant Version' },
        conflictPolicy: 'client-wins',
      });

      let attempts = 0;
      const conflictThenSuccessExecutor = vi.fn().mockImplementation(
        async (mutation: OutboxMutation) => {
          attempts++;
          if (mutation.forced) {
            // Server honors forced overwrite
            return { status: 200, data: { updated: true } };
          }
          // Initial conflict
          return { status: 409, data: { currentServerRevision: 10 } };
        }
      );

      // First replay: hits 409, resolver triggers 'force'
      const res1 = await outbox.replay(
        conflictThenSuccessExecutor,
        async () => 'force'
      );

      expect(res1.processed).toBe(1);
      expect(res1.successful).toBe(0);

      // Verify mutation is re-queued with forced = true and status = 'pending'
      const pendingAfterConflict = outbox.getPendingMutations();
      expect(pendingAfterConflict).toHaveLength(1);
      expect(pendingAfterConflict[0].mutation_id).toBe('mut-client-wins');
      expect(pendingAfterConflict[0].forced).toBe(true);
      expect(pendingAfterConflict[0].status).toBe('pending');
      expect(pendingAfterConflict[0].headers?.['X-Force-Overwrite']).toBe('true');

      // Second replay: now mutation has forced: true, executor succeeds
      const res2 = await outbox.replay(conflictThenSuccessExecutor);
      expect(res2.processed).toBe(1);
      expect(res2.successful).toBe(1);
      expect(outbox.getPendingMutations()).toHaveLength(0);
    });

    it('client-wins: automatically uses forced re-queue when conflictPolicy is client-wins without explicit resolver', async () => {
      outbox.enqueue({
        mutation_id: 'mut-client-policy',
        endpoint: '/api/docs/1',
        method: 'PUT',
        conflictPolicy: 'client-wins',
      });

      const conflictExecutor = vi.fn().mockResolvedValue({
        status: 409,
        data: { conflict: true },
      });

      await outbox.replay(conflictExecutor);

      const pending = outbox.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].forced).toBe(true);
      expect(pending[0].status).toBe('pending');
    });

    it('merge: invokes custom merge resolver callback with local and server data', async () => {
      const localData = { title: 'Local Draft', status: 'draft', tags: ['work'] };
      const serverData = { title: 'Server Published', status: 'published', author: 'Bob' };

      const mergeResolver = vi.fn().mockImplementation((local, server) => ({
        ...server,
        ...local,
        status: server.status, // Server status wins, but local draft title preserved
      }));

      outbox.enqueue({
        mutation_id: 'mut-merge',
        endpoint: '/api/articles/123',
        method: 'PUT',
        payload: localData,
        conflictPolicy: 'merge',
        mergeResolver,
      });

      const conflictExecutor = vi.fn().mockResolvedValue({
        status: 409,
        data: serverData,
      });

      // Replay with merge resolution
      const res = await outbox.replay(
        conflictExecutor,
        async (mutation, conflictPayload) => {
          expect(mutation.mutation_id).toBe('mut-merge');
          expect(conflictPayload).toEqual(serverData);
          return 'merged';
        }
      );

      // Verify merge resolver was invoked with local and server data
      expect(mergeResolver).toHaveBeenCalledTimes(1);
      expect(mergeResolver).toHaveBeenCalledWith(localData, serverData);

      // Verify mutation payload was updated in SQLite with the merged result and remains pending
      const pending = outbox.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].mutation_id).toBe('mut-merge');
      expect(pending[0].status).toBe('pending');
      expect(pending[0].payload).toEqual({
        title: 'Local Draft',
        status: 'published',
        author: 'Bob',
        tags: ['work'],
      });
    });
  });
});
