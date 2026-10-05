import { describe, it, expect } from 'vitest';
import type {
  QueryKey,
  QueryStatus,
  CacheEntry,
  OutboxMutation,
  ConflictPolicy,
  TransportAdapter,
  TransportRequest,
  TransportResponse,
  InvalidationEvent,
  QueryState,
} from '../src/index.js';

describe('Core Type Contracts', () => {
  it('instantiates valid QueryKey tuples', () => {
    const key1: QueryKey = ['users', 123];
    const key2: QueryKey = ['posts', { limit: 10, offset: 0 }];
    const key3: QueryKey = [];

    expect(key1).toEqual(['users', 123]);
    expect(key2).toEqual(['posts', { limit: 10, offset: 0 }]);
    expect(key3).toEqual([]);
    expect(Array.isArray(key1)).toBe(true);
  });

  it('validates all QueryStatus lifecycle states', () => {
    const statuses: QueryStatus[] = ['idle', 'loading', 'success', 'error', 'retrying'];
    expect(statuses).toHaveLength(5);
    expect(statuses).toContain('idle');
    expect(statuses).toContain('loading');
    expect(statuses).toContain('success');
    expect(statuses).toContain('error');
    expect(statuses).toContain('retrying');
  });

  it('instantiates CacheEntry with typed payload and metadata', () => {
    interface UserProfile {
      id: string;
      name: string;
    }

    const now = Date.now();
    const entry: CacheEntry<UserProfile> = {
      query_hash: 'hash_users_123',
      query_key: ['users', '123'],
      data_payload: { id: '123', name: 'Alice' },
      etag: '"v1-hash"',
      created_at: now,
      stale_at: now + 60_000,
      expires_at: now + 300_000,
    };

    expect(entry.query_hash).toBe('hash_users_123');
    expect(entry.query_key).toEqual(['users', '123']);
    expect(entry.data_payload.name).toBe('Alice');
    expect(entry.etag).toBe('"v1-hash"');
    expect(entry.stale_at).toBeGreaterThan(entry.created_at);
    expect(entry.expires_at).toBeGreaterThan(entry.stale_at);
  });

  it('instantiates OutboxMutation with proper status and retry counter', () => {
    interface UpdateNamePayload {
      name: string;
    }

    const mutation: OutboxMutation<UpdateNamePayload> = {
      mutation_id: 'mut_001',
      endpoint: '/api/v1/users/123',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      payload: { name: 'Bob' },
      status: 'pending',
      retry_count: 0,
      created_at: Date.now(),
      last_attempt_at: undefined,
    };

    expect(mutation.mutation_id).toBe('mut_001');
    expect(mutation.method).toBe('PATCH');
    expect(mutation.status).toBe('pending');
    expect(mutation.retry_count).toBe(0);
    expect(mutation.payload?.name).toBe('Bob');
  });

  it('validates ConflictPolicy union types', () => {
    const policies: ConflictPolicy[] = ['server-wins', 'client-wins', 'merge'];
    expect(policies).toContain('server-wins');
    expect(policies).toContain('client-wins');
    expect(policies).toContain('merge');
  });

  it('satisfies TransportAdapter interface with fetch and subscribe', async () => {
    class MockTransportAdapter implements TransportAdapter {
      private subscribers = new Set<(event: InvalidationEvent) => void>();

      async fetch<TData = unknown, TPayload = unknown>(
        request: TransportRequest<TPayload>
      ): Promise<TransportResponse<TData>> {
        return {
          data: { fetched: true, endpoint: request.endpoint } as unknown as TData,
          status: 200,
          etag: '"etag-123"',
        };
      }

      subscribe(onEvent: (event: InvalidationEvent) => void): () => void {
        this.subscribers.add(onEvent);
        return () => {
          this.subscribers.delete(onEvent);
        };
      }

      emit(event: InvalidationEvent) {
        for (const sub of this.subscribers) {
          sub(event);
        }
      }
    }

    const adapter = new MockTransportAdapter();
    const response = await adapter.fetch({ endpoint: '/users/42' });
    expect(response.status).toBe(200);
    expect(response.etag).toBe('"etag-123"');

    const events: InvalidationEvent[] = [];
    const unsubscribe = adapter.subscribe((evt) => {
      events.push(evt);
    });

    adapter.emit({ type: 'INVALIDATE', tags: ['user-42'] });
    expect(events).toHaveLength(1);
    expect(events[0].tags).toEqual(['user-42']);

    unsubscribe();
    adapter.emit({ type: 'INVALIDATE', tags: ['user-42'] });
    expect(events).toHaveLength(1);
  });

  it('instantiates QueryState correctly', () => {
    const state: QueryState<string, Error> = {
      status: 'success',
      data: 'Hello World',
      dataUpdatedAt: Date.now(),
      isFetching: false,
    };

    expect(state.status).toBe('success');
    expect(state.data).toBe('Hello World');
    expect(state.isFetching).toBe(false);
  });
});
