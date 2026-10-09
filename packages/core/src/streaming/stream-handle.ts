export interface StreamSlice<T = string> {
  delta: T;
  cumulative: T;
  seq: number;
  byteOffset: number;
  done: boolean;
  reset?: boolean;
}

export interface StreamHandleOptions {
  queryHash?: string;
  abortController?: AbortController;
  highWaterMark?: number;
}

/**
 * StreamHandle represents an active or completed streaming query.
 * Implements AsyncIterable<StreamSlice<T>> to yield incremental slices
 * with cancellation via AbortController/AbortSignal and a completion Promise.
 */
export class StreamHandle<T = string> implements AsyncIterable<StreamSlice<T>> {
  public readonly abortController: AbortController;
  public readonly abortSignal: AbortSignal;
  public readonly queryHash: string;
  public readonly done: Promise<T>;
  public isDone: boolean = false;
  public isCancelled: boolean = false;
  public readonly highWaterMark: number;

  private _queue: StreamSlice<T>[] = [];
  private _waitingResolvers: Array<{
    resolve: (result: IteratorResult<StreamSlice<T>>) => void;
    reject: (err: any) => void;
  }> = [];
  private _errorState: Error | null = null;
  private _resolveDone!: (value: T | PromiseLike<T>) => void;
  private _rejectDone!: (reason?: any) => void;

  constructor(optionsOrHash?: string | StreamHandleOptions) {
    if (typeof optionsOrHash === 'string') {
      this.queryHash = optionsOrHash;
      this.abortController = new AbortController();
      this.highWaterMark = 100;
    } else {
      this.queryHash = optionsOrHash?.queryHash ?? '';
      this.abortController = optionsOrHash?.abortController ?? new AbortController();
      this.highWaterMark = optionsOrHash?.highWaterMark ?? 100;
    }
    this.abortSignal = this.abortController.signal;

    this.done = new Promise<T>((resolve, reject) => {
      this._resolveDone = resolve;
      this._rejectDone = reject;
    });
    // Prevent unhandled promise rejections if consumer only iterates without awaiting .done
    this.done.catch(() => {});

    // Hook external abort event
    this.abortSignal.addEventListener('abort', () => {
      if (!this.isCancelled) {
        this.cancel(String(this.abortSignal.reason ?? 'Aborted'));
      }
    });
  }

  get bufferedAmount(): number {
    return this._queue.length;
  }

  /**
   * Pushes a new slice into the stream.
   * Returns true if queue length is within highWaterMark, or false if backpressure is applied.
   */
  push(slice: StreamSlice<T>): boolean {
    if (this.isCancelled || (this.isDone && !slice.done)) {
      return false;
    }

    if (this._waitingResolvers.length > 0) {
      const resolver = this._waitingResolvers.shift()!;
      resolver.resolve({ done: false, value: slice });
    } else {
      this._queue.push(slice);
    }

    if (slice.done && !this.isDone) {
      this.end(slice.cumulative);
    }

    return this._queue.length < this.highWaterMark;
  }

  /**
   * Ends the stream with a final cumulative payload.
   */
  end(finalPayload: T): void {
    if (this.isDone || this.isCancelled) {
      return;
    }
    this.isDone = true;
    this._resolveDone(finalPayload);

    while (this._waitingResolvers.length > 0) {
      const resolver = this._waitingResolvers.shift()!;
      resolver.resolve({ done: true, value: undefined });
    }
  }

  /**
   * Emits an upstream error, rejecting pending iterations and the done promise.
   */
  error(err: Error): void {
    if (this.isDone || this.isCancelled) {
      return;
    }
    this.isDone = true;
    this._errorState = err;
    this._rejectDone(err);

    while (this._waitingResolvers.length > 0) {
      const resolver = this._waitingResolvers.shift()!;
      resolver.reject(err);
    }
  }

  /**
   * Cancels the stream, aborting the controller, discarding buffered slices,
   * and closing the iterator.
   */
  cancel(reason?: string): void {
    if (this.isCancelled) {
      return;
    }
    this.isCancelled = true;
    this.isDone = true;

    try {
      this.abortController.abort(reason);
    } catch {
      // Ignore if already aborted
    }

    const abortError = new Error(reason ?? 'Stream cancelled');
    abortError.name = 'AbortError';
    this._rejectDone(abortError);

    // Clear queue so iteration halts immediately
    this._queue = [];

    while (this._waitingResolvers.length > 0) {
      const resolver = this._waitingResolvers.shift()!;
      resolver.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamSlice<T>> {
    return {
      next: (): Promise<IteratorResult<StreamSlice<T>>> => {
        if (this.isCancelled) {
          return Promise.resolve({ done: true, value: undefined });
        }
        if (this._errorState) {
          return Promise.reject(this._errorState);
        }
        if (this._queue.length > 0) {
          const value = this._queue.shift()!;
          return Promise.resolve({ done: false, value });
        }
        if (this.isDone) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<StreamSlice<T>>>((resolve, reject) => {
          this._waitingResolvers.push({ resolve, reject });
        });
      },
      return: (value?: any): Promise<IteratorResult<StreamSlice<T>>> => {
        return Promise.resolve({ done: true, value });
      },
      throw: (err?: any): Promise<IteratorResult<StreamSlice<T>>> => {
        return Promise.reject(err);
      },
    };
  }
}
