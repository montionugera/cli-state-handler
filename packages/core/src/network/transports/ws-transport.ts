import type {
  TransportAdapter,
  TransportRequest,
  TransportResponse,
  InvalidationEvent,
  UnsubscribeFn,
} from '../../types.js';

export type WsConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

export interface WebSocketLike {
  readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WsTransportOptions {
  url: string;
  protocols?: string | string[];
  websocketFactory?: (url: string, protocols?: string | string[]) => WebSocketLike;
  pingInterval?: number; // default: 30000ms
  pongTimeout?: number; // default: 10000ms
  reconnect?: boolean; // default: true
  reconnectBaseDelay?: number; // default: 500ms
  reconnectMaxDelay?: number; // default: 30000ms
  maxReconnectAttempts?: number; // default: Infinity
  autoConnect?: boolean; // default: false
}

interface PendingWsRequest {
  resolve: (res: TransportResponse<unknown>) => void;
  reject: (err: unknown) => void;
}

/**
 * WebSocket Transport Adapter.
 * Features:
 * - Connection lifecycle FSM ('connecting' | 'connected' | 'disconnected' | 'reconnecting')
 * - Periodic ping keepalive frames and pong reception
 * - Ingestion of server push invalidation messages: { type: 'INVALIDATE', tags: [...] }
 * - Request-Response correlation multiplexing over WebSocket
 */
export class WsTransport implements TransportAdapter {
  private readonly _url: string;
  private readonly _protocols?: string | string[];
  private readonly _websocketFactory: (
    url: string,
    protocols?: string | string[]
  ) => WebSocketLike;
  private readonly _pingInterval: number;
  private readonly _pongTimeout: number;
  private readonly _reconnect: boolean;
  private readonly _reconnectBaseDelay: number;
  private readonly _reconnectMaxDelay: number;
  private readonly _maxReconnectAttempts: number;

  private _state: WsConnectionState = 'disconnected';
  private _socket: WebSocketLike | null = null;
  private _explicitDisconnect: boolean = false;
  private _reconnectAttempts: number = 0;
  private _reconnectTimer?: ReturnType<typeof setTimeout>;
  private _pingIntervalTimer?: ReturnType<typeof setInterval>;
  private _pongTimeoutTimer?: ReturnType<typeof setTimeout>;

  private readonly _stateListeners = new Set<(state: WsConnectionState) => void>();
  private readonly _invalidationSubscribers = new Set<
    (event: InvalidationEvent) => void
  >();
  private readonly _messageListeners = new Set<(data: unknown) => void>();
  private readonly _pendingRequests = new Map<string, PendingWsRequest>();

  constructor(options: WsTransportOptions) {
    this._url = options.url;
    this._protocols = options.protocols;
    this._websocketFactory =
      options.websocketFactory ??
      ((url, protocols) => {
        if (typeof WebSocket !== 'undefined') {
          return new WebSocket(url, protocols) as unknown as WebSocketLike;
        }
        throw new Error('WsTransport: No WebSocket implementation available');
      });
    this._pingInterval = options.pingInterval ?? 30000;
    this._pongTimeout = options.pongTimeout ?? 10000;
    this._reconnect = options.reconnect ?? true;
    this._reconnectBaseDelay = options.reconnectBaseDelay ?? 500;
    this._reconnectMaxDelay = options.reconnectMaxDelay ?? 30000;
    this._maxReconnectAttempts = options.maxReconnectAttempts ?? Infinity;

    if (options.autoConnect) {
      this.connect();
    }
  }

  /**
   * Returns current connection lifecycle state.
   */
  getState(): WsConnectionState {
    return this._state;
  }

  /**
   * Registers a listener callback for connection state changes.
   */
  onStateChange(listener: (state: WsConnectionState) => void): UnsubscribeFn {
    this._stateListeners.add(listener);
    return () => {
      this._stateListeners.delete(listener);
    };
  }

