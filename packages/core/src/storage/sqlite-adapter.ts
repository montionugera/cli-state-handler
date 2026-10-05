import Database from 'better-sqlite3';
import type { CacheEntry, QueryKey } from '../types.js';
import {
  insertTags,
  getQueryHashesByTag,
  deleteTagsForQuery,
} from './tag-index.js';
import {
  initCasTable,
  upsertCasObject,
  updateCasAccessTime,
  getCasObject,
  deleteCasObject,
  getTotalCasSize,
  getLruCasObjects,
  type CasObjectRecord,
} from './cas-lru.js';

export interface SqliteAdapterOptions {
  journalMode?: 'WAL' | 'MEMORY' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'OFF';
  busyTimeout?: number;
}

export type SqliteCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE';
export type CheckpointMode = SqliteCheckpointMode;

interface QueryCacheRow {
  query_hash: string;
  query_key: string;
  data_payload: string;
  etag: string | null;
  created_at: number;
  stale_at: number;
  expires_at: number;
}

export class SqliteAdapter {
  private readonly _db: Database.Database;
  private _isClosed = false;

  private _upsertQueryStmt!: Database.Statement<
    [string, string, string, string | null, number, number, number]
  >;
  private _getQueryStmt!: Database.Statement<[string]>;
  private _deleteQueryStmt!: Database.Statement<[string]>;
  private _getExpiredQueriesStmt!: Database.Statement<[number]>;

  constructor(dbPath: string = ':memory:', options?: SqliteAdapterOptions) {
    this._db = new Database(dbPath);

    // Enforce foreign key constraints for cascade deletions
    this._db.pragma('foreign_keys = ON');

    // Concurrency: 5000ms busy timeout default
    const timeout = options?.busyTimeout ?? 5000;
    this._db.pragma(`busy_timeout = ${timeout}`);

    // Journaling: WAL default on native, MEMORY on in-memory / web
    const journal = options?.journalMode ?? (dbPath === ':memory:' ? 'MEMORY' : 'WAL');
    this._db.pragma(`journal_mode = ${journal}`);
    this._db.pragma('synchronous = NORMAL');

    this.initSchema();
  }

  /**
   * Returns the underlying better-sqlite3 database instance.
   */
  get db(): Database.Database {
    return this._db;
  }

