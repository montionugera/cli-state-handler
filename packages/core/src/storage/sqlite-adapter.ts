import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CacheEntry, QueryKey } from '../types.js';
import { hashQueryKey } from '../query/key-hasher.js';
import type { CasStore } from './cas-store.js';
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
import { MigrationRunner, TARGET_SCHEMA_VERSION } from './migration-runner.js';

export type StreamStatus = 'open' | 'complete' | 'aborted' | 'error';
export type StreamEncoding = 'utf8' | 'bytes';
export type ResumeKind = 'range' | 'last-event-id' | 'continuation' | 'restart';

export interface StreamRecord {
  queryHash: string;
  queryKey: QueryKey;
  status: StreamStatus;
  encoding: StreamEncoding;
  nextSeq: number;
  byteLength: number;
  resumeKind: ResumeKind | null;
  resumeToken: string | null;
  etag: string | null;
  writerId: string | null;
  writerLeaseUntil: number | null;
  payloadVersion: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface StreamChunk {
  queryHash: string;
  seq: number;
  byteOffset: number;
  data: Buffer;
}

export interface CreateStreamOptions {
  encoding?: StreamEncoding;
  resumeKind?: ResumeKind;
  resumeToken?: string;
  etag?: string;
  writerId?: string;
  writerLeaseUntil?: number;
  payloadVersion?: number;
  ttlMs?: number;
  tags?: string[];
}

export type ChangeLogKind = 'invalidate' | 'mutation' | 'stream' | 'reset';

export interface ChangeLogRow {
  seq: number;
  origin: string;
  kind: ChangeLogKind;
  tags: string[] | null;
  query_hashes: string[] | null;
  detail: Record<string, unknown> | null;
  created_at: number;
}

export interface ReadChangesResult {
  rows: ChangeLogRow[];
  truncated: boolean;
  headSeq: number;
}

export interface SqliteAdapterOptions {
  journalMode?: 'WAL' | 'MEMORY' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'OFF';
  busyTimeout?: number;
  targetSchemaVersion?: number;
  origin?: string;
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
  payload_version?: number;
}

export class SqliteAdapter {
  private readonly _db: Database.Database;
  private readonly _origin: string;
  private _isClosed = false;

  private _upsertQueryStmt!: Database.Statement<
    [string, string, string, string | null, number, number, number, number]
  >;
  private _getQueryStmt!: Database.Statement<[string]>;
  private _deleteQueryStmt!: Database.Statement<[string]>;
  private _updateQueryPayloadStmt!: Database.Statement<[string, number, string]>;
  private _getExpiredQueriesStmt!: Database.Statement<[number]>;

  private _insertChangeLogStmt?: Database.Statement<
    [string, string, string | null, string | null, string | null, number]
  >;
  private _readChangesStmt?: Database.Statement<[number, number]>;
  private _getMaxSeqStmt?: Database.Statement;
  private _getMinSeqStmt?: Database.Statement;

  private _insertStreamStmt?: Database.Statement<
    [
      string,
      string,
      string,
      string,
      number,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      number,
      string | null,
      number,
      number,
      number,
    ]
  >;
  private _insertStreamTagStmt?: Database.Statement<[string, string]>;
  private _getStreamStmt?: Database.Statement<[string]>;
  private _getStreamRawStmt?: Database.Statement<[string]>;
  private _insertStreamChunkStmt?: Database.Statement<
    [string, number, number, Buffer]
  >;
  private _updateStreamAppendStmt?: Database.Statement<[number, number, string]>;
  private _getStreamChunksStmt?: Database.Statement<[string, number]>;
  private _getStreamTagsStmt?: Database.Statement<[string]>;
  private _abortStreamStmt?: Database.Statement<[string | null, number, string]>;
  private _deleteStreamStmt?: Database.Statement<[string]>;
  private _deleteStreamChunksStmt?: Database.Statement<[string]>;
  private _resetStreamStmt?: Database.Statement<[number, string]>;
  private _updateStreamResumeTokenStmt?: Database.Statement<[string, number, string]>;
  private _updateStreamResumeTokenWithKindStmt?: Database.Statement<
    [string, string, number, string]
  >;