  private setState(nextState: WsConnectionState): void {
    if (this._state !== nextState) {
      this._state = nextState;
      for (const listener of this._stateListeners) {
        try {
          listener(nextState);
        } catch {
          // Ignore listener errors
        }
      }
    }
  }

  /**
   * Initiates connection to the WebSocket server.
   */
  connect(): void {
    if (this._state === 'connected' || this._state === 'connecting') {
      return;
    }

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }

    this._explicitDisconnect = false;
    this.setState('connecting');

    try {
      const socket = this._websocketFactory(this._url, this._protocols);
      this._socket = socket;

      socket.onopen = () => {
        this._reconnectAttempts = 0;
        this.setState('connected');
        this.startPingTimer();
      };

      socket.onclose = () => {
        this.stopPingTimer();
        this._socket = null;

        if (this._explicitDisconnect) {
          this.setState('disconnected');
        } else if (
          this._reconnect &&
          this._reconnectAttempts < this._maxReconnectAttempts
        ) {
          this.setState('reconnecting');
          const delay = Math.min(
            this._reconnectMaxDelay,
            this._reconnectBaseDelay * Math.pow(2, this._reconnectAttempts)
          );
          this._reconnectAttempts++;
          this._reconnectTimer = setTimeout(() => {
            this.connect();
          }, delay);
        } else {
          this.setState('disconnected');
        }
      };

      socket.onerror = () => {
        // Socket errors trigger onclose on standard WebSockets
      };

      socket.onmessage = (event) => {
        this.handleIncomingMessage(event.data);
      };
    } catch {
      this.setState('disconnected');
    }
  }

  /**
   * Gracefully disconnects the WebSocket.
   */
  disconnect(): void {
    this._explicitDisconnect = true;
    this.stopPingTimer();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }

    if (this._socket) {
      try {
        this._socket.close(1000, 'Client closed');
      } catch {
        // Ignore close error
      }
      this._socket = null;
    }

