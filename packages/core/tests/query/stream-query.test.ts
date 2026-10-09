import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  QueryEngine,
  SqliteAdapter,
  hashQueryKey,
  CasStore,
  type StreamSlice,
  type StreamFnContext,
} from '../../src/index.js';

describe('QueryEngine.streamQuery()', () => {
  let adapter: SqliteAdapter;
  let engine: QueryEngine;
  let tmpCasDir: string;
  let casStore: CasStore;

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new SqliteAdapter(':memory:');
    engine = new QueryEngine({
      sqliteAdapter: adapter,
      defaultStaleTime: 60_000,
    });
    tmpCasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-cas-test-'));
    casStore = new CasStore({ baseDir: tmpCasDir });
  });

  afterEach(() => {
    adapter.close();
    try {
      fs.rmSync(tmpCasDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('streams LLM tokens incrementally, updating delta, cumulative, and seq', async () => {
    const tokens = ['The ', 'quick ', 'brown ', 'fox ', 'jumps.'];
    const queryKey = ['llm', 'completion', '1'];

    async function* tokenProducer(ctx: StreamFnContext) {
      for (const token of tokens) {
        if (ctx.signal.aborted) break;
        await new Promise((r) => setTimeout(r, 10));
        yield token;
      }
    }

    const handle = engine.streamQuery(queryKey, (ctx) => tokenProducer(ctx));

    const receivedSlices: StreamSlice<string>[] = [];
    for await (const slice of handle) {
      receivedSlices.push(slice);
    }

    // Verify deltas and cumulatives
    const deltas = receivedSlices.filter((s) => s.delta.length > 0).map((s) => s.delta);
    expect(deltas).toEqual(tokens);

    // Verify final slice or handle.done
    const finalResult = await handle.done;
    expect(finalResult).toBe('The quick brown fox jumps.');

    const lastSlice = receivedSlices[receivedSlices.length - 1];
    expect(lastSlice.done).toBe(true);
    expect(lastSlice.cumulative).toBe('The quick brown fox jumps.');
  });

  it('compacts stream atomically into SQLite query cache on completion', async () => {
    const tokens = ['Hello ', 'World!'];
    const queryKey = ['chat', 'stream', 'compact'];
    const queryHash = hashQueryKey(queryKey);

    const handle = engine.streamQuery(queryKey, async function* () {
      for (const t of tokens) {
        yield t;
      }
    });

    const result = await handle.done;
    expect(result).toBe('Hello World!');

    // Stream record and chunks should be purged after compaction
    expect(adapter.getStream(queryHash)).toBeUndefined();
    expect(adapter.getStreamChunks(queryHash)).toEqual([]);

    // Query cache must contain the compacted entry
    const cached = adapter.getQuery(queryHash);
    expect(cached).toBeDefined();
    expect(cached?.data_payload).toBe('Hello World!');

    // QueryEngine state should be success with the data
    const state = engine.getQueryState(queryKey);
    expect(state?.status).toBe('success');
    expect(state?.data).toBe('Hello World!');
  });

  it('hits cache immediately on subsequent fetchQuery or streamQuery without re-streaming', async () => {
    const queryKey = ['cached', 'stream', 'swr'];
    let streamCallCount = 0;

    const streamFn = async function* () {
      streamCallCount++;
      yield 'Initial ';
      yield 'Stream';
    };

    // First stream execution
    const handle1 = engine.streamQuery(queryKey, streamFn, { staleTime: 60_000 });
    const result1 = await handle1.done;
    expect(result1).toBe('Initial Stream');
    expect(streamCallCount).toBe(1);

    // Second stream execution: should hit cache immediately!
    const handle2 = engine.streamQuery(queryKey, streamFn, { staleTime: 60_000 });
    const slices2: StreamSlice<string>[] = [];
    for await (const s of handle2) {
      slices2.push(s);
    }
    const result2 = await handle2.done;
    expect(result2).toBe('Initial Stream');
    expect(streamCallCount).toBe(1); // Not called again!
    expect(slices2.length).toBe(1);
    expect(slices2[0].done).toBe(true);
    expect(slices2[0].cumulative).toBe('Initial Stream');

    // Subsequent fetchQuery should also hit cache immediately
    let fetchFnCalled = false;
    const fetchData = await engine.fetchQuery(queryKey, async () => {
      fetchFnCalled = true;
      return 'new data';
    });
    expect(fetchData).toBe('Initial Stream');
    expect(fetchFnCalled).toBe(false);
  });

  it('stops producer and marks stream aborted when handle.cancel() is called', async () => {
    const queryKey = ['stream', 'cancellation'];
    const queryHash = hashQueryKey(queryKey);
    let producerCleanedUp = false;

    async function* infiniteStream(signal: AbortSignal) {
      try {
        let i = 0;
        while (!signal.aborted) {
          yield `token-${i++} `;
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        producerCleanedUp = true;
      }
    }

    const handle = engine.streamQuery(queryKey, (ctx) => infiniteStream(ctx.signal));

    const received: string[] = [];
    for await (const slice of handle) {
      if (slice.delta) {
        received.push(slice.delta);
      }
      if (received.length >= 2) {
        handle.cancel('User requested cancellation');
      }
    }

    // Wait a brief moment for the generator's return/finally to run
    await new Promise((r) => setTimeout(r, 50));

    expect(handle.isCancelled).toBe(true);
    expect(producerCleanedUp).toBe(true);

    // Stream record in SQLite should be marked aborted
    const stream = adapter.getStream(queryHash);
    expect(stream?.status).toBe('aborted');
  });

  it('recovers from transport failure using HTTP Range resume strategy', async () => {
    const queryKey = ['stream', 'resilient', 'range'];
    let attempt = 0;

    async function* resilientProducer(ctx: StreamFnContext) {
      attempt++;
      if (attempt === 1) {
        yield 'Part 1: Hello ';
        // Simulate sudden network drop
        throw new Error('Connection reset by peer');
      }

      // On reconnect, verify Range header was built
      expect(ctx.resumeHeaders).toBeDefined();
      expect(ctx.resumeHeaders?.Range).toMatch(/^bytes=\d+-$/);

      yield 'Part 2: World!';
    }

    const handle = engine.streamQuery(
      queryKey,
      (ctx) => resilientProducer(ctx),
      {
        baseDelayMs: 10, // Fast retry for tests
      }
    );

    const received: StreamSlice<string>[] = [];
    for await (const slice of handle) {
      received.push(slice);
    }

    const finalResult = await handle.done;
    expect(finalResult).toBe('Part 1: Hello Part 2: World!');
    expect(attempt).toBe(2);

    // Stream should be cleanly compacted after recovery
    const queryHash = hashQueryKey(queryKey);
    expect(adapter.getStream(queryHash)).toBeUndefined();
    expect(adapter.getQuery(queryHash)?.data_payload).toBe('Part 1: Hello Part 2: World!');
  });

  it('safely handles multi-byte UTF-8 boundaries across chunks without replacement characters', async () => {
    const queryKey = ['stream', 'utf8', 'boundary'];
    // 🚀 is 4 bytes: 0xF0 0x9F 0x9A 0x80
    const emojiBytes = Buffer.from('🚀', 'utf8');
    const chunk1 = emojiBytes.subarray(0, 2); // incomplete 2 bytes
    const chunk2 = emojiBytes.subarray(2); // remaining 2 bytes

    async function* multiByteProducer() {
      yield 'Launch: ';
      yield chunk1;
      yield chunk2;
      yield '!';
    }

    const handle = engine.streamQuery(queryKey, () => multiByteProducer());

    const chunks: string[] = [];
    for await (const slice of handle) {
      if (slice.delta) {
        chunks.push(slice.delta);
      }
    }

    const full = await handle.done;
    expect(full).toBe('Launch: 🚀!');
    // Verify zero replacement characters \uFFFD were emitted
    for (const chunk of chunks) {
      expect(chunk).not.toContain('\uFFFD');
    }
  });

  it('compacts into CAS store when stream exceeds casThresholdBytes', async () => {
    const queryKey = ['stream', 'large', 'cas'];
    const queryHash = hashQueryKey(queryKey);

    const largeData = 'A'.repeat(5000);

    const handle = engine.streamQuery(
      queryKey,
      async function* () {
        yield largeData.slice(0, 2500);
        yield largeData.slice(2500);
      },
      {
        casStore,
        casThresholdBytes: 2000,
      }
    );

    const result = await handle.done;
    expect(result).toBe(largeData);

    const cached = adapter.getQuery(queryHash);
    expect(cached).toBeDefined();
    const payload = cached?.data_payload as { __cas_ref?: boolean; hash?: string; size?: number };
    expect(payload.__cas_ref).toBe(true);
    expect(payload.size).toBe(5000);
    expect(payload.hash).toBeDefined();

    // Verify data can be read from CAS store
    const readBack = await casStore.get(payload.hash!);
    expect(readBack).toBeDefined();
    expect(readBack!.toString('utf8')).toBe(largeData);
  });

  it('emits error and marks stream aborted when retries are exceeded', async () => {
    const queryKey = ['stream', 'unrecoverable'];
    const queryHash = hashQueryKey(queryKey);

    async function* failingProducer() {
      throw new Error('Fatal service outage');
    }

    const handle = engine.streamQuery(
      queryKey,
      () => failingProducer(),
      {
        maxRetries: 2,
        baseDelayMs: 5,
      }
    );

    await expect(handle.done).rejects.toThrow('Fatal service outage');

    const stream = adapter.getStream(queryHash);
    expect(stream?.status).toBe('aborted');

    const state = engine.getQueryState(queryKey);
    expect(state?.status).toBe('error');
  });
});
