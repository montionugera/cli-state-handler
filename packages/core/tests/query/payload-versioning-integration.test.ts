import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { QueryEngine, hashQueryKey } from '../../src/query/query-engine.js';
import { PayloadRegistry } from '../../src/query/payload-upcaster.js';

interface V1User {
  id: number;
  name: string;
}

interface V2User {
  id: number;
  fullName: string;
  schemaVersion: 2;
}

interface V3User {
  id: number;
  profile: {
    fullName: string;
  };
  schemaVersion: 3;
}

describe('Payload Versioning & Lazy On-Read Upcasting Integration', () => {
  let tmpDir: string;
  let dbPath: string;
  let sqliteAdapter: SqliteAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-payload-versioning-'));
    dbPath = path.join(tmpDir, 'payload_test.db');
    sqliteAdapter = new SqliteAdapter(dbPath);
  });

  afterEach(() => {
    sqliteAdapter.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('automatically upcasts v1 cached data to v2 on read and updates SQLite', async () => {
    const registry = new PayloadRegistry();
    const upcasterSpy = vi.fn((v1: V1User): V2User => ({
      id: v1.id,
      fullName: v1.name,
      schemaVersion: 2,
    }));

    registry.register<V1User, V2User>('users', 1, 2, upcasterSpy);

    const queryKey = ['users', 42];
    const hash = hashQueryKey(queryKey);
    const now = Date.now();

    // 1. Pre-seed SQLite cache with v1 data (payload_version = 1)
    sqliteAdapter.setQuery({
      query_hash: hash,
      query_key: queryKey,
      data_payload: { id: 42, name: 'Alice Smith' },
      created_at: now - 1000,
      stale_at: now + 5000,
      expires_at: now + 100000,
      payload_version: 1,
    });

    // 2. Initialize QueryEngine targeting payload version 2
    const engine = new QueryEngine({
      sqliteAdapter,
      payloadRegistry: registry,
      targetPayloadVersion: 2,
    });

    // 3. Read via getQueryData (synchronous cache read)
    const data = engine.getQueryData<V2User>(queryKey);
    expect(data).toBeDefined();
    expect(data?.fullName).toBe('Alice Smith');
    expect(data?.schemaVersion).toBe(2);
    expect(upcasterSpy).toHaveBeenCalledTimes(1);

    // 4. Verify SQLite was updated with upcasted payload and payload_version = 2
    const rawDb = new Database(dbPath);
    const row = rawDb
      .prepare('SELECT payload_version, data_payload FROM ucsa_query_cache WHERE query_hash = ?')
      .get(hash) as { payload_version: number; data_payload: string };
    rawDb.close();

    expect(row).toBeDefined();
    expect(row.payload_version).toBe(2);
    const parsedPayload = JSON.parse(row.data_payload) as V2User;
    expect(parsedPayload.fullName).toBe('Alice Smith');
    expect(parsedPayload.schemaVersion).toBe(2);

    // 5. Subsequent reads hit version 2 directly without re-invoking upcaster
    const freshEngine = new QueryEngine({
      sqliteAdapter,
      payloadRegistry: registry,
      targetPayloadVersion: 2,
    });

    const secondRead = freshEngine.getQueryData<V2User>(queryKey);
    expect(secondRead).toEqual(data);
    expect(upcasterSpy).toHaveBeenCalledTimes(1); // Not called again!
  });

  it('performs multi-hop chaining (v1 -> v2 -> v3) on read with single write-back', () => {
    const registry = new PayloadRegistry();

    registry.register<V1User, V2User>('users', 1, 2, (v1) => ({
      id: v1.id,
      fullName: v1.name,
      schemaVersion: 2,
    }));

    registry.register<V2User, V3User>('users', 2, 3, (v2) => ({
      id: v2.id,
      profile: {
        fullName: v2.fullName,
      },
      schemaVersion: 3,
    }));

    const queryKey = ['users', 99];
    const hash = hashQueryKey(queryKey);
    const now = Date.now();

    // Seed v1
    sqliteAdapter.setQuery({
      query_hash: hash,
      query_key: queryKey,
      data_payload: { id: 99, name: 'Bob Jones' },
      created_at: now - 1000,
      stale_at: now + 5000,
      expires_at: now + 100000,
      payload_version: 1,
    });

    const engine = new QueryEngine({
      sqliteAdapter,
      payloadRegistry: registry,
      targetPayloadVersion: 3,
    });

    const result = engine.getQueryData<V3User>(queryKey);
    expect(result).toBeDefined();
    expect(result?.profile.fullName).toBe('Bob Jones');
    expect(result?.schemaVersion).toBe(3);

    // Verify SQLite is now at version 3
    const rawDb = new Database(dbPath);
    const row = rawDb
      .prepare('SELECT payload_version, data_payload FROM ucsa_query_cache WHERE query_hash = ?')
      .get(hash) as { payload_version: number; data_payload: string };
    rawDb.close();

    expect(row.payload_version).toBe(3);
    const stored = JSON.parse(row.data_payload) as V3User;
    expect(stored.profile.fullName).toBe('Bob Jones');
  });

  it('serves upcasted payload through useQuery SWR snapshot', () => {
    const registry = new PayloadRegistry();
    registry.register<V1User, V2User>('users', 1, 2, (v1) => ({
      id: v1.id,
      fullName: v1.name,
      schemaVersion: 2,
    }));

    const queryKey = ['users', 50];
    const hash = hashQueryKey(queryKey);
    const now = Date.now();

    sqliteAdapter.setQuery({
      query_hash: hash,
      query_key: queryKey,
      data_payload: { id: 50, name: 'Charlie' },
      created_at: now - 1000,
      stale_at: now + 2000,
      expires_at: now + 100000,
      payload_version: 1,
    });

    const engine = new QueryEngine({
      sqliteAdapter,
      payloadRegistry: registry,
      targetPayloadVersion: 2,
    });

    const query = engine.useQuery<V2User>(
      ['users', 50],
      async () => ({ id: 50, fullName: 'Charlie Refetched', schemaVersion: 2 }),
      { staleTime: 60000 } // Don't trigger refetch during test
    );

    const snapshot = query.getSnapshot();
    expect(snapshot.status).toBe('success');
    expect(snapshot.data?.fullName).toBe('Charlie');
    expect(snapshot.data?.schemaVersion).toBe(2);
  });

  it('stores newly fetched entries at targetPayloadVersion', async () => {
    const engine = new QueryEngine({
      sqliteAdapter,
      targetPayloadVersion: 2,
    });

    await engine.fetchQuery(
      ['products', 10],
      async () => ({ id: 10, title: 'Super Gadget' })
    );

    const rawDb = new Database(dbPath);
    const hash = '["products",10]';
    const row = rawDb
      .prepare('SELECT payload_version FROM ucsa_query_cache WHERE query_hash = ?')
      .get(hash) as { payload_version: number };
    rawDb.close();

    expect(row).toBeDefined();
    expect(row.payload_version).toBe(2);
  });
});
