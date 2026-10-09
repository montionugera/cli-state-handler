import type { QueryKey } from '../types.js';
import type { ResumeStrategy, ResumeContext } from './resume-strategy.js';
import type { SqliteAdapter } from '../storage/sqlite-adapter.js';
import { hashQueryKey } from '../query/key-hasher.js';

export type StreamResumeState =
  | 'idle'
  | 'streaming'
  | 'interrupted'
  | 'resuming'
  | 'complete'
  | 'aborted';

export interface StreamResumeFsmOptions {
  queryHash: string;
  queryKey: QueryKey;
  strategy: ResumeStrategy;
  maxRetries?: number; // default 5
  baseDelayMs?: number; // default 300
  maxDelayMs?: number; // default 10000
  sqliteAdapter?: SqliteAdapter;
  etag?: string | null;
  initialLastEventId?: string | null;
  onReset?: () => void;
}

export interface IncomingChunkResult {
  accepted: boolean;
  duplicate: boolean;
  slice: Buffer;
  seq: number;
  byteOffset: number;
}

export interface HandleErrorResult {
  canResume: boolean;
  retryDelayMs: number;
  headers?: Record<string, string>;
  continuationPayload?: unknown;
  restart: boolean;
}

/**
 * Finite State Machine managing resumable stream connections, chunk deduplication,
 * exponential backoff retry with full jitter, and strategy-driven recovery.
 */
export class StreamResumeFsm {
  public state: StreamResumeState = 'idle';
  public retryCount = 0;
  public committedByteLength = 0;
  public committedSeq = 0;
  public lastEventId: string | null = null;
  public accumulatedText = '';

  public readonly queryHash: string;
  public readonly queryKey: QueryKey;
  public readonly strategy: ResumeStrategy;
  public readonly maxRetries: number;
  public readonly baseDelayMs: number;
  public readonly maxDelayMs: number;
  public readonly sqliteAdapter?: SqliteAdapter;
  public etag: string | null = null;
  public readonly onReset?: () => void;

  constructor(options: StreamResumeFsmOptions) {
    this.queryHash = options.queryHash;
    this.queryKey = options.queryKey;
    this.strategy = options.strategy;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 300;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.sqliteAdapter = options.sqliteAdapter;
    this.etag = options.etag ?? null;
    this.lastEventId = options.initialLastEventId ?? null;
    this.onReset = options.onReset;

    if (this.sqliteAdapter) {
      let existing = this.sqliteAdapter.getStream(this.queryHash);
      if (!existing && hashQueryKey(this.queryKey) === this.queryHash) {
        try {
          this.sqliteAdapter.createStream(this.queryKey, {
            etag: this.etag ?? undefined,
            resumeToken: this.lastEventId ?? undefined,
            resumeKind: this.strategy.kind === 'last-event-id' ? 'last-event-id' : undefined,
          });
          existing = this.sqliteAdapter.getStream(this.queryHash);
        } catch {
          // Stream may already exist concurrently or was created externally
        }
      }

      if (existing) {
        this.committedByteLength = existing.byteLength;
        this.committedSeq = existing.nextSeq;
        if (existing.resumeToken && !this.lastEventId) {
          this.lastEventId = existing.resumeToken;
        }
        if (existing.etag && !this.etag) {
          this.etag = existing.etag;
        }
        if (existing.byteLength > 0) {
          const chunks = this.sqliteAdapter.getStreamChunks(this.queryHash, 0);
          this.accumulatedText = Buffer.concat(chunks.map((c) => c.data)).toString('utf8');
        }
      }
    }
  }

  /**
   * Transitions state from 'idle' to 'streaming'.
   */
  start(): void {
    this.state = 'streaming';
  }

