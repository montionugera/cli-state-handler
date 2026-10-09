import type { QueryKey } from '../types.js';
import type { ResumeKind } from '../storage/sqlite-adapter.js';

export interface ResumeContext {
  queryHash: string;
  queryKey: QueryKey;
  byteLength: number;
  nextSeq: number;
  etag?: string | null;
  lastEventId?: string | null;
  accumulatedText?: string;
}

export interface RangeResumeStrategy {
  kind: 'range';
  buildHeaders(ctx: ResumeContext): Record<string, string>;
}

export interface LastEventIdResumeStrategy {
  kind: 'last-event-id';
  buildHeaders(ctx: ResumeContext): Record<string, string>;
}

export interface ContinuationResumeStrategy<TContinuation = unknown> {
  kind: 'continuation';
  buildContinuation(ctx: ResumeContext): TContinuation;
}

export interface RestartResumeStrategy {
  kind: 'restart';
  reset(ctx: ResumeContext): { reset: true; seq: 0; byteOffset: 0 };
}

export type ResumeStrategy =
  | RangeResumeStrategy
  | LastEventIdResumeStrategy
  | ContinuationResumeStrategy
  | RestartResumeStrategy;

/**
 * Creates an HTTP Range resume strategy that generates Range and optional If-Range headers.
 */
export function createRangeResumeStrategy(): RangeResumeStrategy {
  return {
    kind: 'range',
    buildHeaders(ctx: ResumeContext): Record<string, string> {
      return {
        Range: `bytes=${ctx.byteLength}-`,
        ...(ctx.etag ? { 'If-Range': ctx.etag } : {}),
      };
    },
  };
}

/**
 * Creates an SSE resume strategy that passes the Last-Event-ID header upon reconnection.
 */
export function createLastEventIdResumeStrategy(): LastEventIdResumeStrategy {
  return {
    kind: 'last-event-id',
    buildHeaders(ctx: ResumeContext): Record<string, string> {
      return ctx.lastEventId ? { 'Last-Event-ID': ctx.lastEventId } : {};
    },
  };
}

/**
 * Creates an application-level continuation strategy invoking a custom factory with ResumeContext.
 */
export function createContinuationResumeStrategy<TContinuation = unknown>(
  fn: (ctx: ResumeContext) => TContinuation
): ContinuationResumeStrategy<TContinuation> {
  return {
    kind: 'continuation',
    buildContinuation(ctx: ResumeContext): TContinuation {
      return fn(ctx);
    },
  };
}

/**
 * Creates a restart resume strategy resetting chunk sequence and byte offset to zero.
 */
export function createRestartResumeStrategy(): RestartResumeStrategy {
  return {
    kind: 'restart',
    reset(_ctx: ResumeContext): { reset: true; seq: 0; byteOffset: 0 } {
      return { reset: true, seq: 0, byteOffset: 0 };
    },
  };
}