  constructor(dbPath: string = ':memory:', options?: SqliteAdapterOptions) {
    this._db = new Database(dbPath);
    this._origin = options?.origin ?? randomUUID();

    // Enforce foreign key constraints for cascade deletions
    this._db.pragma('foreign_keys = ON');

    // Concurrency: 5000ms busy timeout default
    const timeout = options?.busyTimeout ?? 5000;
    this._db.pragma(`busy_timeout = ${timeout}`);

    // Journaling: WAL default on native, MEMORY on in-memory / web
    const journal = options?.journalMode ?? (dbPath === ':memory:' ? 'MEMORY' : 'WAL');
    this._db.pragma(`journal_mode = ${journal}`);
    this._db.pragma('synchronous = NORMAL');

    this.initSchema(options?.targetSchemaVersion);
  }

  /**
   * Returns this adapter's unique origin identifier.
   */
  get origin(): string {
    return this._origin;
  }

  /**
   * Returns the underlying better-sqlite3 database instance.
   */
  get db(): Database.Database {
    return this._db;
  }

  /**
   * Returns current user_version from SQLite schema.
   */
  getSchemaVersion(): number {
    return MigrationRunner.getUserVersion(this._db);
  }

  private get insertChangeLogStmt(): Database.Statement<
    [string, string, string | null, string | null, string | null, number]
  > {
    if (!this._insertChangeLogStmt) {
      this._insertChangeLogStmt = this._db.prepare<
        [string, string, string | null, string | null, string | null, number]
      >(`
        INSERT INTO ucsa_change_log (
          origin, kind, tags, query_hashes, detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?);
      `);
    }
    return this._insertChangeLogStmt;
  }

  private get readChangesStmt(): Database.Statement<[number, number]> {
    if (!this._readChangesStmt) {
      this._readChangesStmt = this._db.prepare<[number, number]>(`
        SELECT seq, origin, kind, tags, query_hashes, detail, created_at
        FROM ucsa_change_log
        WHERE seq > ?
        ORDER BY seq ASC
        LIMIT ?;
      `);
    }
    return this._readChangesStmt;
  }

  private get getMaxSeqStmt(): Database.Statement {
    if (!this._getMaxSeqStmt) {
      this._getMaxSeqStmt = this._db.prepare(`
        SELECT MAX(seq) as max_seq FROM ucsa_change_log;
      `);
    }
    return this._getMaxSeqStmt;
  }

  private get getMinSeqStmt(): Database.Statement {
    if (!this._getMinSeqStmt) {
      this._getMinSeqStmt = this._db.prepare(`
        SELECT MIN(seq) as min_seq FROM ucsa_change_log;
      `);
    }
    return this._getMinSeqStmt;
  }

  private get insertStreamStmt(): Database.Statement<
    [
      string,
      string,
      string,
      string,
      number,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      number | null,
      number,
      string | null,
      number,
      number,
      number,
    ]
  > {
    if (!this._insertStreamStmt) {
      this._insertStreamStmt = this._db.prepare<
        [
          string,
          string,
          string,
          string,
          number,
          number,
          string | null,
          string | null,
          string | null,
          string | null,
          number | null,
          number,
          string | null,
          number,
          number,
          number,
        ]
      >(`
        INSERT INTO ucsa_streams (
          query_hash, query_key, status, encoding, next_seq, byte_length,
          resume_kind, resume_token, etag, writer_id, writer_lease_until,
          payload_version, error, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `);
    }
    return this._insertStreamStmt;
  }

  private get insertStreamTagStmt(): Database.Statement<[string, string]> {
    if (!this._insertStreamTagStmt) {
      this._insertStreamTagStmt = this._db.prepare<[string, string]>(`
        INSERT OR IGNORE INTO ucsa_stream_tags (tag, query_hash) VALUES (?, ?);
      `);
    }
    return this._insertStreamTagStmt;
  }