    this.setState('disconnected');
  }

  private startPingTimer(): void {
    this.stopPingTimer();
    if (this._pingInterval <= 0) return;

    this._pingIntervalTimer = setInterval(() => {
      this.sendPing();
    }, this._pingInterval);
  }

  private stopPingTimer(): void {
    if (this._pingIntervalTimer) {
      clearInterval(this._pingIntervalTimer);
      this._pingIntervalTimer = undefined;
    }
    if (this._pongTimeoutTimer) {
      clearTimeout(this._pongTimeoutTimer);
      this._pongTimeoutTimer = undefined;
    }
  }

  private sendPing(): void {
    if (this._socket && this._state === 'connected') {
      try {
        this._socket.send(JSON.stringify({ type: 'ping' }));
        if (this._pongTimeout > 0) {
          this._pongTimeoutTimer = setTimeout(() => {
            // Heartbeat missed; force reconnect
            if (this._socket) {
              try {
                this._socket.close(4000, 'Ping timeout');
              } catch {}
            }
          }, this._pongTimeout);
        }
      } catch {
        // Ping send failed
      }
    }
  }

  private handleIncomingMessage(rawData: unknown): void {
    let parsed: unknown;

    if (typeof rawData === 'string') {
      if (rawData === 'pong') {
        if (this._pongTimeoutTimer) {
          clearTimeout(this._pongTimeoutTimer);
          this._pongTimeoutTimer = undefined;
        }
        return;
      }
      try {
        parsed = JSON.parse(rawData);
      } catch {
        parsed = rawData;
      }
    } else {
      parsed = rawData;
    }

    if (typeof parsed === 'object' && parsed !== null) {
      const msg = parsed as Record<string, unknown>;

      // 1. Handle pong message
      if (msg.type === 'pong') {
        if (this._pongTimeoutTimer) {
          clearTimeout(this._pongTimeoutTimer);
          this._pongTimeoutTimer = undefined;
        }
        return;
      }

      // 2. Handle ping message
      if (msg.type === 'ping') {
        if (this._socket && this._state === 'connected') {
          try {
            this._socket.send(JSON.stringify({ type: 'pong' }));
          } catch {}
        }
        return;
      }

      // 3. Handle push invalidation message
      if (msg.type === 'INVALIDATE') {
        const invalidationEvent: InvalidationEvent = {
          type: 'INVALIDATE',
          tags: Array.isArray(msg.tags) ? (msg.tags as string[]) : undefined,
          query_key: Array.isArray(msg.query_key) ? msg.query_key : undefined,
        };
        for (const subscriber of this._invalidationSubscribers) {
          try {
            subscriber(invalidationEvent);
          } catch {}
        }
      }

      // 4. Handle RPC correlation response
      if (typeof msg.id === 'string' && this._pendingRequests.has(msg.id)) {
        const pending = this._pendingRequests.get(msg.id)!;
        this._pendingRequests.delete(msg.id);
        pending.resolve({
          status: typeof msg.status === 'number' ? msg.status : 200,
          data: msg.data,
          etag: typeof msg.etag === 'string' ? msg.etag : undefined,
        });
      }
    }

    // Notify general message listeners
    for (const listener of this._messageListeners) {
      try {
        listener(parsed);
      } catch {}
    }
  }

  /**
   * Subscribes to server push invalidation events.
   */
  subscribe(onEvent: (event: InvalidationEvent) => void): UnsubscribeFn {
    this._invalidationSubscribers.add(onEvent);
    return () => {
      this._invalidationSubscribers.delete(onEvent);
    };
  }

  /**
   * Subscribes to all incoming messages parsed from the WebSocket.
   */
  onMessage(listener: (data: unknown) => void): UnsubscribeFn {
    this._messageListeners.add(listener);
    return () => {
      this._messageListeners.delete(listener);
    };
  }

  /**
   * Sends raw data over the connected WebSocket.
   */
  send(data: string | object): void {
    if (!this._socket || this._state !== 'connected') {
      throw new Error('WsTransport: WebSocket is not connected');
    }
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this._socket.send(payload);
  }

  /**
   * Executes a request over WebSocket using correlation IDs.
   */
  async fetch<TData = unknown, TPayload = unknown>(
    request: TransportRequest<TPayload>
  ): Promise<TransportResponse<TData>> {
    if (!this._socket || this._state !== 'connected') {
      throw new Error('WsTransport: WebSocket is not connected');
    }

    const reqId = `ws-req-${Math.random().toString(36).slice(2)}-${Date.now()}`;

    return new Promise<TransportResponse<TData>>((resolve, reject) => {
      if (request.signal?.aborted) {
        return reject(new Error('WsTransport: Request aborted'));
      }

      const abortHandler = () => {
        this._pendingRequests.delete(reqId);
        reject(new Error('WsTransport: Request aborted'));
      };

      request.signal?.addEventListener('abort', abortHandler, { once: true });

      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(reqId);
        request.signal?.removeEventListener('abort', abortHandler);
        reject(new Error(`WsTransport: Request ${reqId} timed out`));
      }, 30000);

      this._pendingRequests.set(reqId, {
        resolve: (resp) => {
          clearTimeout(timeoutId);
          request.signal?.removeEventListener('abort', abortHandler);
          resolve(resp as TransportResponse<TData>);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          request.signal?.removeEventListener('abort', abortHandler);
          reject(err);
        },
      });

      try {
        this._socket!.send(
          JSON.stringify({
            id: reqId,
            type: 'REQUEST',
            endpoint: request.endpoint,
            method: request.method,
            payload: request.payload,
            headers: request.headers,
          })
        );
      } catch (err) {
        clearTimeout(timeoutId);
        request.signal?.removeEventListener('abort', abortHandler);
        this._pendingRequests.delete(reqId);
        reject(err);
      }
    });
  }
}
