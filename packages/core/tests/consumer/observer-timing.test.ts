import { describe, it, expect, vi } from 'vitest';
import { QueryEngine } from '../../src/query/query-engine.js';
import { createSelectorObserver } from '../../src/consumer/observer.js';

interface StockTick {
  symbol: string;
  price: number;
  sequence: number;
}

describe('SelectorObserver Timing Controls (Throttle & Debounce)', () => {
  it('throttles high-frequency updates to leading and trailing edge', async () => {
    vi.useFakeTimers();
    try {
      const engine = new QueryEngine();
      const queryKey = ['stocks', 'AAPL'];

      let tick: StockTick = { symbol: 'AAPL', price: 150.0, sequence: 1 };
      engine.setQueryData(queryKey, tick);

      let listenerCallCount = 0;
      let lastObservedPrice: number | undefined;

      const observer = createSelectorObserver<StockTick, number>(
        engine,
        queryKey,
        (s) => s.price,
        {
          throttleMs: 100,
        }
      );

      observer.subscribe(() => {
        listenerCallCount++;
        lastObservedPrice = observer.getSnapshot();
      });

      // Initially subscribed, count is 0 until updates occur
      expect(listenerCallCount).toBe(0);

      // 1. First update fires leading edge immediately
      tick = { symbol: 'AAPL', price: 151.0, sequence: 2 };
      engine.setQueryData(queryKey, tick);
      expect(listenerCallCount).toBe(1);
      expect(lastObservedPrice).toBe(151.0);

      // 2. Rapid intermediate updates within 100ms window are throttled
      vi.advanceTimersByTime(20);
      tick = { symbol: 'AAPL', price: 152.0, sequence: 3 };
      engine.setQueryData(queryKey, tick);

      vi.advanceTimersByTime(20);
      tick = { symbol: 'AAPL', price: 153.0, sequence: 4 };
      engine.setQueryData(queryKey, tick);

      vi.advanceTimersByTime(20);
      tick = { symbol: 'AAPL', price: 154.0, sequence: 5 };
      engine.setQueryData(queryKey, tick);

      // Still only 1 call (leading edge)
      expect(listenerCallCount).toBe(1);
      expect(lastObservedPrice).toBe(151.0);

      // 3. Advance to 100ms: trailing edge fires once with latest price (154.0)
      vi.advanceTimersByTime(40);
      expect(listenerCallCount).toBe(2);
      expect(lastObservedPrice).toBe(154.0);

      // 4. Advancing further without updates does NOT trigger another trailing call
      vi.advanceTimersByTime(200);
      expect(listenerCallCount).toBe(2);

      // 5. Subsequent update after window expires fires leading edge immediately again
      tick = { symbol: 'AAPL', price: 155.0, sequence: 6 };
      engine.setQueryData(queryKey, tick);
      expect(listenerCallCount).toBe(3);
      expect(lastObservedPrice).toBe(155.0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces rapid updates and fires only after quiet period', async () => {
    vi.useFakeTimers();
    try {
      const engine = new QueryEngine();
      const queryKey = ['search', 'input'];

      let queryState = { text: 'a' };
      engine.setQueryData(queryKey, queryState);

      let listenerCallCount = 0;
      let lastObservedText: string | undefined;

      const observer = createSelectorObserver<{ text: string }, string>(
        engine,
        queryKey,
        (s) => s.text,
        {
          debounceMs: 50,
        }
      );

      observer.subscribe(() => {
        listenerCallCount++;
        lastObservedText = observer.getSnapshot();
      });

      expect(listenerCallCount).toBe(0);

      // Rapid keystrokes every 10ms (resetting the 50ms timer each time)
      engine.setQueryData(queryKey, { text: 'ap' });
      vi.advanceTimersByTime(10);
      expect(listenerCallCount).toBe(0);

      engine.setQueryData(queryKey, { text: 'app' });
      vi.advanceTimersByTime(10);
      expect(listenerCallCount).toBe(0);

      engine.setQueryData(queryKey, { text: 'appl' });
      vi.advanceTimersByTime(10);
      expect(listenerCallCount).toBe(0);

      engine.setQueryData(queryKey, { text: 'apple' });
      // 0ms elapsed since last keystroke 'apple'
      expect(listenerCallCount).toBe(0);

      // Now quiet period begins: advance 49ms (still not 50ms)
      vi.advanceTimersByTime(49);
      expect(listenerCallCount).toBe(0);

      // Advance 1ms more (reaching 50ms quiet period)
      vi.advanceTimersByTime(1);
      expect(listenerCallCount).toBe(1);
      expect(lastObservedText).toBe('apple');

      // Further time does not fire again
      vi.advanceTimersByTime(100);
      expect(listenerCallCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribing cancels pending throttle or debounce timers', async () => {
    vi.useFakeTimers();
    try {
      const engine = new QueryEngine();
      const queryKey = ['search', 'input'];

      engine.setQueryData(queryKey, { text: 'init' });

      let listenerCallCount = 0;
      const observer = createSelectorObserver<{ text: string }, string>(
        engine,
        queryKey,
        (s) => s.text,
        {
          debounceMs: 50,
        }
      );

      const unsubscribe = observer.subscribe(() => {
        listenerCallCount++;
      });

      engine.setQueryData(queryKey, { text: 'new_text' });
      vi.advanceTimersByTime(20);

      // Unsubscribe during debounce window
      unsubscribe();

      // Advance past debounce window
      vi.advanceTimersByTime(100);

      // Listener was never called
      expect(listenerCallCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