  private get getStreamStmt(): Database.Statement<[string]> {
    if (!this._getStreamStmt) {
      this._getStreamStmt = this._db.prepare<[string]>(`
        SELECT
          query_hash, query_key, status, encoding, next_seq, byte_length,
          resume_kind, resume_token, etag, writer_id, writer_lease_until,
          payload_version, error, created_at, updated_at, expires_at
        FROM ucsa_streams
        WHERE query_hash = ?;
      `);
    }
    return this._getStreamStmt;
  }

  private get getStreamRawStmt(): Database.Statement<[string]> {
    if (!this._getStreamRawStmt) {
      this._getStreamRawStmt = this._db.prepare<[string]>(`
        SELECT status, next_seq, byte_length
        FROM ucsa_streams
        WHERE query_hash = ?;
      `);
    }
    return this._getStreamRawStmt;
  }

  private get insertStreamChunkStmt(): Database.Statement<
    [string, number, number, Buffer]
  > {
    if (!this._insertStreamChunkStmt) {
      this._insertStreamChunkStmt = this._db.prepare<
        [string, number, number, Buffer]
      >(`
        INSERT INTO ucsa_stream_chunks (query_hash, seq, byte_offset, data)
        VALUES (?, ?, ?, ?);
      `);
    }
    return this._insertStreamChunkStmt;
  }

  private get updateStreamAppendStmt(): Database.Statement<[number, number, string]> {
    if (!this._updateStreamAppendStmt) {
      this._updateStreamAppendStmt = this._db.prepare<[number, number, string]>(`
        UPDATE ucsa_streams
        SET next_seq = next_seq + 1, byte_length = byte_length + ?, updated_at = ?
        WHERE query_hash = ?;
      `);
    }
    return this._updateStreamAppendStmt;
  }

  private get getStreamChunksStmt(): Database.Statement<[string, number]> {
    if (!this._getStreamChunksStmt) {
      this._getStreamChunksStmt = this._db.prepare<[string, number]>(`
        SELECT query_hash, seq, byte_offset, data
        FROM ucsa_stream_chunks
        WHERE query_hash = ? AND seq >= ?
        ORDER BY seq ASC;
      `);
    }
    return this._getStreamChunksStmt;
  }

  private get getStreamTagsStmt(): Database.Statement<[string]> {
    if (!this._getStreamTagsStmt) {
      this._getStreamTagsStmt = this._db.prepare<[string]>(`
        SELECT tag FROM ucsa_stream_tags WHERE query_hash = ?;
      `);
    }
    return this._getStreamTagsStmt;
  }

  private get abortStreamStmt(): Database.Statement<[string | null, number, string]> {
    if (!this._abortStreamStmt) {
      this._abortStreamStmt = this._db.prepare<[string | null, number, string]>(`
        UPDATE ucsa_streams
        SET status = 'aborted', error = ?, updated_at = ?
        WHERE query_hash = ?;
      `);
    }
    return this._abortStreamStmt;
  }

  private get deleteStreamStmt(): Database.Statement<[string]> {
    if (!this._deleteStreamStmt) {
      this._deleteStreamStmt = this._db.prepare<[string]>(`
        DELETE FROM ucsa_streams WHERE query_hash = ?;
      `);
    }
    return this._deleteStreamStmt;
  }

  private get deleteStreamChunksStmt(): Database.Statement<[string]> {
    if (!this._deleteStreamChunksStmt) {
      this._deleteStreamChunksStmt = this._db.prepare<[string]>(`
        DELETE FROM ucsa_stream_chunks WHERE query_hash = ?;
      `);
    }
    return this._deleteStreamChunksStmt;
  }

