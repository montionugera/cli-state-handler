import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  CasStore,
  SqliteAdapter,
  getCasObject,
  getTotalCasSize,
  getLruCasObjects,
} from '../../src/index.js';

describe('CasStore LRU & Access Tracking', () => {
  let tempBaseDir: string;
  let adapter: SqliteAdapter;
  let casStore: CasStore;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-lru-test-'));
    adapter = new SqliteAdapter(':memory:');
    casStore = new CasStore({
      baseDir: tempBaseDir,
      sqliteAdapter: adapter,
      maxSizeBytes: 1000,
    });
  });

  afterEach(async () => {
    adapter.close();
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('records last_accessed_at and size in ucsa_cas_objects on put()', async () => {
    const payload = Buffer.alloc(300, 'a');
    const { hash } = await casStore.put(payload);

    const record = getCasObject(adapter.db, hash);
    expect(record).not.toBeNull();
    expect(record!.hash).toBe(hash);
    expect(record!.size).toBe(300);
    expect(record!.last_accessed_at).toBeGreaterThan(0);

    const totalSize = getTotalCasSize(adapter.db);
    expect(totalSize).toBe(300);
  });

  it('updates last_accessed_at in SQLite and touches mtime on get()', async () => {
    const payload = Buffer.alloc(300, 'a');
    const { hash, path: filePath } = await casStore.put(payload);

    const recordBefore = getCasObject(adapter.db, hash);
    expect(recordBefore).not.toBeNull();

    // Set file mtime to a timestamp in the past to verify touch
    const pastTime = new Date(Date.now() - 10000);
    fs.utimesSync(filePath, pastTime, pastTime);
    const mtimePast = fs.statSync(filePath).mtimeMs;

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Access object via get()
    const content = await casStore.get(hash);
    expect(content).not.toBeNull();
    expect(content!.byteLength).toBe(300);

    // Verify SQLite last_accessed_at was updated
    const recordAfter = getCasObject(adapter.db, hash);
    expect(recordAfter!.last_accessed_at).toBeGreaterThan(recordBefore!.last_accessed_at);

    // Verify file mtime was touched forward
    const mtimeAfter = fs.statSync(filePath).mtimeMs;
    expect(mtimeAfter).toBeGreaterThan(mtimePast);
  });

  it('updates last_accessed_at on read() alias as well', async () => {
    const payload = Buffer.alloc(300, 'b');
    const { hash } = await casStore.put(payload);

    const recordBefore = getCasObject(adapter.db, hash);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await casStore.read(hash);
    expect(content).not.toBeNull();

    const recordAfter = getCasObject(adapter.db, hash);
    expect(recordAfter!.last_accessed_at).toBeGreaterThan(recordBefore!.last_accessed_at);
  });

  it('executes full LRU eviction cycle when maxSizeBytes is exceeded', async () => {
    // 1. Setup CasStore with 1000 bytes maxSizeBytes
    // 2. Write 3 objects totaling 900 bytes
    const obj1Data = Buffer.alloc(300, '1');
    const obj2Data = Buffer.alloc(300, '2');
    const obj3Data = Buffer.alloc(300, '3');

    const res1 = await casStore.put(obj1Data);
    await new Promise((r) => setTimeout(r, 15));
    const res2 = await casStore.put(obj2Data);
    await new Promise((r) => setTimeout(r, 15));
    const res3 = await casStore.put(obj3Data);

    // Assert total size is 900 bytes
    expect(getTotalCasSize(adapter.db)).toBe(900);
    expect(await casStore.getTotalSize()).toBe(900);

    // Assert last_accessed_at is recorded in SQLite for all 3 objects
    expect(getCasObject(adapter.db, res1.hash)).not.toBeNull();
    expect(getCasObject(adapter.db, res2.hash)).not.toBeNull();
    expect(getCasObject(adapter.db, res3.hash)).not.toBeNull();

    // 3. Access object 1: assert last_accessed_at updates to newer timestamp and mtime is touched
    const record1Before = getCasObject(adapter.db, res1.hash)!;
    const pastTime = new Date(Date.now() - 5000);
    fs.utimesSync(res1.path, pastTime, pastTime);

    await new Promise((r) => setTimeout(r, 20));
    await casStore.get(res1.hash);

    const record1After = getCasObject(adapter.db, res1.hash)!;
    expect(record1After.last_accessed_at).toBeGreaterThan(record1Before.last_accessed_at);
    expect(fs.statSync(res1.path).mtimeMs).toBeGreaterThan(pastTime.getTime());

    // At this point, access order from oldest to newest is:
    // obj2 (oldest), obj3 (middle), obj1 (recently accessed)
    const lruList = getLruCasObjects(adapter.db);
    expect(lruList[0].hash).toBe(res2.hash);
    expect(lruList[1].hash).toBe(res3.hash);
    expect(lruList[2].hash).toBe(res1.hash);

    // 4. Write 4th object pushing total bytes beyond maxSizeBytes (900 + 300 = 1200 > 1000)
    await new Promise((r) => setTimeout(r, 15));
    const obj4Data = Buffer.alloc(300, '4');
    const res4 = await casStore.put(obj4Data);

    // 5. Assert oldest unaccessed objects (obj2 and obj3) are pruned,
    // while recently accessed obj1 and newly written obj4 remain intact
    expect(await casStore.has(res2.hash)).toBe(false);
    expect(await casStore.has(res3.hash)).toBe(false);
    expect(await casStore.get(res2.hash)).toBeNull();
    expect(await casStore.get(res3.hash)).toBeNull();

    expect(await casStore.has(res1.hash)).toBe(true);
    expect(await casStore.has(res4.hash)).toBe(true);
    expect((await casStore.get(res1.hash))!.equals(obj1Data)).toBe(true);
    expect((await casStore.get(res4.hash))!.equals(obj4Data)).toBe(true);

    // Assert SQLite records for pruned objects were deleted
    expect(getCasObject(adapter.db, res2.hash)).toBeNull();
    expect(getCasObject(adapter.db, res3.hash)).toBeNull();
    expect(getCasObject(adapter.db, res1.hash)).not.toBeNull();
    expect(getCasObject(adapter.db, res4.hash)).not.toBeNull();

    // 6. Total bytes after prune drops to target threshold (<= 70% of maxSizeBytes, i.e. <= 700)
    const currentTotalSize = getTotalCasSize(adapter.db);
    expect(currentTotalSize).toBeLessThanOrEqual(1000 * 0.7);
    expect(currentTotalSize).toBe(600); // 300 + 300
  });

  it('allows explicit prune() with custom targetRatio', async () => {
    // Write 3 objects of 300 bytes (total 900) with maxSizeBytes = 1000
    const res1 = await casStore.put(Buffer.alloc(300, '1'));
    await new Promise((r) => setTimeout(r, 10));
    const res2 = await casStore.put(Buffer.alloc(300, '2'));
    await new Promise((r) => setTimeout(r, 10));
    const res3 = await casStore.put(Buffer.alloc(300, '3'));

    expect(await casStore.getTotalSize()).toBe(900);

    // prune() without exceeding maxSizeBytes should do nothing
    const noopResult = await casStore.prune(0.7);
    expect(noopResult.prunedCount).toBe(0);
    expect(noopResult.bytesFreed).toBe(0);
    expect(await casStore.getTotalSize()).toBe(900);

    // If quotaBytes is supplied to prune, it triggers pruning down to 900 * 0.4 = 360
    const pruneResult = await casStore.prune(0.4, 800); // target = 800 * 0.4 = 320
    expect(pruneResult.prunedCount).toBe(2);
    expect(pruneResult.bytesFreed).toBe(600);

    expect(await casStore.has(res1.hash)).toBe(false);
    expect(await casStore.has(res2.hash)).toBe(false);
    expect(await casStore.has(res3.hash)).toBe(true);
    expect(await casStore.getTotalSize()).toBe(300);
  });

  it('delete() removes object from both filesystem and ucsa_cas_objects SQLite table', async () => {
    const payload = Buffer.alloc(250, 'x');
    const { hash, path: filePath } = await casStore.put(payload);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(getCasObject(adapter.db, hash)).not.toBeNull();
    expect(await casStore.getTotalSize()).toBe(250);

    const deleted = await casStore.delete(hash);
    expect(deleted).toBe(true);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(getCasObject(adapter.db, hash)).toBeNull();
    expect(await casStore.getTotalSize()).toBe(0);

    // Second delete returns false
    const deleteAgain = await casStore.delete(hash);
    expect(deleteAgain).toBe(false);
  });

  it('handles get() on non-existent object without touching database', async () => {
    const nonExistent = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = await casStore.get(nonExistent);
    expect(result).toBeNull();
    expect(getCasObject(adapter.db, nonExistent)).toBeNull();
  });

  it('works gracefully without sqliteAdapter (no LRU tracking or crashes)', async () => {
    const standaloneStore = new CasStore({
      baseDir: tempBaseDir,
      maxSizeBytes: 500,
    });

    const res = await standaloneStore.put(Buffer.alloc(600, 'z'));
    expect(res.size).toBe(600);
    expect(await standaloneStore.has(res.hash)).toBe(true);

    const pruneRes = await standaloneStore.prune();
    expect(pruneRes).toEqual({ prunedCount: 0, bytesFreed: 0 });
    expect(await standaloneStore.getTotalSize()).toBe(0);
  });
});
