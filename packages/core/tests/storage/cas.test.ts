import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { CasStore, IntegrityError, SqliteAdapter } from '../../src/index.js';

describe('CasStore - CAS Store, Atomic Writes & Checksum Verification', () => {
  let tempBaseDir: string;
  let casStore: CasStore;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-store-test-'));
    casStore = new CasStore({ baseDir: tempBaseDir });
  });

  afterEach(async () => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('initializes base directories (objects and tmp)', async () => {
    await casStore.init();

    const objectsDir = path.join(tempBaseDir, 'objects');
    const tmpDir = path.join(tempBaseDir, 'tmp');

    expect(fs.existsSync(objectsDir)).toBe(true);
    expect(fs.existsSync(tmpDir)).toBe(true);
    expect(fs.statSync(objectsDir).isDirectory()).toBe(true);
    expect(fs.statSync(tmpDir).isDirectory()).toBe(true);
  });

  it('computes correct getPath under <baseDir>/objects/<prefix>/<hash>', () => {
    const dummyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const expectedPath = path.join(
      tempBaseDir,
      'objects',
      dummyHash.slice(0, 2),
      dummyHash
    );

    expect(casStore.getPath(dummyHash)).toBe(expectedPath);
  });

  it('stores a Buffer, returns computed SHA-256 hash, correct byte size, and path', async () => {
    const content = Buffer.from('hello cas package cache world');
    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');

    const result = await casStore.put(content);

    expect(result.hash).toBe(expectedHash);
    expect(result.size).toBe(content.byteLength);
    expect(result.path).toBe(casStore.getPath(expectedHash));

    // Verify file exists on disk with exact content
    expect(fs.existsSync(result.path)).toBe(true);
    const diskContent = fs.readFileSync(result.path);
    expect(diskContent.equals(content)).toBe(true);
  });

  it('stores a Uint8Array correctly', async () => {
    const rawBytes = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    const expectedHash = crypto.createHash('sha256').update(rawBytes).digest('hex');

    const result = await casStore.put(rawBytes);

    expect(result.hash).toBe(expectedHash);
    expect(result.size).toBe(rawBytes.byteLength);

    const retrieved = await casStore.get(expectedHash);
    expect(retrieved).not.toBeNull();
    expect(new Uint8Array(retrieved!)).toEqual(rawBytes);
  });

  it('ensures atomic writes leave no temporary files in <baseDir>/tmp/', async () => {
    const content = Buffer.from('test atomic write cleanup');
    await casStore.put(content);

    const tmpDir = path.join(tempBaseDir, 'tmp');
    const tmpFiles = fs.readdirSync(tmpDir);
    expect(tmpFiles).toHaveLength(0);
  });

  it('succeeds when put() is called with matching expectedHash', async () => {
    const content = Buffer.from('verified matching content');
    const correctHash = crypto.createHash('sha256').update(content).digest('hex');

    const result = await casStore.put(content, correctHash);
    expect(result.hash).toBe(correctHash);
  });

  it('throws IntegrityError and cleans up temp files when expectedHash mismatches', async () => {
    const content = Buffer.from('corrupted package data payload');
    const computedHash = crypto.createHash('sha256').update(content).digest('hex');
    const wrongExpectedHash = '0000000000000000000000000000000000000000000000000000000000000000';

    await expect(casStore.put(content, wrongExpectedHash)).rejects.toThrow(IntegrityError);

    // Verify temp directory contains no leftover files
    const tmpDir = path.join(tempBaseDir, 'tmp');
    if (fs.existsSync(tmpDir)) {
      const tmpFiles = fs.readdirSync(tmpDir);
      expect(tmpFiles).toHaveLength(0);
    }

    // Verify no corrupted object file was written under wrong hash or computed hash
    expect(fs.existsSync(casStore.getPath(wrongExpectedHash))).toBe(false);
    expect(fs.existsSync(casStore.getPath(computedHash))).toBe(false);
  });

  it('retrieves exact stored buffer with get() and read()', async () => {
    const content = Buffer.from('binary-asset-payload-\x00\x01\xfe\xff');
    const { hash } = await casStore.put(content);

    const retrievedGet = await casStore.get(hash);
    expect(retrievedGet).not.toBeNull();
    expect(retrievedGet!.equals(content)).toBe(true);

    const retrievedRead = await casStore.read(hash);
    expect(retrievedRead).not.toBeNull();
    expect(retrievedRead!.equals(content)).toBe(true);
  });

  it('returns null when get() is called on non-existent hash', async () => {
    const nonExistent = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const result = await casStore.get(nonExistent);
    expect(result).toBeNull();
  });

  it('checks object existence with has()', async () => {
    const content = Buffer.from('presence check content');
    const { hash } = await casStore.put(content);

    const exists = await casStore.has(hash);
    expect(exists).toBe(true);

    const nonExistent = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    const notExists = await casStore.has(nonExistent);
    expect(notExists).toBe(false);
  });

  it('deletes an object with delete() and returns true; returns false if not found', async () => {
    const content = Buffer.from('to be deleted content');
    const { hash } = await casStore.put(content);

    expect(await casStore.has(hash)).toBe(true);

    const deleted = await casStore.delete(hash);
    expect(deleted).toBe(true);
    expect(await casStore.has(hash)).toBe(false);
    expect(await casStore.get(hash)).toBeNull();

    // Second delete returns false
    const deleteAgain = await casStore.delete(hash);
    expect(deleteAgain).toBe(false);
  });

  it('handles idempotent put() calls without corruption or crash', async () => {
    const content = Buffer.from('repeated identical writes');
    const res1 = await casStore.put(content);
    const res2 = await casStore.put(content);

    expect(res1.hash).toBe(res2.hash);
    expect(await casStore.has(res1.hash)).toBe(true);
    const retrieved = await casStore.get(res1.hash);
    expect(retrieved!.equals(content)).toBe(true);
  });

  it('accepts optional sqliteAdapter and maxSizeBytes options in constructor', () => {
    const adapter = new SqliteAdapter(':memory:');
    try {
      const storeWithAdapter = new CasStore({
        baseDir: tempBaseDir,
        sqliteAdapter: adapter,
        maxSizeBytes: 1024 * 1024 * 100, // 100MB
      });
      expect(storeWithAdapter).toBeInstanceOf(CasStore);
    } finally {
      adapter.close();
    }
  });
});
