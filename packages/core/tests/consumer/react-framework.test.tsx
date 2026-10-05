// @vitest-environment jsdom
import React, { useMemo, useSyncExternalStore, useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { QueryEngine, createSelectorObserver, SqliteAdapter } from '../../src/index.js';

interface UserState {
  id: string;
  name: string;
  avatarUrl: string;
  lastLoginTimestamp: number;
}

/**
 * Idiomatic React Hook consuming UCSA via standard React 18/19 useSyncExternalStore.
 */
function useUcsaSelector<TData, TSelected>(
  engine: QueryEngine,
  queryKey: (string | number)[],
  selector: (data: TData) => TSelected
): TSelected | undefined {
  const observer = useMemo(
    () => createSelectorObserver(engine, queryKey, selector),
    [engine, JSON.stringify(queryKey)]
  );

  return useSyncExternalStore(
    observer.subscribe,
    observer.getSnapshot,
    observer.getSnapshot
  );
}

describe('React Framework Integration (useSyncExternalStore)', () => {
  it('mounts real React components and eliminates re-renders when unselected slices update', async () => {
    const engine = new QueryEngine();
    const queryKey = ['users', 'user-42'];

    let serverData: UserState = {
      id: 'user-42',
      name: 'Alice',
      avatarUrl: 'https://cdn.example.com/alice.png',
      lastLoginTimestamp: 1000,
    };

    const fetchUser = async () => ({ ...serverData });

    // Pre-populate query
    await engine.fetchQuery(queryKey, fetchUser);

    // Component tracking render count
    let renderCount = 0;
    function UserNameDisplay() {
      renderCount++;
      const name = useUcsaSelector<UserState, string>(
        engine,
        queryKey,
        (user) => user.name
      );

      return (
        <div>
          <span data-testid="user-name">{name}</span>
          <span data-testid="render-count">{renderCount}</span>
        </div>
      );
    }

    // Mount real React component
    const { rerender } = render(<UserNameDisplay />);

    // 1. Initial render
    expect(screen.getByTestId('user-name').textContent).toBe('Alice');
    expect(screen.getByTestId('render-count').textContent).toBe('1');
    expect(renderCount).toBe(1);

    // 2. Revalidation with identical data: React re-renders ZERO times
    await act(async () => {
      await engine.fetchQuery(queryKey, fetchUser);
    });
    expect(renderCount).toBe(1);
    expect(screen.getByTestId('render-count').textContent).toBe('1');

    // 3. Revalidation changing unselected field (lastLoginTimestamp 1000 -> 9999):
    // React re-renders ZERO times!
    serverData = { ...serverData, lastLoginTimestamp: 9999 };
    await act(async () => {
      await engine.fetchQuery(queryKey, fetchUser);
    });
    expect(renderCount).toBe(1);
    expect(screen.getByTestId('render-count').textContent).toBe('1');

    // 4. Revalidation changing selected field (name: 'Alice' -> 'Alice Smith'):
    // React re-renders exactly ONCE and updates DOM!
    serverData = { ...serverData, name: 'Alice Smith' };
    await act(async () => {
      await engine.fetchQuery(queryKey, fetchUser);
    });
    expect(renderCount).toBe(2);
    expect(screen.getByTestId('user-name').textContent).toBe('Alice Smith');
    expect(screen.getByTestId('render-count').textContent).toBe('2');
  });
});
