import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import {
  BusHub,
  resolveBusEndpoint,
  type HubRecord,
  type ElectionResult,
} from '../../src/ipc/bus-hub.js';
import {
  FrameType,
  encodeFrame,
  FrameDecoder,
  type Frame,
} from '../../src/ipc/frame-codec.js';

describe('BusHub and Endpoint Resolution', () => {
  let tmpDir: string;
  let dbPath: string;
  let adapter: SqliteAdapter;
  const hubsToClean: BusHub[] = [];
  const socketsToClean: net.Socket[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-bus-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    adapter = new SqliteAdapter(dbPath);
  });

  afterEach(async () => {
    for (const socket of socketsToClean) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    socketsToClean.length = 0;

    for (const hub of hubsToClean) {
      await hub.close();
    }
    hubsToClean.length = 0;

    adapter.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function createHub(sqlite = adapter, customEndpoint?: string): BusHub {
    const hub = new BusHub({
      sqliteAdapter: sqlite,
      endpoint: customEndpoint,
    });
    hubsToClean.push(hub);
    return hub;
  }

  function connectRawClient(endpoint: string): Promise<{
    socket: net.Socket;
    nextFrame: () => Promise<Frame>;
  }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      socketsToClean.push(socket);
      const decoder = new FrameDecoder();
      const frameQueue: Frame[] = [];
      const waiters: Array<(frame: Frame) => void> = [];

      socket.on('data', (chunk) => {
        try {
          const frames = decoder.feed(chunk);
          for (const frame of frames) {
            if (waiters.length > 0) {
              const waiter = waiters.shift()!;
              waiter(frame);
            } else {
              frameQueue.push(frame);
            }
          }
        } catch (err) {
          // ignore decoder errors on destroyed sockets
        }
      });

      socket.once('connect', () => {
        const nextFrame = (): Promise<Frame> => {
          if (frameQueue.length > 0) {
            return Promise.resolve(frameQueue.shift()!);
          }
          return new Promise<Frame>((res, rej) => {
            const timeout = setTimeout(() => {
              const idx = waiters.indexOf(res);
              if (idx !== -1) waiters.splice(idx, 1);
              rej(new Error('Timed out waiting for frame'));
            }, 3000);
            waiters.push((f) => {
              clearTimeout(timeout);
              res(f);
            });
          });
        };
        resolve({ socket, nextFrame });
      });

      socket.once('error', (err) => {
        reject(err);
      });
    });
  }

  it('resolves deterministic endpoint with short hash (<100 chars)', () => {
    const endpoint1 = resolveBusEndpoint(dbPath);
    const endpoint2 = resolveBusEndpoint(dbPath);
    expect(endpoint1).toBe(endpoint2);
    expect(endpoint1.length).toBeLessThan(100);

    if (process.platform === 'win32') {
      expect(endpoint1).toMatch(/^\\\\\.\\pipe\\ucsa-[a-f0-9]{16}$/);
    } else {
      expect(endpoint1).toMatch(/ucsa-[a-f0-9]{16}\.sock$/);
      const parentDir = path.dirname(endpoint1);
      expect(fs.existsSync(parentDir)).toBe(true);
    }

    const otherEndpoint = resolveBusEndpoint(path.join(tmpDir, 'other.db'));
    expect(otherEndpoint).not.toBe(endpoint1);
  });

  it('single process elects itself as hub and successfully binds socket', async () => {
    const hub = createHub();
    const result = await hub.electOrConnect();

    expect(result.role).toBe('hub');
    expect(result.epoch).toBe(1);
    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(0);
    expect(hub.role).toBe('hub');
    expect(hub.epoch).toBe(1);
    expect(hub.server?.listening).toBe(true);

    if (process.platform !== 'win32') {
      expect(fs.existsSync(result.endpoint)).toBe(true);
    }

    const row = hub.getHubRecord();
    expect(row).not.toBeNull();
    expect(row?.epoch).toBe(1);
    expect(row?.pid).toBe(process.pid);
    expect(row?.token).toBe(result.token);
    expect(row?.endpoint).toBe(result.endpoint);
  });

  it('second process detects running hub and becomes client', async () => {
    const hub1 = createHub();
    const result1 = await hub1.electOrConnect();
    expect(result1.role).toBe('hub');

    const adapter2 = new SqliteAdapter(dbPath);
    const hub2 = createHub(adapter2);
    const result2 = await hub2.electOrConnect();

    expect(result2.role).toBe('client');
    expect(result2.epoch).toBe(result1.epoch);
    expect(result2.token).toBe(result1.token);
    expect(result2.endpoint).toBe(result1.endpoint);
    expect(hub2.role).toBe('client');
    expect(hub2.clientSocket).toBeDefined();
    expect(hub2.clientSocket?.destroyed).toBe(false);

    adapter2.close();
  });

  it('client sends HELLO with correct token and receives WELCOME', async () => {
    const hub = createHub();
    const { endpoint, token, epoch } = await hub.electOrConnect();

    const { socket, nextFrame } = await connectRawClient(endpoint);
    socket.write(
      encodeFrame(FrameType.HELLO, {
        client_id: 'client-1',
        token,
      }),
    );

    const frame = await nextFrame();
    expect(frame.type).toBe(FrameType.WELCOME);
    const payload = frame.payload as Record<string, unknown>;
    expect(payload.proto).toBe(1);
    expect(payload.hub_epoch).toBe(epoch);
    expect(payload.hub_pid).toBe(process.pid);
    expect(payload.head_seq).toBe(0);
    expect(payload.ping_ms).toBe(30000);

    expect(hub.clients.size).toBe(1);
  });

  it('client sends HELLO with invalid token, receives ERROR, and is disconnected', async () => {
    const hub = createHub();
    const { endpoint } = await hub.electOrConnect();

    const { socket, nextFrame } = await connectRawClient(endpoint);
    socket.write(
      encodeFrame(FrameType.HELLO, {
        client_id: 'bad-client',
        token: 'wrong-token',
      }),
    );

    const frame = await nextFrame();
    expect(frame.type).toBe(FrameType.ERROR);
    const payload = frame.payload as Record<string, unknown>;
    expect(payload.code).toBe('INVALID_TOKEN');

    await new Promise<void>((resolve) => {
      if (socket.destroyed) {
        resolve();
      } else {
        socket.once('close', () => resolve());
      }
    });

    expect(socket.destroyed).toBe(true);
    expect(hub.clients.size).toBe(0);
  });

  it('publishing message fans out EVENT frame to other subscribed clients with echo suppression', async () => {
    const hub = createHub();
    const { endpoint, token } = await hub.electOrConnect();

    const clientA = await connectRawClient(endpoint);
    const clientB = await connectRawClient(endpoint);
    const clientC = await connectRawClient(endpoint);

    // Handshake all clients
    clientA.socket.write(encodeFrame(FrameType.HELLO, { client_id: 'client-a', token }));
    await clientA.nextFrame();

    clientB.socket.write(encodeFrame(FrameType.HELLO, { client_id: 'client-b', token }));
    await clientB.nextFrame();

    clientC.socket.write(encodeFrame(FrameType.HELLO, { client_id: 'client-c', token }));
    await clientC.nextFrame();

    // Client B and C subscribe to 'invalidate'
    clientB.socket.write(encodeFrame(FrameType.SUBSCRIBE, { kinds: ['invalidate'] }));
    clientC.socket.write(encodeFrame(FrameType.SUBSCRIBE, { kinds: ['invalidate'] }));

    // Small delay for subscription registration
    await new Promise((r) => setTimeout(r, 50));

    // Client A publishes an invalidation event
    const publishPayload = {
      kind: 'invalidate',
      tags: ['users'],
      origin: 'client-a',
    };
    clientA.socket.write(encodeFrame(FrameType.PUBLISH, publishPayload));

    // Clients B and C should receive the EVENT frame
    const frameB = await clientB.nextFrame();
    expect(frameB.type).toBe(FrameType.EVENT);
    expect(frameB.payload).toEqual(publishPayload);

    const frameC = await clientC.nextFrame();
    expect(frameC.type).toBe(FrameType.EVENT);
    expect(frameC.payload).toEqual(publishPayload);

    // Client A must NOT receive an echo of its own published event
    let echoReceived = false;
    const echoPromise = clientA.nextFrame().then(() => {
      echoReceived = true;
    }).catch(() => {
      // Timeout is expected
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(echoReceived).toBe(false);
  });

  it('heartbeat: sending PING receives PONG', async () => {
    const hub = createHub();
    const { endpoint, token } = await hub.electOrConnect();

    const client = await connectRawClient(endpoint);
    client.socket.write(encodeFrame(FrameType.HELLO, { client_id: 'client-ping', token }));
    await client.nextFrame();

    client.socket.write(encodeFrame(FrameType.PING, { nonce: 'test-nonce-123', ts: 12345678 }));
    const pongFrame = await client.nextFrame();

    expect(pongFrame.type).toBe(FrameType.PONG);
    const pongPayload = pongFrame.payload as Record<string, unknown>;
    expect(pongPayload.nonce).toBe('test-nonce-123');
    expect(pongPayload.ts).toBe(12345678);
  });

  it('stale socket cleanup: when hub process exits uncleanly, new election takes over with epoch + 1', async () => {
    const hub1 = createHub();
    const result1 = await hub1.electOrConnect();
    expect(result1.epoch).toBe(1);

    // Simulate unclean exit: close server without resetting DB row
    await new Promise<void>((resolve) => {
      hub1.server!.close(() => resolve());
    });
    hub1.server = undefined;

    // Hub 2 starts on the same DB
    const adapter2 = new SqliteAdapter(dbPath);
    const hub2 = createHub(adapter2);
    const result2 = await hub2.electOrConnect();

    expect(result2.role).toBe('hub');
    expect(result2.epoch).toBe(2);
    expect(result2.token).not.toBe(result1.token);
    expect(hub2.role).toBe('hub');
    expect(hub2.epoch).toBe(2);

    const row = hub2.getHubRecord();
    expect(row?.epoch).toBe(2);
    expect(row?.token).toBe(result2.token);

    adapter2.close();
  });

  it('graceful shutdown: close() sends BYE frame, cleans up socket file, and shuts down server', async () => {
    const hub = createHub();
    const { endpoint, token } = await hub.electOrConnect();

    const client = await connectRawClient(endpoint);
    client.socket.write(encodeFrame(FrameType.HELLO, { client_id: 'client-bye', token }));
    await client.nextFrame();

    const byePromise = client.nextFrame();

    await hub.close();

    const byeFrame = await byePromise;
    expect(byeFrame.type).toBe(FrameType.BYE);

    expect(hub.role).toBe('idle');
    expect(hub.server).toBeUndefined();
    expect(hub.clients.size).toBe(0);

    if (process.platform !== 'win32') {
      expect(fs.existsSync(endpoint)).toBe(false);
    }
  });

  it('slow-consumer protection: drops queue and sends RESYNC frame when threshold exceeded', async () => {
    const hub = new BusHub({
      sqliteAdapter: adapter,
      maxQueueFrames: 2,
    });
    hubsToClean.push(hub);
    const { endpoint, token } = await hub.electOrConnect();

    const client = await connectRawClient(endpoint);
    client.socket.write(encodeFrame(FrameType.HELLO, { client_id: 'slow-client', token }));
    await client.nextFrame();

    // Pause client socket to simulate slow consumer buffering
    client.socket.pause();

    // Broadcast more events than maxQueueFrames (threshold is 2)
    hub.broadcastEvent({ kind: 'event-1' });
    hub.broadcastEvent({ kind: 'event-2' });
    hub.broadcastEvent({ kind: 'event-3' });

    // Resume socket and read incoming frames
    client.socket.resume();

    const receivedFrames: Frame[] = [];
    while (receivedFrames.length < 3) {
      try {
        const f = await client.nextFrame();
        receivedFrames.push(f);
      } catch {
        break;
      }
    }

    const hasResync = receivedFrames.some((f) => f.type === FrameType.RESYNC);
    expect(hasResync).toBe(true);
  });
});
