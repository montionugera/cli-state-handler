import type { CacheEntry, QueryKey, QueryState } from '../types.js';
import type { SqliteAdapter, ChangeLogRow } from '../storage/sqlite-adapter.js';
import type { BusClient } from '../ipc/bus-client.js';
import type { CasStore } from '../storage/cas-store.js';
import {
  type ResumeStrategy,
  createRangeResumeStrategy,
} from '../streaming/resume-strategy.js';
import { StreamResumeFsm } from '../streaming/stream-resume-fsm.js';
import { Utf8StreamDecoder } from '../streaming/utf8-stream-decoder.js';
import { StreamHandle, type StreamSlice } from '../streaming/stream-handle.js';
import { replaceEqualDeep, isPlainObject } from './structural-sharing.js';
import {
  type PayloadRegistry,
  IncompatiblePayloadError,
} from './payload-upcaster.js';
import { hashQueryKey } from './key-hasher.js';

export interface QueryEngineOptions {
  /**
   * Optional SQLite adapter for persistent disk-backed caching.
   */
  sqliteAdapter?: SqliteAdapter;

  /**
   * Optional IPC bus client for zero-polling cross-process cache invalidation.
   */
  busClient?: BusClient;

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

  /**
   * Optional payload registry for automatic schema and payload upcasting.
   */
  payloadRegistry?: PayloadRegistry;

  /**
   * Target payload version for cached entries.
   * If an entry's payload_version is lower than targetPayloadVersion,
   * it will be lazily upcasted on cache read and written back to SQLite.
   */
  targetPayloadVersion?: number;

  /**
   * Optional callback triggered when an incompatible, un-upcastable,
   * or corrupt cached payload is selectively evicted.
   */
  onIncompatiblePayload?: (
    err: Error,
    entry: CacheEntry<unknown> | { query_hash: string; query_key?: QueryKey }
  ) => void;
}

export interface StreamQueryOptions {
  staleTime?: number;
  gcTime?: number;
  tags?: string[];
  encoding?: 'utf8' | 'bytes';
  strategy?: ResumeStrategy;
  casStore?: CasStore;
  casThresholdBytes?: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  maxRetries?: number;
}

export interface StreamFnContext {
  queryHash: string;
  signal: AbortSignal;
  resumeHeaders?: Record<string, string>;
  continuationPayload?: unknown;
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

export { hashQueryKey };

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
  private readonly busClient?: BusClient;
  private readonly defaultStaleTime: number;
  private readonly defaultGcTime: number;
  private readonly payloadRegistry?: PayloadRegistry;
  private readonly targetPayloadVersion?: number;
  private readonly onIncompatiblePayload?: (
    err: Error,
    entry: CacheEntry<unknown> | { query_hash: string; query_key?: QueryKey }
  ) => void;

  private readonly queries = new Map<string, InternalQueryRecord<unknown>>();

