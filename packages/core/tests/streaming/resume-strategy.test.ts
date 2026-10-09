import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteAdapter,
  createRangeResumeStrategy,
  createLastEventIdResumeStrategy,
  createContinuationResumeStrategy,
  createRestartResumeStrategy,
  type ResumeContext,
  type RangeResumeStrategy,
  type LastEventIdResumeStrategy,
  type ContinuationResumeStrategy,
  type RestartResumeStrategy,
  type ResumeStrategy,
} from '../../src/index.js';

describe('Resumable Streaming Strategies & SQLite Reset Engine (Task 1)', () => {
  let tmpDir: string;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-resume-strategy-test-'));
    adapter = new SqliteAdapter(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    adapter.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('RangeResumeStrategy', () => {
    it('creates a range resume strategy with kind "range"', () => {
      const strategy = createRangeResumeStrategy();
      expect(strategy.kind).toBe('range');
    });

    it('formats Range: bytes=<byte_length>- header without etag', () => {
      const strategy = createRangeResumeStrategy();
      const ctx: ResumeContext = {
        queryHash: 'q-hash-1',
        queryKey: ['llm', 'completion'],
        byteLength: 1024,
        nextSeq: 5,
        etag: null,
      };

      const headers = strategy.buildHeaders(ctx);
      expect(headers).toEqual({
        Range: 'bytes=1024-',
      });
    });

    it('formats Range and If-Range headers when etag is present', () => {
      const strategy = createRangeResumeStrategy();
      const ctx: ResumeContext = {
        queryHash: 'q-hash-1',
        queryKey: ['llm', 'completion'],
        byteLength: 2048,
        nextSeq: 10,
        etag: '"etag-xyz-123"',
      };

      const headers = strategy.buildHeaders(ctx);
      expect(headers).toEqual({
        Range: 'bytes=2048-',
        'If-Range': '"etag-xyz-123"',
      });
    });
  });

  describe('LastEventIdResumeStrategy', () => {
    it('creates an SSE last-event-id strategy with kind "last-event-id"', () => {
      const strategy = createLastEventIdResumeStrategy();
      expect(strategy.kind).toBe('last-event-id');
    });

    it('formats Last-Event-ID header when lastEventId is set', () => {
      const strategy = createLastEventIdResumeStrategy();
      const ctx: ResumeContext = {
        queryHash: 'q-hash-2',
        queryKey: ['sse', 'events'],
        byteLength: 512,
        nextSeq: 3,
        lastEventId: 'evt_98765',
      };

      const headers = strategy.buildHeaders(ctx);
      expect(headers).toEqual({
        'Last-Event-ID': 'evt_98765',
      });
    });

    it('returns empty headers object when lastEventId is null or undefined', () => {
      const strategy = createLastEventIdResumeStrategy();
      const ctxNull: ResumeContext = {
        queryHash: 'q-hash-2',
        queryKey: ['sse', 'events'],
        byteLength: 512,
        nextSeq: 3,
        lastEventId: null,
      };
      expect(strategy.buildHeaders(ctxNull)).toEqual({});

      const ctxUndefined: ResumeContext = {
        queryHash: 'q-hash-2',
        queryKey: ['sse', 'events'],
        byteLength: 512,
        nextSeq: 3,
      };
      expect(strategy.buildHeaders(ctxUndefined)).toEqual({});
    });
  });

  describe('ContinuationResumeStrategy', () => {
    it('creates a continuation strategy with kind "continuation"', () => {
      const strategy = createContinuationResumeStrategy((ctx) => ({ token: ctx.queryHash }));
      expect(strategy.kind).toBe('continuation');
    });

    it('passes ResumeContext with accumulated text to continuation callback', () => {
      interface CustomContinuation {
        prompt: string;
        byteOffset: number;
        seq: number;
      }

      const strategy = createContinuationResumeStrategy<CustomContinuation>((ctx) => ({
        prompt: `Continue from: ${ctx.accumulatedText ?? ''}`,
        byteOffset: ctx.byteLength,
        seq: ctx.nextSeq,
      }));

      const ctx: ResumeContext = {
        queryHash: 'q-hash-3',
        queryKey: ['ai', 'agent'],
        byteLength: 120,
        nextSeq: 4,
        accumulatedText: 'Hello world, this is a streaming response.',
      };

      const result = strategy.buildContinuation(ctx);
      expect(result).toEqual({
        prompt: 'Continue from: Hello world, this is a streaming response.',
        byteOffset: 120,
        seq: 4,
      });
    });
  });

  describe('RestartResumeStrategy', () => {
    it('creates a restart strategy with kind "restart"', () => {
      const strategy = createRestartResumeStrategy();
      expect(strategy.kind).toBe('restart');
    });

    it('returns { reset: true, seq: 0, byteOffset: 0 } on reset()', () => {
      const strategy = createRestartResumeStrategy();
      const ctx: ResumeContext = {
        queryHash: 'q-hash-4',
        queryKey: ['stream', 'data'],
        byteLength: 4096,
        nextSeq: 8,
      };

      const resetSignal = strategy.reset(ctx);
      expect(resetSignal).toEqual({
        reset: true,
        seq: 0,
        byteOffset: 0,
      });
    });
  });

  describe('SQLite resetStream & updateStreamResumeToken', () => {
    it('resetStream clears chunks and resets stream record to seq 0, byteLength 0, status open', () => {
      const queryKey = ['ai', 'stream', 'session-reset'] as const;
      const stream = adapter.createStream(queryKey);
      const queryHash = stream.queryHash;

      // Append 3 chunks
      adapter.appendStreamChunk(queryHash, 'chunk 1 - ');
      adapter.appendStreamChunk(queryHash, 'chunk 2 - ');
      adapter.appendStreamChunk(queryHash, 'chunk 3');

      // Verify chunks exist
      const chunksBefore = adapter.getStreamChunks(queryHash, 0);
      expect(chunksBefore).toHaveLength(3);

      const streamBefore = adapter.getStream(queryHash);
      expect(streamBefore?.nextSeq).toBe(3);
      expect(streamBefore?.byteLength).toBe(27);

      // Abort or fail the stream to test status reset
      adapter.abortStream(queryHash, 'Connection lost');
      const abortedStream = adapter.getStream(queryHash);
      expect(abortedStream?.status).toBe('aborted');
      expect(abortedStream?.error).toBe('Connection lost');

      // Now reset the stream
      adapter.resetStream(queryHash);

      // Verify chunks table is empty for queryHash
      const chunksAfter = adapter.getStreamChunks(queryHash, 0);
      expect(chunksAfter).toHaveLength(0);

      // Verify stream row has next_seq = 0, byte_length = 0, status = 'open', error = null
      const streamAfter = adapter.getStream(queryHash);
      expect(streamAfter).toBeDefined();
      expect(streamAfter?.nextSeq).toBe(0);
      expect(streamAfter?.byteLength).toBe(0);
      expect(streamAfter?.status).toBe('open');
      expect(streamAfter?.error).toBeNull();
      expect(streamAfter?.updatedAt).toBeGreaterThanOrEqual(streamBefore!.updatedAt);
    });

    it('updateStreamResumeToken updates token and resumeKind', () => {
      const queryKey = ['ai', 'stream', 'resume-token-test'] as const;
      const stream = adapter.createStream(queryKey);
      const queryHash = stream.queryHash;

      expect(stream.resumeToken).toBeNull();
      expect(stream.resumeKind).toBeNull();

      // Update with token and kind
      adapter.updateStreamResumeToken(queryHash, 'cursor_token_abc123', 'continuation');

      const updated1 = adapter.getStream(queryHash);
      expect(updated1?.resumeToken).toBe('cursor_token_abc123');
      expect(updated1?.resumeKind).toBe('continuation');
      expect(updated1?.updatedAt).toBeGreaterThanOrEqual(stream.updatedAt);

      // Update with token only (no kind)
      adapter.updateStreamResumeToken(queryHash, 'cursor_token_def456');

      const updated2 = adapter.getStream(queryHash);
      expect(updated2?.resumeToken).toBe('cursor_token_def456');
      expect(updated2?.resumeKind).toBe('continuation'); // retains prior kind
    });
  });
});
