import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runQuery,
  runCas,
  runOutbox,
  runDurability,
  runStatus,
} from '../src/commands/index.js';
import { parseArgs, dispatchCommand } from '../src/router.js';

describe('CLI Commands Execution', () => {
  let tempDir: string;
  let dbPath: string;
  let casDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ucsa-cli-test-'));
    dbPath = path.join(tempDir, 'test-cache.db');
    casDir = path.join(tempDir, 'test-cas');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  describe('query command', () => {
    it('performs initial network fetch and subsequent SWR cache hit', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      // 1. Initial fetch -> network
      await runQuery('users/profile', { db: dbPath, ttl: 5000 });

      expect(logs.some((l) => l.includes('Source: network'))).toBe(true);
      expect(logs.some((l) => l.includes('ETag:'))).toBe(true);
      expect(logs.some((l) => l.includes('Execution time:'))).toBe(true);
      expect(logs.some((l) => l.includes('Payload:'))).toBe(true);

      logs.length = 0;

      // 2. Subsequent query -> cache (SWR) hit
      await runQuery('users/profile', { db: dbPath, ttl: 5000 });

      expect(logs.some((l) => l.includes('Source: cache (SWR)'))).toBe(true);
      expect(logs.some((l) => l.includes('ETag:'))).toBe(true);
      expect(logs.some((l) => l.includes('Execution time:'))).toBe(true);
      expect(logs.some((l) => l.includes('Payload:'))).toBe(true);

      logSpy.mockRestore();
    });

    it('supports query tagging for invalidation indexing', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      await runQuery('orders/100', { db: dbPath, ttl: 10000, tag: 'orders' });
      expect(logs.some((l) => l.includes('Source: network'))).toBe(true);

      logs.length = 0;
      await runStatus({ db: dbPath, casDir });
      expect(logs.some((l) => l.includes('Cache Tags: 1'))).toBe(true);

      logSpy.mockRestore();
    });
  });

  describe('cas command', () => {
    it('stores and retrieves files using SHA-256 content addressable storage', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      const sampleFile = path.join(tempDir, 'source.txt');
      const testContent = 'UCSA Content-Addressable Storage Payload';
      await fs.writeFile(sampleFile, testContent, 'utf-8');

      // 1. CAS Put
      await runCas('put', sampleFile, { dir: casDir });

      expect(logs.some((l) => l.includes('Stored object successfully'))).toBe(true);
      const hashLog = logs.find((l) => l.includes('Hash: '));
      expect(hashLog).toBeDefined();
      const hash = hashLog!.replace('[ucsa:cas] Hash: ', '').trim();
      expect(hash.length).toBe(64);

      logs.length = 0;

      // 2. CAS Get stdout
      await runCas('get', hash, { dir: casDir });
      expect(logs.some((l) => l.includes('Retrieved object'))).toBe(true);
      expect(logs.some((l) => l.includes(testContent))).toBe(true);

      logs.length = 0;

      // 3. CAS Get to --out destination
      const outFile = path.join(tempDir, 'retrieved.txt');
      await runCas('get', hash, { dir: casDir, out: outFile });
      expect(logs.some((l) => l.includes('Saved object'))).toBe(true);

      const retrievedContent = await fs.readFile(outFile, 'utf-8');
      expect(retrievedContent).toBe(testContent);

      logSpy.mockRestore();
    });

    it('triggers LRU pruning when size quota is exceeded', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      // Write 3 files of 1000 bytes each
      const fileA = path.join(tempDir, 'fileA.bin');
      const fileB = path.join(tempDir, 'fileB.bin');
      const fileC = path.join(tempDir, 'fileC.bin');

      await fs.writeFile(fileA, Buffer.alloc(1000, 1));
      await fs.writeFile(fileB, Buffer.alloc(1000, 2));
      await fs.writeFile(fileC, Buffer.alloc(1000, 3));

      await runCas('put', fileA, { dir: casDir });
      await runCas('put', fileB, { dir: casDir });
      await runCas('put', fileC, { dir: casDir });

      logs.length = 0;

      // Prune to 1500 bytes (threshold)
      await runCas('prune', '1500', { dir: casDir });

      expect(logs.some((l) => l.includes('Prune complete'))).toBe(true);
      expect(logs.some((l) => l.includes('Pruned count:'))).toBe(true);
      expect(logs.some((l) => l.includes('Bytes freed:'))).toBe(true);

      const countLog = logs.find((l) => l.includes('Pruned count: '));
      const prunedCount = Number(countLog?.replace('[ucsa:cas] Pruned count: ', ''));
      expect(prunedCount).toBeGreaterThanOrEqual(1);

      logSpy.mockRestore();
    });
  });

  describe('outbox command', () => {
    it('queues offline mutations and replays successfully', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      // 1. Queue mutation
      await runOutbox('queue', '/api/users', {
        db: dbPath,
        method: 'POST',
        payload: JSON.stringify({ name: 'Alice', role: 'admin' }),
        policy: 'server-wins',
      });

      expect(logs.some((l) => l.includes('Enqueued mutation:'))).toBe(true);
      expect(logs.some((l) => l.includes('Endpoint: /api/users'))).toBe(true);
      expect(logs.some((l) => l.includes('Method: POST'))).toBe(true);
      expect(logs.some((l) => l.includes('Policy: server-wins'))).toBe(true);

      logs.length = 0;

      // 2. Replay mutation
      await runOutbox('replay', '', { db: dbPath });

      expect(logs.some((l) => l.includes('Replay complete:'))).toBe(true);
      expect(logs.some((l) => l.includes('Processed: 1'))).toBe(true);
      expect(logs.some((l) => l.includes('Successful: 1'))).toBe(true);
      expect(logs.some((l) => l.includes('Failed: 0'))).toBe(true);

      logSpy.mockRestore();
    });

    it('resolves conflicts using server-wins policy', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      await runOutbox('queue', '/api/conflicted', {
        db: dbPath,
        payload: JSON.stringify({ conflict: true }),
        policy: 'server-wins',
      });

      logs.length = 0;

      await runOutbox('replay', '', { db: dbPath });

      expect(logs.some((l) => l.includes('Rolled back mutation'))).toBe(true);
      expect(logs.some((l) => l.includes('Successful: 1'))).toBe(true);

      logSpy.mockRestore();
    });

    it('resolves conflicts using client-wins policy with forced flag retry', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      await runOutbox('queue', '/api/conflicted-client', {
        db: dbPath,
        payload: JSON.stringify({ conflict: true, version: 1 }),
        policy: 'client-wins',
      });

      logs.length = 0;

      // First replay: marks forced
      await runOutbox('replay', '', { db: dbPath });

      // Second replay: forced flag succeeds
      await runOutbox('replay', '', { db: dbPath });

      expect(logs.some((l) => l.includes('Successful: 1'))).toBe(true);

      logSpy.mockRestore();
    });

    it('resolves conflicts using merge policy', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      await runOutbox('queue', '/api/conflicted-merge', {
        db: dbPath,
        payload: JSON.stringify({ conflict: true, clientField: 'local-val' }),
        policy: 'merge',
      });

      logs.length = 0;

      // First replay: triggers merge resolver and updates payload
      await runOutbox('replay', '', { db: dbPath });
      expect(logs.some((l) => l.includes('Merged mutation conflict'))).toBe(true);

      // Second replay: payload is now merged, proceeds cleanly
      await runOutbox('replay', '', { db: dbPath });
      expect(logs.some((l) => l.includes('Successful: 1'))).toBe(true);

      logSpy.mockRestore();
    });
  });

  describe('durability command', () => {
    it('verifies WAL truncate checkpointing on exit', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      await runDurability({ db: dbPath });

      expect(
        logs.some((l) =>
          l.includes('WAL checkpoint TRUNCATE verified successfully (0 bytes)')
        )
      ).toBe(true);

      const walFile = `${dbPath}-wal`;
      if (fsSync.existsSync(walFile)) {
        const walSize = fsSync.statSync(walFile).size;
        expect(walSize).toBe(0);
      }

      logSpy.mockRestore();
    });
  });

  describe('status command', () => {
    it('accurately outputs cache, CAS, outbox, and storage metrics', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      // 1. Populate query and tag
      await runQuery('data/item1', { db: dbPath, tag: 'metrics' });

      // 2. Populate CAS object
      const dummyFile = path.join(tempDir, 'dummy.txt');
      await fs.writeFile(dummyFile, 'Dummy CAS Data', 'utf-8');
      await runCas('put', dummyFile, { dir: casDir });

      // 3. Populate Outbox mutation
      await runOutbox('queue', '/api/test', {
        db: dbPath,
        payload: JSON.stringify({ test: 123 }),
      });

      logs.length = 0;

      // 4. Run status
      await runStatus({ db: dbPath, casDir });

      expect(logs.some((l) => l.includes('Database:'))).toBe(true);
      expect(logs.some((l) => l.includes('Cached Queries: 1'))).toBe(true);
      expect(logs.some((l) => l.includes('Cache Tags: 1'))).toBe(true);
      expect(logs.some((l) => l.includes('Outbox Pending: 1'))).toBe(true);
      expect(logs.some((l) => l.includes('CAS Objects: 1'))).toBe(true);
      expect(logs.some((l) => l.includes('SQLite Size:'))).toBe(true);

      logSpy.mockRestore();
    });
  });

  describe('router integration with real subcommands', () => {
    it('dispatches commands end-to-end via dispatchCommand', async () => {
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
        logs.push(msg);
      });

      // Dispatch query
      await dispatchCommand(
        parseArgs(['query', 'dispatch/key', '--db', dbPath, '--ttl', '60000'])
      );
      expect(logs.some((l) => l.includes('Source: network'))).toBe(true);

      logs.length = 0;

      // Dispatch status
      await dispatchCommand(
        parseArgs(['status', '--db', dbPath, '--casDir', casDir])
      );
      expect(logs.some((l) => l.includes('Cached Queries: 1'))).toBe(true);

      logs.length = 0;

      // Dispatch durability
      await dispatchCommand(parseArgs(['durability', '--db', dbPath]));
      expect(
        logs.some((l) => l.includes('WAL checkpoint TRUNCATE verified successfully'))
      ).toBe(true);

      logSpy.mockRestore();
    });
  });
});
