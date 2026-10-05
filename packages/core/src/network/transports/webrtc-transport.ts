import type {
  TransportAdapter,
  TransportRequest,
  TransportResponse,
  InvalidationEvent,
  UnsubscribeFn,
} from '../../types.js';

export type WebRtcConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface RTCDataChannelLike {
  readyState: string; // 'connecting' | 'open' | 'closing' | 'closed'
  binaryType?: string;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface DecodedFrame {
  type: number;
  payload: Uint8Array | string | unknown;
}

interface PendingRtcRequest {
  resolve: (res: TransportResponse<unknown>) => void;
  reject: (err: unknown) => void;
}

export interface WebRtcTransportOptions {
  dataChannel?: RTCDataChannelLike;
}

/**
 * WebRTC DataChannel Transport Adapter.
 * Features:
 * - Connection lifecycle management ('new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed')
 * - Ingress string & binary framing (Type byte + Length + Payload)
 * - P2P state synchronization and push invalidations
 * - Request-Response correlation multiplexing over DataChannel
 */
export class WebRtcDataTransport implements TransportAdapter {
  private _state: WebRtcConnectionState = 'new';
  private _dataChannel: RTCDataChannelLike | null = null;
  private readonly _stateListeners = new Set<
    (state: WebRtcConnectionState) => void
  >();
  private readonly _invalidationSubscribers = new Set<
    (event: InvalidationEvent) => void
  >();
  private readonly _messageListeners = new Set<(data: unknown) => void>();
  private readonly _pendingRequests = new Map<string, PendingRtcRequest>();

  constructor(options?: WebRtcTransportOptions) {
    if (options?.dataChannel) {
      this.bindDataChannel(options.dataChannel);
    }
  }

  /**
   * Encodes a payload into a framed binary packet:
   * [1 byte: FrameType] [4 bytes: Length big-endian] [N bytes: Payload]
   */
  static encodeFrame(type: number, payload: Uint8Array | string): Uint8Array {
    let bytes: Uint8Array;
    if (typeof payload === 'string') {
      bytes = new TextEncoder().encode(payload);
    } else {
      bytes = payload;
    }
    const frame = new Uint8Array(5 + bytes.length);
    frame[0] = type;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    view.setUint32(1, bytes.length, false);
    frame.set(bytes, 5);
    return frame;
  }

  /**
   * Decodes a binary frame packet into type and payload.
   */
  static decodeFrame(buffer: ArrayBuffer | Uint8Array | ArrayBufferLike): DecodedFrame {
    const bytes =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer as ArrayBuffer);

    if (bytes.length < 5) {
      throw new Error('WebRtcDataTransport: Invalid frame length');
    }

    const type = bytes[0];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(1, false);

    const payloadBytes = bytes.subarray(5, 5 + length);

    if (type === 0x01 || type === 0x05) {
      const text = new TextDecoder().decode(payloadBytes);
      try {
        return { type, payload: JSON.parse(text) };
      } catch {
        return { type, payload: text };
      }
    }

    return { type, payload: payloadBytes };
  }

  /**
   * Returns current connection state.
   */
  getState(): WebRtcConnectionState {
    return this._state;
  }

  /**
   * Updates connection state and notifies state listeners.
   */
  setConnectionState(nextState: WebRtcConnectionState): void {
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
   * Registers a listener for connection state changes.
   */
  onStateChange(
    listener: (state: WebRtcConnectionState) => void
  ): UnsubscribeFn {
    this._stateListeners.add(listener);
    return () => {
      this._stateListeners.delete(listener);
    };
  }

  /**
   * Binds an RTCDataChannel to this transport adapter.
   */
  bindDataChannel(dataChannel: RTCDataChannelLike): void {
    this._dataChannel = dataChannel;

    if (dataChannel.readyState === 'open') {
      this.setConnectionState('connected');
    } else if (dataChannel.readyState === 'connecting') {
      this.setConnectionState('connecting');
    }

    dataChannel.onopen = () => {
      this.setConnectionState('connected');
    };

    dataChannel.onclose = () => {
      this.setConnectionState('closed');
    };

    dataChannel.onerror = () => {
      this.setConnectionState('failed');
    };

    dataChannel.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };
  }

  private handleIncomingMessage(rawData: unknown): void {
    if (typeof rawData === 'string') {
      this.processStringMessage(rawData);
    } else if (
      rawData instanceof ArrayBuffer ||
      ArrayBuffer.isView(rawData)
    ) {
      const buffer =
        rawData instanceof ArrayBuffer
          ? rawData
          : new Uint8Array(
              (rawData as ArrayBufferView).buffer as ArrayBuffer,
              (rawData as ArrayBufferView).byteOffset,
              (rawData as ArrayBufferView).byteLength
            );
      try {
        const decoded = WebRtcDataTransport.decodeFrame(buffer);
        if (
          typeof decoded.payload === 'object' &&
          decoded.payload !== null
        ) {
          this.processParsedObject(decoded.payload as Record<string, unknown>);
        }
        for (const listener of this._messageListeners) {
          try {
            listener(decoded);
          } catch {}
        }
      } catch {
        // Ignore malformed binary frames
      }
    }
  }

  private processStringMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (typeof parsed === 'object' && parsed !== null) {
      this.processParsedObject(parsed as Record<string, unknown>);
    }

    for (const listener of this._messageListeners) {
      try {
        listener(parsed);
      } catch {}
    }
  }

  private processParsedObject(msg: Record<string, unknown>): void {
    // 1. Push invalidation frame
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

    // 2. Correlation response
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

  /**
   * Subscribes a listener to invalidation events.
   */
  subscribe(onEvent: (event: InvalidationEvent) => void): UnsubscribeFn {
    this._invalidationSubscribers.add(onEvent);
    return () => {
      this._invalidationSubscribers.delete(onEvent);
    };
  }

  /**
   * Subscribes to all incoming messages.
   */
  onMessage(listener: (data: unknown) => void): UnsubscribeFn {
    this._messageListeners.add(listener);
    return () => {
      this._messageListeners.delete(listener);
    };
  }

  /**
   * Sends raw string or binary data over the data channel.
   */
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (!this._dataChannel || this._state !== 'connected') {
      throw new Error('WebRtcDataTransport: DataChannel is not open');
    }
    this._dataChannel.send(data);
  }

  /**
   * Executes a request over WebRTC DataChannel using correlation IDs.
   */
  async fetch<TData = unknown, TPayload = unknown>(
    request: TransportRequest<TPayload>
  ): Promise<TransportResponse<TData>> {
    if (!this._dataChannel || this._state !== 'connected') {
      throw new Error('WebRtcDataTransport: DataChannel is not open');
    }

    const reqId = `rtc-req-${Math.random().toString(36).slice(2)}-${Date.now()}`;

    return new Promise<TransportResponse<TData>>((resolve, reject) => {
      if (request.signal?.aborted) {
        return reject(new Error('WebRtcDataTransport: Request aborted'));
      }

      const abortHandler = () => {
        this._pendingRequests.delete(reqId);
        reject(new Error('WebRtcDataTransport: Request aborted'));
      };

      request.signal?.addEventListener('abort', abortHandler, { once: true });

      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(reqId);
        request.signal?.removeEventListener('abort', abortHandler);
        reject(new Error(`WebRtcDataTransport: Request ${reqId} timed out`));
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
        this._dataChannel!.send(
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