  constructor(options?: QueryEngineOptions) {
    this.sqliteAdapter = options?.sqliteAdapter;
    this.busClient = options?.busClient;
    this.defaultStaleTime = options?.defaultStaleTime ?? 0;
    this.defaultGcTime = options?.defaultGcTime ?? 300000;
    this.payloadRegistry = options?.payloadRegistry;
    this.targetPayloadVersion = options?.targetPayloadVersion;
    this.onIncompatiblePayload = options?.onIncompatiblePayload;

    if (this.busClient) {
      this.busClient.subscribeEvents((event) => this.handleRemoteEvent(event));
    }
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
   * Streams a query with incremental UTF-8/bytes slicing, automatic compaction into SQLite/CAS,
   * failure recovery via StreamResumeFsm, and SWR caching.
   */
  streamQuery<T = string>(
    queryKey: QueryKey,
    streamFn: (
      ctx: StreamFnContext
    ) =>
      | AsyncIterable<Buffer | string | Uint8Array>
      | Promise<AsyncIterable<Buffer | string | Uint8Array>>,
    options?: StreamQueryOptions
  ): StreamHandle<T> {
    const queryHash = hashQueryKey(queryKey);
    const record = this.getOrCreateRecord<T>(
      queryKey,
      queryHash,
      options as QueryOptions
    );

    // SWR check: if query is cached in SQLite or in memory and fresh
    const staleThreshold =
      options?.staleTime !== undefined && record.entry
        ? record.entry.created_at + options.staleTime
        : record.entry?.stale_at ?? 0;

    const isFresh = Boolean(record.entry) && Date.now() < staleThreshold;

    if (isFresh && record.state.data !== undefined) {
      const cachedData = record.state.data as T;
      const cachedHandle = new StreamHandle<T>({ queryHash });
      cachedHandle.push({
        delta: cachedData,
        cumulative: cachedData,
        seq: 0,
        byteOffset: 0,
        done: true,
      });
      return cachedHandle;
    }

    // Create stream in SQLite adapter
    if (this.sqliteAdapter) {
      try {
        const existing = this.sqliteAdapter.getStream(queryHash);
        if (existing) {
          try {
            this.sqliteAdapter.db
              .prepare('DELETE FROM ucsa_streams WHERE query_hash = ?')
              .run(queryHash);
          } catch {
            // ignore
          }
        }
        this.sqliteAdapter.createStream(queryKey, {
          encoding: options?.encoding ?? 'utf8',
          tags: options?.tags,
          ttlMs: options?.gcTime,
          resumeKind:
            options?.strategy?.kind === 'last-event-id'
              ? 'last-event-id'
              : 'range',
        });
      } catch {
        // Stream may already exist or DB table error
      }
    }

    const isUtf8 = options?.encoding !== 'bytes';
    let utf8Decoder = isUtf8 ? new Utf8StreamDecoder() : undefined;

    const strategy = options?.strategy ?? createRangeResumeStrategy();
    const resumeFsm = new StreamResumeFsm({
      queryHash,
      queryKey,
      strategy,
      sqliteAdapter: this.sqliteAdapter,
      baseDelayMs: options?.baseDelayMs,
      maxRetries: options?.maxRetries,
    });
    resumeFsm.start();

    const internalController = new AbortController();
    const internalSignal = internalController.signal;
    const handle = new StreamHandle<T>({
      queryHash,
      abortController: internalController,
    });
    record.activeController = internalController;

    const doCancel = (reason: string) => {
      if (!internalSignal.aborted) {
        internalController.abort(reason);
      }
      if (!handle.isCancelled) {
        handle.cancel(reason);
      }
      this.sqliteAdapter?.abortStream(queryHash, reason);
      resumeFsm.abort(reason);
      record.state = {
        ...record.state,
        isFetching: false,
      };
      this.notifySubscribers(record as InternalQueryRecord<unknown>);
    };

    if (options?.signal?.aborted) {
      doCancel(String(options.signal.reason ?? 'Aborted'));
      return handle;
    }

    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        doCancel(String(options.signal!.reason ?? 'Aborted'));
      });
    }

    handle.abortSignal.addEventListener('abort', () => {
      doCancel(String(handle.abortSignal.reason ?? 'Cancelled'));
    });

    record.state = {
      ...record.state,
      status: record.state.data !== undefined ? record.state.status : 'loading',
      isFetching: true,
    };
    this.notifySubscribers(record as InternalQueryRecord<unknown>);

    let cumulativeText = '';
    let cumulativeBuffers: Buffer[] = [];

    // Background pipeline execution
    (async () => {
      let currentResumeHeaders: Record<string, string> | undefined;
      let currentContinuationPayload: unknown | undefined;

      while (!handle.isDone && !handle.isCancelled && !internalSignal.aborted) {
        try {
          const ctx: StreamFnContext = {
            queryHash,
            signal: internalSignal,
            resumeHeaders: currentResumeHeaders,
            continuationPayload: currentContinuationPayload,
          };

          const iterable = await streamFn(ctx);

          for await (const rawChunk of iterable) {
            if (handle.isCancelled || internalSignal.aborted) {
              break;
            }

            const chunkBuf = Buffer.isBuffer(rawChunk)
              ? rawChunk
              : typeof rawChunk === 'string'
              ? rawChunk
              : Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength);
            const chunkResult = resumeFsm.handleIncomingChunk(chunkBuf);
            if (!chunkResult.accepted) {
              continue;
            }

            if (isUtf8 && utf8Decoder) {
              const delta = utf8Decoder.decode(chunkResult.slice);
              cumulativeText += delta;
              if (delta.length > 0) {
                handle.push({
                  delta: delta as unknown as T,
                  cumulative: cumulativeText as unknown as T,
                  seq: chunkResult.seq,
                  byteOffset: chunkResult.byteOffset,
                  done: false,
                });
              }
            } else {
              cumulativeBuffers.push(chunkResult.slice);
              const cumulativeBuf = Buffer.concat(cumulativeBuffers);
              handle.push({
                delta: chunkResult.slice as unknown as T,
                cumulative: cumulativeBuf as unknown as T,
                seq: chunkResult.seq,
                byteOffset: chunkResult.byteOffset,
                done: false,
              });
            }
          }

          if (handle.isCancelled || internalSignal.aborted) {
            break;
          }

          resumeFsm.complete();

          let finalPayload: T;
          if (isUtf8 && utf8Decoder) {
            const flushed = utf8Decoder.flush();
            if (flushed.length > 0) {
              cumulativeText += flushed;
              handle.push({
                delta: flushed as unknown as T,
                cumulative: cumulativeText as unknown as T,
                seq: resumeFsm.committedSeq,
                byteOffset: resumeFsm.committedByteLength,
                done: false,
              });
            }
            finalPayload = cumulativeText as unknown as T;
          } else {
            finalPayload = Buffer.concat(cumulativeBuffers) as unknown as T;
          }

          let compactedEntry: CacheEntry<unknown> | undefined;
          if (this.sqliteAdapter) {
            try {
              compactedEntry = await this.sqliteAdapter.compactStream(
                queryHash,
                options?.casStore,
                options?.casThresholdBytes
              );
            } catch {
              // Ignore compaction error
            }
          }

          const now = Date.now();
          const staleTime = options?.staleTime ?? this.defaultStaleTime;
          const gcTime = options?.gcTime ?? this.defaultGcTime;

          if (compactedEntry && options?.staleTime !== undefined) {
            compactedEntry.stale_at =
              compactedEntry.created_at + options.staleTime;
            try {
              this.sqliteAdapter?.setQuery(compactedEntry, options.tags);
            } catch {
              // Ignore
            }
          }

          const entryToStore: CacheEntry<unknown> = compactedEntry ?? {
            query_hash: queryHash,
            query_key: queryKey,
            data_payload: finalPayload,
            created_at: now,
            stale_at: now + staleTime,
            expires_at: now + gcTime,
            payload_version: this.targetPayloadVersion ?? 1,
          };

          record.entry = entryToStore as CacheEntry<T>;
          record.state = {
            status: 'success',
            data: entryToStore.data_payload as T,
            dataUpdatedAt: now,
            error: undefined,
            errorUpdatedAt: record.state.errorUpdatedAt,
            isFetching: false,
          };
          this.notifySubscribers(record as InternalQueryRecord<unknown>);

          handle.push({
            delta: (isUtf8 ? '' : Buffer.alloc(0)) as unknown as T,
            cumulative: finalPayload,
            seq: resumeFsm.committedSeq,
            byteOffset: resumeFsm.committedByteLength,
            done: true,
          });
          handle.end(finalPayload);
          break;
        } catch (err: unknown) {
          if (handle.isCancelled || internalSignal.aborted) {
            break;
          }

          const errorResult = resumeFsm.handleError(err);
          if (errorResult.canResume) {
            currentResumeHeaders = errorResult.headers;
            currentContinuationPayload = errorResult.continuationPayload;
            if (errorResult.restart) {
              cumulativeText = '';
              cumulativeBuffers = [];
              if (isUtf8) {
                utf8Decoder = new Utf8StreamDecoder();
              }
              handle.push({
                delta: (isUtf8 ? '' : Buffer.alloc(0)) as unknown as T,
                cumulative: (isUtf8 ? '' : Buffer.alloc(0)) as unknown as T,
                seq: 0,
                byteOffset: 0,
                done: false,
                reset: true,
              });
            }
            if (errorResult.retryDelayMs > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, errorResult.retryDelayMs)
              );
            }
            continue;
          } else {
            const finalError =
              err instanceof Error ? err : new Error(String(err));
            resumeFsm.abort(finalError.message);
            handle.error(finalError);
            record.state = {
              ...record.state,
              status: 'error',
              error: finalError,
              errorUpdatedAt: Date.now(),
              isFetching: false,
            };
            this.notifySubscribers(record as InternalQueryRecord<unknown>);
            break;
          }
        }
      }
    })().catch(() => {});

    return handle;
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

    if (this.busClient) {
      const hashes =
        matchedHashes.size > 0
          ? Array.from(matchedHashes)
          : [hashQueryKey(queryKeyOrPrefix)];
      this.busClient.publish({
        kind: 'invalidate',
        queryHashes: hashes,
      });
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

    if (this.busClient) {
      this.busClient.publish({
        kind: 'invalidate',
        tags: [tag],
        queryHashes: Array.from(invalidatedHashes),
      });
    }

    if (revalidations.length > 0) {
      await Promise.allSettled(revalidations);
    }

    return Array.from(invalidatedHashes);
  }

  /**
   * Handles incoming IPC bus events (with echo suppression).
   */
  private handleRemoteEvent(event: ChangeLogRow): void {
    if (this.sqliteAdapter?.origin && event.origin === this.sqliteAdapter.origin) {
      return;
    }
    if (this.busClient?.clientId && event.origin === this.busClient.clientId) {
      return;
    }

    if (event.kind === 'invalidate') {
      const affectedRecords = new Set<InternalQueryRecord<unknown>>();

      if (event.tags && event.tags.length > 0) {
        const eventTags = new Set(event.tags);
        for (const record of this.queries.values()) {
          if (record.tags?.some((t) => eventTags.has(t))) {
            affectedRecords.add(record);
          }
        }
      }

      if (event.query_hashes && event.query_hashes.length > 0) {
        for (const hash of event.query_hashes) {
          const record = this.queries.get(hash);
          if (record) {
            affectedRecords.add(record);
          }
        }
      }

      for (const record of affectedRecords) {
        if (record.entry) {
          record.entry.stale_at = 0;
        }
        record.state = {
          ...record.state,
          dataUpdatedAt: 0,
        };

        if (record.queryFn) {
          record.state = {
            ...record.state,
            isFetching: true,
          };
          this.notifySubscribers(record);
          this.executeFetch(record, record.queryFn, record.options).catch(() => {});
        } else if (record.subscribers.size > 0) {
          this.notifySubscribers(record);
        }
      }
    }
  }

  /**
   * Synchronously reads the query state for a query key from memory or SQLite.
   */
  getQueryState<T>(queryKey: QueryKey): QueryState<T> | undefined {
    const hash = hashQueryKey(queryKey);
    const record = this.queries.get(hash) as InternalQueryRecord<T> | undefined;
    if (record) {
      try {
        this.maybeUpcastRecord(record);
        return record.state;
      } catch (err) {
        this.handleIncompatibleEntry(hash, queryKey, record.entry, err);
        return undefined;
      }
    }

    if (this.sqliteAdapter) {
      try {
        let entry = this.sqliteAdapter.getQuery<T>(hash);
        if (entry && Date.now() <= entry.expires_at) {
          entry = this.maybeUpcastEntry(queryKey, hash, entry);
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
      } catch (err) {
        this.handleIncompatibleEntry(hash, queryKey, undefined, err);
        return undefined;
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
      payload_version: this.targetPayloadVersion ?? 1,
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
          payload_version: this.targetPayloadVersion ?? 1,
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
      try {
        this.maybeUpcastRecord(record);
        return record;
      } catch (err) {
        this.handleIncompatibleEntry(hash, queryKey, record.entry, err);
      }
    }

    if (this.sqliteAdapter) {
      try {
        let entry = this.sqliteAdapter.getQuery<T>(hash);
        if (entry) {
          if (Date.now() <= entry.expires_at) {
            entry = this.maybeUpcastEntry(queryKey, hash, entry);
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
      } catch (err) {
        this.handleIncompatibleEntry(hash, queryKey, undefined, err);
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

  private handleIncompatibleEntry(
    hash: string,
    queryKey: QueryKey,
    entry: CacheEntry<unknown> | undefined,
    err: unknown
  ): void {
    this.queries.delete(hash);
    if (this.sqliteAdapter) {
      try {
        this.sqliteAdapter.deleteQuery(hash);
      } catch {
        // ignore
      }
    }
    const normalizedError =
      err instanceof Error ? err : new IncompatiblePayloadError(String(err));
    if (this.onIncompatiblePayload) {
      try {
        this.onIncompatiblePayload(
          normalizedError,
          entry ?? { query_hash: hash, query_key: queryKey }
        );
      } catch {
        // ignore telemetry errors
      }
    }
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

  private maybeUpcastEntry<T>(
    queryKey: QueryKey,
    hash: string,
    entry: CacheEntry<T>
  ): CacheEntry<T> {
    const currentVersion = entry.payload_version ?? 1;
    if (
      this.payloadRegistry &&
      this.targetPayloadVersion !== undefined &&
      currentVersion < this.targetPayloadVersion
    ) {
      try {
        const upcastResult = this.payloadRegistry.upcast<T>(
          queryKey,
          entry.data_payload,
          currentVersion,
          this.targetPayloadVersion
        );
        entry.data_payload = upcastResult.data;
        entry.payload_version = this.targetPayloadVersion;

        if (this.sqliteAdapter) {
          try {
            this.sqliteAdapter.updateQueryPayload(
              hash,
              entry.data_payload,
              entry.payload_version
            );
          } catch {
            // Resilience: do not fail cache read if background write-back fails
          }
        }
      } catch (err) {
        throw new IncompatiblePayloadError(
          `Payload cannot be upcasted from version ${currentVersion} to ${this.targetPayloadVersion}: ${err instanceof Error ? err.message : String(err)}`,
          {
            queryKey,
            payloadVersion: currentVersion,
            targetVersion: this.targetPayloadVersion,
            cause: err,
          }
        );
      }
    }
    return entry;
  }

  private maybeUpcastRecord<T>(record: InternalQueryRecord<T>): void {
    if (!record.entry) return;
    const currentVersion = record.entry.payload_version ?? 1;
    if (
      this.payloadRegistry &&
      this.targetPayloadVersion !== undefined &&
      currentVersion < this.targetPayloadVersion
    ) {
      try {
        const upcastResult = this.payloadRegistry.upcast<T>(
          record.queryKey,
          record.entry.data_payload,
          currentVersion,
          this.targetPayloadVersion
        );
        record.entry.data_payload = upcastResult.data;
        record.entry.payload_version = this.targetPayloadVersion;
        if (record.state.data !== undefined) {
          record.state.data = upcastResult.data;
        }

        if (this.sqliteAdapter) {
          try {
            this.sqliteAdapter.updateQueryPayload(
              record.hash,
              record.entry.data_payload,
              record.entry.payload_version
            );
          } catch {
            // Resilience: do not fail cache read
          }
        }
      } catch (err) {
        throw new IncompatiblePayloadError(
          `Payload cannot be upcasted from version ${currentVersion} to ${this.targetPayloadVersion}: ${err instanceof Error ? err.message : String(err)}`,
          {
            queryKey: record.queryKey,
            payloadVersion: currentVersion,
            targetVersion: this.targetPayloadVersion,
            cause: err,
          }
        );
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
