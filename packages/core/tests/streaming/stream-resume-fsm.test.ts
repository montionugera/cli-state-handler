import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteAdapter,
  StreamResumeFsm,
  createRangeResumeStrategy,
  createLastEventIdResumeStrategy,
  createContinuationResumeStrategy,
  createRestartResumeStrategy,
  hashQueryKey,
  type ResumeContext,
} from '../../src/index.js';

describe('StreamResumeFsm (Task 2)', () => {
  let tmpDir: string;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-fsm-test-'));
    adapter = new SqliteAdapter(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    adapter.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Lifecycle & State Transitions', () => {
    it('initializes in idle state and moves to streaming on start()', () => {
      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-lifecycle',
        queryKey: ['llm', 'stream'],
        strategy: createRangeResumeStrategy(),
      });

      expect(fsm.state).toBe('idle');
      expect(fsm.retryCount).toBe(0);
      expect(fsm.committedByteLength).toBe(0);
      expect(fsm.committedSeq).toBe(0);
      expect(fsm.accumulatedText).toBe('');
      expect(fsm.lastEventId).toBeNull();

      fsm.start();
      expect(fsm.state).toBe('streaming');
    });

    it('transitions to complete state on complete()', () => {
      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-complete',
        queryKey: ['llm', 'stream'],
        strategy: createRangeResumeStrategy(),
      });
      fsm.start();
      fsm.complete();
      expect(fsm.state).toBe('complete');
    });

    it('transitions to aborted state and aborts SQLite stream on abort()', () => {
      const queryKey = ['llm', 'stream-abort'] as const;
      const stream = adapter.createStream(queryKey);
      const fsm = new StreamResumeFsm({
        queryHash: stream.queryHash,
        queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
      });

      fsm.start();
      fsm.abort('User cancelled');
      expect(fsm.state).toBe('aborted');

      const streamRow = adapter.getStream(stream.queryHash);
      expect(streamRow?.status).toBe('aborted');
      expect(streamRow?.error).toBe('User cancelled');
    });
  });

  describe('Seamless HTTP Range Resume', () => {
    it('feeds 500 bytes, simulates error, checks Range header, and deduplicates overlapping chunk (450..600)', () => {
      const queryKey = ['llm', 'range-stream'] as const;
      const stream = adapter.createStream(queryKey);
      const queryHash = stream.queryHash;

      const fsm = new StreamResumeFsm({
        queryHash,
        queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
      });
      fsm.start();

      // 1. Feed 500 bytes (e.g. 500 characters of text)
      const initialChunk = Buffer.alloc(500, 'A');
      const r1 = fsm.handleIncomingChunk(initialChunk);

      expect(r1.accepted).toBe(true);
      expect(r1.duplicate).toBe(false);
      expect(r1.slice.length).toBe(500);
      expect(r1.seq).toBe(0);
      expect(r1.byteOffset).toBe(0);
      expect(fsm.committedByteLength).toBe(500);
      expect(fsm.committedSeq).toBe(1);

      // 2. Simulate network error / drop
      const errResult = fsm.handleError(new Error('Connection reset by peer'));
      expect(errResult.canResume).toBe(true);
      expect(errResult.restart).toBe(false);
      expect(errResult.headers).toEqual({
        Range: 'bytes=500-',
      });
      expect(fsm.state).toBe('resuming');
      expect(fsm.retryCount).toBe(1);

      // 3. Server re-sends overlapping chunk from offset 450 to 600 (150 bytes: 50 overlapping 'A's + 100 new 'B's)
      const overlappingChunk = Buffer.concat([
        Buffer.alloc(50, 'A'), // bytes 450..499 (already received)
        Buffer.alloc(100, 'B'), // bytes 500..599 (new)
      ]);
      expect(overlappingChunk.length).toBe(150);

      const r2 = fsm.handleIncomingChunk(overlappingChunk, 1, 450);

      // 4. Verify only bytes 500..600 (100 bytes of 'B's) were accepted
      expect(r2.accepted).toBe(true);
      expect(r2.duplicate).toBe(false);
      expect(r2.slice.length).toBe(100);
      expect(r2.slice.toString('utf8')).toBe('B'.repeat(100));
      expect(r2.seq).toBe(1);
      expect(r2.byteOffset).toBe(500);

      expect(fsm.committedByteLength).toBe(600);
      expect(fsm.committedSeq).toBe(2);
      expect(fsm.state).toBe('streaming');
      expect(fsm.retryCount).toBe(0); // reset on successful recovery

      // Verify SQLite chunk store has exactly 2 chunks: chunk 0 (500 bytes) and chunk 1 (100 bytes)
      const chunksInDb = adapter.getStreamChunks(queryHash, 0);
      expect(chunksInDb).toHaveLength(2);
      expect(chunksInDb[0].seq).toBe(0);
      expect(chunksInDb[0].byteOffset).toBe(0);
      expect(chunksInDb[0].data.length).toBe(500);

      expect(chunksInDb[1].seq).toBe(1);
      expect(chunksInDb[1].byteOffset).toBe(500);
      expect(chunksInDb[1].data.length).toBe(100);
    });

    it('generates If-Range header when etag is provided', () => {
      const queryKey = ['llm', 'range-etag'] as const;
      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-etag',
        queryKey,
        strategy: createRangeResumeStrategy(),
        etag: '"v1-etag-123"',
      });

      fsm.handleIncomingChunk('Initial 256 bytes of data');
      const errorResult = fsm.handleError('drop');
      expect(errorResult.headers).toEqual({
        Range: `bytes=${Buffer.byteLength('Initial 256 bytes of data')}-`,
        'If-Range': '"v1-etag-123"',
      });
    });

    it('identifies and rejects completely duplicate chunks', () => {
      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-dup',
        queryKey: ['test', 'dup'],
        strategy: createRangeResumeStrategy(),
      });

      fsm.handleIncomingChunk(Buffer.alloc(300, 'X'), 0, 0);
      expect(fsm.committedByteLength).toBe(300);

      // Incoming chunk completely contained inside [0, 300)
      const dup = fsm.handleIncomingChunk(Buffer.alloc(100, 'X'), 0, 100);
      expect(dup.accepted).toBe(false);
      expect(dup.duplicate).toBe(true);
      expect(dup.slice.length).toBe(0);
      expect(dup.seq).toBe(0);
      expect(dup.byteOffset).toBe(100);
      expect(fsm.committedByteLength).toBe(300);
      expect(fsm.committedSeq).toBe(1);
    });
  });

  describe('SSE Last-Event-ID Resume', () => {
    it('feeds chunk with eventId, updates SQLite resume token, and generates Last-Event-ID header on error', () => {
      const queryKey = ['sse', 'events'] as const;
      const stream = adapter.createStream(queryKey);
      const queryHash = stream.queryHash;

      const fsm = new StreamResumeFsm({
        queryHash,
        queryKey,
        strategy: createLastEventIdResumeStrategy(),
        sqliteAdapter: adapter,
      });

      // Feed chunk with eventId 'evt-42'
      fsm.handleIncomingChunk('event: message\ndata: {"status":"running"}\n\n', 0, 0, 'evt-42');
      expect(fsm.lastEventId).toBe('evt-42');

      // Verify token updated in SQLite
      const updatedStream = adapter.getStream(queryHash);
      expect(updatedStream?.resumeToken).toBe('evt-42');
      expect(updatedStream?.resumeKind).toBe('last-event-id');

      // Simulate connection drop
      const err = fsm.handleError('SSE disconnected');
      expect(err.canResume).toBe(true);
      expect(err.restart).toBe(false);
      expect(err.headers).toEqual({
        'Last-Event-ID': 'evt-42',
      });
    });

    it('initializes lastEventId from initialLastEventId option', () => {
      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-init-sse',
        queryKey: ['sse', 'init'],
        strategy: createLastEventIdResumeStrategy(),
        initialLastEventId: 'initial-token-99',
      });

      expect(fsm.lastEventId).toBe('initial-token-99');
      const err = fsm.handleError('drop');
      expect(err.headers).toEqual({
        'Last-Event-ID': 'initial-token-99',
      });
    });
  });

  describe('Continuation Strategy', () => {
    it('returns continuation payload containing accumulated text on error', () => {
      const queryKey = ['ai', 'agent-turn'] as const;
      const strategy = createContinuationResumeStrategy((ctx: ResumeContext) => ({
        resumePrompt: `Please continue from: "${ctx.accumulatedText}"`,
        cursor: ctx.byteLength,
      }));

      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-cont',
        queryKey,
        strategy,
      });

      fsm.handleIncomingChunk('Part 1: The quick brown fox ');
      fsm.handleIncomingChunk('Part 2: jumps over the lazy dog.');

      expect(fsm.accumulatedText).toBe(
        'Part 1: The quick brown fox Part 2: jumps over the lazy dog.'
      );

      const errResult = fsm.handleError('Token limit reached');
      expect(errResult.canResume).toBe(true);
      expect(errResult.restart).toBe(false);
      expect(errResult.continuationPayload).toEqual({
        resumePrompt:
          'Please continue from: "Part 1: The quick brown fox Part 2: jumps over the lazy dog."',
        cursor: Buffer.byteLength(
          'Part 1: The quick brown fox Part 2: jumps over the lazy dog.'
        ),
      });
    });
  });

  describe('HTTP 416 & 412 Restart Fallback', () => {
    it('resets stream on HTTP 416 Range Not Satisfiable: clears chunks, invokes onReset, returns retryDelayMs 0', () => {
      const queryKey = ['llm', 'stream-416'] as const;
      const stream = adapter.createStream(queryKey);
      const queryHash = stream.queryHash;

      const onReset = vi.fn();
      const fsm = new StreamResumeFsm({
        queryHash,
        queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
        onReset,
      });

      // Commit 2 chunks
      fsm.handleIncomingChunk('chunk 1 data');
      fsm.handleIncomingChunk('chunk 2 data');
      expect(fsm.committedByteLength).toBeGreaterThan(0);
      expect(fsm.committedSeq).toBe(2);
      expect(adapter.getStreamChunks(queryHash, 0)).toHaveLength(2);

      // Receive 416 Range Not Satisfiable
      const err = fsm.handleError(new Error('Range Not Satisfiable'), 416);

      expect(err.canResume).toBe(true);
      expect(err.restart).toBe(true);
      expect(err.retryDelayMs).toBe(0);
      expect(onReset).toHaveBeenCalledTimes(1);

      // Verify FSM properties reset
      expect(fsm.committedByteLength).toBe(0);
      expect(fsm.committedSeq).toBe(0);
      expect(fsm.accumulatedText).toBe('');
      expect(fsm.state).toBe('resuming');

      // Verify SQLite stream chunks purged and stream counters reset
      expect(adapter.getStreamChunks(queryHash, 0)).toHaveLength(0);
      const dbStream = adapter.getStream(queryHash);
      expect(dbStream?.byteLength).toBe(0);
      expect(dbStream?.nextSeq).toBe(0);
      expect(dbStream?.status).toBe('open');
    });

    it('resets stream on HTTP 412 Precondition Failed', () => {
      const onReset = vi.fn();
      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-412',
        queryKey: ['llm', 'stream-412'],
        strategy: createRangeResumeStrategy(),
        onReset,
      });

      fsm.handleIncomingChunk('data payload');
      const err = fsm.handleError('ETag mismatch', 412);

      expect(err.canResume).toBe(true);
      expect(err.restart).toBe(true);
      expect(err.retryDelayMs).toBe(0);
      expect(onReset).toHaveBeenCalledTimes(1);
      expect(fsm.committedByteLength).toBe(0);
      expect(fsm.state).toBe('resuming');
    });
  });

  describe('RestartResumeStrategy Integration', () => {
    it('executes restart strategy when configured as primary resume strategy', () => {
      const queryKey = ['llm', 'restart-strat'] as const;
      const stream = adapter.createStream(queryKey);
      const onReset = vi.fn();

      const fsm = new StreamResumeFsm({
        queryHash: stream.queryHash,
        queryKey,
        strategy: createRestartResumeStrategy(),
        sqliteAdapter: adapter,
        onReset,
      });

      fsm.handleIncomingChunk('some partial data');
      expect(fsm.committedByteLength).toBeGreaterThan(0);

      // Normal error triggers restart strategy
      const err = fsm.handleError('Network blip');
      expect(err.canResume).toBe(true);
      expect(err.restart).toBe(true);
      expect(err.retryDelayMs).toBeGreaterThanOrEqual(0);
      expect(onReset).toHaveBeenCalledTimes(1);
      expect(fsm.committedByteLength).toBe(0);
      expect(fsm.committedSeq).toBe(0);
    });
  });

  describe('Retry Backoff & Max Retries', () => {
    it('calculates exponential backoff with full jitter within bounds', () => {
      const fsm = new StreamResumeFsm({
        queryHash: 'q-hash-backoff',
        queryKey: ['backoff', 'test'],
        strategy: createRangeResumeStrategy(),
        baseDelayMs: 100,
        maxDelayMs: 1000,
        maxRetries: 5,
      });

      // Error 1: retryCount 0 -> upper bound is 100 * 2^0 = 100
      const err1 = fsm.handleError('err1');
      expect(err1.canResume).toBe(true);
      expect(err1.retryDelayMs).toBeGreaterThanOrEqual(0);
      expect(err1.retryDelayMs).toBeLessThanOrEqual(100);
      expect(fsm.retryCount).toBe(1);

      // Error 2: retryCount 1 -> upper bound is 100 * 2^1 = 200
      const err2 = fsm.handleError('err2');
      expect(err2.canResume).toBe(true);
      expect(err2.retryDelayMs).toBeGreaterThanOrEqual(0);
      expect(err2.retryDelayMs).toBeLessThanOrEqual(200);
      expect(fsm.retryCount).toBe(2);

      // Error 3: retryCount 2 -> upper bound is 100 * 2^2 = 400
      const err3 = fsm.handleError('err3');
      expect(err3.canResume).toBe(true);
      expect(err3.retryDelayMs).toBeGreaterThanOrEqual(0);
      expect(err3.retryDelayMs).toBeLessThanOrEqual(400);
      expect(fsm.retryCount).toBe(3);

      // Error 4: retryCount 3 -> upper bound is 100 * 2^3 = 800
      const err4 = fsm.handleError('err4');
      expect(err4.canResume).toBe(true);
      expect(err4.retryDelayMs).toBeGreaterThanOrEqual(0);
      expect(err4.retryDelayMs).toBeLessThanOrEqual(800);
      expect(fsm.retryCount).toBe(4);

      // Error 5: retryCount 4 -> upper bound is min(1000, 100 * 2^4 = 1600) = 1000
      const err5 = fsm.handleError('err5');
      expect(err5.canResume).toBe(true);
      expect(err5.retryDelayMs).toBeGreaterThanOrEqual(0);
      expect(err5.retryDelayMs).toBeLessThanOrEqual(1000);
      expect(fsm.retryCount).toBe(5);
    });

    it('transitions to aborted and marks SQLite stream aborted when max retries exceeded', () => {
      const queryKey = ['test', 'max-retries'] as const;
      const stream = adapter.createStream(queryKey);
      const queryHash = stream.queryHash;

      const fsm = new StreamResumeFsm({
        queryHash,
        queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
        maxRetries: 3,
      });

      // 3 retries
      fsm.handleError('e1');
      expect(fsm.retryCount).toBe(1);
      fsm.handleError('e2');
      expect(fsm.retryCount).toBe(2);
      fsm.handleError('e3');
      expect(fsm.retryCount).toBe(3);

      // 4th error exceeds maxRetries (3)
      const terminalErr = fsm.handleError(new Error('Fatal connection drop'));
      expect(terminalErr.canResume).toBe(false);
      expect(terminalErr.restart).toBe(false);
      expect(fsm.state).toBe('aborted');

      const streamRow = adapter.getStream(queryHash);
      expect(streamRow?.status).toBe('aborted');
      expect(streamRow?.error).toBe('Fatal connection drop');
    });
  });

  describe('Pre-existing Stream Hydration & Auto-creation', () => {
    it('hydrates committedByteLength, committedSeq, and accumulatedText from existing SQLite stream', () => {
      const queryKey = ['llm', 'existing-stream'] as const;
      const stream = adapter.createStream(queryKey, {
        etag: '"initial-etag"',
        resumeToken: 'evt-init-1',
        resumeKind: 'last-event-id',
      });
      const queryHash = stream.queryHash;

      adapter.appendStreamChunk(queryHash, 'Hello, ');
      adapter.appendStreamChunk(queryHash, 'world!');

      const fsm = new StreamResumeFsm({
        queryHash,
        queryKey,
        strategy: createLastEventIdResumeStrategy(),
        sqliteAdapter: adapter,
      });

      expect(fsm.committedByteLength).toBe(13);
      expect(fsm.committedSeq).toBe(2);
      expect(fsm.accumulatedText).toBe('Hello, world!');
      expect(fsm.lastEventId).toBe('evt-init-1');
      expect(fsm.etag).toBe('"initial-etag"');
    });

    it('auto-creates stream in SQLite if not yet existing when queryHash matches key', () => {
      const queryKey = ['llm', 'autocreate-test'] as const;
      const queryHash = hashQueryKey(queryKey);
      const fsm = new StreamResumeFsm({
        queryHash,
        queryKey,
        strategy: createRangeResumeStrategy(),
        sqliteAdapter: adapter,
      });

      const res = fsm.handleIncomingChunk('Autocreated stream data');
      expect(res.accepted).toBe(true);
      expect(fsm.committedByteLength).toBe(23);

      const dbStream = adapter.getStream(fsm.queryHash);
      expect(dbStream).toBeDefined();
      expect(dbStream?.byteLength).toBe(23);
    });

    it('gracefully handles sqliteAdapter createStream throwing', () => {
      const queryKey = ['llm', 'throw-test'] as const;
      const queryHash = hashQueryKey(queryKey);
      const mockAdapter = {
        getStream: vi.fn().mockReturnValue(undefined),
        createStream: vi.fn().mockImplementation(() => {
          throw new Error('Disk full');
        }),
      } as unknown as SqliteAdapter;

      expect(() => {
        new StreamResumeFsm({
          queryHash,
          queryKey,
          strategy: createRangeResumeStrategy(),
          sqliteAdapter: mockAdapter,
        });
      }).not.toThrow();
    });

    it('works in pure in-memory mode without sqliteAdapter', () => {
      const fsm = new StreamResumeFsm({
        queryHash: 'q-mem',
        queryKey: ['mem', 'stream'],
        strategy: createRangeResumeStrategy(),
      });

      fsm.start();
      const c1 = fsm.handleIncomingChunk('hello ');
      expect(c1.accepted).toBe(true);
      expect(fsm.committedByteLength).toBe(6);

      const c2 = fsm.handleIncomingChunk('world', 1, 6, 'evt-mem');
      expect(c2.accepted).toBe(true);
      expect(fsm.lastEventId).toBe('evt-mem');
      expect(fsm.accumulatedText).toBe('hello world');

      const err = fsm.handleError('drop');
      expect(err.canResume).toBe(true);
      expect(err.headers).toEqual({ Range: 'bytes=11-' });

      fsm.abort();
      expect(fsm.state).toBe('aborted');
    });

    it('handles non-Error objects when max retries exceeded', () => {
      const fsm = new StreamResumeFsm({
        queryHash: 'q-non-err',
        queryKey: ['test', 'non-err'],
        strategy: createRangeResumeStrategy(),
        maxRetries: 0,
      });

      const res = fsm.handleError(404);
      expect(res.canResume).toBe(false);
      expect(fsm.state).toBe('aborted');
    });
  });
});

