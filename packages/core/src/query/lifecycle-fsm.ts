import type { QueryStatus } from '../types.js';

export interface LifecycleFSMOptions {
  /**
   * Initial base delay in milliseconds for exponential backoff.
   * @default 500
   */
  baseDelay?: number;

  /**
   * Maximum backoff delay cap in milliseconds.
   * @default 30000
   */
  maxDelay?: number;

  /**
   * Maximum number of retry attempts before transitioning to 'error'.
   * @default 4
   */
  maxRetries?: number;
}

/**
 * 5-Stage Lifecycle State Machine for query operations with exponential jitter backoff.
 * States: 'idle' -> 'loading' -> 'retrying' -> 'success' | 'error'.
 */
export class LifecycleFSM<TData = unknown, TError = Error> {
  public state: QueryStatus = 'idle';
  public retryCount: number = 0;
  public data?: TData;
  public error?: TError;

  public readonly baseDelay: number;
  public readonly maxDelay: number;
  public readonly maxRetries: number;

  constructor(options?: LifecycleFSMOptions) {
    this.baseDelay = options?.baseDelay ?? 500;
    this.maxDelay = options?.maxDelay ?? 30000;
    this.maxRetries = options?.maxRetries ?? 4;
  }

  /**
   * Transition to 'loading' state when a query fetch starts.
   */
  public startLoading(): QueryStatus {
    this.state = 'loading';
    return this.state;
  }

  /**
   * Transition to 'success' state, storing the payload and resetting retry count.
   */
  public recordSuccess(data: TData): QueryStatus {
    this.state = 'success';
    this.data = data;
    this.error = undefined;
    this.retryCount = 0;
    return this.state;
  }

  /**
   * Transition to 'retrying' if attempt < maxRetries, or 'error' if attempt >= maxRetries.
   * Increments retry count on retry transitions.
   */
  public recordError(error: TError, attempt?: number): QueryStatus {
    this.error = error;
    const currentAttempt = attempt !== undefined ? attempt : this.retryCount;
    if (currentAttempt < this.maxRetries) {
      this.retryCount = currentAttempt + 1;
      this.state = 'retrying';
    } else {
      this.retryCount = currentAttempt;
      this.state = 'error';
    }
    return this.state;
  }

  /**
   * Computes exponential backoff with full jitter:
   * delay = Math.floor(Math.random() * (Math.min(maxDelay, baseDelay * 2^attempt) + 1))
   */
  public calculateBackoffDelay(attempt?: number): number {
    const currentAttempt = attempt !== undefined ? attempt : this.retryCount;
    const capped = Math.min(
      this.maxDelay,
      this.baseDelay * Math.pow(2, currentAttempt)
    );
    return Math.floor(Math.random() * (capped + 1));
  }

  /**
   * Restores the state machine back to its initial 'idle' state.
   */
  public reset(): void {
    this.state = 'idle';
    this.retryCount = 0;
    this.data = undefined;
    this.error = undefined;
  }

  public get isIdle(): boolean {
    return this.state === 'idle';
  }

  public get isLoading(): boolean {
    return this.state === 'loading';
  }

  public get isSuccess(): boolean {
    return this.state === 'success';
  }

  public get isError(): boolean {
    return this.state === 'error';
  }

  public get isRetrying(): boolean {
    return this.state === 'retrying';
  }
}
