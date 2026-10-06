import type { CacheEntry, QueryKey, QueryState } from '../types.js';
import type { SqliteAdapter } from '../storage/sqlite-adapter.js';
import { replaceEqualDeep, isPlainObject } from './structural-sharing.js';

export interface QueryEngineOptions {
  /**
   * Optional SQLite adapter for persistent disk-backed caching.
   */
  sqliteAdapter?: SqliteAdapter;

  /**
   * Default stale time in milliseconds.
   * Cached queries younger than staleTime are considered fresh.
   * @default 0
   */
  defaultStaleTime?: number;

  /**
   * Default garbage collection time in milliseconds.
   * Entries older than gcTime are expired.
   * @default 300000 (5 minutes)
   */
  defaultGcTime?: number;
}

export interface QueryOptions {
  /**
   * Custom stale time in milliseconds for this query.
   */
  staleTime?: number;

  /**
   * Domain tags associated with this query for fast indexed invalidation.
   */
  tags?: string[];

  /**
   * Optional debounce delay in milliseconds before executing queryFn.
   * Subsequent calls within the window reset the timer and share the final result.
   */
  debounceMs?: number;
}

export interface UseQueryResult<T> {
  /**
   * Synchronously returns the current query state snapshot.
   */
  getSnapshot: () => QueryState<T>;

  /**
   * Subscribes a listener to query state changes.
   * Returns an unsubscribe function.
   */
  subscribe: (callback: () => void) => () => void;

  /**
   * Cancels the active query fetch if one is in flight.
   */
  cancel: () => void;
}

export type QueryFunction<T> = (ctx: { signal: AbortSignal }) => Promise<T>;

/**
 * Generates a deterministic hash for a QueryKey tuple.
 * Plain objects inside the tuple have their keys sorted to ensure consistent serialization.
 */
export function hashQueryKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey, (_key, val) => {
    if (isPlainObject(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = val[k];
          return acc;
        }, {});
    }
    return val;
  });
}

/**
 * Deep equality comparison for query keys and partial matching.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (
        !deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
      ) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Checks if targetQueryKey matches prefixQueryKey.
 * A prefix match succeeds if target is at least as long as prefix, and every prefix element matches.
 * Plain objects in prefix match partially against plain objects in target.
 */
export function matchQueryKey(prefix: QueryKey, target: QueryKey): boolean {
  if (prefix.length > target.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    const p = prefix[i];
    const t = target[i];
    if (isPlainObject(p) && isPlainObject(t)) {
      for (const key of Object.keys(p)) {
        if (
          !deepEqual(
            (p as Record<string, unknown>)[key],
            (t as Record<string, unknown>)[key]
          )
        ) {
          return false;
        }
      }
    } else if (!deepEqual(p, t)) {
      return false;
    }
  }
  return true;
}

interface InternalQueryRecord<T = unknown> {
  queryKey: QueryKey;
  hash: string;
  entry?: CacheEntry<T>;
  tags?: string[];
  options?: QueryOptions;
  queryFn?: QueryFunction<T>;
  state: QueryState<T>;
  subscribers: Set<() => void>;
  activeController?: AbortController;
  activePromise?: Promise<T>;
  debounceTimer?: ReturnType<typeof setTimeout>;
  debounceResolvers?: Array<{
    resolve: (data: T) => void;
    reject: (error: unknown) => void;
  }>;
}

/**
 * Core UCSA Query Engine providing asynchronous caching, Stale-While-Revalidate (SWR),
 * structural sharing, and AbortSignal query cancellation.
 */
export class QueryEngine {
  private readonly sqliteAdapter?: SqliteAdapter;
  private readonly defaultStaleTime: number;
  private readonly defaultGcTime: number;

  private readonly queries = new Map<string, InternalQueryRecord<unknown>>();

  constructor(options?: QueryEngineOptions) {
    this.sqliteAdapter = options?.sqliteAdapter;
    this.defaultStaleTime = options?.defaultStaleTime ?? 0;
    this.defaultGcTime = options?.defaultGcTime ?? 300000;
  }

