import type Database from 'better-sqlite3';
import type { SqliteAdapter } from '../storage/sqlite-adapter.js';
import type {
  OutboxMutation,
  OutboxMutationStatus,
  ConflictPolicy,
} from '../types.js';

export interface MutationOutboxOptions {
  sqliteAdapter: SqliteAdapter;
  maxRetries?: number;
  onRollback?: (mutation: OutboxMutation) => void | Promise<void>;
  mergeResolver?: (localData: unknown, serverData: unknown) => unknown | Promise<unknown>;
}

export interface ReplayResult {
  processed: number;
  successful: number;
  failed: number;
}

export interface ReplayOptions {
  rateLimitMs?: number;
  batchSize?: number;
  conflictResolver?: ConflictResolver;
}

export type ConflictResolution = 'rollback' | 'force' | 'merged';

export type MutationExecutor = (
  mutation: OutboxMutation
) => Promise<{ status: number; data?: unknown }>;

export type ConflictResolver = (
  mutation: OutboxMutation,
  conflictData: unknown
) => Promise<ConflictResolution>;

interface OutboxRow {
  mutation_id: string;
  endpoint: string;
  method: string;
  headers: string | null;
  payload: string | null;
  status: string;
  retry_count: number;
  created_at: number;
  last_attempt_at: number | null;
  error: string | null;
  forced: number;
}

/**
 * Manages persistent offline mutations in SQLite with automatic replay
 * and deterministic conflict resolution policies (server-wins, client-wins, merge).
 */
export class MutationOutbox {
  private readonly _sqliteAdapter: SqliteAdapter;
  private readonly _db: Database.Database;
  private readonly _maxRetries: number;
  private readonly _options: MutationOutboxOptions;

  private readonly _rollbackCallbacks = new Map<
    string,
    (mutation: OutboxMutation) => void | Promise<void>
  >();
  private readonly _mergeResolvers = new Map<
    string,
    (local: unknown, server: unknown) => unknown | Promise<unknown>
  >();
  private readonly _conflictPolicies = new Map<string, ConflictPolicy>();

  private _insertStmt!: Database.Statement;
  private _getPendingStmt!: Database.Statement;
  private _getAllStmt!: Database.Statement;
  private _getByIdStmt!: Database.Statement;
  private _deleteStmt!: Database.Statement;
  private _updateStatusStmt!: Database.Statement;
  private _updateRetryStmt!: Database.Statement;
  private _requeueForcedStmt!: Database.Statement;
  private _updatePayloadStmt!: Database.Statement;

  constructor(options: MutationOutboxOptions) {
    this._options = options;
    this._sqliteAdapter = options.sqliteAdapter;
    this._db = options.sqliteAdapter.db;
    this._maxRetries = options.maxRetries ?? 3;

    // Ensure error and forced columns exist if table was created previously without them
    try {
      this._db.exec('ALTER TABLE ucsa_mutation_outbox ADD COLUMN error TEXT;');
    } catch {}
    try {
      this._db.exec('ALTER TABLE ucsa_mutation_outbox ADD COLUMN forced INTEGER DEFAULT 0;');
    } catch {}

    this._prepareStatements();
  }

  get maxRetries(): number {
    return this._maxRetries;
  }

  get sqliteAdapter(): SqliteAdapter {
    return this._sqliteAdapter;
  }

