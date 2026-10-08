import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { SqliteAdapter, ChangeLogRow, ChangeLogKind } from '../storage/sqlite-adapter.js';
import {
  FrameType,
  encodeFrame,
  FrameDecoder,
  type Frame,
} from './frame-codec.js';

export interface BusClientOptions {
  endpoint: string;
  token: string;
  clientId?: string;
  sqliteAdapter?: SqliteAdapter;
  autoReconnect?: boolean;
}

export class BusClient {
  public readonly endpoint: string;
  public readonly token: string;
  public readonly clientId: string;
  public readonly sqliteAdapter?: SqliteAdapter;
  public readonly autoReconnect: boolean;

  public lastSeq = 0;
  public isConnected = false;

  private socket?: net.Socket;
  private decoder = new FrameDecoder();
  private eventListeners = new Set<(event: ChangeLogRow) => void>();
  private isClosing = false;
  private hasConnectedBefore = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private connectPromise?: Promise<void>;

  constructor(options: BusClientOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.clientId = options.clientId ?? randomUUID();
    this.sqliteAdapter = options.sqliteAdapter;
    this.autoReconnect = options.autoReconnect ?? false;
  }

  /**
   * Connects to the bus hub socket, executes HELLO/WELCOME handshake,
   * and sends the initial SUBSCRIBE frame.
   */
  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.isConnected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.isClosing = false;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;

