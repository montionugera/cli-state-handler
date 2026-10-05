/**
 * Core type contracts for Unified Client State Architecture (UCSA).
 */

/**
 * Structured hierarchical key representing a cached query.
 * Must be JSON-serializable.
 */
export type QueryKey = readonly unknown[];

/**
 * 5-stage lifecycle query status.
 */
export type QueryStatus = 'idle' | 'loading' | 'success' | 'error' | 'retrying';

/**
 * Authoritative cached query entry stored in memory and persisted in SQLite.
 */
export interface CacheEntry<TData = unknown> {
  query_hash: string;
  query_key: QueryKey;
  data_payload: TData;
  etag?: string;
  created_at: number;
  stale_at: number;
  expires_at: number;
}

/**
 * Offline mutation status.
 */
export type OutboxMutationStatus = 'pending' | 'in_flight' | 'failed';

/**
 * Outbox mutation record for offline resilience and replay.
 */
export interface OutboxMutation<TPayload = unknown> {
  mutation_id: string;
  endpoint: string;
  method: string;
  headers?: Record<string, string>;
  payload?: TPayload;
  status: OutboxMutationStatus;
  retry_count: number;
  created_at: number;
  last_attempt_at?: number;
  error?: string;
  forced?: boolean;
  conflictPolicy?: ConflictPolicy;
  onRollback?: (mutation: OutboxMutation<TPayload>) => void | Promise<void>;
  mergeResolver?: (
    localData: TPayload | undefined,
    serverData: unknown
  ) => TPayload | Promise<TPayload>;
}

/**
 * Conflict resolution policies for optimistic offline updates.
 */
export type ConflictPolicy = 'server-wins' | 'client-wins' | 'merge';

/**
 * Standard transport request shape for network ingress adapters.
 */
export interface TransportRequest<TPayload = unknown> {
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  payload?: TPayload;
  signal?: AbortSignal;
}

/**
 * Standard transport response shape returned by adapters.
 */
export interface TransportResponse<TData = unknown> {
  data: TData;
  etag?: string;
  status: number;
  headers?: Record<string, string>;
}

/**
 * Invalidation push event from WebSocket / SSE / WebRTC ingress.
 */
export interface InvalidationEvent {
  type: 'INVALIDATE';
  tags?: readonly string[];
  query_key?: QueryKey;
}

/**
 * Unsubscribe callback returned by event subscriptions.
 */
export type UnsubscribeFn = () => void;

/**
 * Pluggable transport adapter interface bridging network protocols into the query cache.
 */
export interface TransportAdapter {
  fetch<TData = unknown, TPayload = unknown>(
    request: TransportRequest<TPayload>
  ): Promise<TransportResponse<TData>>;
  subscribe(
    onEvent: (event: InvalidationEvent) => void
  ): UnsubscribeFn;
}

/**
 * In-memory reactive query state representation.
 */
export interface QueryState<TData = unknown, TError = unknown> {
  status: QueryStatus;
  data?: TData;
  error?: TError;
  dataUpdatedAt?: number;
  errorUpdatedAt?: number;
  isFetching?: boolean;
}
