import { describe, it, expect, vi } from 'vitest';
import { QueryEngine } from '../../src/query/query-engine.js';
import { createSelectorObserver } from '../../src/consumer/observer.js';
import type { QueryKey } from '../../src/types.js';

interface UserProfile {
  user: {
    id: string;
    name: string;
    role: string;
  };
  settings: {
    theme: string;
    notifications: boolean;
  };
  timestamp: number;
}

describe('Task 1: Re-render Benchmark & Structural Sharing Verification', () => {
  it('verifies exact render counts across initial fetch, identical revalidations, unselected updates, selected updates, and rapid bursts', async () => {
    const engine = new QueryEngine();
    const queryKey: QueryKey = ['users', 'profile', 'usr_001'];

    // Selector only extracts user.name
    const observer = createSelectorObserver(
      engine,
      queryKey,
      (data: UserProfile) => data.user.name
    );

    let renderCount = 0;
    const renders: string[] = [];

    const unsubscribe = observer.subscribe(() => {
      renderCount++;
      const val = observer.getSnapshot();
      if (val !== undefined) {
        renders.push(val);
      }
    });

    // 0. Before initial fetch: snapshot is undefined, renderCount is 0
    expect(renderCount).toBe(0);
    expect(observer.getSnapshot()).toBeUndefined();

    // 1. Initial fetch: listener called 1 time on data load
    await engine.fetchQuery(queryKey, async () => ({
      user: { id: 'usr_001', name: 'Alice', role: 'admin' },
      settings: { theme: 'dark', notifications: true },
      timestamp: 1000,
    }));

    expect(renderCount).toBe(1);
    expect(observer.getSnapshot()).toBe('Alice');
    expect(renders).toEqual(['Alice']);

    // 2. Background revalidation bringing identical payload: listener called 0 additional times
    await engine.fetchQuery(queryKey, async () => ({
      user: { id: 'usr_001', name: 'Alice', role: 'admin' },
      settings: { theme: 'dark', notifications: true },
      timestamp: 1000,
    }));

    expect(renderCount).toBe(1);
    expect(observer.getSnapshot()).toBe('Alice');
    expect(renders).toEqual(['Alice']);

    // 3. Background revalidation changing an unselected field (timestamp and theme changed):
    // listener called 0 additional times (render count stays 1)
    await engine.fetchQuery(queryKey, async () => ({
      user: { id: 'usr_001', name: 'Alice', role: 'admin' },
      settings: { theme: 'light', notifications: true },
      timestamp: 2000,
    }));

    expect(renderCount).toBe(1);
    expect(observer.getSnapshot()).toBe('Alice');
    expect(renders).toEqual(['Alice']);

    // 4. Background revalidation changing the selected field (user.name changed to Bob):
    // listener called exactly 1 additional time (render count becomes 2)
    await engine.fetchQuery(queryKey, async () => ({
      user: { id: 'usr_001', name: 'Bob', role: 'admin' },
      settings: { theme: 'light', notifications: true },
      timestamp: 3000,
    }));

    expect(renderCount).toBe(2);
    expect(observer.getSnapshot()).toBe('Bob');
    expect(renders).toEqual(['Alice', 'Bob']);

    // 5. Rapid bursts: 10 background revalidations in sequence with identical data result in 0 re-renders
    for (let i = 0; i < 10; i++) {
      await engine.fetchQuery(queryKey, async () => ({
        user: { id: 'usr_001', name: 'Bob', role: 'admin' },
        settings: { theme: 'light', notifications: true },
        timestamp: 3000,
      }));
    }

    expect(renderCount).toBe(2);
    expect(observer.getSnapshot()).toBe('Bob');
    expect(renders).toEqual(['Alice', 'Bob']);

    // 6. Rapid bursts modifying unselected fields: 10 background revalidations altering timestamp only
    for (let i = 0; i < 10; i++) {
      await engine.fetchQuery(queryKey, async () => ({
        user: { id: 'usr_001', name: 'Bob', role: 'admin' },
        settings: { theme: 'light', notifications: true },
        timestamp: 4000 + i * 100,
      }));
    }

    // Render count must remain 2 despite 10 payload updates because user.name was unchanged
    expect(renderCount).toBe(2);
    expect(observer.getSnapshot()).toBe('Bob');
    expect(renders).toEqual(['Alice', 'Bob']);

    unsubscribe();
  });

  it('guarantees structural sharing preservation for object slices (referential stability)', async () => {
    const engine = new QueryEngine();
    const queryKey: QueryKey = ['users', 'profile', 'usr_002'];

    // Selector extracts user object { id, name, role }
    const observer = createSelectorObserver(
      engine,
      queryKey,
      (data: UserProfile) => data.user
    );

    let renderCount = 0;
    const snapshots: Array<{ id: string; name: string; role: string }> = [];

    const unsubscribe = observer.subscribe(() => {
      renderCount++;
      const snap = observer.getSnapshot();
      if (snap) {
        snapshots.push(snap);
      }
    });

    // Initial load
    await engine.fetchQuery(queryKey, async () => ({
      user: { id: 'usr_002', name: 'Carol', role: 'member' },
      settings: { theme: 'dark', notifications: true },
      timestamp: 100,
    }));

    expect(renderCount).toBe(1);
    const initialUserSnapshot = observer.getSnapshot();
    expect(initialUserSnapshot).toEqual({
      id: 'usr_002',
      name: 'Carol',
      role: 'member',
    });

    // Update settings only
    await engine.fetchQuery(queryKey, async () => ({
      user: { id: 'usr_002', name: 'Carol', role: 'member' },
      settings: { theme: 'system', notifications: false },
      timestamp: 200,
    }));

    // Zero additional renders
    expect(renderCount).toBe(1);
    // Exact same reference preserved via structural sharing
    expect(observer.getSnapshot()).toBe(initialUserSnapshot);

    // Update user role -> 1 additional render
    await engine.fetchQuery(queryKey, async () => ({
      user: { id: 'usr_002', name: 'Carol', role: 'admin' },
      settings: { theme: 'system', notifications: false },
      timestamp: 300,
    }));

    expect(renderCount).toBe(2);
    expect(observer.getSnapshot()).toEqual({
      id: 'usr_002',
      name: 'Carol',
      role: 'admin',
    });
    expect(observer.getSnapshot()).not.toBe(initialUserSnapshot);

    unsubscribe();
  });

  it('provides independent selector isolation across multiple consumers', async () => {
    const engine = new QueryEngine();
    const queryKey: QueryKey = ['feed', 'active'];

    interface FeedData {
      title: string;
      counter: number;
      tags: string[];
    }

    const titleObserver = createSelectorObserver(
      engine,
      queryKey,
      (data: FeedData) => data.title
    );
    const counterObserver = createSelectorObserver(
      engine,
      queryKey,
      (data: FeedData) => data.counter
    );

    let titleRenders = 0;
    let counterRenders = 0;

    const unsubTitle = titleObserver.subscribe(() => {
      titleRenders++;
    });
    const unsubCounter = counterObserver.subscribe(() => {
      counterRenders++;
    });

    // 1. Initial load
    await engine.fetchQuery(queryKey, async () => ({
      title: 'Breaking News',
      counter: 1,
      tags: ['top'],
    }));

    expect(titleRenders).toBe(1);
    expect(counterRenders).toBe(1);

    // 2. Increment counter only: title must not re-render
    await engine.fetchQuery(queryKey, async () => ({
      title: 'Breaking News',
      counter: 2,
      tags: ['top'],
    }));

    expect(titleRenders).toBe(1); // 0 additional renders
    expect(counterRenders).toBe(2); // 1 additional render

    // 3. Update title only: counter must not re-render
    await engine.fetchQuery(queryKey, async () => ({
      title: 'Updated Headline',
      counter: 2,
      tags: ['top'],
    }));

    expect(titleRenders).toBe(2); // 1 additional render
    expect(counterRenders).toBe(2); // 0 additional renders

    // 4. Update tags only: neither title nor counter must re-render
    await engine.fetchQuery(queryKey, async () => ({
      title: 'Updated Headline',
      counter: 2,
      tags: ['top', 'featured'],
    }));

    expect(titleRenders).toBe(2);
    expect(counterRenders).toBe(2);

    unsubTitle();
    unsubCounter();
  });

  it('supports options.queryFn with automatic fetch on subscribe', async () => {
    const engine = new QueryEngine();
    const queryKey: QueryKey = ['items', 'auto'];

    const queryFn = vi.fn().mockResolvedValue({ count: 42 });

    const observer = createSelectorObserver(
      engine,
      queryKey,
      (data: { count: number }) => data.count,
      { queryFn }
    );

    expect(observer.getSnapshot()).toBeUndefined();
    expect(queryFn).not.toHaveBeenCalled();

    let renderCount = 0;
    const unsub = observer.subscribe(() => {
      renderCount++;
    });

    // Auto fetch triggered on subscription
    expect(queryFn).toHaveBeenCalledTimes(1);

    // Wait for the async fetch to settle
    await vi.waitFor(() => {
      expect(renderCount).toBe(1);
    });

    expect(observer.getSnapshot()).toBe(42);

    unsub();
  });

  it('respects unsubscription and ceases listener notifications', async () => {
    const engine = new QueryEngine();
    const queryKey: QueryKey = ['ephemeral', 'test'];

    const observer = createSelectorObserver(
      engine,
      queryKey,
      (data: { value: number }) => data.value
    );

    let renderCount = 0;
    const unsub = observer.subscribe(() => {
      renderCount++;
    });

    await engine.fetchQuery(queryKey, async () => ({ value: 1 }));
    expect(renderCount).toBe(1);

    unsub();

    await engine.fetchQuery(queryKey, async () => ({ value: 2 }));
    expect(renderCount).toBe(1); // Did not increase
  });

  it('supports custom isEqual comparison logic', async () => {
    const engine = new QueryEngine();
    const queryKey: QueryKey = ['geometry', 'point'];

    interface Point {
      x: number;
      y: number;
    }

    // Custom isEqual that treats points within distance 1.0 as equal (deadband)
    const observer = createSelectorObserver(
      engine,
      queryKey,
      (data: Point) => data,
      {
        isEqual: (a, b) => {
          if (!a || !b) return a === b;
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          return dist < 1.0;
        },
      }
    );

    let renderCount = 0;
    const unsub = observer.subscribe(() => {
      renderCount++;
    });

    // Initial point (0, 0)
    await engine.fetchQuery(queryKey, async () => ({ x: 0, y: 0 }));
    expect(renderCount).toBe(1);

    // Micro jitter (0.2, 0.3) -> dist ~ 0.36 < 1.0 -> no render
    await engine.fetchQuery(queryKey, async () => ({ x: 0.2, y: 0.3 }));
    expect(renderCount).toBe(1);

    // Significant move (2.0, 2.0) -> dist > 1.0 -> render
    await engine.fetchQuery(queryKey, async () => ({ x: 2.0, y: 2.0 }));
    expect(renderCount).toBe(2);

    unsub();
  });
});