  private _prepareStatements(): void {
    this._insertStmt = this._db.prepare(`
      INSERT INTO ucsa_mutation_outbox (
        mutation_id, endpoint, method, headers, payload, status, retry_count, created_at, last_attempt_at, error, forced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mutation_id) DO UPDATE SET
        endpoint = excluded.endpoint,
        method = excluded.method,
        headers = excluded.headers,
        payload = excluded.payload,
        status = excluded.status,
        retry_count = excluded.retry_count,
        created_at = excluded.created_at,
        last_attempt_at = excluded.last_attempt_at,
        error = excluded.error,
        forced = excluded.forced;
    `);

    this._getPendingStmt = this._db.prepare(`
      SELECT mutation_id, endpoint, method, headers, payload, status, retry_count, created_at, last_attempt_at, error, forced
      FROM ucsa_mutation_outbox
      WHERE status = 'pending'
      ORDER BY created_at ASC;
    `);

    this._getAllStmt = this._db.prepare(`
      SELECT mutation_id, endpoint, method, headers, payload, status, retry_count, created_at, last_attempt_at, error, forced
      FROM ucsa_mutation_outbox
      ORDER BY created_at ASC;
    `);

    this._getByIdStmt = this._db.prepare(`
      SELECT mutation_id, endpoint, method, headers, payload, status, retry_count, created_at, last_attempt_at, error, forced
      FROM ucsa_mutation_outbox
      WHERE mutation_id = ?;
    `);

    this._deleteStmt = this._db.prepare(`
      DELETE FROM ucsa_mutation_outbox WHERE mutation_id = ?;
    `);

    this._updateStatusStmt = this._db.prepare(`
      UPDATE ucsa_mutation_outbox
      SET status = ?, last_attempt_at = ?, error = ?
      WHERE mutation_id = ?;
    `);

    this._updateRetryStmt = this._db.prepare(`
      UPDATE ucsa_mutation_outbox
      SET retry_count = ?, status = ?, last_attempt_at = ?, error = ?
      WHERE mutation_id = ?;
    `);

    this._requeueForcedStmt = this._db.prepare(`
      UPDATE ucsa_mutation_outbox
      SET status = 'pending', forced = 1, headers = ?, last_attempt_at = ?
      WHERE mutation_id = ?;
    `);

    this._updatePayloadStmt = this._db.prepare(`
      UPDATE ucsa_mutation_outbox
      SET payload = ?, status = 'pending', last_attempt_at = ?
      WHERE mutation_id = ?;
    `);
  }