  /**
   * Fetches and caches a query, returning a Promise resolving to the data.
   * If fresh data is already cached, returns immediately without invoking queryFn.
   * If debounceMs is specified, delays execution and collapses rapid successive calls.
   */
  async fetchQuery<T>(
    queryKey: QueryKey,
    queryFn: QueryFunction<T>,
    options?: QueryOptions
  ): Promise<T> {
    const hash = hashQueryKey(queryKey);
    const record = this.getOrCreateRecord<T>(queryKey, hash, options);

    const staleThreshold =
      options?.staleTime !== undefined && record.entry
        ? record.entry.created_at + options.staleTime
        : record.entry?.stale_at ?? 0;

    const isFresh = Boolean(record.entry) && Date.now() < staleThreshold;

    if (isFresh && record.state.data !== undefined) {
      return record.state.data;
    }

    record.queryFn = queryFn;
    record.options = options;
    if (options?.tags) {
      record.tags = options.tags;
    }

    if (options?.debounceMs !== undefined && options.debounceMs > 0) {
      if (!record.debounceResolvers) {
        record.debounceResolvers = [];
      }

      if (record.debounceTimer) {
        clearTimeout(record.debounceTimer);
      }

      return new Promise<T>((resolve, reject) => {
        record.debounceResolvers!.push({
          resolve: resolve as (data: unknown) => void,
          reject,
        });

        record.debounceTimer = setTimeout(async () => {
          record.debounceTimer = undefined;
          const resolvers = record.debounceResolvers ?? [];
          record.debounceResolvers = undefined;

          try {
            const data = await this.executeFetch(
              record,
              record.queryFn as QueryFunction<T>,
              record.options
            );
            for (const r of resolvers) {
              r.resolve(data);
            }
          } catch (err) {
            for (const r of resolvers) {
              r.reject(err);
            }
          }
        }, options.debounceMs);
      });
    }

    return this.executeFetch(record, queryFn, options);
  }

  /**
   * Reactive hook-compatible query subscriber supporting Stale-While-Revalidate (SWR).
   * Synchronously populates state from memory or SQLite, and triggers background revalidation if stale.
   */
  useQuery<T>(
    queryKey: QueryKey,
    queryFn: QueryFunction<T>,
    options?: QueryOptions
  ): UseQueryResult<T> {
    const hash = hashQueryKey(queryKey);
    const record = this.getOrCreateRecord<T>(queryKey, hash, options);

    record.queryFn = queryFn;
    record.options = options;
    if (options?.tags) {
      record.tags = options.tags;
    }

    const staleThreshold =
      options?.staleTime !== undefined && record.entry
        ? record.entry.created_at + options.staleTime
        : record.entry?.stale_at ?? 0;

    const hasData = record.state.data !== undefined;
    const isStale = !record.entry || Date.now() >= staleThreshold;

    if (!hasData) {
      record.state = {
        ...record.state,
        status: 'loading',
        isFetching: true,
      };
      this.executeFetch(record, queryFn, options).catch(() => {});
    } else if (isStale) {
      // SWR: Cache hit! Data is present, but stale. Revalidate in the background.
      record.state = {
        ...record.state,
        isFetching: true,
      };
      this.executeFetch(record, queryFn, options).catch(() => {});
    } else {
      // Cache hit and fresh.
      record.state = {
        ...record.state,
        isFetching: false,
      };
    }

    return {
      getSnapshot: () => record.state,
      subscribe: (callback: () => void) => {
        record.subscribers.add(callback);
        return () => {
          record.subscribers.delete(callback);
        };
      },
      cancel: () => {
        this.cancelQuery(queryKey);
      },
    };
  }

  /**
   * Subscribes a listener to state changes for the specified query key.
   * Returns an unsubscribe function.
   */
  subscribe(queryKey: QueryKey, callback: () => void): () => void {
    const hash = hashQueryKey(queryKey);
    const record = this.getOrCreateRecord(queryKey, hash);
    record.subscribers.add(callback);
    return () => {
      record.subscribers.delete(callback);
    };
  }

  /**
   * Cancels any active in-flight fetch operation or pending debounce timer for the specified query key.
   */
  cancelQuery(queryKey: QueryKey): void {
    const hash = hashQueryKey(queryKey);
    const record = this.queries.get(hash);

    if (record?.debounceTimer) {
      clearTimeout(record.debounceTimer);
      record.debounceTimer = undefined;
      const resolvers = record.debounceResolvers ?? [];
      record.debounceResolvers = undefined;
      const cancelErr = new Error('Query was cancelled');
      for (const r of resolvers) {
        r.reject(cancelErr);
      }
    }

    if (record?.activeController) {
      record.activeController.abort();
      record.activeController = undefined;
      record.activePromise = undefined;
      record.state = {
        ...record.state,
        isFetching: false,
      };
    }
  }

