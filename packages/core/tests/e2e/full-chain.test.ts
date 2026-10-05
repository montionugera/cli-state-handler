import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  SqliteAdapter,
  CasStore,
  QueryEngine,
  MutationOutbox,
  BffTransport,
  WsTransport,
  CliDurabilityManager,
  OnlineManager,
  createSelectorObserver,
  hashQueryKey,
} from '../../src/index.js';
import type {
  WebSocketLike,
  InvalidationEvent,
  OutboxMutation,
} from '../../src/index.js';

class MockWebSocket implements WebSocketLike {
  readyState = 1; // OPEN
  sentMessages: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(public url: string) {}

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sentMessages.push(typeof data === 'string' ? data : String(data));
  }

  close(code = 1000, reason = 'Normal closure') {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true });
  }

  triggerOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }

  triggerMessage(data: string) {
    this.onmessage?.({ data });
  }
}

interface PackageMetadata {
  id: string;
  name: string;
  version: string;
  sha256: string;
  downloads: number;
  author: string;
}

describe('Full-Chain End-to-End Integration (UCSA)', () => {
  it('executes full chain: ingress -> QueryEngine -> SQLite WAL -> CAS -> Observer -> Real-time WS -> Offline Outbox -> Reconnect -> Durability Flush', async () => {
    // -------------------------------------------------------------------------
    // Step 1: Initialize real disk SqliteAdapter (WAL mode) and CasStore
    // -------------------------------------------------------------------------
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-e2e-full-chain-'));
    const dbPath = path.join(tmpDir, 'state.db');
    const walPath = `${dbPath}-wal`;
    const casDir = path.join(tmpDir, 'cas');

    const sqliteAdapter = new SqliteAdapter(dbPath, {
      journalMode: 'WAL',
      busyTimeout: 5000,
    });

    const casStore = new CasStore({
      baseDir: casDir,
      sqliteAdapter,
      maxSizeBytes: 20 * 1024 * 1024, // 20 MB quota
    });
    await casStore.init();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(casDir)).toBe(true);

    // Verify SQLite WAL pragma
    const pragmaJournalMode = (
      sqliteAdapter.db.prepare('PRAGMA journal_mode;').get() as {
        journal_mode: string;
      }
    ).journal_mode.toUpperCase();
    expect(pragmaJournalMode).toBe('WAL');

    // -------------------------------------------------------------------------
    // Step 2: Initialize QueryEngine, MutationOutbox, BffTransport, WsTransport, CliDurabilityManager
    // -------------------------------------------------------------------------
    const queryEngine = new QueryEngine({
      sqliteAdapter,
      defaultStaleTime: 60_000,
      defaultGcTime: 300_000,
    });

    const outbox = new MutationOutbox({
      sqliteAdapter,
      maxRetries: 3,
    });

    const durabilityManager = new CliDurabilityManager();
    durabilityManager.registerSqliteCheckpoint(sqliteAdapter, -100, 'TRUNCATE');

    const onlineManager = new OnlineManager();
    expect(onlineManager.isOnline()).toBe(true);

    // Server state fixture for BFF transport
    const packagePayload = Buffer.from(
      '#!/usr/bin/env node\nconsole.log("Unified Client State Architecture package payload v1.0.0");'
    );
    const expectedSha256 = crypto
      .createHash('sha256')
      .update(packagePayload)
      .digest('hex');

    let serverMeta: PackageMetadata = {
      id: 'pkg-1',
      name: '@scope/cli-core-pkg',
      version: '1.0.0',
      sha256: expectedSha256,
      downloads: 120,
      author: 'DeepMind Engineer',
    };
    let serverEtag = '"v1.0.0-etag"';

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const ifNoneMatch = headers['if-none-match'] || headers['If-None-Match'];

      if (url.includes('/api/v1/packages/pkg-1')) {
        if (ifNoneMatch && ifNoneMatch === serverEtag) {
          return {
            status: 304,
            ok: true,
            headers: new Headers({
              etag: serverEtag,
              'content-type': 'application/json',
            }),
            text: async () => '',
          };
        }

        return {
          status: 200,
          ok: true,
          headers: new Headers({
            etag: serverEtag,
            'content-type': 'application/json',
          }),
          text: async () => JSON.stringify(serverMeta),
        };
      }

      return {
        status: 404,
        ok: false,
        text: async () => 'Not Found',
      };
    });

    const bffTransport = new BffTransport({
      baseUrl: 'https://registry.example.internal',
      fetch: mockFetch as unknown as typeof fetch,
    });

    let activeSocket: MockWebSocket | null = null;
    const wsTransport = new WsTransport({
      url: 'wss://realtime.example.internal/state',
      websocketFactory: (url) => {
        activeSocket = new MockWebSocket(url);
        return activeSocket;
      },
      pingInterval: 60_000,
    });
    wsTransport.connect();
    expect(activeSocket).not.toBeNull();
    activeSocket!.triggerOpen();
    expect(wsTransport.getState()).toBe('connected');

    // -------------------------------------------------------------------------
    // Step 3: Ingress: Perform initial query via BffTransport with ETag caching, persist into SQLite
    // -------------------------------------------------------------------------
    const pkgQueryKey = ['packages', 'pkg-1'];
    const pkgTags = ['pkg:1', 'registry'];

    const fetchPkgFn = async () => {
      const res = await bffTransport.fetch<PackageMetadata>({
        endpoint: '/api/v1/packages/pkg-1',
      });
      return res.data;
    };

    const initialData = await queryEngine.fetchQuery(pkgQueryKey, fetchPkgFn, {
      tags: pkgTags,
    });

    expect(initialData).toBeDefined();
    expect(initialData.name).toBe('@scope/cli-core-pkg');
    expect(initialData.version).toBe('1.0.0');
    expect(initialData.sha256).toBe(expectedSha256);

    // ETag is cached in BffTransport
    expect(bffTransport.getCachedEtag('/api/v1/packages/pkg-1')).toBe(serverEtag);

    // Subsequent fetch returns 304 with cached payload without re-downloading body
    const conditionalRes = await bffTransport.fetch<PackageMetadata>({
      endpoint: '/api/v1/packages/pkg-1',
    });
    expect(conditionalRes.status).toBe(304);
    expect(conditionalRes.data.version).toBe('1.0.0');

    // Verify persisted into SQLite query cache
    const queryHash = hashQueryKey(pkgQueryKey);
    const dbCached = sqliteAdapter.getQuery<PackageMetadata>(queryHash);
    expect(dbCached).not.toBeNull();
    expect(dbCached?.data_payload.version).toBe('1.0.0');

    // Verify tag indexing in SQLite
    const taggedQueries = sqliteAdapter.getQueryHashesByTag('pkg:1');
    expect(taggedQueries).toContain(queryHash);

    // -------------------------------------------------------------------------
    // Step 4: CAS Storage: Download binary package payload, verify SHA-256, store in CasStore, verify disk access tracking
    // -------------------------------------------------------------------------
    const casPutResult = await casStore.put(packagePayload, initialData.sha256);
    expect(casPutResult.hash).toBe(expectedSha256);
    expect(casPutResult.size).toBe(packagePayload.byteLength);
    expect(fs.existsSync(casPutResult.path)).toBe(true);

    // Retrieve from CAS store
    const retrievedBuffer = await casStore.get(expectedSha256);
    expect(retrievedBuffer).not.toBeNull();
    expect(retrievedBuffer!.equals(packagePayload)).toBe(true);

    // Verify explicit SQLite tracking in ucsa_cas_objects table
    const casRecord = sqliteAdapter.db
      .prepare('SELECT * FROM ucsa_cas_objects WHERE hash = ?')
      .get(expectedSha256) as {
      hash: string;
      size: number;
      last_accessed_at: number;
    };
    expect(casRecord).toBeDefined();
    expect(casRecord.hash).toBe(expectedSha256);
    expect(casRecord.size).toBe(packagePayload.byteLength);
    expect(casRecord.last_accessed_at).toBeGreaterThan(0);

    // -------------------------------------------------------------------------
    // Step 5: Observer: Mount createSelectorObserver, verify initial snapshot and zero re-renders on identical revalidations
    // -------------------------------------------------------------------------
    const versionObserver = createSelectorObserver(
      queryEngine,
      pkgQueryKey,
      (data: PackageMetadata) => data.version
    );

    // Synchronous snapshot available immediately from cache
    expect(versionObserver.getSnapshot()).toBe('1.0.0');

    let renderCount = 0;
    const versionRenders: string[] = [];

    const unsubObserver = versionObserver.subscribe(() => {
      renderCount++;
      const val = versionObserver.getSnapshot();
      if (val !== undefined) {
        versionRenders.push(val);
      }
    });

    // Initial subscriber count is 0 because snapshot was already captured
    expect(renderCount).toBe(0);

    // Revalidation 1: Identical data -> zero re-renders
    await queryEngine.fetchQuery(pkgQueryKey, fetchPkgFn, { tags: pkgTags });
    expect(renderCount).toBe(0);
    expect(versionObserver.getSnapshot()).toBe('1.0.0');

    // Revalidation 2: Modify unselected field (downloads 120 -> 500)
    serverMeta = {
      ...serverMeta,
      downloads: 500,
    };
    serverEtag = '"v1.0.0-d500"';
    await queryEngine.fetchQuery(pkgQueryKey, fetchPkgFn, { tags: pkgTags });

    // Zero re-renders because selected version was unchanged
    expect(renderCount).toBe(0);
    expect(versionObserver.getSnapshot()).toBe('1.0.0');
    expect(versionRenders).toHaveLength(0);

    // -------------------------------------------------------------------------
    // Step 6: Real-time push: Ingest WS push frame ({ type: 'INVALIDATE', tags: ['pkg:1'] }), trigger automatic SWR revalidation
    // -------------------------------------------------------------------------
    // Wire WS push events directly to QueryEngine tag invalidation
    wsTransport.subscribe((event: InvalidationEvent) => {
      if (event.type === 'INVALIDATE' && event.tags) {
        for (const tag of event.tags) {
          queryEngine.invalidateByTag(tag).catch(() => {});
        }
      }
    });

    // Remote server publishes new version 1.1.0
    serverMeta = {
      ...serverMeta,
      version: '1.1.0',
      downloads: 501,
    };
    serverEtag = '"v1.1.0-etag"';

    // Ingest push frame over WebSocket
    activeSocket!.triggerMessage(
      JSON.stringify({
        type: 'INVALIDATE',
        tags: ['pkg:1'],
      })
    );

    // Await background SWR revalidation triggered by push frame
    await vi.waitFor(() => {
      expect(renderCount).toBe(1);
    });

    expect(versionObserver.getSnapshot()).toBe('1.1.0');
    expect(versionRenders).toEqual(['1.1.0']);

    // Verify SQLite cache updated with revalidated version
    const updatedCache = sqliteAdapter.getQuery<PackageMetadata>(queryHash);
    expect(updatedCache?.data_payload.version).toBe('1.1.0');

    // -------------------------------------------------------------------------
    // Step 7: Offline Mutation: Go offline via OnlineManager, enqueue mutation in MutationOutbox
    // -------------------------------------------------------------------------
    onlineManager.setOnline(false);
    expect(onlineManager.isOnline()).toBe(false);

    const queuedMutation = outbox.enqueue({
      mutation_id: 'mut-publish-patch-1',
      endpoint: '/api/v1/packages/pkg-1',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        version: '1.1.1',
        description: 'Critical patch applied offline',
      },
      conflictPolicy: 'client-wins',
    });

    expect(queuedMutation.mutation_id).toBe('mut-publish-patch-1');
    expect(queuedMutation.status).toBe('pending');

    const pendingList = outbox.getPendingMutations();
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0].mutation_id).toBe('mut-publish-patch-1');

    // Verify mutation persisted in SQLite outbox table
    const outboxRow = sqliteAdapter.db
      .prepare('SELECT * FROM ucsa_mutation_outbox WHERE mutation_id = ?')
      .get('mut-publish-patch-1') as {
      mutation_id: string;
      status: string;
      forced: number;
    };
    expect(outboxRow).toBeDefined();
    expect(outboxRow.status).toBe('pending');
    expect(outboxRow.forced).toBe(0);

    // -------------------------------------------------------------------------
    // Step 8: Reconnect: Go online, replay outbox mutation with conflict resolution
    // -------------------------------------------------------------------------
    onlineManager.setOnline(true);
    expect(onlineManager.isOnline()).toBe(true);

    let replayAttempts = 0;
    const mutationExecutor = async (mutation: OutboxMutation) => {
      replayAttempts++;
      if (replayAttempts === 1) {
        // First replay encounter upstream HTTP 409 Conflict
        return {
          status: 409,
          data: { error: 'Conflict: Upstream version changed to 1.1.0-rc1' },
        };
      }
      // Second attempt with client-wins forced flag succeeds
      return {
        status: 200,
        data: { ok: true, version: '1.1.1' },
      };
    };

    // Replay attempt 1: Triggers 409 conflict -> client-wins re-queues with forced = 1
    const replayResult1 = await outbox.replay(mutationExecutor);
    expect(replayResult1.processed).toBe(1);

    const reQueued = outbox.getMutation('mut-publish-patch-1');
    expect(reQueued).not.toBeNull();
    expect(reQueued?.forced).toBe(true);
    expect(reQueued?.status).toBe('pending');

    // Replay attempt 2: Forced replay succeeds and removes mutation from outbox
    const replayResult2 = await outbox.replay(mutationExecutor);
    expect(replayResult2.processed).toBe(1);
    expect(replayResult2.successful).toBe(1);
    expect(outbox.getPendingMutations()).toHaveLength(0);
    expect(outbox.getMutation('mut-publish-patch-1')).toBeNull();

    // -------------------------------------------------------------------------
    // Step 9: Durability: Trigger flushAll(), verify WAL checkpoint, close cleanly with zero leaks
    // -------------------------------------------------------------------------
    // Force write operation to guarantee WAL pages are present
    sqliteAdapter.setQuery({
      query_hash: 'durability-sentinel',
      query_key: ['system', 'sentinel'],
      data_payload: { status: 'healthy', timestamp: Date.now() },
      created_at: Date.now(),
      stale_at: Date.now() + 10_000,
      expires_at: Date.now() + 60_000,
    });

    expect(fs.existsSync(walPath)).toBe(true);
    const walSizePreCheckpoint = fs.statSync(walPath).size;
    expect(walSizePreCheckpoint).toBeGreaterThan(0);

    // Trigger synchronous exit durability flush
    durabilityManager.flushAll();

    // Verify WAL checkpoint truncated WAL file to 0 bytes
    const walSizePostCheckpoint = fs.statSync(walPath).size;
    expect(walSizePostCheckpoint).toBe(0);

    // Clean teardown
    unsubObserver();
    wsTransport.disconnect();
    onlineManager.cleanup();
    sqliteAdapter.close();

    // Verify state.db can be reopened cleanly and read without corruption
    const reopenAdapter = new SqliteAdapter(dbPath);
    const sentinelQuery = reopenAdapter.getQuery('durability-sentinel');
    expect(sentinelQuery?.data_payload).toEqual(
      expect.objectContaining({ status: 'healthy' })
    );
    reopenAdapter.close();

    // Remove temporary directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