  private get resetStreamStmt(): Database.Statement<[number, string]> {
    if (!this._resetStreamStmt) {
      this._resetStreamStmt = this._db.prepare<[number, string]>(`
        UPDATE ucsa_streams
        SET next_seq = 0, byte_length = 0, status = 'open', error = NULL, updated_at = ?
        WHERE query_hash = ?;
      `);
    }
    return this._resetStreamStmt;
  }

  private get updateStreamResumeTokenStmt(): Database.Statement<
    [string, number, string]
  > {
    if (!this._updateStreamResumeTokenStmt) {
      this._updateStreamResumeTokenStmt = this._db.prepare<
        [string, number, string]
      >(`
        UPDATE ucsa_streams
        SET resume_token = ?, updated_at = ?
        WHERE query_hash = ?;
      `);
    }
    return this._updateStreamResumeTokenStmt;
  }

  private get updateStreamResumeTokenWithKindStmt(): Database.Statement<
    [string, string, number, string]
  > {
    if (!this._updateStreamResumeTokenWithKindStmt) {
      this._updateStreamResumeTokenWithKindStmt = this._db.prepare<
        [string, string, number, string]
      >(`
        UPDATE ucsa_streams
        SET resume_token = ?, resume_kind = ?, updated_at = ?
        WHERE query_hash = ?;
      `);
    }
    return this._updateStreamResumeTokenWithKindStmt;
  }

  /**
   * Initializes tables and indexes by running migrations.
   * Compiles and caches prepared statements.
   */
  initSchema(targetVersion?: number): void {
    MigrationRunner.migrate(this._db, targetVersion ?? TARGET_SCHEMA_VERSION);

    this._upsertQueryStmt = this._db.prepare<
      [string, string, string, string | null, number, number, number, number]
    >(`
      INSERT INTO ucsa_query_cache (
        query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(query_hash) DO UPDATE SET
        query_key = excluded.query_key,
        data_payload = excluded.data_payload,
        etag = excluded.etag,
        created_at = excluded.created_at,
        stale_at = excluded.stale_at,
        expires_at = excluded.expires_at,
        payload_version = excluded.payload_version;
    `);

    this._getQueryStmt = this._db.prepare<[string]>(`
      SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
      FROM ucsa_query_cache
      WHERE query_hash = ?;
    `);

    this._deleteQueryStmt = this._db.prepare<[string]>(`
      DELETE FROM ucsa_query_cache WHERE query_hash = ?;
    `);

    this._updateQueryPayloadStmt = this._db.prepare<[string, number, string]>(`
      UPDATE ucsa_query_cache
      SET data_payload = ?, payload_version = ?
      WHERE query_hash = ?;
    `);

    this._getExpiredQueriesStmt = this._db.prepare<[number]>(`
      SELECT query_hash, query_key, data_payload, etag, created_at, stale_at, expires_at, payload_version
      FROM ucsa_query_cache
      WHERE expires_at <= ?;
    `);

    if (this.getSchemaVersion() >= 3) {
      this._insertChangeLogStmt = this._db.prepare<
        [string, string, string | null, string | null, string | null, number]
      >(`
        INSERT INTO ucsa_change_log (
          origin, kind, tags, query_hashes, detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?);
      `);

      this._readChangesStmt = this._db.prepare<[number, number]>(`
        SELECT seq, origin, kind, tags, query_hashes, detail, created_at
        FROM ucsa_change_log
        WHERE seq > ?
        ORDER BY seq ASC
        LIMIT ?;
      `);

      this._getMaxSeqStmt = this._db.prepare(`
        SELECT MAX(seq) as max_seq FROM ucsa_change_log;
      `);

      this._getMinSeqStmt = this._db.prepare(`
        SELECT MIN(seq) as min_seq FROM ucsa_change_log;
      `);
    }
  }