  /**
   * Invalidates all queries matching the query key prefix.
   * Marks matching queries as stale and triggers revalidation for active queries.
   */
  async invalidateQueries(queryKeyOrPrefix: QueryKey): Promise<void> {
    const matchedHashes = new Set<string>();

    for (const [hash, record] of this.queries.entries()) {
      if (matchQueryKey(queryKeyOrPrefix, record.queryKey)) {
        matchedHashes.add(hash);
      }
    }

    if (this.sqliteAdapter) {
      try {
        const rows = this.sqliteAdapter.db
          .prepare('SELECT query_hash, query_key FROM ucsa_query_cache')
          .all() as Array<{ query_hash: string; query_key: string }>;

        for (const row of rows) {
          try {
            const parsedKey = JSON.parse(row.query_key) as QueryKey;
            if (matchQueryKey(queryKeyOrPrefix, parsedKey)) {
              matchedHashes.add(row.query_hash);
              this.sqliteAdapter.deleteQuery(row.query_hash);
            }
          } catch {
            // Ignore parse errors
          }
        }
      } catch {
        // Ignore table errors
      }
    }

    const revalidations: Promise<unknown>[] = [];

    for (const hash of matchedHashes) {
      const record = this.queries.get(hash);
      if (record) {
        if (record.entry) {
          record.entry.stale_at = 0;
        }
        if (record.queryFn) {
          record.state = {
            ...record.state,
            isFetching: true,
          };
          revalidations.push(
            this.executeFetch(record, record.queryFn, record.options).catch(
              () => {}
            )
          );
        }
      }
    }

    if (revalidations.length > 0) {
      await Promise.allSettled(revalidations);
    }
  }

  /**
   * Invalidates all queries tagged with the specified tag.
   * Returns the list of query hashes that were invalidated.
   */
  async invalidateByTag(tag: string): Promise<string[]> {
    const invalidatedHashes = new Set<string>();

    // 1. Invalidate in SQLite
    if (this.sqliteAdapter) {
      const dbHashes = this.sqliteAdapter.invalidateByTag(tag);
      for (const h of dbHashes) {
        invalidatedHashes.add(h);
      }
    }

    // 2. Invalidate in memory
    for (const [hash, record] of this.queries.entries()) {
      if (record.tags?.includes(tag) || invalidatedHashes.has(hash)) {
        invalidatedHashes.add(hash);
      }
    }

    const revalidations: Promise<unknown>[] = [];

    for (const hash of invalidatedHashes) {
      const record = this.queries.get(hash);
      if (record) {
        if (record.entry) {
          record.entry.stale_at = 0;
        }
        if (record.queryFn) {
          record.state = {
            ...record.state,
            isFetching: true,
          };
          revalidations.push(
            this.executeFetch(record, record.queryFn, record.options).catch(
              () => {}
            )
          );
        }
      }
    }

    if (revalidations.length > 0) {
      await Promise.allSettled(revalidations);
    }

    return Array.from(invalidatedHashes);
  }

  /**
   * Synchronously reads the query state for a query key from memory or SQLite.
   */
  getQueryState<T>(queryKey: QueryKey): QueryState<T> | undefined {
    const hash = hashQueryKey(queryKey);
    const record = this.queries.get(hash) as InternalQueryRecord<T> | undefined;
    if (record) {
      return record.state;
    }

    if (this.sqliteAdapter) {
      const entry = this.sqliteAdapter.getQuery<T>(hash);
      if (entry && Date.now() <= entry.expires_at) {
        const newRecord: InternalQueryRecord<T> = {
          queryKey,
          hash,
          entry,
          subscribers: new Set(),
          state: {
            status: 'success',
            data: entry.data_payload,
            dataUpdatedAt: entry.created_at,
            isFetching: false,
          },
        };
        this.queries.set(hash, newRecord as InternalQueryRecord<unknown>);
        return newRecord.state;
      }
    }

    return undefined;
  }

  /**
   * Synchronously reads query data if present.
   */
  getQueryData<T>(queryKey: QueryKey): T | undefined {
    return this.getQueryState<T>(queryKey)?.data;
  }

  /**
   * Manually sets or updates cached query data.
   */
  setQueryData<T>(
    queryKey: QueryKey,
    data: T,
    options?: QueryOptions
  ): void {
    const hash = hashQueryKey(queryKey);
    const record = this.getOrCreateRecord<T>(queryKey, hash, options);
    const now = Date.now();
    const staleTime = options?.staleTime ?? this.defaultStaleTime;
    const gcTime = this.defaultGcTime;

    const oldData = record.state.data;
    const sharedData =
      oldData !== undefined ? replaceEqualDeep(oldData, data) : data;
    const dataChanged = oldData === undefined || sharedData !== oldData;

    record.state = {
      status: 'success',
      data: sharedData,
      dataUpdatedAt: now,
      error: undefined,
      errorUpdatedAt: record.state.errorUpdatedAt,
      isFetching: false,
    };

    const entry: CacheEntry<T> = {
      query_hash: hash,
      query_key: queryKey,
      data_payload: sharedData,
      created_at: now,
      stale_at: now + staleTime,
      expires_at: now + gcTime,
    };
    record.entry = entry;

    if (this.sqliteAdapter) {
      const tags = options?.tags ?? record.tags;
      this.sqliteAdapter.setQuery(entry, tags);
    }

    if (dataChanged) {
      this.notifySubscribers(record as InternalQueryRecord<unknown>);
    }
  }

