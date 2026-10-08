import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { BusHub } from '../../src/ipc/bus-hub.js';
import { BusClient } from '../../src/ipc/bus-client.js';
import { QueryEngine } from '../../src/query/query-engine.js';

describe('Cross-Process Invalidation with BusClient and QueryEngine', () => {
  let tmpDir: string;
  let dbPath: string;
  let hubAdapter: SqliteAdapter;
  let hub: BusHub;
  let clientA: BusClient;
  let clientB: BusClient;
  let adapterA: SqliteAdapter;
  let adapterB: SqliteAdapter;
  let engineA: QueryEngine;
  let engineB: QueryEngine;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-xproc-test-'));
    dbPath = path.join(tmpDir, 'shared.db');

    // Hub initialized on shared DB
    hubAdapter = new SqliteAdapter(dbPath, { origin: 'hub-origin' });
    hub = new BusHub({ sqliteAdapter: hubAdapter });
    const election = await hub.electOrConnect();
    expect(election.role).toBe('hub');

    // Engine A adapter & client
    adapterA = new SqliteAdapter(dbPath, { origin: 'engine-a' });
    clientA = new BusClient({
      endpoint: election.endpoint,
      token: election.token,
      clientId: 'client-a',
      sqliteAdapter: adapterA,
    });
    await clientA.connect();
    engineA = new QueryEngine({
      sqliteAdapter: adapterA,
      busClient: clientA,
    });

    // Engine B adapter & client
    adapterB = new SqliteAdapter(dbPath, { origin: 'engine-b' });
    clientB = new BusClient({
      endpoint: election.endpoint,
      token: election.token,
      clientId: 'client-b',
      sqliteAdapter: adapterB,
    });
    await clientB.connect();
    engineB = new QueryEngine({
      sqliteAdapter: adapterB,
      busClient: clientB,
    });
  });

  afterEach(async () => {
    await clientA?.close();
    await clientB?.close();
    await hub?.close();
    adapterA?.close();
    adapterB?.close();
    hubAdapter?.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('engineA.invalidateByTag triggers instant invalidation on engineB (<100ms) with observer refetch', async () => {
    let userVersion = 1;
    const fetcherA = vi.fn().mockImplementation(async () => ({
      id: 1,
      name: `Alice v${userVersion}`,
    }));
    const fetcherB = vi.fn().mockImplementation(async () => ({
      id: 1,
      name: `Alice v${userVersion}`,
    }));

    // Populate cache on both engines
    await engineA.fetchQuery(['user', 1], fetcherA, {
      staleTime: 60000,
      tags: ['user:1'],
    });

    const qB = engineB.useQuery(['user', 1], fetcherB, {
      staleTime: 60000,
      tags: ['user:1'],
    });
    // Engine B loads from shared SQLite cache
    expect(qB.getSnapshot().data).toEqual({ id: 1, name: 'Alice v1' });

    const observerValues: unknown[] = [];
    const unsub = qB.subscribe(() => {
      observerValues.push(qB.getSnapshot().data);
    });

    // Update backend data
    userVersion = 2;

    const startTime = performance.now();
    // Engine A invalidates tag 'user:1'
    await engineA.invalidateByTag('user:1');

    // Wait for Engine B observer to receive fresh data (<100ms)
    await vi.waitFor(
      () => {
        expect(qB.getSnapshot().data).toEqual({ id: 1, name: 'Alice v2' });
      },
      { timeout: 100 }
    );

    const elapsed = performance.now() - startTime;
    expect(elapsed).toBeLessThan(100);
    expect(fetcherB).toHaveBeenCalledTimes(1);
    expect(observerValues).toContainEqual({ id: 1, name: 'Alice v2' });

    unsub();
  });

  it('verifies echo suppression: engineA does not refetch on its own invalidation from bus event', async () => {
    let callCountA = 0;
    const fetcherA = vi.fn().mockImplementation(async () => {
      callCountA++;
      return { id: 1, name: `User ${callCountA}` };
    });

    // Mount query observer on Engine A
    const qA = engineA.useQuery(['user', 1], fetcherA, {
      staleTime: 60000,
      tags: ['user:1'],
    });

    await vi.waitFor(() => {
      expect(qA.getSnapshot().data).toEqual({ id: 1, name: 'User 1' });
    });
    expect(fetcherA).toHaveBeenCalledTimes(1);

    // Local invalidateByTag triggers local revalidation once
    await engineA.invalidateByTag('user:1');
    expect(fetcherA).toHaveBeenCalledTimes(2);

    // Wait to ensure bus event arrives and echo suppression prevents a 3rd fetch
    await new Promise((r) => setTimeout(r, 60));
    expect(fetcherA).toHaveBeenCalledTimes(2);
  });

  it('engineA.invalidateQueries triggers remote invalidation on engineB', async () => {
    let callCountB = 0;
    const fetcherB = vi.fn().mockImplementation(async () => {
      callCountB++;
      return { id: 1, count: callCountB };
    });

    const qB = engineB.useQuery(['counter', 1], fetcherB, {
      staleTime: 60000,
    });
    await vi.waitFor(() => {
      expect(qB.getSnapshot().data).toEqual({ id: 1, count: 1 });
    });
    expect(fetcherB).toHaveBeenCalledTimes(1);

    // Engine A invalidates query key ['counter', 1]
    await engineA.invalidateQueries(['counter', 1]);

    await vi.waitFor(
      () => {
        expect(qB.getSnapshot().data).toEqual({ id: 1, count: 2 });
      },
      { timeout: 100 }
    );
    expect(fetcherB).toHaveBeenCalledTimes(2);
  });

  it('reconnect catch-up: events emitted while Engine B is disconnected are replayed from change log on reconnect', async () => {
    let userVersion = 1;
    const fetcherB = vi.fn().mockImplementation(async () => ({
      id: 1,
      name: `Bob v${userVersion}`,
    }));

    const qB = engineB.useQuery(['user', 1], fetcherB, {
      staleTime: 60000,
      tags: ['user:1'],
    });
    await vi.waitFor(() => {
      expect(qB.getSnapshot().data).toEqual({ id: 1, name: 'Bob v1' });
    });
    expect(fetcherB).toHaveBeenCalledTimes(1);

    // Disconnect Engine B client
    await clientB.close();

    // While Engine B is disconnected, Engine A modifies and invalidates 'user:1'
    userVersion = 2;
    await engineA.invalidateByTag('user:1');

    // Engine B reconnects
    await clientB.connect();

    // Replay on reconnect triggers revalidation on Engine B
    await vi.waitFor(
      () => {
        expect(qB.getSnapshot().data).toEqual({ id: 1, name: 'Bob v2' });
      },
      { timeout: 200 }
    );
    expect(fetcherB).toHaveBeenCalledTimes(2);
  });

  it('verifies clean shutdown of BusClient and BusHub', async () => {
    expect(clientA.isConnected).toBe(true);
    expect(clientB.isConnected).toBe(true);

    await clientA.close();
    await clientB.close();

    expect(clientA.isConnected).toBe(false);
    expect(clientB.isConnected).toBe(false);

    await hub.close();
    expect(hub.role).toBe('idle');
  });
});
