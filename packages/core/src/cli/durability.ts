import type { SqliteAdapter, SqliteCheckpointMode } from '../storage/sqlite-adapter.js';

export type FlushFn = () => void;

export interface ProcessLike {
  on(event: 'beforeExit' | 'exit' | string, listener: (...args: any[]) => void): this | any;
  removeListener?(event: 'beforeExit' | 'exit' | string, listener: (...args: any[]) => void): this | any;
  off?(event: 'beforeExit' | 'exit' | string, listener: (...args: any[]) => void): this | any;
}

export interface CliDurabilityManagerOptions {
  onError?: (error: unknown) => void;
}

interface RegisteredFlusher {
  id: number;
  flushFn: FlushFn;
  priority: number;
}

/**
 * Manages synchronous flush callbacks for ephemeral CLI processes.
 * Ensures in-memory outboxes and SQLite WAL files are committed before process exit.
 */
export class CliDurabilityManager {
  private readonly _flushers: Map<number, RegisteredFlusher> = new Map();
  private _nextId = 0;
  private readonly _onError?: (error: unknown) => void;

  constructor(options?: CliDurabilityManagerOptions) {
    this._onError = options?.onError;
  }

  /**
   * Registers a synchronous flush callback with an optional priority.
   * Higher priority numbers execute first during flushAll().
   * Callbacks with identical priority execute in registration order (FIFO).
   * Returns an unregister function that removes the callback.
   */
  register(flushFn: FlushFn, priority = 0): () => void {
    const id = ++this._nextId;
    this._flushers.set(id, { id, flushFn, priority });

    let unregistered = false;
    return () => {
      if (!unregistered) {
        unregistered = true;
        this._flushers.delete(id);
      }
    };
  }

  /**
   * Executes all registered callbacks synchronously in order of priority (highest first).
   * Errors thrown by callbacks are caught safely so all remaining handlers run.
   */
  flushAll(): void {
    const sorted = Array.from(this._flushers.values()).sort(
      (a, b) => b.priority - a.priority || a.id - b.id
    );

    for (const item of sorted) {
      try {
        item.flushFn();
      } catch (err) {
        if (this._onError) {
          this._onError(err);
        } else {
          console.error('CliDurabilityManager: Error executing flush callback:', err);
        }
      }
    }
  }

  /**
   * Hooks into `beforeExit` and `exit` lifecycle events on the given process object.
   * Defaults to global `process` if available in the current runtime environment.
   * Returns an unregister function to remove the attached event listeners.
   */
  attachToProcess(processObj: ProcessLike = process): () => void {
    if (!processObj || typeof processObj.on !== 'function') {
      return () => {};
    }

    const handleExit = () => {
      this.flushAll();
    };

    processObj.on('beforeExit', handleExit);
    processObj.on('exit', handleExit);

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;

      if (typeof processObj.removeListener === 'function') {
        processObj.removeListener('beforeExit', handleExit);
        processObj.removeListener('exit', handleExit);
      } else if (typeof processObj.off === 'function') {
        processObj.off('beforeExit', handleExit);
        processObj.off('exit', handleExit);
      }
    };
  }

  /**
   * Registers a SQLite WAL checkpoint handler that calls `sqliteAdapter.checkpoint('TRUNCATE')`.
   * Defaults priority to -100 so in-memory mutations flush to SQLite before WAL is checkpointed.
   */
  registerSqliteCheckpoint(
    sqliteAdapter: SqliteAdapter,
    priority = -100,
    mode: SqliteCheckpointMode = 'TRUNCATE'
  ): () => void {
    return this.register(() => {
      sqliteAdapter.checkpoint(mode);
    }, priority);
  }

  /**
   * Returns the number of registered flush handlers.
   */
  get size(): number {
    return this._flushers.size;
  }
}

let defaultDurabilityManager: CliDurabilityManager | null = null;
let defaultDetachFn: (() => void) | null = null;

/**
 * Returns the default singleton CliDurabilityManager instance,
 * automatically attached to process exit hooks.
 */
export function getDefaultDurabilityManager(): CliDurabilityManager {
  if (!defaultDurabilityManager) {
    defaultDurabilityManager = new CliDurabilityManager();
    defaultDetachFn = defaultDurabilityManager.attachToProcess();
  }
  return defaultDurabilityManager;
}

/**
 * Resets the default singleton durability manager and detaches from process events.
 * Primarily used in test isolation.
 */
export function resetDefaultDurabilityManager(): void {
  if (defaultDetachFn) {
    defaultDetachFn();
    defaultDetachFn = null;
  }
  defaultDurabilityManager = null;
}

/**
 * Registers a synchronous exit flush callback with the default durability manager.
 * Ensures the callback runs synchronously before process termination.
 */
export function registerExitFlush(
  flushFn: FlushFn,
  priority = 0
): () => void {
  return getDefaultDurabilityManager().register(flushFn, priority);
}
