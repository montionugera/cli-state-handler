import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteAdapter,
  CasStore,
  type StreamRecord,
  type StreamChunk,
  type CreateStreamOptions,
} from '../../src/index.js';
import { hashQueryKey } from '../../src/query/key-hasher.js';

describe('Streaming Chunk Store & Atomic Compaction (Task 2)', () => {
  let tmpDir: string;
  let adapter: SqliteAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucsa-stream-chunk-test-'));
    adapter = new SqliteAdapter(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    adapter.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createStream & getStream', () => {
    it('creates a stream with default options and retrieves it', () => {
      const queryKey = ['ai', 'chat', 'session-123'] as const;
      const expectedHash = hashQueryKey(queryKey);

      const before = Date.now();
      const stream = adapter.createStream(queryKey);
      const after = Date.now();

      expect(stream.queryHash).toBe(expectedHash);
      expect(stream.queryKey).toEqual(queryKey);
      expect(stream.status).toBe('open');
      expect(stream.encoding).toBe('utf8');
      expect(stream.nextSeq).toBe(0);
      expect(stream.byteLength).toBe(0);
      expect(stream.resumeKind).toBeNull();
      expect(stream.resumeToken).toBeNull();
      expect(stream.etag).toBeNull();
      expect(stream.writerId).toBeNull();
      expect(stream.writerLeaseUntil).toBeNull();
      expect(stream.payloadVersion).toBe(1);
      expect(stream.error).toBeNull();
      expect(stream.createdAt).toBeGreaterThanOrEqual(before);
      expect(stream.createdAt).toBeLessThanOrEqual(after);
      expect(stream.updatedAt).toBe(stream.createdAt);
      expect(stream.expiresAt).toBe(stream.createdAt + 300_000);

      const retrieved = adapter.getStream(expectedHash);
      expect(retrieved).toEqual(stream);
    });

    it('creates a stream with custom options (tags, etag, encoding, lease, resume token, ttlMs)', () => {
      const queryKey = ['media', 'render', 'job-456'] as const;
      const options: CreateStreamOptions = {
        encoding: 'bytes',
        resumeKind: 'range',
        resumeToken: 'bytes=100-200',
        etag: '"v1-stream"',
        writerId: 'worker-node-1',
        writerLeaseUntil: Date.now() + 60_000,
        payloadVersion: 2,
        ttlMs: 120_000,
        tags: ['job:render', 'user:456'],
      };

      const stream = adapter.createStream(queryKey, options);

      expect(stream.encoding).toBe('bytes');
      expect(stream.resumeKind).toBe('range');
      expect(stream.resumeToken).toBe('bytes=100-200');
      expect(stream.etag).toBe('"v1-stream"');
      expect(stream.writerId).toBe('worker-node-1');
      expect(stream.writerLeaseUntil).toBe(options.writerLeaseUntil);
      expect(stream.payloadVersion).toBe(2);
      expect(stream.expiresAt).toBe(stream.createdAt + 120_000);

      // Verify stream tags were inserted into ucsa_stream_tags
      const tagsInDb = adapter.db
        .prepare('SELECT tag FROM ucsa_stream_tags WHERE query_hash = ? ORDER BY tag ASC')
        .all(stream.queryHash) as Array<{ tag: string }>;
      expect(tagsInDb.map((t) => t.tag)).toEqual(['job:render', 'user:456']);

      const retrieved = adapter.getStream(stream.queryHash);
      expect(retrieved).toEqual(stream);
    });

    it('returns undefined for nonexistent stream', () => {
      const result = adapter.getStream('nonexistent-hash');
      expect(result).toBeUndefined();
    });
  });

  describe('appendStreamChunk', () => {
    it('appends sequential chunks (0, 1, 2) and updates next_seq and byte_length', () => {
      const queryKey = ['llm', 'generate', 'prompt-1'] as const;
      const stream = adapter.createStream(queryKey, { encoding: 'utf8' });

      const chunk0 = 'Hello, ';
      const chunk1 = 'world! ';
      const chunk2 = 'How are you?';

      const res0 = adapter.appendStreamChunk(stream.queryHash, chunk0, 0);
      expect(res0).toEqual({
        seq: 0,
        byteOffset: 0,
        byteLength: Buffer.byteLength(chunk0, 'utf8'),
      });

      const updated1 = adapter.getStream(stream.queryHash);
      expect(updated1?.nextSeq).toBe(1);
      expect(updated1?.byteLength).toBe(res0.byteLength);

      const res1 = adapter.appendStreamChunk(stream.queryHash, chunk1, 1);
      expect(res1).toEqual({
        seq: 1,
        byteOffset: res0.byteLength,
        byteLength: Buffer.byteLength(chunk1, 'utf8'),
      });

      const updated2 = adapter.getStream(stream.queryHash);
      expect(updated2?.nextSeq).toBe(2);
      expect(updated2?.byteLength).toBe(res0.byteLength + res1.byteLength);

      const res2 = adapter.appendStreamChunk(stream.queryHash, chunk2, 2);
      expect(res2).toEqual({
        seq: 2,
        byteOffset: res0.byteLength + res1.byteLength,
        byteLength: Buffer.byteLength(chunk2, 'utf8'),
      });

      const updated3 = adapter.getStream(stream.queryHash);
      expect(updated3?.nextSeq).toBe(3);
      expect(updated3?.byteLength).toBe(
        res0.byteLength + res1.byteLength + res2.byteLength
      );
    });

    it('appends Buffer and Uint8Array data correctly without expectedSeq', () => {
      const queryKey = ['binary', 'stream', 'bin-1'] as const;
      const stream = adapter.createStream(queryKey, { encoding: 'bytes' });

      const buf = Buffer.from([1, 2, 3, 4]);
      const uint8 = new Uint8Array([5, 6, 7]);

      const res0 = adapter.appendStreamChunk(stream.queryHash, buf);
      expect(res0).toEqual({ seq: 0, byteOffset: 0, byteLength: 4 });

      const res1 = adapter.appendStreamChunk(stream.queryHash, uint8);
      expect(res1).toEqual({ seq: 1, byteOffset: 4, byteLength: 3 });

      const chunks = adapter.getStreamChunks(stream.queryHash);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].data).toEqual(buf);
      expect(chunks[1].data).toEqual(Buffer.from(uint8));
    });

    it('rejects append if expectedSeq mismatches next_seq', () => {
      const queryKey = ['test', 'seq-mismatch'] as const;
      const stream = adapter.createStream(queryKey);

      adapter.appendStreamChunk(stream.queryHash, 'chunk 0', 0);

      // Expected seq is 1, but caller sends 2
      expect(() => {
        adapter.appendStreamChunk(stream.queryHash, 'chunk 2', 2);
      }).toThrow(/Sequence mismatch: expected 2, but next sequence is 1/i);

      // Verify next_seq is still 1
      const current = adapter.getStream(stream.queryHash);
      expect(current?.nextSeq).toBe(1);
    });

    it('rejects append if stream not found', () => {
      expect(() => {
        adapter.appendStreamChunk('missing-hash', 'data');
      }).toThrow(/Stream not found: missing-hash/i);
    });

    it('rejects append if stream is aborted or closed', () => {
      const queryKey = ['test', 'aborted-stream'] as const;
      const stream = adapter.createStream(queryKey);

      adapter.abortStream(stream.queryHash, 'User cancelled');

      expect(() => {
        adapter.appendStreamChunk(stream.queryHash, 'chunk', 0);
      }).toThrow(/Stream is not open \(status: aborted\)/i);
    });
  });

  describe('getStreamChunks', () => {
    it('retrieves chunks with and without fromSeq', () => {
      const queryKey = ['test', 'get-chunks'] as const;
      const stream = adapter.createStream(queryKey);

      adapter.appendStreamChunk(stream.queryHash, 'zero', 0);
      adapter.appendStreamChunk(stream.queryHash, 'one', 1);
      adapter.appendStreamChunk(stream.queryHash, 'two', 2);
      adapter.appendStreamChunk(stream.queryHash, 'three', 3);

      const allChunks = adapter.getStreamChunks(stream.queryHash);
      expect(allChunks).toHaveLength(4);
      expect(allChunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
      expect(allChunks.map((c) => c.data.toString('utf8'))).toEqual([
        'zero',
        'one',
        'two',
        'three',
      ]);

      const slicedChunks = adapter.getStreamChunks(stream.queryHash, 2);
      expect(slicedChunks).toHaveLength(2);
      expect(slicedChunks.map((c) => c.seq)).toEqual([2, 3]);
      expect(slicedChunks.map((c) => c.data.toString('utf8'))).toEqual([
        'two',
        'three',
      ]);
    });

    it('returns empty array if no chunks exist or queryHash not found', () => {
      const queryKey = ['test', 'empty'] as const;
      const stream = adapter.createStream(queryKey);

      expect(adapter.getStreamChunks(stream.queryHash)).toEqual([]);
      expect(adapter.getStreamChunks('missing-hash')).toEqual([]);
    });
  });

  describe('abortStream', () => {
    it('transitions status to aborted and sets error message', () => {
      const queryKey = ['test', 'abort'] as const;
      const stream = adapter.createStream(queryKey);

      adapter.abortStream(stream.queryHash, 'Upstream timeout');

      const aborted = adapter.getStream(stream.queryHash);
      expect(aborted?.status).toBe('aborted');
      expect(aborted?.error).toBe('Upstream timeout');
      expect(aborted?.updatedAt).toBeGreaterThanOrEqual(stream.createdAt);
    });
  });

  describe('cascade delete', () => {
    it('deleting stream row purges associated chunks and stream tags', () => {
      const queryKey = ['test', 'cascade'] as const;
      const stream = adapter.createStream(queryKey, {
        tags: ['tag1', 'tag2'],
      });

      adapter.appendStreamChunk(stream.queryHash, 'chunk 0');
      adapter.appendStreamChunk(stream.queryHash, 'chunk 1');

      expect(adapter.getStreamChunks(stream.queryHash)).toHaveLength(2);

      const tagCountBefore = adapter.db
        .prepare('SELECT count(*) as cnt FROM ucsa_stream_tags WHERE query_hash = ?')
        .get(stream.queryHash) as { cnt: number };
      expect(tagCountBefore.cnt).toBe(2);

      // Directly delete stream from ucsa_streams
      adapter.db
        .prepare('DELETE FROM ucsa_streams WHERE query_hash = ?')
        .run(stream.queryHash);

      // Chunks and tags must be cascade deleted
      expect(adapter.getStream(stream.queryHash)).toBeUndefined();
      expect(adapter.getStreamChunks(stream.queryHash)).toEqual([]);

      const tagCountAfter = adapter.db
        .prepare('SELECT count(*) as cnt FROM ucsa_stream_tags WHERE query_hash = ?')
        .get(stream.queryHash) as { cnt: number };
      expect(tagCountAfter.cnt).toBe(0);
    });
  });

  describe('compactStream', () => {
    it('compacts UTF-8 JSON stream into ucsa_query_cache and copies tags to ucsa_cache_tags', async () => {
      const queryKey = ['ai', 'response', 'req-1'] as const;
      const tags = ['ai-response', 'user-42'];
      const stream = adapter.createStream(queryKey, {
        encoding: 'utf8',
        etag: '"response-etag-123"',
        tags,
        payloadVersion: 2,
      });

      // Stream JSON fragments: '{"answer":', ' "Paris",', ' "confidence": 0.99}'
      adapter.appendStreamChunk(stream.queryHash, '{"answer":');
      adapter.appendStreamChunk(stream.queryHash, ' "Paris",');
      adapter.appendStreamChunk(stream.queryHash, ' "confidence": 0.99}');

      const entry = await adapter.compactStream(stream.queryHash);

      expect(entry.query_hash).toBe(stream.queryHash);
      expect(entry.query_key).toEqual(queryKey);
      expect(entry.data_payload).toEqual({ answer: 'Paris', confidence: 0.99 });
      expect(entry.etag).toBe('"response-etag-123"');
      expect(entry.created_at).toBe(stream.createdAt);
      expect(entry.stale_at).toBe(stream.createdAt + 60_000);
      expect(entry.expires_at).toBe(stream.expiresAt);
      expect(entry.payload_version).toBe(2);

      // Verify stream is purged from ucsa_streams, chunks, and tags
      expect(adapter.getStream(stream.queryHash)).toBeUndefined();
      expect(adapter.getStreamChunks(stream.queryHash)).toEqual([]);
      const streamTags = adapter.db
        .prepare('SELECT count(*) as cnt FROM ucsa_stream_tags WHERE query_hash = ?')
        .get(stream.queryHash) as { cnt: number };
      expect(streamTags.cnt).toBe(0);

      // Verify entry is retrievable via getQuery
      const cached = adapter.getQuery<{ answer: string; confidence: number }>(
        stream.queryHash
      );
      expect(cached).toBeDefined();
      expect(cached?.data_payload).toEqual({ answer: 'Paris', confidence: 0.99 });

      // Verify tags moved to ucsa_cache_tags
      const cacheHashes = adapter.getQueryHashesByTag('ai-response');
      expect(cacheHashes).toContain(stream.queryHash);
      const userHashes = adapter.getQueryHashesByTag('user-42');
      expect(userHashes).toContain(stream.queryHash);
    });

    it('compacts UTF-8 plain text (non-JSON) stream into ucsa_query_cache', async () => {
      const queryKey = ['stream', 'text-raw'] as const;
      const stream = adapter.createStream(queryKey, { encoding: 'utf8' });

      adapter.appendStreamChunk(stream.queryHash, 'Line 1\n');
      adapter.appendStreamChunk(stream.queryHash, 'Line 2\n');

      const entry = await adapter.compactStream(stream.queryHash);
      expect(entry.data_payload).toBe('Line 1\nLine 2\n');

      const cached = adapter.getQuery<string>(stream.queryHash);
      expect(cached?.data_payload).toBe('Line 1\nLine 2\n');
    });

    it('compacts bytes stream into ucsa_query_cache', async () => {
      const queryKey = ['stream', 'binary-raw'] as const;
      const stream = adapter.createStream(queryKey, { encoding: 'bytes' });

      const b1 = Buffer.from([10, 20]);
      const b2 = Buffer.from([30, 40, 50]);
      adapter.appendStreamChunk(stream.queryHash, b1);
      adapter.appendStreamChunk(stream.queryHash, b2);

      const entry = await adapter.compactStream(stream.queryHash);
      expect(entry.data_payload).toEqual(Buffer.concat([b1, b2]));
    });

    it('compacts stream exceeding casThresholdBytes into CAS store fallback', async () => {
      const casDir = path.join(tmpDir, 'cas');
      const casStore = new CasStore({
        baseDir: casDir,
        sqliteAdapter: adapter,
      });

      const queryKey = ['stream', 'large-payload'] as const;
      const stream = adapter.createStream(queryKey, {
        encoding: 'utf8',
        tags: ['large-blob'],
      });

      // Write 2KB of data with a threshold of 1KB (1024 bytes)
      const chunkData = 'x'.repeat(600);
      adapter.appendStreamChunk(stream.queryHash, chunkData, 0);
      adapter.appendStreamChunk(stream.queryHash, chunkData, 1);
      adapter.appendStreamChunk(stream.queryHash, chunkData, 2);

      const totalSize = 1800;
      expect(adapter.getStream(stream.queryHash)?.byteLength).toBe(totalSize);

      const entry = await adapter.compactStream(stream.queryHash, casStore, 1024);

      // Verify payload is formatted as CAS reference
      expect(entry.data_payload).toMatchObject({
        __cas_ref: true,
        size: totalSize,
      });
      const casPayload = entry.data_payload as {
        __cas_ref: boolean;
        hash: string;
        size: number;
      };
      expect(typeof casPayload.hash).toBe('string');
      expect(casPayload.hash).toHaveLength(64); // SHA-256 hex

      // Verify CAS file actually exists on disk
      const casPath = casStore.getPath(casPayload.hash);
      expect(fs.existsSync(casPath)).toBe(true);
      const onDisk = fs.readFileSync(casPath, 'utf8');
      expect(onDisk).toBe('x'.repeat(1800));

      // Verify stream is purged from SQLite
      expect(adapter.getStream(stream.queryHash)).toBeUndefined();
      expect(adapter.getStreamChunks(stream.queryHash)).toEqual([]);

      // Verify tags moved to ucsa_cache_tags
      expect(adapter.getQueryHashesByTag('large-blob')).toContain(stream.queryHash);

      // Verify getQuery returns the CAS reference
      const cached = adapter.getQuery<typeof casPayload>(stream.queryHash);
      expect(cached?.data_payload).toEqual(casPayload);
    });

    it('throws if compactStream is called on nonexistent stream', async () => {
      await expect(adapter.compactStream('nonexistent-hash')).rejects.toThrow(
        /Stream not found: nonexistent-hash/i
      );
    });
  });
});
