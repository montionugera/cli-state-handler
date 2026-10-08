import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteAdapter } from '../storage/sqlite-adapter.js';
import {
  FrameType,
  encodeFrame,
  FrameDecoder,
  type Frame,
} from './frame-codec.js';

export interface HubRecord {
  id: number;
  epoch: number;
  pid: number;
  endpoint: string;
  token: string;
  claimed_at: number;
}

export type BusHubRole = 'idle' | 'hub' | 'client';

export interface BusHubOptions {
  sqliteAdapter: SqliteAdapter;
  endpoint?: string;
  clientId?: string;
  maxQueueFrames?: number;
  maxQueueBytes?: number;
  connectTimeoutMs?: number;
}

export interface ElectionResult {
  role: 'hub' | 'client';
  endpoint: string;
  token: string;
  epoch: number;
}

interface ClientState {
  authenticated: boolean;
  origin?: string;
  clientId?: string;
  subscriptions: Set<string>;
  queueFrames: number;
  queueBytes: number;
}

/**
 * Resolves deterministic IPC endpoint (Unix domain socket or Windows named pipe)
 * based on the SQLite database path. Path is kept short (<100 chars) via SHA-256 hash.
 */
export function resolveBusEndpoint(dbPath: string): string {
  const absPath = path.resolve(dbPath);
  const shortHash = createHash('sha256').update(absPath).digest('hex').slice(0, 16);

  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ucsa-${shortHash}`;
  }

  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '0';
  const runtimeDir = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `ucsa-${uid}`);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(runtimeDir, 0o700);
  } catch {
    // Ignore error on existing directory
  }

  return path.join(runtimeDir, `ucsa-${shortHash}.sock`);
}

/**
 * In-process elected bus hub managing transport lifecycle, client token authentication,
 * event fan-out with echo suppression, and slow consumer protection.
 */
export class BusHub {
  public role: BusHubRole = 'idle';
  public server?: net.Server;
  public clients: Set<net.Socket> = new Set();
  public epoch?: number;
  public token?: string;
  public endpoint: string;
  public clientSocket?: net.Socket;
  public readonly sqliteAdapter: SqliteAdapter;
  public readonly clientId: string;
  public readonly maxQueueFrames: number;
  public readonly maxQueueBytes: number;
  public readonly connectTimeoutMs: number;

  private clientStates: Map<net.Socket, ClientState> = new Map();
  private inboundSockets: Set<net.Socket> = new Set();

  constructor(options: BusHubOptions) {
    this.sqliteAdapter = options.sqliteAdapter;
    this.endpoint = options.endpoint ?? resolveBusEndpoint(options.sqliteAdapter.db.name);
    this.clientId = options.clientId ?? options.sqliteAdapter.origin;
    this.maxQueueFrames = options.maxQueueFrames ?? 1000;
    this.maxQueueBytes = options.maxQueueBytes ?? 4 * 1024 * 1024;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 500;
  }

  /**
   * Reads current hub record from ucsa_bus_hub table (id = 1).
   */
  getHubRecord(): HubRecord | null {
    try {
      const row = this.sqliteAdapter.db
        .prepare('SELECT id, epoch, pid, endpoint, token, claimed_at FROM ucsa_bus_hub WHERE id = 1')
        .get() as HubRecord | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Retrieves highest sequence number from ucsa_change_log.
   */
  private getHeadSeq(): number {
    try {
      const row = this.sqliteAdapter.db
        .prepare('SELECT MAX(seq) as max_seq FROM ucsa_change_log')
        .get() as { max_seq: number | null } | undefined;
      return row?.max_seq ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Attempts connection to the given endpoint with timeout.
   */
  private connectToEndpoint(endpoint: string, timeoutMs = this.connectTimeoutMs): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.connect(endpoint);

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`Connection to endpoint ${endpoint} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      socket.once('connect', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(socket);
        }
      });

      socket.once('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        }
      });
    });
  }

  /**
   * Runs the election protocol:
   * Probes existing hub endpoint; if healthy, connects as client.
   * Otherwise enters immediate SQLite transaction, binds socket, increments epoch,
   * updates ucsa_bus_hub, and elects itself as hub.
   */
  async electOrConnect(): Promise<ElectionResult> {
    if (this.role === 'hub' && this.server?.listening) {
      return {
        role: 'hub',
        endpoint: this.endpoint,
        token: this.token!,
        epoch: this.epoch!,
      };
    }
    if (this.role === 'client' && this.clientSocket && !this.clientSocket.destroyed) {
      return {
        role: 'client',
        endpoint: this.endpoint,
        token: this.token!,
        epoch: this.epoch!,
      };
    }

    const getHubStmt = this.sqliteAdapter.db.prepare(
      'SELECT id, epoch, pid, endpoint, token, claimed_at FROM ucsa_bus_hub WHERE id = 1',
    );
    const initialRow = getHubStmt.get() as HubRecord | undefined;
    const initialClaimedAt = initialRow?.claimed_at;

    if (initialRow) {
      try {
        const socket = await this.connectToEndpoint(initialRow.endpoint);
        this.role = 'client';
        this.epoch = initialRow.epoch;
        this.token = initialRow.token;
        this.endpoint = initialRow.endpoint;
        this.clientSocket = socket;
        return {
          role: 'client',
          endpoint: initialRow.endpoint,
          token: initialRow.token,
          epoch: initialRow.epoch,
        };
      } catch {
        // Connection failed, stale or dead process -> proceed to election
      }
    }

    let newEpoch = 1;
    let token = '';

    const electionTx = this.sqliteAdapter.db.transaction((): HubRecord | undefined => {
      const current = getHubStmt.get() as HubRecord | undefined;
      if (current && current.claimed_at !== initialClaimedAt) {
        // Another process claimed in the meantime
        return current;
      }

      if (process.platform !== 'win32') {
        try {
          if (fs.existsSync(this.endpoint)) {
            fs.unlinkSync(this.endpoint);
          }
        } catch {
          // ignore
        }
      }

      token = randomUUID();
      const prevEpoch = current?.epoch ?? 0;
      newEpoch = prevEpoch + 1;

      this.server = net.createServer((socket) => this.handleClientConnection(socket));
      this.server.listen(this.endpoint);

      this.sqliteAdapter.db.prepare(`
        INSERT OR REPLACE INTO ucsa_bus_hub (id, epoch, pid, endpoint, token, claimed_at)
        VALUES (1, ?, ?, ?, ?, ?)
      `).run(newEpoch, process.pid, this.endpoint, token, Date.now());

      return undefined;
    }).immediate;

    const retryRow = electionTx();

    if (retryRow) {
      try {
        const socket = await this.connectToEndpoint(retryRow.endpoint);
        this.role = 'client';
        this.epoch = retryRow.epoch;
        this.token = retryRow.token;
        this.endpoint = retryRow.endpoint;
        this.clientSocket = socket;
        return {
          role: 'client',
          endpoint: retryRow.endpoint,
          token: retryRow.token,
          epoch: retryRow.epoch,
        };
      } catch {
        return this.electOrConnect();
      }
    }

    this.role = 'hub';
    this.epoch = newEpoch;
    this.token = token;

    return {
      role: 'hub',
      endpoint: this.endpoint,
      token: this.token,
      epoch: this.epoch,
    };
  }

  /**
   * Internal connection handler for inbound client sockets on the hub.
   */
  private handleClientConnection(socket: net.Socket): void {
    this.inboundSockets.add(socket);
    const decoder = new FrameDecoder();
    let authenticated = false;
    let clientOrigin: string | undefined;

    const clientInfo: ClientState = {
      authenticated: false,
      subscriptions: new Set<string>(),
      queueFrames: 0,
      queueBytes: 0,
    };
    this.clientStates.set(socket, clientInfo);

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.feed(chunk);
      } catch {
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        if (!authenticated) {
          const payload = (frame.payload && typeof frame.payload === 'object'
            ? frame.payload
            : {}) as Record<string, unknown>;

          if (frame.type !== FrameType.HELLO || payload.token !== this.token) {
            const errFrame = encodeFrame(FrameType.ERROR, {
              code: 'INVALID_TOKEN',
              message: frame.type !== FrameType.HELLO ? 'First frame must be HELLO' : 'Invalid auth token',
            });
            socket.write(errFrame, () => {
              socket.destroy();
            });
            return;
          }

          authenticated = true;
          clientInfo.authenticated = true;
          clientOrigin = (payload.origin as string) ?? (payload.client_id as string);
          clientInfo.origin = clientOrigin;
          clientInfo.clientId = payload.client_id as string;
          this.clients.add(socket);

          const welcomePayload = {
            proto: 1,
            hub_epoch: this.epoch,
            hub_pid: process.pid,
            head_seq: this.getHeadSeq(),
            ping_ms: 30000,
          };
          socket.write(encodeFrame(FrameType.WELCOME, welcomePayload));
          continue;
        }

        switch (frame.type) {
          case FrameType.PING: {
            const pongPayload =
              typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {};
            socket.write(encodeFrame(FrameType.PONG, pongPayload));
            break;
          }

          case FrameType.PUBLISH: {
            this.broadcastEvent(frame.payload, socket);
            break;
          }

          case FrameType.SUBSCRIBE: {
            const payload = (frame.payload && typeof frame.payload === 'object'
              ? frame.payload
              : {}) as Record<string, unknown>;
            if (Array.isArray(payload.kinds)) {
              for (const k of payload.kinds) clientInfo.subscriptions.add(String(k));
            }
            if (Array.isArray(payload.tags)) {
              for (const t of payload.tags) clientInfo.subscriptions.add(String(t));
            }
            if (typeof payload.topic === 'string') {
              clientInfo.subscriptions.add(payload.topic);
            }
            break;
          }

          case FrameType.UNSUBSCRIBE: {
            const payload = (frame.payload && typeof frame.payload === 'object'
              ? frame.payload
              : {}) as Record<string, unknown>;
            if (Array.isArray(payload.kinds)) {
              for (const k of payload.kinds) clientInfo.subscriptions.delete(String(k));
            }
            if (Array.isArray(payload.tags)) {
              for (const t of payload.tags) clientInfo.subscriptions.delete(String(t));
            }
            if (typeof payload.topic === 'string') {
              clientInfo.subscriptions.delete(payload.topic);
            }
            break;
          }

          case FrameType.RESYNC: {
            const payload = (frame.payload && typeof frame.payload === 'object'
              ? frame.payload
              : {}) as Record<string, unknown>;
            const sinceSeq = Number(payload.since_seq ?? payload.last_seq ?? payload.seq ?? 0);
            try {
              const result = this.sqliteAdapter.readChangesSince(sinceSeq, 1000);
              for (const change of result.rows) {
                this.sendFrameToClient(socket, FrameType.EVENT, change);
              }
            } catch {
              // ignore
            }
            break;
          }

          case FrameType.BYE: {
            socket.destroy();
            break;
          }
        }
      }
    });

    const cleanup = () => {
      this.clients.delete(socket);
      this.clientStates.delete(socket);
      this.inboundSockets.delete(socket);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  /**
   * Transmits a frame to a specific client with backpressure / slow consumer protection.
   */
  private sendFrameToClient(socket: net.Socket, type: FrameType, payload: unknown): void {
    if (socket.destroyed || !socket.writable) {
      this.clients.delete(socket);
      this.clientStates.delete(socket);
      this.inboundSockets.delete(socket);
      return;
    }

    const clientInfo = this.clientStates.get(socket);
    if (!clientInfo) {
      return;
    }

    const frameBuf = encodeFrame(type, payload);

    if (
      clientInfo.queueFrames >= this.maxQueueFrames ||
      clientInfo.queueBytes >= this.maxQueueBytes ||
      socket.writableLength >= this.maxQueueBytes
    ) {
      clientInfo.queueFrames = 0;
      clientInfo.queueBytes = 0;
      const resyncBuf = encodeFrame(FrameType.RESYNC, {
        reason: 'SLOW_CONSUMER',
        head_seq: this.getHeadSeq(),
      });
      socket.write(resyncBuf);
      return;
    }

    clientInfo.queueFrames++;
    clientInfo.queueBytes += frameBuf.length;

    socket.write(frameBuf, () => {
      clientInfo.queueFrames = Math.max(0, clientInfo.queueFrames - 1);
      clientInfo.queueBytes = Math.max(0, clientInfo.queueBytes - frameBuf.length);
    });
  }

  /**
   * Broadcasts an EVENT frame to all connected clients with echo suppression.
   */
  async broadcastEvent(payload: unknown, excludeSocket?: net.Socket): Promise<void> {
    const payloadObj = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const publishOrigin = payloadObj.origin;

    for (const client of this.clients) {
      if (client === excludeSocket) {
        continue;
      }
      const info = this.clientStates.get(client);
      if (publishOrigin && info?.origin && info.origin === publishOrigin) {
        continue;
      }

      if (info && info.subscriptions.size > 0 && !info.subscriptions.has('*')) {
        const kind = typeof payloadObj.kind === 'string' ? payloadObj.kind : undefined;
        const tags = Array.isArray(payloadObj.tags) ? (payloadObj.tags as string[]) : [];
        const topic = typeof payloadObj.topic === 'string' ? payloadObj.topic : undefined;

        let matches = false;
        if (kind && info.subscriptions.has(kind)) matches = true;
        if (topic && info.subscriptions.has(topic)) matches = true;
        for (const t of tags) {
          if (info.subscriptions.has(t)) {
            matches = true;
            break;
          }
        }
        if (!matches) {
          continue;
        }
      }

      this.sendFrameToClient(client, FrameType.EVENT, payload);
    }
  }

  /**
   * Gracefully shuts down the hub or client.
   * On hub: broadcasts BYE frame to all connected clients, destroys sockets,
   * closes server, unlinks socket file on POSIX, and transitions role to idle.
   */
  async close(): Promise<void> {
    if (this.role === 'idle') {
      return;
    }

    if (this.role === 'client') {
      if (this.clientSocket && !this.clientSocket.destroyed) {
        this.clientSocket.destroy();
      }
      this.clientSocket = undefined;
      this.role = 'idle';
      return;
    }

    const byeFrame = encodeFrame(FrameType.BYE, { reason: 'hub_shutdown' });
    for (const client of this.clients) {
      try {
        client.write(byeFrame);
      } catch {
        // ignore
      }
    }

    for (const s of this.inboundSockets) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    this.inboundSockets.clear();
    this.clients.clear();
    this.clientStates.clear();

    if (this.server) {
      const srv = this.server;
      this.server = undefined;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        setTimeout(resolve, 200);
      });
    }

    if (process.platform !== 'win32') {
      try {
        if (fs.existsSync(this.endpoint)) {
          fs.unlinkSync(this.endpoint);
        }
      } catch {
        // ignore
      }
    }

    this.role = 'idle';
  }
}
