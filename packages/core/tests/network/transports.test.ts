import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OnlineManager,
  FocusManager,
  BffTransport,
  BffHttpError,
  GqlTransport,
  GqlError,
  WsTransport,
  WebRtcDataTransport,
} from '../../src/index.js';
import type {
  WebSocketLike,
  RTCDataChannelLike,
} from '../../src/index.js';

describe('Network Managers & Transports', () => {
  describe('OnlineManager', () => {
    let manager: OnlineManager;

    beforeEach(() => {
      manager = new OnlineManager();
    });

    afterEach(() => {
      manager.cleanup();
    });

    it('defaults to online (true)', () => {
      expect(manager.isOnline()).toBe(true);
    });

    it('tracks online/offline status and emits events to listeners on change', () => {
      const listener = vi.fn();
      const unsub = manager.subscribe(listener);

      manager.setOnline(false);
      expect(manager.isOnline()).toBe(false);
      expect(listener).toHaveBeenCalledWith(false);

      manager.setOnline(true);
      expect(manager.isOnline()).toBe(true);
      expect(listener).toHaveBeenCalledWith(true);

      // Should not notify if setting same status
      manager.setOnline(true);
      expect(listener).toHaveBeenCalledTimes(2);

      unsub();
      manager.setOnline(false);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('supports custom event listener setup and cleanup', () => {
      const cleanupMock = vi.fn();
      let emitPlatformOnline: ((online: boolean) => void) | undefined;

      manager.setEventListener((setOnline) => {
        emitPlatformOnline = setOnline;
        return cleanupMock;
      });

      expect(emitPlatformOnline).toBeDefined();
      emitPlatformOnline!(false);
      expect(manager.isOnline()).toBe(false);

      manager.cleanup();
      expect(cleanupMock).toHaveBeenCalled();
    });
  });

  describe('FocusManager', () => {
    let manager: FocusManager;

    beforeEach(() => {
      manager = new FocusManager();
    });

    afterEach(() => {
      manager.cleanup();
    });

    it('defaults to focused (true)', () => {
      expect(manager.isFocused()).toBe(true);
    });

    it('tracks window/tab focus status and notifies listeners on change', () => {
      const listener = vi.fn();
      const unsub = manager.subscribe(listener);

      manager.setFocused(false);
      expect(manager.isFocused()).toBe(false);
      expect(listener).toHaveBeenCalledWith(false);

      manager.setFocused(true);
      expect(manager.isFocused()).toBe(true);
      expect(listener).toHaveBeenCalledWith(true);

      // Duplicate focus does not trigger listener again
      manager.setFocused(true);
      expect(listener).toHaveBeenCalledTimes(2);

      unsub();
      manager.setFocused(false);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('supports custom event listener setup and cleanup', () => {
      const cleanupMock = vi.fn();
      let emitPlatformFocus: ((focused?: boolean) => void) | undefined;

      manager.setEventListener((setFocused) => {
        emitPlatformFocus = setFocused;
        return cleanupMock;
      });

      expect(emitPlatformFocus).toBeDefined();
      emitPlatformFocus!(false);
      expect(manager.isFocused()).toBe(false);

      manager.cleanup();
      expect(cleanupMock).toHaveBeenCalled();
    });
  });

  describe('BffTransport', () => {
    it('injects Authorization: Bearer <token> when static token is provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ message: 'authenticated' }),
      });

      const transport = new BffTransport({
        token: 'secret-jwt-123',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res = await transport.fetch({
        endpoint: 'https://api.example.com/v1/profile',
      });

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ message: 'authenticated' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/profile',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret-jwt-123',
          }),
        })
      );
    });

    it('injects Authorization: Bearer <token> when async token getter is provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ user: 'alice' }),
      });

      const tokenGetter = vi.fn().mockResolvedValue('dynamic-token-456');
      const transport = new BffTransport({
        token: tokenGetter,
        fetch: mockFetch as unknown as typeof fetch,
      });

      await transport.fetch({
        endpoint: '/users/me',
      });

      expect(tokenGetter).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        '/users/me',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer dynamic-token-456',
          }),
        })
      );
    });

    it('parses JSON response and extracts ETag header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({
          'content-type': 'application/json',
          etag: '"w/etag-001"',
        }),
        text: async () => JSON.stringify({ id: 1, name: 'Widget' }),
      });

      const transport = new BffTransport({
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res = await transport.fetch<{ id: number; name: string }>({
        endpoint: '/items/1',
      });

      expect(res.status).toBe(200);
      expect(res.etag).toBe('"w/etag-001"');
      expect(res.data).toEqual({ id: 1, name: 'Widget' });
      expect(transport.getCachedEtag('/items/1')).toBe('"w/etag-001"');
    });

    it('adds If-None-Match: <etag> when cached ETag exists', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: 200,
            ok: true,
            headers: new Headers({
              'content-type': 'application/json',
              etag: '"etag-xyz"',
            }),
            text: async () => JSON.stringify({ version: 1 }),
          };
        } else {
          return {
            status: 304,
            ok: true,
            headers: new Headers({
              etag: '"etag-xyz"',
            }),
            text: async () => '',
          };
        }
      });

      const transport = new BffTransport({
        fetch: mockFetch as unknown as typeof fetch,
      });

      // First request -> 200 OK + ETag
      const res1 = await transport.fetch({ endpoint: '/version' });
      expect(res1.status).toBe(200);
      expect(res1.etag).toBe('"etag-xyz"');

      // Second request -> should send If-None-Match: "etag-xyz"
      const res2 = await transport.fetch({ endpoint: '/version' });
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/version',
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-None-Match': '"etag-xyz"',
          }),
        })
      );
      // HTTP 304 returns status 304 and preserves cached data
      expect(res2.status).toBe(304);
      expect(res2.data).toEqual({ version: 1 });
      expect(res2.etag).toBe('"etag-xyz"');
    });

    it('translates RFC 7807 Problem Details into BffHttpError on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 409,
        ok: false,
        headers: new Headers({ 'content-type': 'application/problem+json' }),
        text: async () =>
          JSON.stringify({
            type: 'https://example.com/probs/conflict',
            title: 'Conflict detected',
            status: 409,
            detail: 'Item version mismatch',
            instance: '/items/123',
          }),
      });

      const transport = new BffTransport({
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        transport.fetch({ endpoint: '/items/123', method: 'PUT', payload: { version: 1 } })
      ).rejects.toThrow(BffHttpError);

      try {
        await transport.fetch({ endpoint: '/items/123' });
      } catch (err) {
        expect(err).toBeInstanceOf(BffHttpError);
        const bffErr = err as BffHttpError;
        expect(bffErr.status).toBe(409);
        expect(bffErr.problemDetails?.title).toBe('Conflict detected');
        expect(bffErr.problemDetails?.detail).toBe('Item version mismatch');
      }
    });

    it('supports subscription for invalidation events', () => {
      const transport = new BffTransport();
      const listener = vi.fn();
      const unsub = transport.subscribe(listener);

      transport.emitInvalidation({ type: 'INVALIDATE', tags: ['tag:profile'] });
      expect(listener).toHaveBeenCalledWith({ type: 'INVALIDATE', tags: ['tag:profile'] });

      unsub();
      transport.emitInvalidation({ type: 'INVALIDATE', tags: ['tag:profile'] });
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('GqlTransport', () => {
    it('formats GraphQL request payload { query, variables }', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ data: { user: { id: 'u1', name: 'Alice' } } }),
      });

      const transport = new GqlTransport({
        endpoint: 'https://api.example.com/graphql',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const res = await transport.fetch({
        endpoint: 'https://api.example.com/graphql',
        payload: {
          query: 'query GetUser($id: ID!) { user(id: $id) { id name } }',
          variables: { id: 'u1' },
        },
      });

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ user: { id: 'u1', name: 'Alice' } });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            query: 'query GetUser($id: ID!) { user(id: $id) { id name } }',
            variables: { id: 'u1' },
          }),
        })
      );
    });

    it('supports persisted document query hashing: { extensions: { persistedQuery: { sha256Hash: ... } } }', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ data: { orders: [{ id: 101 }] } }),
      });

      const transport = new GqlTransport({
        endpoint: 'https://api.example.com/graphql',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const hash = 'a6c8e31b67f1b2c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8';

      const res = await transport.fetch({
        endpoint: 'https://api.example.com/graphql',
        payload: {
          sha256Hash: hash,
          variables: { limit: 10 },
        },
      });

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ orders: [{ id: 101 }] });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            variables: { limit: 10 },
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: hash,
              },
            },
          }),
        })
      );
    });

    it('unwraps standard GraphQL { data, errors } responses, throwing formatted errors on GraphQL failures', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            data: null,
            errors: [
              { message: 'Field "secret" is not defined', locations: [{ line: 2, column: 3 }] },
              { message: 'Unauthorized access to resource' },
            ],
          }),
      });

      const transport = new GqlTransport({
        endpoint: '/graphql',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(
        transport.fetch({
          endpoint: '/graphql',
          payload: { query: '{ secret }' },
        })
      ).rejects.toThrow(GqlError);

      try {
        await transport.fetch({
          endpoint: '/graphql',
          payload: { query: '{ secret }' },
        });
      } catch (err) {
        expect(err).toBeInstanceOf(GqlError);
        const gqlErr = err as GqlError;
        expect(gqlErr.errors).toHaveLength(2);
        expect(gqlErr.message).toContain('Field "secret" is not defined');
        expect(gqlErr.message).toContain('Unauthorized access to resource');
      }
    });

    it('supports query helper method and auth injection', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ data: { count: 42 } }),
      });

      const transport = new GqlTransport({
        endpoint: '/graphql',
        token: 'token-abc',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const data = await transport.query<{ count: number }>('query { count }');
      expect(data).toEqual({ count: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        '/graphql',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token-abc',
          }),
        })
      );
    });
  });

  describe('WsTransport', () => {
    class MockWebSocket implements WebSocketLike {
      readyState = 0; // CONNECTING
      sentMessages: string[] = [];
      onopen: ((event: unknown) => void) | null = null;
      onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;

      constructor(public url: string) {}

      send(data: string) {
        this.sentMessages.push(data);
      }

      close(code = 1000, reason = 'Normal closure') {
        this.readyState = 3; // CLOSED
        this.onclose?.({ code, reason, wasClean: true });
      }

      // Test helper: simulate open
      triggerOpen() {
        this.readyState = 1; // OPEN
        this.onopen?.({});
      }

      // Test helper: simulate message
      triggerMessage(data: string) {
        this.onmessage?.({ data });
      }

      // Test helper: simulate error
      triggerError(err: unknown) {
        this.onerror?.(err);
      }
    }

    let activeSocket: MockWebSocket | null = null;

    beforeEach(() => {
      vi.useFakeTimers();
      activeSocket = null;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('implements connection lifecycle FSM (connecting, connected, disconnected, reconnecting)', () => {
      const stateTransitions: string[] = [];

      const transport = new WsTransport({
        url: 'wss://realtime.example.com/state',
        websocketFactory: (url) => {
          activeSocket = new MockWebSocket(url);
          return activeSocket;
        },
        reconnectBaseDelay: 100,
      });

      transport.onStateChange((st) => stateTransitions.push(st));

      expect(transport.getState()).toBe('disconnected');

      // 1. Connect -> connecting
      transport.connect();
      expect(transport.getState()).toBe('connecting');
      expect(activeSocket).not.toBeNull();

      // 2. Open -> connected
      activeSocket!.triggerOpen();
      expect(transport.getState()).toBe('connected');

      // 3. Socket abnormal drop -> reconnecting
      activeSocket!.close(1006, 'Abnormal closure');
      expect(transport.getState()).toBe('reconnecting');

      // Advance timers to trigger reconnect attempt
      vi.advanceTimersByTime(200);
      expect(transport.getState()).toBe('connecting');

      // Reconnect succeeds
      activeSocket!.triggerOpen();
      expect(transport.getState()).toBe('connected');

      // 4. Intentional disconnect -> disconnected
      transport.disconnect();
      expect(transport.getState()).toBe('disconnected');

      expect(stateTransitions).toEqual([
        'connecting',
        'connected',
        'reconnecting',
        'connecting',
        'connected',
        'disconnected',
      ]);
    });

    it('emits ping frames every interval (e.g. 30s) and handles pong', () => {
      const transport = new WsTransport({
        url: 'wss://realtime.example.com/state',
        pingInterval: 30000,
        websocketFactory: (url) => {
          activeSocket = new MockWebSocket(url);
          return activeSocket;
        },
      });

      transport.connect();
      activeSocket!.triggerOpen();

      expect(activeSocket!.sentMessages).toHaveLength(0);

      // Advance 30 seconds
      vi.advanceTimersByTime(30000);
      expect(activeSocket!.sentMessages).toHaveLength(1);
      const pingMsg = JSON.parse(activeSocket!.sentMessages[0]);
      expect(pingMsg.type).toBe('ping');

      // Respond with pong
      activeSocket!.triggerMessage(JSON.stringify({ type: 'pong' }));

      // Advance another 30 seconds
      vi.advanceTimersByTime(30000);
      expect(activeSocket!.sentMessages).toHaveLength(2);

      transport.disconnect();
    });

    it('ingests push messages: parses { type: "INVALIDATE", tags: ["tag:orders"] } and notifies registered invalidation listeners', () => {
      const transport = new WsTransport({
        url: 'wss://realtime.example.com/state',
        websocketFactory: (url) => {
          activeSocket = new MockWebSocket(url);
          return activeSocket;
        },
      });

      const invalidationListener = vi.fn();
      const unsub = transport.subscribe(invalidationListener);

      transport.connect();
      activeSocket!.triggerOpen();

      // Send push invalidation frame
      activeSocket!.triggerMessage(
        JSON.stringify({
          type: 'INVALIDATE',
          tags: ['tag:orders', 'tag:user-123'],
        })
      );

      expect(invalidationListener).toHaveBeenCalledWith({
        type: 'INVALIDATE',
        tags: ['tag:orders', 'tag:user-123'],
        query_key: undefined,
      });

      // Send non-invalidation message
      activeSocket!.triggerMessage(JSON.stringify({ type: 'CHAT_MESSAGE', text: 'hi' }));
      expect(invalidationListener).toHaveBeenCalledTimes(1);

      unsub();
      activeSocket!.triggerMessage(
        JSON.stringify({ type: 'INVALIDATE', tags: ['tag:orders'] })
      );
      expect(invalidationListener).toHaveBeenCalledTimes(1);

      transport.disconnect();
    });
  });

  describe('WebRtcDataTransport', () => {
    class MockDataChannel implements RTCDataChannelLike {
      readyState = 'connecting';
      sentData: Array<string | ArrayBuffer | ArrayBufferView> = [];
      onopen: ((event: unknown) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;

      send(data: string | ArrayBuffer | ArrayBufferView) {
        this.sentData.push(data);
      }

      close() {
        this.readyState = 'closed';
        this.onclose?.({});
      }

      triggerOpen() {
        this.readyState = 'open';
        this.onopen?.({});
      }

      triggerMessage(data: unknown) {
        this.onmessage?.({ data });
      }

      triggerError(err: unknown) {
        this.onerror?.(err);
      }
    }

    it('manages connection lifecycle (new, connecting, connected, disconnected, failed, closed)', () => {
      const stateHistory: string[] = [];
      const transport = new WebRtcDataTransport();
      transport.onStateChange((s) => stateHistory.push(s));

      expect(transport.getState()).toBe('new');

      const mockChannel = new MockDataChannel();
      transport.bindDataChannel(mockChannel);

      expect(transport.getState()).toBe('connecting');

      mockChannel.triggerOpen();
      expect(transport.getState()).toBe('connected');

      transport.setConnectionState('disconnected');
      expect(transport.getState()).toBe('disconnected');

      mockChannel.triggerError(new Error('RTC failed'));
      expect(transport.getState()).toBe('failed');

      mockChannel.close();
      expect(transport.getState()).toBe('closed');

      expect(stateHistory).toEqual([
        'connecting',
        'connected',
        'disconnected',
        'failed',
        'closed',
      ]);
    });

    it('handles ingress string data framing', () => {
      const transport = new WebRtcDataTransport();
      const mockChannel = new MockDataChannel();
      transport.bindDataChannel(mockChannel);
      mockChannel.triggerOpen();

      const invalidationListener = vi.fn();
      transport.subscribe(invalidationListener);

      // Ingress string JSON invalidation
      mockChannel.triggerMessage(
        JSON.stringify({
          type: 'INVALIDATE',
          tags: ['tag:peer-state'],
        })
      );

      expect(invalidationListener).toHaveBeenCalledWith({
        type: 'INVALIDATE',
        tags: ['tag:peer-state'],
        query_key: undefined,
      });
    });

    it('handles ingress binary data framing', () => {
      const transport = new WebRtcDataTransport();
      const mockChannel = new MockDataChannel();
      transport.bindDataChannel(mockChannel);
      mockChannel.triggerOpen();

      const invalidationListener = vi.fn();
      transport.subscribe(invalidationListener);

      // Encode a framed binary packet (FrameType 0x01: JSON string)
      const payloadStr = JSON.stringify({
        type: 'INVALIDATE',
        tags: ['tag:binary-event'],
      });
      const encoded = WebRtcDataTransport.encodeFrame(0x01, payloadStr);

      // Feed binary packet into mock channel
      mockChannel.triggerMessage(encoded.buffer);

      expect(invalidationListener).toHaveBeenCalledWith({
        type: 'INVALIDATE',
        tags: ['tag:binary-event'],
        query_key: undefined,
      });
    });

    it('encodes and decodes binary frames with type headers and payloads', () => {
      const rawPayload = new Uint8Array([10, 20, 30, 40, 50]);
      const frame = WebRtcDataTransport.encodeFrame(0x02, rawPayload);

      const decoded = WebRtcDataTransport.decodeFrame(frame);
      expect(decoded.type).toBe(0x02);
      expect(new Uint8Array(decoded.payload as Uint8Array)).toEqual(rawPayload);
    });
  });
});
