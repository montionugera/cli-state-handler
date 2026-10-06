import { describe, it, expect, vi } from 'vitest';
import { QueryEngine, debounceQuery } from '../../src/index.js';

describe('Query Execution Debouncing & Cancellation', () => {
  it('collapses rapid fetchQuery calls within debounce window into a single execution', async () => {
    vi.useFakeTimers();
    try {
      const engine = new QueryEngine();
      const queryKey = ['search', 'users'];

      let executionCount = 0;
      const fetchFn = (term: string) => async () => {
        executionCount++;
        return { term, results: [`User for ${term}`] };
      };

      // Call 1 at t=0
      const p1 = engine.fetchQuery(queryKey, fetchFn('a'), { debounceMs: 50 });
      expect(executionCount).toBe(0);

      // Call 2 at t=20
      vi.advanceTimersByTime(20);
      const p2 = engine.fetchQuery(queryKey, fetchFn('ab'), { debounceMs: 50 });
      expect(executionCount).toBe(0);

      // Call 3 at t=40
      vi.advanceTimersByTime(20);
      const p3 = engine.fetchQuery(queryKey, fetchFn('abc'), { debounceMs: 50 });
      expect(executionCount).toBe(0);

      // Advance 49ms from Call 3 (t=89ms total)
      vi.advanceTimersByTime(49);
      expect(executionCount).toBe(0);

      // Advance 1ms (reaching 50ms quiet period after Call 3)
      vi.advanceTimersByTime(1);
      expect(executionCount).toBe(1);

      // All promises resolve with the latest execution result
      const [res1, res2, res3] = await Promise.all([p1, p2, p3]);
      expect(res1.term).toBe('abc');
      expect(res2.term).toBe('abc');
      expect(res3.term).toBe('abc');
      expect(executionCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending debounce timer when cancelQuery is called', async () => {
    vi.useFakeTimers();
    try {
      const engine = new QueryEngine();
      const queryKey = ['search', 'canceled'];

      let executed = false;
      const p = engine.fetchQuery(
        queryKey,
        async () => {
          executed = true;
          return 'ok';
        },
        { debounceMs: 50 }
      );

      vi.advanceTimersByTime(20);
      expect(executed).toBe(false);

      // Cancel query before debounce timer expires
      engine.cancelQuery(queryKey);

      // Advance past the debounce window
      vi.advanceTimersByTime(100);
      expect(executed).toBe(false);

      // Promise should be rejected with cancellation error
      await expect(p).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounceQuery helper wraps engine debounced queries seamlessly', async () => {
    vi.useFakeTimers();
    try {
      const engine = new QueryEngine();
      const queryKey = ['helper', 'test'];

      let callCount = 0;
      const p1 = debounceQuery(
        engine,
        queryKey,
        async () => {
          callCount++;
          return 'first';
        },
        { debounceMs: 40 }
      );

      vi.advanceTimersByTime(20);

      const p2 = debounceQuery(
        engine,
        queryKey,
        async () => {
          callCount++;
          return 'second';
        },
        { debounceMs: 40 }
      );

      vi.advanceTimersByTime(40);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(callCount).toBe(1);
      expect(r1).toBe('second');
      expect(r2).toBe('second');
    } finally {
      vi.useRealTimers();
    }
  });
});