      const onSettled = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.connectPromise = undefined;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const socket = net.connect(this.endpoint);
      this.socket = socket;
      this.decoder.reset();

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        onSettled(new Error(`Connection to ${this.endpoint} timed out`));
      }, 5000);

      socket.once('connect', () => {
        const helloPayload = {
          proto: 1,
          client_id: this.clientId,
          origin: this.sqliteAdapter?.origin ?? this.clientId,
          role: 'subscriber',
          token: this.token,
          last_seq: this.lastSeq,
          lang: 'ts',
        };
        socket.write(encodeFrame(FrameType.HELLO, helloPayload));
      });

      socket.on('data', (chunk: Buffer) => {
        let frames: Frame[];
        try {
          frames = this.decoder.feed(chunk);
        } catch (err) {
          socket.destroy();
          onSettled(err instanceof Error ? err : new Error(String(err)));
          return;
        }

        for (const frame of frames) {
          if (!this.isConnected) {
            if (frame.type === FrameType.WELCOME) {
              clearTimeout(connectTimeout);
              this.isConnected = true;
              this.reconnectAttempts = 0;

              const welcomePayload = (frame.payload && typeof frame.payload === 'object'
                ? frame.payload
                : {}) as Record<string, unknown>;

              // Send SUBSCRIBE frame
              const subPayload = {
                kinds: ['invalidate', 'mutation', 'reset'],
              };
              socket.write(encodeFrame(FrameType.SUBSCRIBE, subPayload));

              const headSeq =
                typeof welcomePayload.head_seq === 'number'
                  ? welcomePayload.head_seq
                  : 0;

              if (this.hasConnectedBefore) {
                // Reconnect catch-up
                if (this.sqliteAdapter && headSeq > this.lastSeq) {
                  this.replayMissedFromSqlite();
                }
              } else {
                // Initial connect
                if (this.lastSeq === 0 && headSeq > 0) {
                  this.lastSeq = headSeq;
                }
                this.hasConnectedBefore = true;
              }

              onSettled();
              continue;
            } else if (frame.type === FrameType.ERROR) {
              clearTimeout(connectTimeout);
              socket.destroy();
              const errPayload = frame.payload as { message?: string; code?: string };
              onSettled(
                new Error(
                  `Hub error: ${errPayload.message ?? errPayload.code ?? 'Connection rejected'}`
                )
              );
              return;
            }
          }

          // Handle frames while connected
          switch (frame.type) {
            case FrameType.EVENT: {
              const event = this.normalizeEvent(frame.payload);
              if (event.seq) {
                this.lastSeq = Math.max(this.lastSeq, event.seq);
              }
              this.dispatchEvent(event);
              break;
            }

            case FrameType.RESYNC: {
              if (this.sqliteAdapter) {
                this.replayMissedFromSqlite();
              }
              break;
            }

            case FrameType.PING: {
              const pongPayload =
                typeof frame.payload === 'object' && frame.payload !== null
                  ? frame.payload
                  : {};
              socket.write(encodeFrame(FrameType.PONG, pongPayload));
              break;
            }

            case FrameType.BYE: {
              this.isConnected = false;
              socket.destroy();
              break;
            }
          }
        }
      });

      const cleanup = (err?: Error) => {
        clearTimeout(connectTimeout);
        const wasConnected = this.isConnected;
        this.isConnected = false;

        if (!wasConnected) {
          onSettled(err ?? new Error('Socket closed before connection established'));
        }

        if (this.autoReconnect && !this.isClosing) {
          this.scheduleReconnect();
        }
      };

      socket.on('error', (err) => {
        cleanup(err);
      });

      socket.on('close', () => {
        cleanup();
      });
    });

    return this.connectPromise;
  }

  /**
   * Publishes a change log event frame to the bus hub for broadcast.
   */
  publish(change: {
    kind: ChangeLogKind;
    tags?: string[];
    queryHashes?: string[];
    query_hashes?: string[];
    detail?: Record<string, unknown>;
    seq?: number;
    origin?: string;
  }): void {
    if (!this.socket || this.socket.destroyed || !this.isConnected) {
      return;
    }

    const payload = {
      kind: change.kind,
      origin: change.origin ?? this.sqliteAdapter?.origin ?? this.clientId,
      tags: change.tags ?? null,
      query_hashes: change.queryHashes ?? change.query_hashes ?? null,
      detail: change.detail ?? null,
      seq: change.seq ?? this.lastSeq,
      created_at: Date.now(),
    };

    try {
      this.socket.write(encodeFrame(FrameType.PUBLISH, payload));
    } catch {
      // ignore write error on closed socket
    }
  }

  /**
   * Registers an event listener callback for incoming EVENT frames.
   * Returns an unsubscribe function.
   */
  subscribeEvents(listener: (event: ChangeLogRow) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Closes connection cleanly with BYE frame and cancels reconnection.
   */
  async close(): Promise<void> {
    this.isClosing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;
    this.socket = undefined;
    this.isConnected = false;

    if (socket && !socket.destroyed) {
      try {
        socket.write(encodeFrame(FrameType.BYE, { reason: 'client_close' }));
      } catch {
        // ignore
      }
      await new Promise<void>((resolve) => {
        socket.end(() => {
          socket.destroy();
          resolve();
        });
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 150);
      });
    }
  }

  private replayMissedFromSqlite(): void {
    if (!this.sqliteAdapter) return;
    try {
      const result = this.sqliteAdapter.readChangesSince(this.lastSeq);
      for (const change of result.rows) {
        this.dispatchEvent(change);
        this.lastSeq = Math.max(this.lastSeq, change.seq);
      }
    } catch {
      // ignore read error
    }
  }

  private dispatchEvent(event: ChangeLogRow): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error in BusClient event listener:', err);
      }
    }
  }

  private normalizeEvent(payload: unknown): ChangeLogRow {
    const p = (typeof payload === 'object' && payload !== null
      ? payload
      : {}) as Record<string, unknown>;

    return {
      seq: typeof p.seq === 'number' ? p.seq : 0,
      origin: typeof p.origin === 'string' ? p.origin : '',
      kind: (typeof p.kind === 'string' ? p.kind : 'invalidate') as ChangeLogKind,
      tags: Array.isArray(p.tags) ? (p.tags as string[]) : null,
      query_hashes: Array.isArray(p.query_hashes)
        ? (p.query_hashes as string[])
        : Array.isArray(p.queryHashes)
        ? (p.queryHashes as string[])
        : null,
      detail:
        typeof p.detail === 'object' && p.detail !== null
          ? (p.detail as Record<string, unknown>)
          : null,
      created_at: typeof p.created_at === 'number' ? p.created_at : Date.now(),
    };
  }

  private scheduleReconnect(): void {
    if (this.isClosing || this.reconnectTimer) return;
    const backoffMs = Math.min(100 * Math.pow(2, this.reconnectAttempts), 2000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {
        // Will reschedule in cleanup() if connection fails
      });
    }, backoffMs);
  }
}