  /**
   * Clears the in-memory cache and aborts any active fetch operations.
   */
  clear(): void {
    for (const record of this.queries.values()) {
      if (record.activeController) {
        record.activeController.abort();
      }
    }
    this.queries.clear();
  }

  private async executeFetch<T>(
    record: InternalQueryRecord<T>,
    queryFn: QueryFunction<T>,
    options?: QueryOptions
  ): Promise<T> {
    if (record.activePromise) {
      return record.activePromise;
    }

    const controller = new AbortController();
    record.activeController = controller;

    const promise = (async () => {
      const prevStatus = record.state.status;
      const oldData = record.state.data;

      try {
        const rawData = await queryFn({ signal: controller.signal });

        const now = Date.now();
        const staleTime = options?.staleTime ?? this.defaultStaleTime;
        const gcTime = this.defaultGcTime;

        // Apply structural sharing if old data exists
        const sharedData =
          oldData !== undefined ? replaceEqualDeep(oldData, rawData) : rawData;

        const dataChanged = oldData === undefined || sharedData !== oldData;
        const statusChanged = prevStatus !== 'success';

        record.state = {
          status: 'success',
          data: sharedData,
          dataUpdatedAt: now,
          error: undefined,
          errorUpdatedAt: record.state.errorUpdatedAt,
          isFetching: false,
        };

        const entry: CacheEntry<T> = {
          query_hash: record.hash,
          query_key: record.queryKey,
          data_payload: sharedData,
          created_at: now,
          stale_at: now + staleTime,
          expires_at: now + gcTime,
        };
        record.entry = entry;

        if (this.sqliteAdapter) {
          const tags = options?.tags ?? record.tags;
          this.sqliteAdapter.setQuery(entry, tags);
        }

        // Prevent unnecessary notifications if data is structurally identical
        if (dataChanged || statusChanged) {
          this.notifySubscribers(record as InternalQueryRecord<unknown>);
        }

        return sharedData;
      } catch (err) {
        if (controller.signal.aborted) {
          // Query was cancelled. Preserve existing data, only reset isFetching.
          record.state = {
            ...record.state,
            isFetching: false,
          };
          throw err;
        }

        const now = Date.now();
        record.state = {
          ...record.state,
          status: 'error',
          error: err,
          errorUpdatedAt: now,
          isFetching: false,
        };

        this.notifySubscribers(record as InternalQueryRecord<unknown>);
        throw err;
      } finally {
        if (record.activeController === controller) {
          record.activeController = undefined;
          record.activePromise = undefined;
        }
      }
    })();

    record.activePromise = promise;
    return promise;
  }

  private getOrCreateRecord<T>(
    queryKey: QueryKey,
    hash: string,
    options?: QueryOptions
  ): InternalQueryRecord<T> {
    let record = this.queries.get(hash) as InternalQueryRecord<T> | undefined;
    if (record) {
      return record;
    }

    if (this.sqliteAdapter) {
      const entry = this.sqliteAdapter.getQuery<T>(hash);
      if (entry) {
        if (Date.now() <= entry.expires_at) {
          record = {
            queryKey,
            hash,
            entry,
            tags: options?.tags,
            options,
            subscribers: new Set(),
            state: {
              status: 'success',
              data: entry.data_payload,
              dataUpdatedAt: entry.created_at,
              isFetching: false,
            },
          };
          this.queries.set(hash, record as InternalQueryRecord<unknown>);
          return record;
        } else {
          this.sqliteAdapter.deleteQuery(hash);
        }
      }
    }

    record = {
      queryKey,
      hash,
      tags: options?.tags,
      options,
      subscribers: new Set(),
      state: {
        status: 'loading',
        data: undefined,
        error: undefined,
        isFetching: false,
      },
    };
    this.queries.set(hash, record as InternalQueryRecord<unknown>);
    return record;
  }

  private notifySubscribers(record: InternalQueryRecord<unknown>): void {
    for (const sub of Array.from(record.subscribers)) {
      try {
        sub();
      } catch (err) {
        console.error('Error in query subscriber:', err);
      }
    }
  }
}

/**
 * Convenient helper to trigger a debounced query fetch.
 * Collapses rapid invocations for the same queryKey into a single execution after debounceMs of quiet.
 */
export function debounceQuery<T>(
  engine: QueryEngine,
  queryKey: QueryKey,
  queryFn: QueryFunction<T>,
  options?: QueryOptions & { debounceMs: number }
): Promise<T> {
  return engine.fetchQuery(queryKey, queryFn, options);
}