  /**
   * Processes an incoming raw chunk, slicing off duplicate overlapping bytes if needed.
   * Persists accepted chunks to SQLite if an adapter is configured.
   */
  handleIncomingChunk(
    data: Buffer | string,
    seq?: number,
    byteOffset?: number,
    eventId?: string
  ): IncomingChunkResult {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    let slice = buf;

    if (byteOffset !== undefined && byteOffset < this.committedByteLength) {
      if (byteOffset + buf.length <= this.committedByteLength) {
        return {
          accepted: false,
          duplicate: true,
          slice: Buffer.alloc(0),
          seq: seq ?? this.committedSeq,
          byteOffset,
        };
      }
      slice = buf.subarray(this.committedByteLength - byteOffset);
    }

    if (eventId) {
      this.lastEventId = eventId;
      this.sqliteAdapter?.updateStreamResumeToken(this.queryHash, eventId, 'last-event-id');
    }

    const currentSeq = this.committedSeq;
    const currentOffset = this.committedByteLength;

    if (this.sqliteAdapter) {
      this.sqliteAdapter.appendStreamChunk(this.queryHash, slice, currentSeq);
    }

    this.committedByteLength += slice.length;
    this.committedSeq += 1;
    this.accumulatedText += slice.toString('utf8');

    if (this.state === 'resuming' || this.state === 'interrupted' || this.state === 'idle') {
      this.state = 'streaming';
      this.retryCount = 0;
    }

    return {
      accepted: true,
      duplicate: false,
      slice,
      seq: currentSeq,
      byteOffset: currentOffset,
    };
  }

  /**
   * Handles network errors or transport disconnects.
   * Implements exponential backoff with full jitter, status code fallbacks (416/412),
   * and resume strategy execution.
   */
  handleError(
    error: unknown,
    statusCode?: number
  ): HandleErrorResult {
    if (statusCode === 416 || statusCode === 412) {
      this._performReset();
      return { canResume: true, retryDelayMs: 0, restart: true };
    }

    if (this.retryCount >= this.maxRetries) {
      this.state = 'aborted';
      this.sqliteAdapter?.abortStream(
        this.queryHash,
        error instanceof Error ? error.message : String(error)
      );
      return { canResume: false, retryDelayMs: 0, restart: false };
    }

    const retryDelayMs = Math.floor(
      Math.random() * Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, this.retryCount))
    );
    this.retryCount += 1;
    this.state = 'interrupted';
    this.state = 'resuming';

    const ctx: ResumeContext = {
      queryHash: this.queryHash,
      queryKey: this.queryKey,
      byteLength: this.committedByteLength,
      nextSeq: this.committedSeq,
      etag: this.etag,
      lastEventId: this.lastEventId,
      accumulatedText: this.accumulatedText,
    };

    let headers: Record<string, string> | undefined;
    let continuationPayload: unknown | undefined;
    let restart = false;

    switch (this.strategy.kind) {
      case 'range':
        headers = this.strategy.buildHeaders(ctx);
        break;
      case 'last-event-id':
        headers = this.strategy.buildHeaders(ctx);
        break;
      case 'continuation':
        continuationPayload = this.strategy.buildContinuation(ctx);
        break;
      case 'restart':
        this.strategy.reset(ctx);
        this._performReset();
        restart = true;
        break;
    }

    const result: HandleErrorResult = {
      canResume: true,
      retryDelayMs,
      restart,
    };

    if (headers !== undefined) {
      result.headers = headers;
    }
    if (continuationPayload !== undefined) {
      result.continuationPayload = continuationPayload;
    }

    return result;
  }

  /**
   * Marks stream as complete.
   */
  complete(): void {
    this.state = 'complete';
  }

  /**
   * Aborts the active stream and updates SQLite if configured.
   */
  abort(reason?: string): void {
    this.state = 'aborted';
    this.sqliteAdapter?.abortStream(this.queryHash, reason);
  }

  private _performReset(): void {
    this.sqliteAdapter?.resetStream(this.queryHash);
    this.committedByteLength = 0;
    this.committedSeq = 0;
    this.accumulatedText = '';
    this.onReset?.();
    this.state = 'resuming';
  }
}
