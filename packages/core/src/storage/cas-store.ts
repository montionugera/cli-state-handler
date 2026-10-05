import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SqliteAdapter } from './sqlite-adapter.js';
import {
  initCasTable,
  upsertCasObject,
  updateCasAccessTime,
  deleteCasObject,
  getTotalCasSize,
  getLruCasObjects,
  type PruneResult,
} from './cas-lru.js';

export class IntegrityError extends Error {
  public readonly expected?: string;
  public readonly actual?: string;

  constructor(message: string, expected?: string, actual?: string) {
    super(message);
    this.name = 'IntegrityError';
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CasStoreOptions {
  baseDir: string;
  sqliteAdapter?: SqliteAdapter;
  maxSizeBytes?: number;
}

export interface CasPutResult {
  hash: string;
  size: number;
  path: string;
}

export class CasStore {
  private readonly baseDir: string;
  private readonly objectsDir: string;
  private readonly tmpDir: string;
  private readonly sqliteAdapter?: SqliteAdapter;
  private readonly maxSizeBytes?: number;
  private initialized = false;

  constructor(options: CasStoreOptions) {
    this.baseDir = options.baseDir;
    this.objectsDir = path.join(this.baseDir, 'objects');
    this.tmpDir = path.join(this.baseDir, 'tmp');
    this.sqliteAdapter = options.sqliteAdapter;
    this.maxSizeBytes = options.maxSizeBytes;
  }

  /**
   * Initializes directories and storage engine.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.objectsDir, { recursive: true });
    await fs.mkdir(this.tmpDir, { recursive: true });

    if (this.sqliteAdapter) {
      initCasTable(this.sqliteAdapter.db);
    }

    this.initialized = true;
  }

  /**
   * Computes the deterministic disk path for a given SHA-256 hash.
   * Path format: <baseDir>/objects/<hash[0..2]>/<hash>
   */
  getPath(hash: string): string {
    const prefix = hash.slice(0, 2);
    return path.join(this.objectsDir, prefix, hash);
  }

  /**
   * Writes data atomically to the CAS store and verifies SHA-256 checksum integrity.
   *
   * 1. Data is written to a temporary file in `<baseDir>/tmp/<uuid>.tmp`.
   * 2. The SHA-256 digest is computed.
   * 3. If `expectedHash` is provided and does not match, the temporary file is deleted
   *    and an `IntegrityError` is thrown.
   * 4. The temporary file is atomically renamed to `<baseDir>/objects/<prefix>/<hash>`.
   * 5. If a SQLite adapter is attached, records size and timestamp in `ucsa_cas_objects`.
   * 6. If storage exceeds `maxSizeBytes`, triggers LRU eviction to target ratio.
   */
  async put(
    data: Buffer | Uint8Array,
    expectedHash?: string
  ): Promise<CasPutResult> {
    await this.init();

    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    const tempFileName = `${crypto.randomUUID()}.tmp`;
    const tempFilePath = path.join(this.tmpDir, tempFileName);

    await fs.writeFile(tempFilePath, buffer);

    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');

    if (
      expectedHash !== undefined &&
      expectedHash.toLowerCase() !== actualHash.toLowerCase()
    ) {
      await fs.unlink(tempFilePath).catch(() => {});
      throw new IntegrityError(
        `Checksum mismatch: expected ${expectedHash}, computed ${actualHash}`,
        expectedHash,
        actualHash
      );
    }

    const targetDir = path.join(this.objectsDir, actualHash.slice(0, 2));
    await fs.mkdir(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, actualHash);

    try {
      await fs.rename(tempFilePath, targetPath);
    } catch (err) {
      await fs.unlink(tempFilePath).catch(() => {});
      throw err;
    }

    if (this.sqliteAdapter) {
      upsertCasObject(
        this.sqliteAdapter.db,
        actualHash,
        buffer.byteLength,
        Date.now()
      );

      if (this.maxSizeBytes !== undefined && this.maxSizeBytes > 0) {
        const totalSize = getTotalCasSize(this.sqliteAdapter.db);
        if (totalSize > this.maxSizeBytes) {
          await this.prune();
        }
      }
    }

    return {
      hash: actualHash,
      size: buffer.byteLength,
      path: targetPath,
    };
  }

  /**
   * Retrieves the raw Buffer for an object by its SHA-256 hash.
   * On cache hit, touches file `mtime` and updates `last_accessed_at` in SQLite.
   * Returns `null` if the object does not exist.
   */
  async get(hash: string): Promise<Buffer | null> {
    const filePath = this.getPath(hash);
    let data: Buffer;
    try {
      data = await fs.readFile(filePath);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }

    // Touch file mtime on cache hit
    const now = new Date();
    await fs.utimes(filePath, now, now).catch(() => {});

    // Update SQLite last_accessed_at
    if (this.sqliteAdapter) {
      const updated = updateCasAccessTime(this.sqliteAdapter.db, hash, Date.now());
      if (!updated) {
        upsertCasObject(this.sqliteAdapter.db, hash, data.byteLength, Date.now());
      }
    }

    return data;
  }

  /**
   * Alias for `get(hash)`.
   */
  async read(hash: string): Promise<Buffer | null> {
    return this.get(hash);
  }

  /**
   * Checks whether an object exists in the CAS store.
   */
  async has(hash: string): Promise<boolean> {
    const filePath = this.getPath(hash);
    try {
      await fs.access(filePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes an object by its SHA-256 hash from both disk and SQLite index.
   * Returns `true` if deleted, `false` if it did not exist.
   */
  async delete(hash: string): Promise<boolean> {
    const filePath = this.getPath(hash);
    let unlinked = false;
    try {
      await fs.unlink(filePath);
      unlinked = true;
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    let dbDeleted = false;
    if (this.sqliteAdapter) {
      dbDeleted = deleteCasObject(this.sqliteAdapter.db, hash);
    }

    return unlinked || dbDeleted;
  }

  /**
   * Returns total byte size of all tracked CAS objects in SQLite.
   */
  async getTotalSize(): Promise<number> {
    if (!this.sqliteAdapter) {
      return 0;
    }
    return getTotalCasSize(this.sqliteAdapter.db);
  }

  /**
   * Prunes least recently accessed objects when total storage exceeds limit.
   *
   * @param targetRatio Ratio of quota limit to prune down to (defaults to 0.7, i.e. 70%).
   * @param quotaBytes Optional override for quota limit (defaults to maxSizeBytes).
   */
  async prune(
    targetRatio = 0.7,
    quotaBytes?: number
  ): Promise<PruneResult> {
    if (!this.sqliteAdapter) {
      return { prunedCount: 0, bytesFreed: 0 };
    }

    const limit = quotaBytes ?? this.maxSizeBytes;
    if (limit === undefined || limit <= 0) {
      return { prunedCount: 0, bytesFreed: 0 };
    }

    let currentSize = getTotalCasSize(this.sqliteAdapter.db);
    if (currentSize <= limit) {
      return { prunedCount: 0, bytesFreed: 0 };
    }

    const targetSize = Math.floor(limit * targetRatio);
    const candidates = getLruCasObjects(this.sqliteAdapter.db);

    let prunedCount = 0;
    let bytesFreed = 0;

    for (const candidate of candidates) {
      if (currentSize <= targetSize) {
        break;
      }

      const filePath = this.getPath(candidate.hash);
      try {
        await fs.unlink(filePath);
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }

      deleteCasObject(this.sqliteAdapter.db, candidate.hash);
      prunedCount++;
      bytesFreed += candidate.size;
      currentSize -= candidate.size;
    }

    return { prunedCount, bytesFreed };
  }
}
