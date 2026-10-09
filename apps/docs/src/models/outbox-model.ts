/**
 * Browser model of UCSA's MutationOutbox (packages/core/src/query/mutation-outbox.ts).
 *
 * The real outbox is bound to SQLite and cannot be bundled for the browser, so this
 * is an in-memory mirror with an injectable clock. Status values, field names and
 * transitions match the real class; tests/outbox-model.parity.test.ts drives the same
 * scripts through both and compares every step.
 *
 * Rules mirrored from the real code, each covered by a case in the parity test:
 *  - There is no backoff delay between retries: a transient failure re-queues the row
 *    as `pending` immediately (until `maxRetries`).
 *  - Completing a mutation is not fenced by lease owner: a worker whose lease was taken
 *    over can still settle the row by id.
 */
import type { ConflictPolicy, OutboxMutation, OutboxMutationStatus } from "@ucsa/core";

export type { ConflictPolicy, OutboxMutation, OutboxMutationStatus };

export interface ModelResponse {
  status: number;
  data?: unknown;
}

export type ModelExecutor = (mutation: OutboxMutation) => Promise<ModelResponse>;

export type SettleOutcome = "synced" | "rolled-back" | "forced" | "merged" | "failed" | "retry";

export interface ReplayResult {
  processed: number;
  successful: number;
  failed: number;
}

export interface ReplayOptions {
  rateLimitMs?: number;
  batchSize?: number;
  leaseDurationMs?: number;
  workerId?: string;
  /** Injected so the UI can advance its virtual clock; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called with what happened to each claimed mutation (model-only; the real replay has no such hook). */
  onOutcome?: (mutation: OutboxMutation, outcome: SettleOutcome) => void;
}

export interface OutboxModelOptions {
  clock: () => number;
  maxRetries?: number;
  workerId?: string;
  defaultLeaseDurationMs?: number;
  onRollback?: (mutation: OutboxMutation) => void | Promise<void>;
  mergeResolver?: (localData: unknown, serverData: unknown) => unknown | Promise<unknown>;
}

export type EnqueueInput = Omit<OutboxMutation, "created_at" | "retry_count" | "status" | "method"> & {
  method?: string;
};

