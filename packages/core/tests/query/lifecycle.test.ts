import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LifecycleFSM } from '../../src/index.js';
import type { QueryStatus } from '../../src/index.js';

describe('LifecycleFSM (5-Stage State Machine)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Initial State & Construction', () => {
    it('initializes in idle state with 0 retries and undefined data/error', () => {
      const fsm = new LifecycleFSM();

      expect(fsm.state).toBe('idle');
      expect(fsm.retryCount).toBe(0);
      expect(fsm.data).toBeUndefined();
      expect(fsm.error).toBeUndefined();
      expect(fsm.isIdle).toBe(true);
      expect(fsm.isLoading).toBe(false);
      expect(fsm.isRetrying).toBe(false);
      expect(fsm.isSuccess).toBe(false);
      expect(fsm.isError).toBe(false);
    });

    it('applies default configuration values', () => {
      const fsm = new LifecycleFSM();

      expect(fsm.baseDelay).toBe(500);
      expect(fsm.maxDelay).toBe(30000);
      expect(fsm.maxRetries).toBe(4);
    });

    it('accepts custom configuration options', () => {
      const fsm = new LifecycleFSM({
        baseDelay: 1000,
        maxDelay: 15000,
        maxRetries: 2,
      });

      expect(fsm.baseDelay).toBe(1000);
      expect(fsm.maxDelay).toBe(15000);
      expect(fsm.maxRetries).toBe(2);
    });
  });

  describe('2. Loading Transitions', () => {
    it('startLoading() transitions from idle to loading', () => {
      const fsm = new LifecycleFSM();
      const status: QueryStatus = fsm.startLoading();

      expect(status).toBe('loading');
      expect(fsm.state).toBe('loading');
      expect(fsm.isLoading).toBe(true);
      expect(fsm.isIdle).toBe(false);
    });

    it('startLoading() transitions from retrying to loading', () => {
      const fsm = new LifecycleFSM({ maxRetries: 3 });
      fsm.startLoading();
      fsm.recordError(new Error('transient failure'));
      expect(fsm.state).toBe('retrying');

      fsm.startLoading();
      expect(fsm.state).toBe('loading');
      expect(fsm.isLoading).toBe(true);
    });

    it('startLoading() transitions from error to loading (manual retry)', () => {
      const fsm = new LifecycleFSM({ maxRetries: 0 });
      fsm.startLoading();
      fsm.recordError(new Error('fatal failure'));
      expect(fsm.state).toBe('error');

      fsm.startLoading();
      expect(fsm.state).toBe('loading');
    });

    it('startLoading() transitions from success to loading (revalidation)', () => {
      const fsm = new LifecycleFSM<string>();
      fsm.startLoading();
      fsm.recordSuccess('initial payload');
      expect(fsm.state).toBe('success');

      fsm.startLoading();
      expect(fsm.state).toBe('loading');
      // Preserves existing data during background revalidation (SWR)
      expect(fsm.data).toBe('initial payload');
    });
  });

  describe('3. Error Transitions & Retries', () => {
    it('recordError(err) transitions to retrying if attempt < maxRetries', () => {
      const fsm = new LifecycleFSM({ maxRetries: 3 });
      fsm.startLoading();

      const err1 = new Error('Network timeout');
      const status1 = fsm.recordError(err1);

      expect(status1).toBe('retrying');
      expect(fsm.state).toBe('retrying');
      expect(fsm.isRetrying).toBe(true);
      expect(fsm.retryCount).toBe(1);
      expect(fsm.error).toBe(err1);
    });

    it('increments retry count sequentially and transitions to error when reaching maxRetries', () => {
      const fsm = new LifecycleFSM({ maxRetries: 3 });
      fsm.startLoading();

      // Attempt 0 fails -> retry 1
      fsm.recordError(new Error('err 1'));
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(1);

      // Attempt 1 fails -> retry 2
      fsm.recordError(new Error('err 2'));
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(2);

      // Attempt 2 fails -> retry 3
      fsm.recordError(new Error('err 3'));
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(3);

      // Attempt 3 fails -> reaches maxRetries (3), transitions to error
      const finalErr = new Error('final failure');
      const finalStatus = fsm.recordError(finalErr);
      expect(finalStatus).toBe('error');
      expect(fsm.state).toBe('error');
      expect(fsm.isError).toBe(true);
      expect(fsm.retryCount).toBe(3);
      expect(fsm.error).toBe(finalErr);
    });

    it('immediately transitions to error when maxRetries is 0', () => {
      const fsm = new LifecycleFSM({ maxRetries: 0 });
      fsm.startLoading();

      const err = new Error('Non-retryable 404');
      const status = fsm.recordError(err);

      expect(status).toBe('error');
      expect(fsm.state).toBe('error');
      expect(fsm.isError).toBe(true);
      expect(fsm.isRetrying).toBe(false);
      expect(fsm.retryCount).toBe(0);
      expect(fsm.error).toBe(err);
    });

    it('supports explicit attempt parameter override in recordError', () => {
      const fsm = new LifecycleFSM({ maxRetries: 3 });
      fsm.startLoading();

      // Pass attempt = 0 (< 3)
      fsm.recordError(new Error('fail'), 0);
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(1);

      // Pass attempt = 3 (>= 3)
      fsm.recordError(new Error('fatal'), 3);
      expect(fsm.state).toBe('error');
      expect(fsm.retryCount).toBe(3);
    });
  });

  describe('4. Exponential Backoff with Full Jitter', () => {
    it('computes exponential backoff delay within [0, baseDelay * 2^attempt]', () => {
      const fsm = new LifecycleFSM({ baseDelay: 500, maxDelay: 30000 });

      // When Math.random returns 0.0 -> delay should be 0
      vi.spyOn(Math, 'random').mockReturnValue(0.0);
      expect(fsm.calculateBackoffDelay(0)).toBe(0);
      expect(fsm.calculateBackoffDelay(1)).toBe(0);
      expect(fsm.calculateBackoffDelay(2)).toBe(0);

      // When Math.random returns 0.5 -> delay is floor(0.5 * (ceiling + 1))
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      // attempt 0: baseDelay * 2^0 = 500, floor(0.5 * 501) = 250
      expect(fsm.calculateBackoffDelay(0)).toBe(250);
      // attempt 1: baseDelay * 2^1 = 1000, floor(0.5 * 1001) = 500
      expect(fsm.calculateBackoffDelay(1)).toBe(500);
      // attempt 2: baseDelay * 2^2 = 2000, floor(0.5 * 2001) = 1000
      expect(fsm.calculateBackoffDelay(2)).toBe(1000);

      // When Math.random approaches 1.0 (e.g. 0.999999) -> delay hits ceiling
      vi.spyOn(Math, 'random').mockReturnValue(0.999999);
      expect(fsm.calculateBackoffDelay(0)).toBe(500);
      expect(fsm.calculateBackoffDelay(1)).toBe(1000);
      expect(fsm.calculateBackoffDelay(2)).toBe(2000);
    });

    it('caps backoff delay at maxDelay regardless of exponential growth', () => {
      const fsm = new LifecycleFSM({ baseDelay: 500, maxDelay: 4000 });

      // attempt 5: 500 * 2^5 = 16000 > 4000 (capped at 4000)
      vi.spyOn(Math, 'random').mockReturnValue(0.999999);
      expect(fsm.calculateBackoffDelay(5)).toBe(4000);

      // attempt 20: huge attempt bounded by maxDelay
      expect(fsm.calculateBackoffDelay(20)).toBe(4000);

      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      // floor(0.5 * (4000 + 1)) = floor(2000.5) = 2000
      expect(fsm.calculateBackoffDelay(5)).toBe(2000);
    });

    it('defaults to internal retryCount when attempt argument is omitted', () => {
      const fsm = new LifecycleFSM({ baseDelay: 100, maxDelay: 5000, maxRetries: 3 });
      vi.spyOn(Math, 'random').mockReturnValue(0.999999);

      // Initially retryCount is 0 -> 100 * 2^0 = 100
      expect(fsm.calculateBackoffDelay()).toBe(100);

      // 1st error -> retryCount becomes 1 -> 100 * 2^1 = 200
      fsm.recordError(new Error('err 1'));
      expect(fsm.retryCount).toBe(1);
      expect(fsm.calculateBackoffDelay()).toBe(200);

      // 2nd error -> retryCount becomes 2 -> 100 * 2^2 = 400
      fsm.recordError(new Error('err 2'));
      expect(fsm.retryCount).toBe(2);
      expect(fsm.calculateBackoffDelay()).toBe(400);
    });

    it('statistically respects boundary ranges over repeated random samples', () => {
      const fsm = new LifecycleFSM({ baseDelay: 200, maxDelay: 1000 });

      for (let i = 0; i < 100; i++) {
        const delay0 = fsm.calculateBackoffDelay(0);
        expect(delay0).toBeGreaterThanOrEqual(0);
        expect(delay0).toBeLessThanOrEqual(200);
        expect(Number.isInteger(delay0)).toBe(true);

        const delay2 = fsm.calculateBackoffDelay(2); // 200 * 4 = 800
        expect(delay2).toBeGreaterThanOrEqual(0);
        expect(delay2).toBeLessThanOrEqual(800);
        expect(Number.isInteger(delay2)).toBe(true);

        const delay10 = fsm.calculateBackoffDelay(10); // Capped at 1000
        expect(delay10).toBeGreaterThanOrEqual(0);
        expect(delay10).toBeLessThanOrEqual(1000);
        expect(Number.isInteger(delay10)).toBe(true);
      }
    });
  });

  describe('5. Success Transitions', () => {
    it('recordSuccess(data) transitions to success and resets retry counter', () => {
      const fsm = new LifecycleFSM<{ id: string; name: string }>();
      fsm.startLoading();
      fsm.recordError(new Error('transient failure 1'));
      fsm.recordError(new Error('transient failure 2'));
      expect(fsm.retryCount).toBe(2);
      expect(fsm.error).toBeDefined();

      const payload = { id: 'usr_1', name: 'Alice' };
      const status = fsm.recordSuccess(payload);

      expect(status).toBe('success');
      expect(fsm.state).toBe('success');
      expect(fsm.isSuccess).toBe(true);
      expect(fsm.data).toEqual(payload);
      expect(fsm.error).toBeUndefined();
      expect(fsm.retryCount).toBe(0);
    });
  });

  describe('6. Reset', () => {
    it('reset() restores idle state, clears data, error, and resets retry counter', () => {
      const fsm = new LifecycleFSM<string>();
      fsm.startLoading();
      fsm.recordError(new Error('fail'));
      fsm.recordSuccess('data');
      expect(fsm.state).toBe('success');
      expect(fsm.data).toBe('data');

      fsm.reset();

      expect(fsm.state).toBe('idle');
      expect(fsm.isIdle).toBe(true);
      expect(fsm.retryCount).toBe(0);
      expect(fsm.data).toBeUndefined();
      expect(fsm.error).toBeUndefined();
    });

    it('reset() works cleanly from error state', () => {
      const fsm = new LifecycleFSM({ maxRetries: 1 });
      fsm.startLoading();
      fsm.recordError(new Error('err1'));
      fsm.recordError(new Error('err2'));
      expect(fsm.state).toBe('error');

      fsm.reset();

      expect(fsm.state).toBe('idle');
      expect(fsm.retryCount).toBe(0);
      expect(fsm.error).toBeUndefined();
    });
  });

  describe('7. Full Lifecycle Scenarios', () => {
    it('scenario A: idle -> loading -> retrying (x2) -> success -> idle', () => {
      const fsm = new LifecycleFSM<number>({ maxRetries: 3 });

      expect(fsm.state).toBe('idle');

      fsm.startLoading();
      expect(fsm.state).toBe('loading');

      fsm.recordError(new Error('timeout 1'));
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(1);

      fsm.startLoading();
      expect(fsm.state).toBe('loading');

      fsm.recordError(new Error('timeout 2'));
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(2);

      fsm.startLoading();
      expect(fsm.state).toBe('loading');

      fsm.recordSuccess(42);
      expect(fsm.state).toBe('success');
      expect(fsm.data).toBe(42);
      expect(fsm.retryCount).toBe(0);

      fsm.reset();
      expect(fsm.state).toBe('idle');
      expect(fsm.data).toBeUndefined();
    });

    it('scenario B: idle -> loading -> retrying (x2) -> error -> reset', () => {
      const fsm = new LifecycleFSM({ maxRetries: 2 });

      expect(fsm.state).toBe('idle');

      fsm.startLoading();
      expect(fsm.state).toBe('loading');

      fsm.recordError(new Error('err 1'));
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(1);

      fsm.startLoading();
      fsm.recordError(new Error('err 2'));
      expect(fsm.state).toBe('retrying');
      expect(fsm.retryCount).toBe(2);

      fsm.startLoading();
      fsm.recordError(new Error('err 3'));
      expect(fsm.state).toBe('error');
      expect(fsm.retryCount).toBe(2);

      fsm.reset();
      expect(fsm.state).toBe('idle');
      expect(fsm.retryCount).toBe(0);
    });
  });
});
