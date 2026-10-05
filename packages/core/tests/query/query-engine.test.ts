import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  QueryEngine,
  replaceEqualDeep,
  isPlainObject,
  hashQueryKey,
  matchQueryKey,
  SqliteAdapter,
} from '../../src/index.js';
import type { CacheEntry, QueryKey } from '../../src/index.js';

describe('Task 2: Query Engine, SWR, Structural Sharing & Cancellation', () => {
  let adapter: SqliteAdapter;

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new SqliteAdapter(':memory:');
  });

  afterEach(() => {
    adapter.close();
    vi.restoreAllMocks();
  });

  describe('1. Structural Sharing (replaceEqualDeep)', () => {
    it('returns exact same reference when prev === next', () => {
      const obj = { id: 1, name: 'Alice' };
      expect(replaceEqualDeep(obj, obj)).toBe(obj);

      const arr = [1, 2, 3];
      expect(replaceEqualDeep(arr, arr)).toBe(arr);

      expect(replaceEqualDeep(42, 42)).toBe(42);
      expect(replaceEqualDeep('str', 'str')).toBe('str');
    });

    it('returns next when prev or next is primitive or different type', () => {
      expect(replaceEqualDeep(1, 2)).toBe(2);
      expect(replaceEqualDeep('foo', 'bar')).toBe('bar');
      expect(replaceEqualDeep(null, { a: 1 })).toEqual({ a: 1 });
      expect(replaceEqualDeep({ a: 1 }, null)).toBeNull();
      expect(replaceEqualDeep(undefined, [1, 2])).toEqual([1, 2]);
      expect(replaceEqualDeep([1], { 0: 1 })).toEqual({ 0: 1 });
    });

    it('preserves object reference when new object has identical key-values', () => {
      const prev = { id: 1, name: 'Alice', meta: { role: 'admin' } };
      const next = { id: 1, name: 'Alice', meta: { role: 'admin' } };

      const result = replaceEqualDeep(prev, next);
      expect(result).toBe(prev);
      expect(result.meta).toBe(prev.meta);
    });

    it('preserves unchanged child references on partial object change', () => {
      const prev = {
        id: 1,
        profile: { name: 'Alice', avatar: 'pic.png' },
        settings: { theme: 'dark', notifications: true },
      };
      const next = {
        id: 1,
        profile: { name: 'Alice Updated', avatar: 'pic.png' },
        settings: { theme: 'dark', notifications: true },
      };

      const result = replaceEqualDeep(prev, next);
      // Top level changed
      expect(result).not.toBe(prev);
      // Changed sub-object has new reference
      expect(result.profile).not.toBe(prev.profile);
      expect(result.profile.name).toBe('Alice Updated');
      // Unchanged sub-object maintains exact reference
      expect(result.settings).toBe(prev.settings);
    });

    it('preserves array reference when elements are identical', () => {
      const prev = [
        { id: 1, val: 'a' },
        { id: 2, val: 'b' },
      ];
      const next = [
        { id: 1, val: 'a' },
        { id: 2, val: 'b' },
      ];

      const result = replaceEqualDeep(prev, next);
      expect(result).toBe(prev);
      expect(result[0]).toBe(prev[0]);
      expect(result[1]).toBe(prev[1]);
    });

    it('preserves unchanged array element references on partial change', () => {
      const prev = [
        { id: 1, val: 'a' },
        { id: 2, val: 'b' },
      ];
      const next = [
        { id: 1, val: 'a' },
        { id: 2, val: 'b-changed' },
      ];

      const result = replaceEqualDeep(prev, next);
      expect(result).not.toBe(prev);
      // Item 0 is identical and preserves reference
      expect(result[0]).toBe(prev[0]);
      // Item 1 changed
      expect(result[1]).not.toBe(prev[1]);
      expect(result[1].val).toBe('b-changed');
    });

    it('returns new array when length changes but preserves matching items', () => {
      const item1 = { id: 1 };
      const item2 = { id: 2 };
      const prev = [item1, item2];
      const next = [item1];

      const result = replaceEqualDeep(prev, next);
      expect(result).not.toBe(prev);
      expect(result.length).toBe(1);
      expect(result[0]).toBe(item1);
    });

    it('preserves non-plain objects identity (Date, RegExp, Map)', () => {
      const d1 = new Date(1000);
      const d2 = new Date(1000);
      expect(replaceEqualDeep(d1, d2)).toBe(d2);

      const r1 = /abc/;
      const r2 = /abc/;
      expect(replaceEqualDeep(r1, r2)).toBe(r2);

      expect(isPlainObject(d1)).toBe(false);
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject(Object.create(null))).toBe(true);
    });
  });

  describe('2. QueryKey Hashing & Matching', () => {
    it('produces deterministic hash irrespective of key property ordering', () => {
      const keyA: QueryKey = ['users', { role: 'admin', page: 1 }];
      const keyB: QueryKey = ['users', { page: 1, role: 'admin' }];

      expect(hashQueryKey(keyA)).toBe(hashQueryKey(keyB));
    });

    it('matches query keys by prefix', () => {
      expect(matchQueryKey(['users'], ['users'])).toBe(true);
      expect(matchQueryKey(['users'], ['users', 1])).toBe(true);
      expect(matchQueryKey(['users'], ['users', 'detail', '123'])).toBe(true);
      expect(matchQueryKey(['users', 1], ['users', 2])).toBe(false);
      expect(matchQueryKey(['users'], ['posts', 1])).toBe(false);
      expect(
        matchQueryKey(
          ['users', { role: 'admin' }],
          ['users', { role: 'admin', page: 1 }]
        )
      ).toBe(true);
      expect(
        matchQueryKey(
          ['users', { role: 'admin' }],
          ['users', { role: 'user', page: 1 }]
        )
      ).toBe(false);
    });
  });

  describe('3. Synchronous Cache Reads (Memory & SQLite)', () => {
    it('reads synchronously from in-memory cache with zero async ticks', async () => {
      const engine = new QueryEngine();
      const queryKey = ['test', 'sync-memory'];

      // Seed cache
      await engine.fetchQuery(queryKey, async () => ({ value: 'in-memory-data' }), {
        staleTime: 60000,
      });

      // Synchronous read via getQueryState
      const state = engine.getQueryState<{ value: string }>(queryKey);
      expect(state).toBeDefined();
      expect(state?.status).toBe('success');
      expect(state?.data).toEqual({ value: 'in-memory-data' });

      // Synchronous read via useQuery
      const queryFnMock = vi.fn();
      const query = engine.useQuery<{ value: string }>(queryKey, queryFnMock, {
        staleTime: 60000,
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.status).toBe('success');
      expect(snapshot.data).toEqual({ value: 'in-memory-data' });
      expect(snapshot.isFetching).toBe(false);
      expect(queryFnMock).not.toHaveBeenCalled();
    });

    it('reads synchronously from SQLite cache on cold engine launch', () => {
      const queryKey = ['users', 42];
      const hash = hashQueryKey(queryKey);
      const now = Date.now();

      // Pre-populate SQLite directly (simulating a cold start of a new process)
      const entry: CacheEntry<{ id: number; name: string }> = {
        query_hash: hash,
        query_key: queryKey,
        data_payload: { id: 42, name: 'Alice from SQLite' },
        created_at: now,
        stale_at: now + 60000, // fresh for 1 min
        expires_at: now + 300000,
      };
      adapter.setQuery(entry, ['tag:user']);

      // Initialize fresh QueryEngine with empty in-memory cache
      const engine = new QueryEngine({ sqliteAdapter: adapter });

      // Synchronous read via getQueryState
      const state = engine.getQueryState<{ id: number; name: string }>(queryKey);
      expect(state).toBeDefined();
      expect(state?.status).toBe('success');
      expect(state?.data).toEqual({ id: 42, name: 'Alice from SQLite' });

      // Synchronous read via useQuery
      const queryFnMock = vi.fn();
      const query = engine.useQuery<{ id: number; name: string }>(
        queryKey,
        queryFnMock,
        { staleTime: 60000 }
      );

      const snapshot = query.getSnapshot();
      expect(snapshot.status).toBe('success');
      expect(snapshot.data).toEqual({ id: 42, name: 'Alice from SQLite' });
      expect(snapshot.isFetching).toBe(false);
      expect(queryFnMock).not.toHaveBeenCalled();
    });
  });

  describe('4. Stale-While-Revalidate (SWR)', () => {
    it('immediately yields stale data from cache while firing background revalidation', async () => {
      const queryKey = ['feed', 'latest'];
      const hash = hashQueryKey(queryKey);
      const now = Date.now();

      // Seed SQLite with stale entry (stale_at in the past)
      const stalePayload = { version: 1, items: ['item1'] };
      const entry: CacheEntry<typeof stalePayload> = {
        query_hash: hash,
        query_key: queryKey,
        data_payload: stalePayload,
        created_at: now - 10000,
        stale_at: now - 5000, // Stale!
        expires_at: now + 60000,
      };
      adapter.setQuery(entry);

      const engine = new QueryEngine({ sqliteAdapter: adapter });

      let resolveFetch!: (val: typeof stalePayload) => void;
      const fetchPromise = new Promise<typeof stalePayload>((res) => {
        resolveFetch = res;
      });
      const fetcher = vi.fn().mockImplementation(() => fetchPromise);

      // Invoke useQuery
      const query = engine.useQuery(queryKey, fetcher, { staleTime: 5000 });

      // SWR: 1. Synchronously returns stale data immediately
      const initialSnapshot = query.getSnapshot();
      expect(initialSnapshot.status).toBe('success');
      expect(initialSnapshot.data).toEqual(stalePayload);
      expect(initialSnapshot.isFetching).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Subscribe to updates
      const listener = vi.fn();
      const unsubscribe = query.subscribe(listener);

      // 2. Background revalidation resolves with fresh data
      const freshPayload = { version: 2, items: ['item1', 'item2'] };
      resolveFetch(freshPayload);
      await fetchPromise;
      // Allow microtasks to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      const updatedSnapshot = query.getSnapshot();
      expect(updatedSnapshot.status).toBe('success');
      expect(updatedSnapshot.data).toEqual(freshPayload);
      expect(updatedSnapshot.isFetching).toBe(false);

      // Verify SQLite was updated with fresh data
      const saved = adapter.getQuery<typeof freshPayload>(hash);
      expect(saved?.data_payload).toEqual(freshPayload);

      unsubscribe();
    });

    it('cold load without cache transitions from loading to success', async () => {
      const engine = new QueryEngine();
      const queryKey = ['posts', 1];

      let resolveFetch!: (val: string) => void;
      const fetchPromise = new Promise<string>((res) => {
        resolveFetch = res;
      });
      const fetcher = vi.fn().mockImplementation(() => fetchPromise);

      const query = engine.useQuery(queryKey, fetcher);

      // Synchronously in loading state
      expect(query.getSnapshot().status).toBe('loading');
      expect(query.getSnapshot().data).toBeUndefined();
      expect(query.getSnapshot().isFetching).toBe(true);

      const listener = vi.fn();
      query.subscribe(listener);

      // Resolve fetch
      resolveFetch('post-payload-1');
      await fetchPromise;
      await new Promise((r) => setTimeout(r, 10));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(query.getSnapshot().status).toBe('success');
      expect(query.getSnapshot().data).toBe('post-payload-1');
      expect(query.getSnapshot().isFetching).toBe(false);
    });
  });

  describe('5. Structural Sharing in QueryEngine', () => {
    it('retains exact reference and suppresses notification when background fetch returns identical payload', async () => {
      const queryKey = ['user', 'profile'];
      const initialUser = {
        id: 101,
        details: { name: 'Bob', email: 'bob@example.com' },
        tags: ['developer', 'admin'],
      };

      const engine = new QueryEngine({ defaultStaleTime: 0 }); // immediately stale
      engine.setQueryData(queryKey, initialUser);

      const oldData = engine.getQueryData<typeof initialUser>(queryKey);
      expect(oldData).toBe(initialUser);

      // Background fetch returns newly allocated, structurally identical object
      const networkPayload = {
        id: 101,
        details: { name: 'Bob', email: 'bob@example.com' },
        tags: ['developer', 'admin'],
      };

      const fetcher = vi.fn().mockResolvedValue(networkPayload);
      const query = engine.useQuery<typeof initialUser>(queryKey, fetcher);

      const listener = vi.fn();
      query.subscribe(listener);

      // Wait for background fetch to resolve
      await new Promise((r) => setTimeout(r, 20));

      expect(fetcher).toHaveBeenCalledTimes(1);

      // Structural sharing: identical payload returns identical object reference
      const currentData = query.getSnapshot().data;
      expect(currentData).toBe(oldData);
      expect(currentData?.details).toBe(oldData?.details);
      expect(currentData?.tags).toBe(oldData?.tags);

      // Unnecessary notification was suppressed!
      expect(listener).not.toHaveBeenCalled();
    });

    it('preserves unchanged nested object references when partial fields update', async () => {
      const queryKey = ['workspace', 1];
      const initialWorkspace = {
        id: 1,
        name: 'Main Workspace',
        theme: { mode: 'dark', accent: 'blue' },
        billing: { plan: 'enterprise', seats: 20 },
      };

      const engine = new QueryEngine({ defaultStaleTime: 0 });
      engine.setQueryData(queryKey, initialWorkspace);

      const oldData = engine.getQueryData<typeof initialWorkspace>(queryKey)!;

      // Background fetch updates name, but theme & billing are unchanged
      const updatedNetwork = {
        id: 1,
        name: 'Renamed Workspace',
        theme: { mode: 'dark', accent: 'blue' },
        billing: { plan: 'enterprise', seats: 20 },
      };

      const fetcher = vi.fn().mockResolvedValue(updatedNetwork);
      const query = engine.useQuery<typeof initialWorkspace>(queryKey, fetcher);

      const listener = vi.fn();
      query.subscribe(listener);

      await new Promise((r) => setTimeout(r, 20));

      expect(listener).toHaveBeenCalledTimes(1);
      const currentData = query.getSnapshot().data!;

      // Top-level reference changed
      expect(currentData).not.toBe(oldData);
      expect(currentData.name).toBe('Renamed Workspace');

      // Unchanged nested structures retained exact memory references!
      expect(currentData.theme).toBe(oldData.theme);
      expect(currentData.billing).toBe(oldData.billing);
    });
  });

  describe('6. AbortSignal & Cancellation', () => {
    it('passes AbortSignal to queryFn and fires abort event on cancelQuery()', async () => {
      const engine = new QueryEngine();
      const queryKey = ['cancellable', 'request'];

      let signalObserved: AbortSignal | null = null;
      let abortEventFired = false;

      const fetchPromise = engine.fetchQuery(queryKey, async ({ signal }) => {
        signalObserved = signal;
        signal.addEventListener('abort', () => {
          abortEventFired = true;
        });

        return new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      expect(signalObserved).toBeInstanceOf(AbortSignal);
      expect(signalObserved!.aborted).toBe(false);
      expect(abortEventFired).toBe(false);

      // Cancel the query
      engine.cancelQuery(queryKey);

      expect(signalObserved!.aborted).toBe(true);
      expect(abortEventFired).toBe(true);

      await expect(fetchPromise).rejects.toThrow('Aborted');
    });

    it('cancels via useQuery().cancel() without destroying existing cached data', async () => {
      const engine = new QueryEngine();
      const queryKey = ['user', 'cancel-test'];

      // Seed cache
      engine.setQueryData(queryKey, { name: 'Preserved' });

      let abortSignal: AbortSignal | null = null;
      const fetcher = vi.fn().mockImplementation(({ signal }) => {
        abortSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('Cancelled'));
          });
        });
      });

      const query = engine.useQuery(queryKey, fetcher, { staleTime: 0 });
      expect(query.getSnapshot().data).toEqual({ name: 'Preserved' });
      expect(query.getSnapshot().isFetching).toBe(true);

      // Cancel query
      query.cancel();
      expect(abortSignal!.aborted).toBe(true);

      await new Promise((r) => setTimeout(r, 20));

      // Data is still intact and isFetching is reset to false
      expect(query.getSnapshot().data).toEqual({ name: 'Preserved' });
      expect(query.getSnapshot().status).toBe('success');
      expect(query.getSnapshot().isFetching).toBe(false);
    });
  });

  describe('7. staleTime Enforcement', () => {
    it('subsequent reads within staleTime return cached data without calling queryFn', async () => {
      const engine = new QueryEngine();
      const queryKey = ['metrics', 'cpu'];
      const fetcher = vi.fn().mockResolvedValue({ usage: 42 });

      // First fetch
      const res1 = await engine.fetchQuery(queryKey, fetcher, { staleTime: 5000 });
      expect(res1).toEqual({ usage: 42 });
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Second read immediately: should use cache
      const res2 = await engine.fetchQuery(queryKey, fetcher, { staleTime: 5000 });
      expect(res2).toEqual({ usage: 42 });
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Third read via useQuery within staleTime: should not trigger fetch
      const query = engine.useQuery(queryKey, fetcher, { staleTime: 5000 });
      expect(query.getSnapshot().data).toEqual({ usage: 42 });
      expect(query.getSnapshot().isFetching).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('refetches when staleTime has elapsed', async () => {
      vi.useFakeTimers();
      const engine = new QueryEngine();
      const queryKey = ['ticker', 'aapl'];
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce({ price: 150 })
        .mockResolvedValueOnce({ price: 155 });

      await engine.fetchQuery(queryKey, fetcher, { staleTime: 1000 });
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Advance time by 1500ms (stale!)
      vi.advanceTimersByTime(1500);

      const res = await engine.fetchQuery(queryKey, fetcher, { staleTime: 1000 });
      expect(res).toEqual({ price: 155 });
      expect(fetcher).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('8. Tag Invalidation', () => {
    it('invalidateByTag marks matching queries as stale and triggers revalidation', async () => {
      const engine = new QueryEngine({ sqliteAdapter: adapter });

      const fetcherUser1 = vi
        .fn()
        .mockResolvedValueOnce({ id: 1, name: 'Alice v1' })
        .mockResolvedValueOnce({ id: 1, name: 'Alice v2' });

      const fetcherUser2 = vi
        .fn()
        .mockResolvedValueOnce({ id: 2, name: 'Bob v1' })
        .mockResolvedValueOnce({ id: 2, name: 'Bob v2' });

      const fetcherOrder = vi
        .fn()
        .mockResolvedValueOnce({ orderId: 99, status: 'open' });

      // Mount user 1 and user 2 with tag:user
      const qUser1 = engine.useQuery(['user', 1], fetcherUser1, {
        staleTime: 60000,
        tags: ['tag:user'],
      });
      const qUser2 = engine.useQuery(['user', 2], fetcherUser2, {
        staleTime: 60000,
        tags: ['tag:user'],
      });

      // Mount order with tag:order
      const qOrder = engine.useQuery(['order', 99], fetcherOrder, {
        staleTime: 60000,
        tags: ['tag:order'],
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(qUser1.getSnapshot().data).toEqual({ id: 1, name: 'Alice v1' });
      expect(qUser2.getSnapshot().data).toEqual({ id: 2, name: 'Bob v1' });
      expect(qOrder.getSnapshot().data).toEqual({ orderId: 99, status: 'open' });
      expect(fetcherUser1).toHaveBeenCalledTimes(1);
      expect(fetcherUser2).toHaveBeenCalledTimes(1);
      expect(fetcherOrder).toHaveBeenCalledTimes(1);

      // Invalidate by tag 'tag:user'
      const invalidated = await engine.invalidateByTag('tag:user');
      expect(invalidated.length).toBe(2);

      // User queries revalidated to v2
      expect(fetcherUser1).toHaveBeenCalledTimes(2);
      expect(fetcherUser2).toHaveBeenCalledTimes(2);
      expect(qUser1.getSnapshot().data).toEqual({ id: 1, name: 'Alice v2' });
      expect(qUser2.getSnapshot().data).toEqual({ id: 2, name: 'Bob v2' });

      // Order query was NOT touched
      expect(fetcherOrder).toHaveBeenCalledTimes(1);
      expect(qOrder.getSnapshot().data).toEqual({ orderId: 99, status: 'open' });
    });

    it('invalidateQueries invalidates by prefix and revalidates active queries', async () => {
      const engine = new QueryEngine({ sqliteAdapter: adapter });

      const fetcherList = vi
        .fn()
        .mockResolvedValueOnce(['a', 'b'])
        .mockResolvedValueOnce(['a', 'b', 'c']);

      const fetcherDetail = vi
        .fn()
        .mockResolvedValueOnce({ id: 'a' })
        .mockResolvedValueOnce({ id: 'a', updated: true });

      const fetcherConfig = vi
        .fn()
        .mockResolvedValueOnce({ theme: 'dark' });

      const qList = engine.useQuery(['items', 'list'], fetcherList, {
        staleTime: 60000,
      });
      const qDetail = engine.useQuery(['items', 'detail', 'a'], fetcherDetail, {
        staleTime: 60000,
      });
      const qConfig = engine.useQuery(['config', 'app'], fetcherConfig, {
        staleTime: 60000,
      });

      await new Promise((r) => setTimeout(r, 20));

      expect(fetcherList).toHaveBeenCalledTimes(1);
      expect(fetcherDetail).toHaveBeenCalledTimes(1);
      expect(fetcherConfig).toHaveBeenCalledTimes(1);

      // Invalidate all queries starting with ['items']
      await engine.invalidateQueries(['items']);

      expect(fetcherList).toHaveBeenCalledTimes(2);
      expect(fetcherDetail).toHaveBeenCalledTimes(2);
      expect(qList.getSnapshot().data).toEqual(['a', 'b', 'c']);
      expect(qDetail.getSnapshot().data).toEqual({ id: 'a', updated: true });

      // Config was not invalidated
      expect(fetcherConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('9. Query Deduplication & Error Handling', () => {
    it('deduplicates simultaneous in-flight fetchQuery requests for the same key', async () => {
      const engine = new QueryEngine();
      const queryKey = ['dedup', 1];

      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 30));
        return { count: fetchCount };
      };

      const [res1, res2, res3] = await Promise.all([
        engine.fetchQuery(queryKey, fetcher),
        engine.fetchQuery(queryKey, fetcher),
        engine.fetchQuery(queryKey, fetcher),
      ]);

      expect(fetchCount).toBe(1);
      expect(res1).toEqual({ count: 1 });
      expect(res2).toEqual({ count: 1 });
      expect(res3).toEqual({ count: 1 });
    });

    it('captures errors, sets status to error, and notifies subscribers', async () => {
      const engine = new QueryEngine();
      const queryKey = ['failing', 'query'];

      const fetcher = vi.fn().mockRejectedValue(new Error('Network offline'));
      const query = engine.useQuery(queryKey, fetcher);

      const listener = vi.fn();
      query.subscribe(listener);

      await new Promise((r) => setTimeout(r, 20));

      expect(listener).toHaveBeenCalled();
      const snapshot = query.getSnapshot();
      expect(snapshot.status).toBe('error');
      expect((snapshot.error as Error).message).toBe('Network offline');
      expect(snapshot.isFetching).toBe(false);
    });
  });
});
