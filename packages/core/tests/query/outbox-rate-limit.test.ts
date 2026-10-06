import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteAdapter,
  MutationOutbox,
} from '../../src/index.js';

describe('MutationOutbox - Batch Replay Rate-Limiting & Pacing', () => {
  let adapter: SqliteAdapter;
  let outbox: MutationOutbox;

  beforeEach(() => {
    adapter = new SqliteAdapter(':memory:');
    outbox = new MutationOutbox({ sqliteAdapter: adapter, maxRetries: 3 });
  });

  afterEach(() => {
    adapter.close();
  });

  it('respects rateLimitMs delay between sequential mutation executions', async () => {
    const executionOrder: string[] = [];
    const executionTimestamps: number[] = [];

    for (let i = 1; i <= 5; i++) {
      outbox.enqueue({
        mutation_id: `mut-${i}`,
        endpoint: `/api/v1/resource/${i}`,
        method: 'POST',
        payload: { index: i },
      });
    }

    const startTime = Date.now();
    const result = await outbox.replay(
      async (m) => {
        executionOrder.push(m.mutation_id);
        executionTimestamps.push(Date.now());
        return { status: 200, data: { ok: true } };
      },
      { rateLimitMs: 25 }
    );
    const duration = Date.now() - startTime;

    expect(result.processed).toBe(5);
    expect(result.successful).toBe(5);
    expect(result.failed).toBe(0);
    expect(executionOrder).toEqual(['mut-1', 'mut-2', 'mut-3', 'mut-4', 'mut-5']);
    expect(duration).toBeGreaterThanOrEqual(95);

    // Verify interval between successive executions was paced
    for (let i = 1; i < executionTimestamps.length; i++) {
      const interval = executionTimestamps[i] - executionTimestamps[i - 1];
      expect(interval).toBeGreaterThanOrEqual(20);
    }
  });

  it('limits processed mutations per run when batchSize is specified', async () => {
    for (let i = 1; i <= 5; i++) {
      outbox.enqueue({
        mutation_id: `mut-batch-${i}`,
        endpoint: `/api/v1/items/${i}`,
        method: 'PUT',
        payload: { item: i },
      });
    }

    expect(outbox.getPendingMutations().length).toBe(5);

    // Batch 1: size 2
    const batch1 = await outbox.replay(
      async () => ({ status: 200 }),
      { batchSize: 2 }
    );
    expect(batch1).toEqual({ processed: 2, successful: 2, failed: 0 });
    expect(outbox.getPendingMutations().length).toBe(3);

    // Batch 2: size 2
    const batch2 = await outbox.replay(
      async () => ({ status: 200 }),
      { batchSize: 2 }
    );
    expect(batch2).toEqual({ processed: 2, successful: 2, failed: 0 });
    expect(outbox.getPendingMutations().length).toBe(1);

    // Batch 3: size 2 (only 1 remaining)
    const batch3 = await outbox.replay(
      async () => ({ status: 200 }),
      { batchSize: 2 }
    );
    expect(batch3).toEqual({ processed: 1, successful: 1, failed: 0 });
    expect(outbox.getPendingMutations().length).toBe(0);
  });

  it('supports combining batchSize and rateLimitMs with conflict resolver', async () => {
    outbox.enqueue({ mutation_id: 'mut-c1', endpoint: '/test/1', method: 'POST' });
    outbox.enqueue({ mutation_id: 'mut-c2', endpoint: '/test/2', method: 'POST' });
    outbox.enqueue({ mutation_id: 'mut-c3', endpoint: '/test/3', method: 'POST' });

    const startTime = Date.now();
    const result = await outbox.replay(
      async () => ({ status: 200 }),
      async () => 'rollback',
      { batchSize: 2, rateLimitMs: 25 }
    );
    const duration = Date.now() - startTime;

    expect(result.processed).toBe(2);
    expect(result.successful).toBe(2);
    expect(outbox.getPendingMutations().length).toBe(1);
    expect(duration).toBeGreaterThanOrEqual(20);
  });
});
