import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SqliteAdapter,
  QueryEngine,
  PayloadRegistry,
  IncompatiblePayloadError,
  MutationOutbox,
  hashQueryKey,
} from '../../src/index.js';

describe('Selective Eviction & Outbox Salvage Protection', () => {
  let tempDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-eviction-test-'));
    dbPath = path.join(tempDir, 'test.db');
    adapter = new SqliteAdapter(dbPath);
  });

  afterEach(() => {
    adapter.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('selectively evicts corrupted JSON payload from SQLite on fetchQuery without crashing and fetches fresh data', async () => {
    const onEvictSpy = vi.fn();
    const engine = new QueryEngine({
      sqliteAdapter: adapter,
      onIncompatiblePayload: onEvictSpy,
    });

    const key1 = ['users', 1];
    const hash1 = hashQueryKey(key1);
    const key2 = ['users', 2];
    const hash2 = hashQueryKey(key2);

    // 1. Insert a corrupt non-JSON payload directly into SQLite
    adapter.db
      .prepare(
        `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        hash1,
        JSON.stringify(key1),
        'INVALID_JSON_{{corrupted_data',
        Date.now(),
        Date.now() + 100000,
        Date.now() + 200000,
        1
      );

    // 2. Insert a valid entry for key2
    adapter.setQuery({
      query_hash: hash2,
      query_key: key2,
      data_payload: { id: 2, name: 'Bob' },
      created_at: Date.now(),
      stale_at: Date.now() + 100000,
      expires_at: Date.now() + 200000,
      payload_version: 1,
    });

    // 3. Insert an outbox mutation to prove outbox salvage protection
    const outbox = new MutationOutbox({ sqliteAdapter: adapter });
    outbox.enqueue({
      mutation_id: 'mut-user-1',
      endpoint: '/api/users/1',
      method: 'POST',
      payload: { action: 'promote' },
    });

    // 4. Fetch key1 with QueryEngine
    const freshData = await engine.fetchQuery(key1, async () => {
      return { id: 1, name: 'Alice Fresh' };
    });

    expect(freshData).toEqual({ id: 1, name: 'Alice Fresh' });
    expect(onEvictSpy).toHaveBeenCalledTimes(1);
    expect(onEvictSpy.mock.calls[0][0]).toBeInstanceOf(Error);

    // 5. Verify corrupt row in SQLite was replaced with valid data
    const repairedRow = adapter.getQuery<{ id: number; name: string }>(hash1);
    expect(repairedRow).not.toBeNull();
    expect(repairedRow?.data_payload).toEqual({ id: 1, name: 'Alice Fresh' });

    // 6. Verify valid key2 was NOT evicted
    const key2Row = adapter.getQuery<{ id: number; name: string }>(hash2);
    expect(key2Row?.data_payload).toEqual({ id: 2, name: 'Bob' });

    // 7. Verify outbox mutation was completely preserved
    const pending = outbox.getPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].endpoint).toBe('/api/users/1');
  });

  it('selectively evicts un-upcastable payload version from SQLite and memory', async () => {
    const registry = new PayloadRegistry();
    // Only register v1 -> v2, but target is v3
    registry.register(['users', '*'], 1, 2, (payload: any) => ({
      ...payload,
      version2: true,
    }));

    const onEvictSpy = vi.fn();
    const engine = new QueryEngine({
      sqliteAdapter: adapter,
      payloadRegistry: registry,
      targetPayloadVersion: 3,
      onIncompatiblePayload: onEvictSpy,
    });

    const key = ['users', 42];
    const hash = hashQueryKey(key);

    // Store at v1
    adapter.setQuery({
      query_hash: hash,
      query_key: key,
      data_payload: { id: 42, name: 'Old User' },
      created_at: Date.now(),
      stale_at: Date.now() + 100000,
      expires_at: Date.now() + 200000,
      payload_version: 1,
    });

    const result = await engine.fetchQuery(key, async () => {
      return { id: 42, name: 'Brand New User v3', v3: true };
    });

    expect(result).toEqual({ id: 42, name: 'Brand New User v3', v3: true });
    expect(onEvictSpy).toHaveBeenCalledTimes(1);
    expect(onEvictSpy.mock.calls[0][0]).toBeInstanceOf(IncompatiblePayloadError);

    const saved = adapter.getQuery<any>(hash);
    expect(saved?.payload_version).toBe(3);
    expect(saved?.data_payload.v3).toBe(true);
  });

  it('selectively evicts when upcaster function throws an error during migration', async () => {
    const registry = new PayloadRegistry();
    registry.register(['users', '*'], 1, 2, () => {
      throw new Error('Fatal schema transform error');
    });

    const onEvictSpy = vi.fn();
    const engine = new QueryEngine({
      sqliteAdapter: adapter,
      payloadRegistry: registry,
      targetPayloadVersion: 2,
      onIncompatiblePayload: onEvictSpy,
    });

    const key = ['users', 99];
    const hash = hashQueryKey(key);

    adapter.setQuery({
      query_hash: hash,
      query_key: key,
      data_payload: { id: 99 },
      created_at: Date.now(),
      stale_at: Date.now() + 100000,
      expires_at: Date.now() + 200000,
      payload_version: 1,
    });

    const result = await engine.fetchQuery(key, async () => {
      return { id: 99, fixed: true };
    });

    expect(result).toEqual({ id: 99, fixed: true });
    expect(onEvictSpy).toHaveBeenCalledTimes(1);
    expect(onEvictSpy.mock.calls[0][0].message).toContain('Fatal schema transform error');
  });

  it('getQueryData returns undefined on corrupted or un-upcastable entry instead of throwing', () => {
    const registry = new PayloadRegistry();
    const onEvictSpy = vi.fn();
    const engine = new QueryEngine({
      sqliteAdapter: adapter,
      payloadRegistry: registry,
      targetPayloadVersion: 2,
      onIncompatiblePayload: onEvictSpy,
    });

    const key = ['corrupt', 'item'];
    const hash = hashQueryKey(key);

    // Insert corrupted JSON
    adapter.db
      .prepare(
        `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(hash, JSON.stringify(key), '{{{bad_json', Date.now(), Date.now() + 10000, Date.now() + 20000, 1);

    const data = engine.getQueryData(key);
    expect(data).toBeUndefined();
    expect(onEvictSpy).toHaveBeenCalledTimes(1);

    // Corrupt entry should be removed from SQLite
    const row = adapter.getQuery(hash);
    expect(row).toBeNull();
  });

  it('useQuery initializes in loading state and revalidates fresh data on corrupt entry', async () => {
    const engine = new QueryEngine({
      sqliteAdapter: adapter,
    });

    const key = ['feed', 1];
    const hash = hashQueryKey(key);

    adapter.db
      .prepare(
        `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(hash, JSON.stringify(key), 'MALFORMED', Date.now(), Date.now() + 100000, Date.now() + 200000, 1);

    let notifyCount = 0;
    const observer = engine.useQuery(key, async () => {
      return { articles: ['a', 'b'] };
    });

    observer.subscribe(() => {
      notifyCount++;
    });

    expect(observer.getSnapshot().status).toBe('loading');

    // Wait for background fetch to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(observer.getSnapshot().status).toBe('success');
    expect(observer.getSnapshot().data).toEqual({ articles: ['a', 'b'] });
    expect(notifyCount).toBeGreaterThanOrEqual(1);
  });

  it('outbox mutations survive mass selective eviction and verifyIntegrity confirms 100% preservation', async () => {
    const outbox = new MutationOutbox({ sqliteAdapter: adapter });

    // Enqueue 5 mutations
    for (let i = 1; i <= 5; i++) {
      outbox.enqueue({
        mutation_id: `mut-${i}`,
        endpoint: `/api/resource/${i}`,
        method: 'POST',
        payload: { item: i },
      });
    }

    const engine = new QueryEngine({
      sqliteAdapter: adapter,
    });

    // Populate 10 corrupted cache entries
    for (let i = 1; i <= 10; i++) {
      const k = ['item', i];
      const h = hashQueryKey(k);
      adapter.db
        .prepare(
          `INSERT INTO ucsa_query_cache (query_hash, query_key, data_payload, created_at, stale_at, expires_at, payload_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(h, JSON.stringify(k), `CORRUPT_${i}`, Date.now(), Date.now() + 100000, Date.now() + 200000, 1);

      // Trigger eviction by querying
      await engine.fetchQuery(k, async () => ({ id: i, valid: true }));
    }

    // Verify outbox integrity
    const integrity = outbox.verifyIntegrity();
    expect(integrity.intact).toBe(true);
    expect(integrity.total).toBe(5);
    expect(integrity.pending).toBe(5);

    // Replay mutations
    const result = await outbox.replay(async (m) => {
      return { status: 200, data: { ok: true } };
    });

    expect(result.processed).toBe(5);
    expect(result.successful).toBe(5);
    expect(outbox.getPendingMutations()).toHaveLength(0);
  });
});