  /**
   * Initializes tables and indexes if they do not exist.
   * Compiles and caches prepared statements.
   */
  initSchema(): void {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS ucsa_query_cache (
        query_hash TEXT PRIMARY KEY,
        query_key TEXT NOT NULL,
        data_payload TEXT NOT NULL,
        etag TEXT,
        created_at INTEGER NOT NULL,
        stale_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_cache_expires ON ucsa_query_cache(expires_at);

      CREATE TABLE IF NOT EXISTS ucsa_cache_tags (
        tag TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        PRIMARY KEY (tag, query_hash),
        FOREIGN KEY (query_hash) REFERENCES ucsa_query_cache(query_hash) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_tags_hash ON ucsa_cache_tags(query_hash);

      CREATE TABLE IF NOT EXISTS ucsa_mutation_outbox (
        mutation_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        headers TEXT,
        payload TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        error TEXT,
        forced INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_outbox_status ON ucsa_mutation_outbox(status, created_at);

      CREATE TABLE IF NOT EXISTS ucsa_cas_objects (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ucsa_cas_access ON ucsa_cas_objects(last_accessed_at);
    `);

    this._upsertQueryStmt = this._db.prepare<
      [string, string, string, string | null, number, number, number]
    >(`
      INSERT INTO ucsa_query_cache (
        query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(query_hash) DO UPDATE SET
        query_key = excluded.query_key,
        data_payload = excluded.data_payload,
        etag = excluded.etag,
        created_at = excluded.created_at,
        stale_at = excluded.stale_at,
        expires_at = excluded.expires_at;
    `);

    this._getQueryStmt = this._db.prepare<[string]>(`
      SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
      FROM ucsa_query_cache
      WHERE query_hash = ?;
    `);

    this._deleteQueryStmt = this._db.prepare<[string]>(`
      DELETE FROM ucsa_query_cache WHERE query_hash = ?;
    `);

    this._getExpiredQueriesStmt = this._db.prepare<[number]>(`
      SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at
      FROM ucsa_query_cache
      WHERE expires_at <= ?;
    `);
  }

  /**
   * Persists or updates a query entry in SQLite and synchronizes tag mappings.
   */
  setQuery<T>(entry: CacheEntry<T>, tags?: string[]): void {
    const serializedKey = JSON.stringify(entry.query_key);
    const serializedPayload = JSON.stringify(entry.data_payload);
    const etag = entry.etag ?? null;

    if (tags !== undefined) {
      const setWithTags = this._db.transaction(() => {
        this._upsertQueryStmt.run(
          entry.query_hash,
          serializedKey,
          serializedPayload,
          etag,
          entry.created_at,
          entry.stale_at,
          entry.expires_at
        );
        deleteTagsForQuery(this._db, entry.query_hash);
        if (tags.length > 0) {
          insertTags(this._db, entry.query_hash, tags);
        }
      });
      setWithTags();
    } else {
      this._upsertQueryStmt.run(
        entry.query_hash,
        serializedKey,
        serializedPayload,
        etag,
        entry.created_at,
        entry.stale_at,
        entry.expires_at
      );
    }
  }

  /**
   * Retrieves and deserializes a cached query entry by hash.
   */
  getQuery<T>(queryHash: string): CacheEntry<T> | null {
    const row = this._getQueryStmt.get(queryHash) as QueryCacheRow | undefined;
    if (!row) return null;

    return {
      query_hash: row.query_hash,
      query_key: JSON.parse(row.query_key) as QueryKey,
      data_payload: JSON.parse(row.data_payload) as T,
      etag: row.etag ?? undefined,
      created_at: row.created_at,
      stale_at: row.stale_at,
      expires_at: row.expires_at,
    };
  }

  /**
   * Deletes a cached query entry by hash.
   * Cascade delete will automatically clean up all associated tags in ucsa_cache_tags.
   */
  deleteQuery(queryHash: string): void {
    this._deleteQueryStmt.run(queryHash);
  }

  /**
   * Invalidates all queries associated with the given tag.
   * Returns the list of query hashes that were invalidated.
   */
  invalidateByTag(tag: string): string[] {
    const hashes = getQueryHashesByTag(this._db, tag);
    if (hashes.length === 0) return [];

    const deleteBatch = this._db.transaction((hashList: string[]) => {
      for (const hash of hashList) {
        this._deleteQueryStmt.run(hash);
      }
    });

    deleteBatch(hashes);
    return hashes;
  }

  /**
   * Queries all query hashes associated with a tag without invalidating them.
   */
  getQueryHashesByTag(tag: string): string[] {
    return getQueryHashesByTag(this._db, tag);
  }

  /**
   * Returns all query entries whose expires_at timestamp is <= the specified cutoff (defaults to Date.now()).
   */
  getExpiredQueries(now: number = Date.now()): CacheEntry<unknown>[] {
    const rows = this._getExpiredQueriesStmt.all(now) as QueryCacheRow[];
    return rows.map((row) => ({
      query_hash: row.query_hash,
      query_key: JSON.parse(row.query_key) as QueryKey,
      data_payload: JSON.parse(row.data_payload),
      etag: row.etag ?? undefined,
      created_at: row.created_at,
      stale_at: row.stale_at,
      expires_at: row.expires_at,
    }));
  }

  /**
   * Retrieves a CAS object record from SQLite by hash.
   */
  getCasObject(hash: string): CasObjectRecord | null {
    return getCasObject(this._db, hash);
  }

  /**
   * Records or updates a CAS object entry in SQLite with size and access timestamp.
   */
  upsertCasObject(
    hash: string,
    size: number,
    lastAccessedAt: number = Date.now()
  ): void {
    upsertCasObject(this._db, hash, size, lastAccessedAt);
  }

  /**
   * Updates last_accessed_at timestamp for a CAS object.
   */
  updateCasAccessTime(
    hash: string,
    lastAccessedAt: number = Date.now()
  ): boolean {
    return updateCasAccessTime(this._db, hash, lastAccessedAt);
  }

  /**
   * Deletes a CAS object record from SQLite.
   */
  deleteCasObject(hash: string): boolean {
    return deleteCasObject(this._db, hash);
  }

  /**
   * Returns total size in bytes of all CAS objects tracked in SQLite.
   */
  getTotalCasSize(): number {
    return getTotalCasSize(this._db);
  }

  /**
   * Returns LRU-ordered CAS objects (least recently accessed first).
   */
  getLruCasObjects(limit?: number): CasObjectRecord[] {
    return getLruCasObjects(this._db, limit);
  }

  /**
   * Executes a WAL checkpoint on the database.
   * In WAL mode, writes pending WAL frames back to the database file.
   * Mode defaults to 'TRUNCATE' to truncate the WAL file to zero bytes.
   */
  checkpoint(mode: SqliteCheckpointMode = 'TRUNCATE'): void {
    if (!this._isClosed) {
      this._db.pragma(`wal_checkpoint(${mode})`);
    }
  }

  /**
   * Closes the underlying database connection.
   */
  close(): void {
    if (!this._isClosed) {
      this._db.close();
      this._isClosed = true;
    }
  }
}