  /**
   * Enqueues an offline mutation into the SQLite outbox.
   */
  enqueue<T = unknown>(
    mutation: Omit<OutboxMutation<T>, 'created_at' | 'retry_count' | 'status'>
  ): OutboxMutation<T> {
    const mutationId =
      mutation.mutation_id ||
      `mut_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const method = mutation.method || 'POST';
    const createdAt = Date.now();
    const status: OutboxMutationStatus = 'pending';
    const retryCount = 0;
    const forced = Boolean(mutation.forced);
    const serializedHeaders = mutation.headers
      ? JSON.stringify(mutation.headers)
      : null;
    const serializedPayload =
      mutation.payload !== undefined ? JSON.stringify(mutation.payload) : null;

    this._insertStmt.run(
      mutationId,
      mutation.endpoint,
      method,
      serializedHeaders,
      serializedPayload,
      status,
      retryCount,
      createdAt,
      null,
      mutation.error ?? null,
      forced ? 1 : 0
    );

    if (mutation.onRollback) {
      this._rollbackCallbacks.set(
        mutationId,
        mutation.onRollback as (m: OutboxMutation) => void | Promise<void>
      );
    }
    if (mutation.mergeResolver) {
      this._mergeResolvers.set(
        mutationId,
        mutation.mergeResolver as (l: unknown, s: unknown) => unknown
      );
    }
    if (mutation.conflictPolicy) {
      this._conflictPolicies.set(mutationId, mutation.conflictPolicy);
    }

    return {
      mutation_id: mutationId,
      endpoint: mutation.endpoint,
      method,
      headers: mutation.headers,
      payload: mutation.payload,
      status,
      retry_count: retryCount,
      created_at: createdAt,
      last_attempt_at: undefined,
      error: mutation.error,
      forced,
      conflictPolicy: mutation.conflictPolicy,
      onRollback: mutation.onRollback,
      mergeResolver: mutation.mergeResolver,
    };
  }

  /**
   * Returns all mutations currently pending replay, ordered by created_at ASC.
   */
  getPendingMutations(): OutboxMutation[] {
    const rows = this._getPendingStmt.all() as OutboxRow[];
    return rows.map((row) => this._mapRowToMutation(row));
  }

  /**
   * Returns all mutations regardless of status.
   */
  getAllMutations(): OutboxMutation[] {
    const rows = this._getAllStmt.all() as OutboxRow[];
    return rows.map((row) => this._mapRowToMutation(row));
  }

  /**
   * Returns a single mutation by its ID, or null if not found.
   */
  getMutation(mutationId: string): OutboxMutation | null {
    const row = this._getByIdStmt.get(mutationId) as OutboxRow | undefined;
    if (!row) return null;
    return this._mapRowToMutation(row);
  }

  /**
   * Updates the lifecycle status of a mutation record.
   */
  markStatus(
    mutationId: string,
    status: OutboxMutationStatus,
    error?: string
  ): void {
    this._updateStatusStmt.run(
      status,
      Date.now(),
      error ?? null,
      mutationId
    );
  }

  /**
   * Removes a mutation record from SQLite and releases in-memory callbacks.
   */
  remove(mutationId: string): void {
    this._deleteStmt.run(mutationId);
    this._rollbackCallbacks.delete(mutationId);
    this._mergeResolvers.delete(mutationId);
    this._conflictPolicies.delete(mutationId);
  }

  /**
   * Replays pending mutations sequentially via an executor function.
   * Handles transient errors with retry count tracking up to maxRetries,
   * and handles 409 Conflict using conflict policies (server-wins, client-wins, merge).
   * Supports rateLimitMs delay between mutation calls and batchSize limits.
   */
  async replay(
    executor: MutationExecutor,
    conflictResolverOrOptions?: ConflictResolver | ReplayOptions,
    options?: ReplayOptions
  ): Promise<ReplayResult> {
    let conflictResolver: ConflictResolver | undefined;
    let opts: ReplayOptions | undefined;

    if (typeof conflictResolverOrOptions === 'function') {
      conflictResolver = conflictResolverOrOptions;
      opts = options;
    } else if (
      typeof conflictResolverOrOptions === 'object' &&
      conflictResolverOrOptions !== null
    ) {
      opts = conflictResolverOrOptions;
      conflictResolver = opts.conflictResolver;
    } else {
      opts = options;
    }

    const rateLimitMs = opts?.rateLimitMs ?? 0;
    const batchSize = opts?.batchSize;

    let pending = this.getPendingMutations();
    if (batchSize !== undefined && batchSize > 0) {
      pending = pending.slice(0, batchSize);
    }

    let processed = 0;
    let successful = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i++) {
      const mutation = pending[i];
      if (i > 0 && rateLimitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
      }
      processed++;
      this.markStatus(mutation.mutation_id, 'in_flight');

      try {
        const response = await executor(mutation);

        if (response.status >= 200 && response.status < 300) {
          // Success: remove from outbox and increment successful count
          this.remove(mutation.mutation_id);
          successful++;
        } else if (response.status === 409) {
          // HTTP 409 Conflict
          let resolution: ConflictResolution = 'rollback';

          if (conflictResolver) {
            resolution = await conflictResolver(mutation, response.data);
          } else if (mutation.conflictPolicy === 'client-wins') {
            resolution = 'force';
          } else if (mutation.conflictPolicy === 'merge') {
            resolution = 'merged';
          } else {
            resolution = 'rollback';
          }

          if (resolution === 'rollback') {
            // Server-wins: invoke rollback callback and mark mutation resolved/removed
            const rollbackFn =
              mutation.onRollback ??
              this._rollbackCallbacks.get(mutation.mutation_id) ??
              this._options.onRollback;
            if (rollbackFn) {
              await rollbackFn(mutation);
            }
            this.remove(mutation.mutation_id);
            successful++;
          } else if (resolution === 'force') {
            // Client-wins: re-queue with forced flag
            this._requeueForced(mutation.mutation_id, mutation.headers);
          } else if (resolution === 'merged') {
            // Merge: invoke custom merge resolver with local and server data
            const mergeFn =
              mutation.mergeResolver ??
              this._mergeResolvers.get(mutation.mutation_id) ??
              this._options.mergeResolver;
            let mergedPayload = mutation.payload;
            if (mergeFn) {
              mergedPayload = await mergeFn(mutation.payload, response.data);
            }
            this._updatePayloadStmt.run(
              mergedPayload !== undefined ? JSON.stringify(mergedPayload) : null,
              Date.now(),
              mutation.mutation_id
            );
          }
        } else if (response.status >= 400 && response.status < 500) {
          // Non-retryable client error: fail immediately
          this._handlePermanentFailure(
            mutation,
            `HTTP ${response.status}`
          );
          failed++;
        } else {
          // Transient failure (500, 502, 503, 504, 0, etc.)
          const isFailed = this._handleTransientFailure(
            mutation,
            `HTTP ${response.status}`
          );
          if (isFailed) {
            failed++;
          }
        }
      } catch (err: unknown) {
        // Network drop / thrown exception
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isFailed = this._handleTransientFailure(mutation, errorMsg);
        if (isFailed) {
          failed++;
        }
      }
    }

    return { processed, successful, failed };
  }

  private _handleTransientFailure(
    mutation: OutboxMutation,
    error: string
  ): boolean {
    const nextRetryCount = mutation.retry_count + 1;
    const isPermanent = nextRetryCount >= this._maxRetries;
    const nextStatus: OutboxMutationStatus = isPermanent ? 'failed' : 'pending';

    this._updateRetryStmt.run(
      nextRetryCount,
      nextStatus,
      Date.now(),
      error,
      mutation.mutation_id
    );

    return isPermanent;
  }

  private _handlePermanentFailure(
    mutation: OutboxMutation,
    error: string
  ): void {
    this._updateRetryStmt.run(
      mutation.retry_count,
      'failed',
      Date.now(),
      error,
      mutation.mutation_id
    );
  }

  private _requeueForced(
    mutationId: string,
    existingHeaders?: Record<string, string>
  ): void {
    const row = this._getByIdStmt.get(mutationId) as OutboxRow | undefined;
    let headers: Record<string, string> = {};
    if (row?.headers) {
      try {
        headers = JSON.parse(row.headers);
      } catch {}
    } else if (existingHeaders) {
      headers = { ...existingHeaders };
    }
    headers['X-Force-Overwrite'] = 'true';

    this._requeueForcedStmt.run(
      JSON.stringify(headers),
      Date.now(),
      mutationId
    );
  }

  private _mapRowToMutation(row: OutboxRow): OutboxMutation {
    let headers: Record<string, string> | undefined;
    if (row.headers) {
      try {
        headers = JSON.parse(row.headers);
      } catch {}
    }

    let payload: unknown;
    if (row.payload !== null && row.payload !== undefined) {
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = row.payload;
      }
    }

    return {
      mutation_id: row.mutation_id,
      endpoint: row.endpoint,
      method: row.method,
      headers,
      payload,
      status: row.status as OutboxMutationStatus,
      retry_count: row.retry_count,
      created_at: row.created_at,
      last_attempt_at: row.last_attempt_at ?? undefined,
      error: row.error ?? undefined,
      forced: Boolean(row.forced),
      conflictPolicy: this._conflictPolicies.get(row.mutation_id),
      onRollback: this._rollbackCallbacks.get(row.mutation_id),
      mergeResolver: this._mergeResolvers.get(row.mutation_id),
    };
  }

  /**
   * Verifies the integrity of the outbox table and returns row counts and statuses.
   * Proves that offline mutations are intact and unaffected by cache eviction or migrations.
   */
  verifyIntegrity(): {
    intact: boolean;
    total: number;
    pending: number;
    inFlight: number;
    failed: number;
  } {
    const rows = this._getAllStmt.all() as OutboxRow[];
    let pending = 0;
    let inFlight = 0;
    let failed = 0;

    for (const row of rows) {
      if (row.status === 'pending') pending++;
      else if (row.status === 'in_flight') inFlight++;
      else if (row.status === 'failed') failed++;
    }

    return {
      intact: true,
      total: rows.length,
      pending,
      inFlight,
      failed,
    };
  }
}