  /**
   * Persists or updates a query entry in SQLite and synchronizes tag mappings.
   */
  setQuery<T>(entry: CacheEntry<T>, tags?: string[]): void {
    const serializedKey = JSON.stringify(entry.query_key);
    const serializedPayload = JSON.stringify(entry.data_payload);
    const etag = entry.etag ?? null;
    const payloadVersion = entry.payload_version ?? 1;

    if (tags !== undefined) {
      const setWithTags = this._db.transaction(() => {
        this._upsertQueryStmt.run(
          entry.query_hash,
          serializedKey,
          serializedPayload,
          etag,
          entry.created_at,
          entry.stale_at,
          entry.expires_at,
          payloadVersion
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
        entry.expires_at,
        payloadVersion
      );
    }
  }

  /**
   * Updates only the data payload and payload version for an existing query entry in SQLite.
   */
  updateQueryPayload(
    queryHash: string,
    dataPayload: unknown,
    payloadVersion: number
  ): void {
    const serializedPayload = JSON.stringify(dataPayload);
    this._updateQueryPayloadStmt.run(serializedPayload, payloadVersion, queryHash);
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
      payload_version: row.payload_version ?? 1,
    };
  }

  /**
   * Appends an entry to ucsa_change_log and returns the generated seq number.
   */
  appendChangeLog(
    kind: ChangeLogKind,
    options?: {
      origin?: string;
      tags?: string[];
      queryHashes?: string[];
      detail?: Record<string, unknown>;
    }
  ): number {
    const origin = options?.origin ?? this._origin;
    const tags = options?.tags !== undefined ? JSON.stringify(options.tags) : null;
    const queryHashes =
      options?.queryHashes !== undefined ? JSON.stringify(options.queryHashes) : null;
    const detail =
      options?.detail !== undefined ? JSON.stringify(options.detail) : null;
    const createdAt = Date.now();

    const info = this.insertChangeLogStmt.run(
      origin,
      kind,
      tags,
      queryHashes,
      detail,
      createdAt
    );

    return Number(info.lastInsertRowid);
  }

  /**
   * Deletes a cached query entry by hash.
   * Cascade delete will automatically clean up all associated tags in ucsa_cache_tags.
   * If schema version >= 3, atomically journals an invalidate change log entry.
   * Returns true if a row was deleted.
   */
  deleteQuery(queryHash: string, origin?: string): boolean {
    const runTx = this._db.transaction(() => {
      const info = this._deleteQueryStmt.run(queryHash);
      const wasDeleted = info.changes > 0;
      if (wasDeleted && this.getSchemaVersion() >= 3) {
        this.appendChangeLog('invalidate', {
          origin: origin ?? this._origin,
          queryHashes: [queryHash],
        });
      }
      return wasDeleted;
    });

    return runTx();
  }

  /**
   * Invalidates all queries associated with the given tag.
   * Inside a transaction: queries affected query_hashes matching tag from ucsa_cache_tags,
   * deletes them from ucsa_query_cache, and inserts a single change log row with
   * kind: 'invalidate', tags: [tag], queryHashes: affectedHashes.
   * Returns the list of query hashes that were invalidated.
   */
  invalidateByTag(tag: string, origin?: string): string[] {
    const runTx = this._db.transaction(() => {
      const affectedHashes = getQueryHashesByTag(this._db, tag);
      for (const hash of affectedHashes) {
        this._deleteQueryStmt.run(hash);
      }
      if (this.getSchemaVersion() >= 3) {
        this.appendChangeLog('invalidate', {
          origin: origin ?? this._origin,
          tags: [tag],
          queryHashes: affectedHashes,
        });
      }
      return affectedHashes;
    });

    return runTx();
  }

  /**
   * Reads change log entries created since lastSeq in ascending sequence order up to limit.
   * Detects gaps caused by pruning (truncated: true).
   */
  readChangesSince(lastSeq: number, limit = 1000): ReadChangesResult {
    const maxRow = this.getMaxSeqStmt.get() as { max_seq: number | null } | undefined;
    const headSeq = maxRow?.max_seq ?? 0;

    const minRow = this.getMinSeqStmt.get() as { min_seq: number | null } | undefined;
    const minSeq = minRow?.min_seq ?? null;

    let truncated = false;
    if (lastSeq > 0 && minSeq !== null && lastSeq < minSeq - 1) {
      truncated = true;
    }

    interface RawChangeLogRow {
      seq: number;
      origin: string;
      kind: ChangeLogKind;
      tags: string | null;
      query_hashes: string | null;
      detail: string | null;
      created_at: number;
    }

    const rawRows = this.readChangesStmt.all(lastSeq, limit) as RawChangeLogRow[];

    const rows: ChangeLogRow[] = rawRows.map((row) => ({
      seq: row.seq,
      origin: row.origin,
      kind: row.kind,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      query_hashes: row.query_hashes
        ? (JSON.parse(row.query_hashes) as string[])
        : null,
      detail: row.detail
        ? (JSON.parse(row.detail) as Record<string, unknown>)
        : null,
      created_at: row.created_at,
    }));

    return {
      rows,
      truncated,
      headSeq,
    };
  }

  /**
   * Prunes old change log entries beyond retention window (retentionMs)
   * or beyond maxRows ceiling (retaining newest maxRows).
   */
  pruneChangeLog(
    retentionMs = 86400000,
    maxRows = 10000
  ): { prunedCount: number } {
    const cutoff = Date.now() - retentionMs;

    const runPrune = this._db.transaction(() => {
      let seqThreshold: number | null = null;
      if (maxRows > 0) {
        const row = this._db
          .prepare<[number]>(
            `SELECT seq FROM ucsa_change_log ORDER BY seq DESC LIMIT 1 OFFSET ?`
          )
          .get(maxRows) as { seq: number } | undefined;
        if (row) {
          seqThreshold = row.seq;
        }
      }

      let result: Database.RunResult;
      if (seqThreshold !== null) {
        result = this._db
          .prepare<[number, number]>(
            `DELETE FROM ucsa_change_log WHERE created_at < ? OR seq <= ?;`
          )
          .run(cutoff, seqThreshold);
      } else {
        result = this._db
          .prepare<[number]>(`DELETE FROM ucsa_change_log WHERE created_at < ?;`)
          .run(cutoff);
      }

      return { prunedCount: result.changes };
    });

    return runPrune();
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
      payload_version: row.payload_version ?? 1,
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
   * Creates a new stream record and persists tags to ucsa_stream_tags.
   */
  createStream(queryKey: QueryKey, options?: CreateStreamOptions): StreamRecord {
    const queryHash = hashQueryKey(queryKey);
    const now = Date.now();
    const status: StreamStatus = 'open';
    const encoding: StreamEncoding = options?.encoding ?? 'utf8';
    const nextSeq = 0;
    const byteLength = 0;
    const resumeKind: ResumeKind | null = options?.resumeKind ?? null;
    const resumeToken: string | null = options?.resumeToken ?? null;
    const etag: string | null = options?.etag ?? null;
    const writerId: string | null = options?.writerId ?? null;
    const writerLeaseUntil: number | null = options?.writerLeaseUntil ?? null;
    const payloadVersion = options?.payloadVersion ?? 1;
    const error: string | null = null;
    const createdAt = now;
    const updatedAt = now;
    const ttlMs = options?.ttlMs ?? 300_000;
    const expiresAt = now + ttlMs;

    const serializedKey = JSON.stringify(queryKey);

    const runTx = this._db.transaction(() => {
      this.insertStreamStmt.run(
        queryHash,
        serializedKey,
        status,
        encoding,
        nextSeq,
        byteLength,
        resumeKind,
        resumeToken,
        etag,
        writerId,
        writerLeaseUntil,
        payloadVersion,
        error,
        createdAt,
        updatedAt,
        expiresAt
      );

      if (options?.tags && options.tags.length > 0) {
        for (const tag of options.tags) {
          this.insertStreamTagStmt.run(tag, queryHash);
        }
      }
    });

    runTx();

    return {
      queryHash,
      queryKey,
      status,
      encoding,
      nextSeq,
      byteLength,
      resumeKind,
      resumeToken,
      etag,
      writerId,
      writerLeaseUntil,
      payloadVersion,
      error,
      createdAt,
      updatedAt,
      expiresAt,
    };
  }

  /**
   * Appends a chunk to the stream, validating sequence number and offset contiguity.
   * Updates stream next_seq and byte_length.
   */
  appendStreamChunk(
    queryHash: string,
    data: Buffer | Uint8Array | string,
    expectedSeq?: number
  ): { seq: number; byteOffset: number; byteLength: number } {
    const buffer = Buffer.isBuffer(data)
      ? data
      : typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    const runTx = this._db.transaction(() => {
      const rawRow = this.getStreamRawStmt.get(queryHash) as
        | { status: string; next_seq: number; byte_length: number }
        | undefined;

      if (!rawRow) {
        throw new Error(`Stream not found: ${queryHash}`);
      }

      if (rawRow.status !== 'open') {
        throw new Error(`Stream is not open (status: ${rawRow.status})`);
      }

      if (expectedSeq !== undefined && expectedSeq !== rawRow.next_seq) {
        throw new Error(
          `Sequence mismatch: expected ${expectedSeq}, but next sequence is ${rawRow.next_seq}`
        );
      }

      const seq = rawRow.next_seq;
      const byteOffset = rawRow.byte_length;
      const byteLength = buffer.length;
      const now = Date.now();

      this.insertStreamChunkStmt.run(queryHash, seq, byteOffset, buffer);
      this.updateStreamAppendStmt.run(byteLength, now, queryHash);

      return { seq, byteOffset, byteLength };
    });

    return runTx();
  }

  /**
   * Retrieves a stream record by its query hash.
   */
  getStream(queryHash: string): StreamRecord | undefined {
    interface RawStreamRow {
      query_hash: string;
      query_key: string;
      status: string;
      encoding: string;
      next_seq: number;
      byte_length: number;
      resume_kind: string | null;
      resume_token: string | null;
      etag: string | null;
      writer_id: string | null;
      writer_lease_until: number | null;
      payload_version: number;
      error: string | null;
      created_at: number;
      updated_at: number;
      expires_at: number;
    }

    const row = this.getStreamStmt.get(queryHash) as RawStreamRow | undefined;
    if (!row) return undefined;

    return {
      queryHash: row.query_hash,
      queryKey: JSON.parse(row.query_key) as QueryKey,
      status: row.status as StreamStatus,
      encoding: row.encoding as StreamEncoding,
      nextSeq: row.next_seq,
      byteLength: row.byte_length,
      resumeKind: (row.resume_kind as ResumeKind) ?? null,
      resumeToken: row.resume_token ?? null,
      etag: row.etag ?? null,
      writerId: row.writer_id ?? null,
      writerLeaseUntil: row.writer_lease_until ?? null,
      payloadVersion: row.payload_version ?? 1,
      error: row.error ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Retrieves sequential stream chunks starting from fromSeq.
   */
  getStreamChunks(queryHash: string, fromSeq = 0): StreamChunk[] {
    interface RawChunkRow {
      query_hash: string;
      seq: number;
      byte_offset: number;
      data: Buffer | Uint8Array;
    }

    const rows = this.getStreamChunksStmt.all(queryHash, fromSeq) as RawChunkRow[];
    return rows.map((r) => ({
      queryHash: r.query_hash,
      seq: r.seq,
      byteOffset: r.byte_offset,
      data: Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data),
    }));
  }

  /**
   * Compacts all chunks of a stream atomically into query cache (or CAS store if exceeding casThresholdBytes).
   * Moves stream tags to ucsa_cache_tags and purges stream row and chunks via cascade.
   */
  async compactStream(
    queryHash: string,
    casStore?: CasStore,
    casThresholdBytes = 1_048_576
  ): Promise<CacheEntry<unknown>> {
    const stream = this.getStream(queryHash);
    if (!stream) {
      throw new Error(`Stream not found: ${queryHash}`);
    }

    const chunks = this.getStreamChunks(queryHash, 0);
    const totalBuffer = Buffer.concat(chunks.map((c) => c.data));

    let payload: unknown;

    if (casStore && totalBuffer.length > casThresholdBytes) {
      const casResult = await casStore.put(totalBuffer);
      payload = {
        __cas_ref: true,
        hash: casResult.hash,
        size: casResult.size,
      };
    } else {
      if (stream.encoding === 'utf8') {
        const text = totalBuffer.toString('utf8');
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      } else {
        payload = totalBuffer;
      }
    }

    const tagRows = this.getStreamTagsStmt.all(queryHash) as Array<{ tag: string }>;
    const tags = tagRows.map((r) => r.tag);

    const cacheEntry: CacheEntry<unknown> = {
      query_hash: stream.queryHash,
      query_key: stream.queryKey,
      data_payload: payload,
      etag: stream.etag ?? undefined,
      created_at: stream.createdAt,
      stale_at: stream.createdAt + 60_000,
      expires_at: stream.expiresAt,
      payload_version: stream.payloadVersion,
    };

    const runTx = this._db.transaction(() => {
      this.setQuery(cacheEntry, tags.length > 0 ? tags : undefined);
      this.deleteStreamStmt.run(queryHash);
    });

    runTx();

    return cacheEntry;
  }

  /**
   * Aborts an active stream and records optional error.
   */
  abortStream(queryHash: string, error?: string): void {
    this.abortStreamStmt.run(error ?? null, Date.now(), queryHash);
  }

  /**
   * Resets a stream by deleting all chunks and resetting sequence counter, byte length, and status.
   * Atomically resets next_seq = 0, byte_length = 0, status = 'open', error = NULL.
   */
  resetStream(queryHash: string): void {
    const runTx = this._db.transaction(() => {
      this.deleteStreamChunksStmt.run(queryHash);
      this.resetStreamStmt.run(Date.now(), queryHash);
    });
    runTx();
  }

  /**
   * Updates the resume token (and optional resume kind) for an active or completed stream.
   */
  updateStreamResumeToken(
    queryHash: string,
    resumeToken: string,
    resumeKind?: ResumeKind
  ): void {
    const now = Date.now();
    if (resumeKind !== undefined) {
      this.updateStreamResumeTokenWithKindStmt.run(
        resumeToken,
        resumeKind,
        now,
        queryHash
      );
    } else {
      this.updateStreamResumeTokenStmt.run(resumeToken, now, queryHash);
    }
  }

  /**
   * Executes a WAL checkpoint on the database.
   * In WAL mode, writes pending WAL frames back to the database file.
   * Mode defaults to 'TRUNCATE' to truncate the WAL file to zero bytes.
   * If mode is 'TRUNCATE' and SQLite encounters a busy condition (e.g. concurrent readers),
   * gracefully falls back to 'PASSIVE' checkpointing to prevent unhandled exceptions during exit.
   */
  checkpoint(mode: SqliteCheckpointMode = 'TRUNCATE'): void {
    if (!this._isClosed) {
      try {
        const result = this._db.pragma(`wal_checkpoint(${mode})`) as
          | Array<{ busy: number; log: number; checkpointed: number }>
          | undefined;

        if (
          mode === 'TRUNCATE' &&
          Array.isArray(result) &&
          result.length > 0 &&
          result[0].busy === 1
        ) {
          try {
            this._db.pragma('wal_checkpoint(PASSIVE)');
          } catch {
            // Ignore secondary error during passive fallback
          }
        }
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        const isBusy =
          error?.code === 'SQLITE_BUSY' ||
          (typeof error?.message === 'string' &&
            error.message.toLowerCase().includes('busy'));

        if (mode === 'TRUNCATE' && isBusy) {
          try {
            this._db.pragma('wal_checkpoint(PASSIVE)');
          } catch {
            // Gracefully ignore secondary error during passive fallback
          }
        } else {
          throw err;
        }
      }
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