/** Stored like the SQLite row: headers/payload are JSON text, so reads are clones. */
interface Row {
  mutation_id: string;
  endpoint: string;
  method: string;
  headers: string | null;
  payload: string | null;
  status: OutboxMutationStatus;
  retry_count: number;
  created_at: number;
  last_attempt_at: number | null;
  error: string | null;
  forced: boolean;
  lease_owner: string | null;
  lease_until: number | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class OutboxModel {
  private readonly _clock: () => number;
  private readonly _maxRetries: number;
  private readonly _workerId: string;
  private readonly _defaultLeaseDurationMs: number;
  private readonly _options: OutboxModelOptions;
  private readonly _rows = new Map<string, Row>();
  private readonly _rollbackCallbacks = new Map<string, (m: OutboxMutation) => void | Promise<void>>();
  private readonly _mergeResolvers = new Map<string, (l: unknown, s: unknown) => unknown>();
  private readonly _conflictPolicies = new Map<string, ConflictPolicy>();
  private _seq = 0;

  constructor(options: OutboxModelOptions) {
    this._options = options;
    this._clock = options.clock;
    this._maxRetries = options.maxRetries ?? 3;
    this._workerId = options.workerId ?? "worker-a";
    this._defaultLeaseDurationMs = options.defaultLeaseDurationMs ?? 30000;
  }

  get workerId(): string {
    return this._workerId;
  }
  get defaultLeaseDurationMs(): number {
    return this._defaultLeaseDurationMs;
  }
  get maxRetries(): number {
    return this._maxRetries;
  }

  enqueue(mutation: EnqueueInput): OutboxMutation {
    const id = mutation.mutation_id || `mut_${this._clock()}_${++this._seq}`;
    const row: Row = {
      mutation_id: id,
      endpoint: mutation.endpoint,
      method: mutation.method || "POST",
      headers: mutation.headers ? JSON.stringify(mutation.headers) : null,
      payload: mutation.payload !== undefined ? JSON.stringify(mutation.payload) : null,
      status: "pending",
      retry_count: 0,
      created_at: this._clock(),
      last_attempt_at: null,
      error: mutation.error ?? null,
      forced: Boolean(mutation.forced),
      lease_owner: mutation.lease_owner ?? null,
      lease_until: mutation.lease_until ?? null,
    };
    this._rows.set(id, row);
    if (mutation.onRollback) this._rollbackCallbacks.set(id, mutation.onRollback as (m: OutboxMutation) => void);
    if (mutation.mergeResolver) this._mergeResolvers.set(id, mutation.mergeResolver as (l: unknown, s: unknown) => unknown);
    if (mutation.conflictPolicy) this._conflictPolicies.set(id, mutation.conflictPolicy);
    return this._map(row);
  }

  getAllMutations(): OutboxMutation[] {
    return this._ordered().map((r) => this._map(r));
  }

  getPendingMutations(): OutboxMutation[] {
    return this._ordered()
      .filter((r) => r.status === "pending")
      .map((r) => this._map(r));
  }

  /** Rows a claim would take right now: pending, or in_flight with an expired lease. */
  countClaimable(): number {
    const now = this._clock();
    return this._ordered().filter(
      (r) => r.status === "pending" || (r.status === "in_flight" && r.lease_until !== null && r.lease_until < now)
    ).length;
  }

  getMutation(id: string): OutboxMutation | null {
    const row = this._rows.get(id);
    return row ? this._map(row) : null;
  }

  markStatus(id: string, status: OutboxMutationStatus, error?: string): void {
    const row = this._rows.get(id);
    if (!row) return;
    row.status = status;
    row.last_attempt_at = this._clock();
    row.error = error ?? null;
    if (status !== "in_flight") {
      row.lease_owner = null;
      row.lease_until = null;
    }
  }

  remove(id: string): void {
    this._rows.delete(id);
    this._rollbackCallbacks.delete(id);
    this._mergeResolvers.delete(id);
    this._conflictPolicies.delete(id);
  }

  /**
   * Claims pending rows and in_flight rows whose lease has expired (`lease_until < now`,
   * strictly: a lease is still live at the exact `lease_until` instant).
   */
  claimPendingMutations(
    workerId: string = this._workerId,
    leaseDurationMs: number = this._defaultLeaseDurationMs,
    limit = 50
  ): OutboxMutation[] {
    const now = this._clock();
    const leaseUntil = now + leaseDurationMs;
    const claimed = this._ordered()
      .filter(
        (r) =>
          r.status === "pending" ||
          (r.status === "in_flight" && r.lease_until !== null && r.lease_until < now)
      )
      .slice(0, limit);
    for (const row of claimed) {
      row.status = "in_flight";
      row.lease_owner = workerId;
      row.lease_until = leaseUntil;
      row.last_attempt_at = now;
    }
    return claimed.map((r) => this._map(r));
  }

  /** Applies one executor result (or thrown error) to a claimed mutation, as replay() does. */
  async settle(mutation: OutboxMutation, outcome: ModelResponse | Error): Promise<SettleOutcome> {
    try {
      if (outcome instanceof Error) throw outcome;
      return await this._applyResponse(mutation, outcome);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this._transient(mutation, message) ? "failed" : "retry";
    }
  }

  async replay(executor: ModelExecutor, options: ReplayOptions = {}): Promise<ReplayResult> {
    const rateLimitMs = options.rateLimitMs ?? 0;
    const sleep = options.sleep ?? defaultSleep;
    const limit = options.batchSize && options.batchSize > 0 ? options.batchSize : 50;
    const claimed = this.claimPendingMutations(
      options.workerId ?? this._workerId,
      options.leaseDurationMs ?? this._defaultLeaseDurationMs,
      limit
    );

    const result: ReplayResult = { processed: 0, successful: 0, failed: 0 };
    for (let i = 0; i < claimed.length; i++) {
      const mutation = claimed[i];
      if (i > 0 && rateLimitMs > 0) await sleep(rateLimitMs);
      result.processed++;
      let outcome: SettleOutcome;
      try {
        outcome = await this.settle(mutation, await executor(mutation));
      } catch (err: unknown) {
        outcome = await this.settle(mutation, err instanceof Error ? err : new Error(String(err)));
      }
      options.onOutcome?.(mutation, outcome);
      if (outcome === "synced" || outcome === "rolled-back") result.successful++;
      else if (outcome === "failed") result.failed++;
    }
    return result;
  }

  private async _applyResponse(mutation: OutboxMutation, response: ModelResponse): Promise<SettleOutcome> {
    const id = mutation.mutation_id;
    if (response.status >= 200 && response.status < 300) {
      this.remove(id);
      return "synced";
    }
    if (response.status === 409) {
      const policy = mutation.conflictPolicy;
      if (policy === "client-wins") {
        this._requeueForced(id, mutation.headers);
        return "forced";
      }
      if (policy === "merge") {
        const mergeFn = mutation.mergeResolver ?? this._mergeResolvers.get(id) ?? this._options.mergeResolver;
        let merged: unknown = mutation.payload;
        if (mergeFn) merged = await mergeFn(mutation.payload, response.data);
        const row = this._rows.get(id);
        if (row) {
          row.payload = merged !== undefined ? JSON.stringify(merged) : null;
          row.status = "pending";
          row.last_attempt_at = this._clock();
          row.lease_owner = null;
          row.lease_until = null;
        }
        return "merged";
      }
      // server-wins, and the default when no policy is set
      const rollbackFn = mutation.onRollback ?? this._rollbackCallbacks.get(id) ?? this._options.onRollback;
      if (rollbackFn) await rollbackFn(mutation);
      this.remove(id);
      return "rolled-back";
    }
    if (response.status >= 400 && response.status < 500) {
      this._update(id, mutation.retry_count, "failed", `HTTP ${response.status}`);
      return "failed";
    }
    return this._transient(mutation, `HTTP ${response.status}`) ? "failed" : "retry";
  }

  /** Returns true when the row became permanently failed. */
  private _transient(mutation: OutboxMutation, error: string): boolean {
    const next = mutation.retry_count + 1;
    const permanent = next >= this._maxRetries;
    this._update(mutation.mutation_id, next, permanent ? "failed" : "pending", error);
    return permanent;
  }

  private _update(id: string, retryCount: number, status: OutboxMutationStatus, error: string): void {
    const row = this._rows.get(id);
    if (!row) return;
    row.retry_count = retryCount;
    row.status = status;
    row.last_attempt_at = this._clock();
    row.error = error;
    row.lease_owner = null;
    row.lease_until = null;
  }

  private _requeueForced(id: string, existing?: Record<string, string>): void {
    const row = this._rows.get(id);
    if (!row) return;
    let headers: Record<string, string> = {};
    if (row.headers) headers = JSON.parse(row.headers) as Record<string, string>;
    else if (existing) headers = { ...existing };
    headers["X-Force-Overwrite"] = "true";
    row.status = "pending";
    row.forced = true;
    row.headers = JSON.stringify(headers);
    row.last_attempt_at = this._clock();
    row.lease_owner = null;
    row.lease_until = null;
  }

  private _ordered(): Row[] {
    return [...this._rows.values()].sort((a, b) => a.created_at - b.created_at);
  }

  private _map(row: Row): OutboxMutation {
    return {
      mutation_id: row.mutation_id,
      endpoint: row.endpoint,
      method: row.method,
      headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : undefined,
      payload: row.payload !== null ? (JSON.parse(row.payload) as unknown) : undefined,
      status: row.status,
      retry_count: row.retry_count,
      created_at: row.created_at,
      last_attempt_at: row.last_attempt_at ?? undefined,
      error: row.error ?? undefined,
      forced: row.forced,
      lease_owner: row.lease_owner,
      lease_until: row.lease_until,
      conflictPolicy: this._conflictPolicies.get(row.mutation_id),
      onRollback: this._rollbackCallbacks.get(row.mutation_id),
      mergeResolver: this._mergeResolvers.get(row.mutation_id) as OutboxMutation["mergeResolver"],
    };
  }
}
