import type {
  QueryEngine,
  QueryFunction,
  QueryOptions,
} from '../query/query-engine.js';
import type { QueryKey } from '../types.js';
import { replaceEqualDeep } from '../query/structural-sharing.js';

export interface SelectorObserver<TSelected> {
  /**
   * Synchronously returns the current selected slice snapshot.
   */
  getSnapshot: () => TSelected | undefined;

  /**
   * Subscribes a listener to changes in the selected slice.
   * Only called when the selected slice value actually changes.
   * Returns an unsubscribe function.
   */
  subscribe: (listener: () => void) => () => void;
}

export interface SelectorObserverOptions<TData, TSelected> {
  /**
   * Optional query function to fetch data if not present in cache.
   */
  queryFn?: QueryFunction<TData>;

  /**
   * Optional query options (e.g. staleTime, tags).
   */
  queryOptions?: QueryOptions;

  /**
   * Custom equality comparison function for selected slice.
   * Defaults to deep structural comparison preserving cached reference.
   */
  isEqual?: (prev: TSelected | undefined, next: TSelected | undefined) => boolean;
}

/**
 * Default equality comparator using Object.is and deep structural sharing check.
 */
export function defaultIsEqual<T>(a: T | undefined, b: T | undefined): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (a === undefined || b === undefined || a === null || b === null) {
    return false;
  }
  if (typeof a !== 'object' && typeof b !== 'object') {
    return false;
  }
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return replaceEqualDeep(a, b) === a;
}

/**
 * Creates a selector observer binding a QueryEngine query to UI subscriber models
 * (e.g. React useSyncExternalStore, Svelte 5 runes, Vue, CLI).
 *
 * Guarantees zero unnecessary notifications:
 * 1. Initial fetch: listener called 1 time on data load.
 * 2. Background revalidations with identical payload: listener called 0 additional times.
 * 3. Background revalidations modifying unselected fields: listener called 0 additional times.
 * 4. Background revalidations modifying selected slice: listener called exactly 1 additional time.
 */
export function createSelectorObserver<TData, TSelected>(
  engine: QueryEngine,
  queryKey: QueryKey,
  selector: (data: TData) => TSelected,
  options?: SelectorObserverOptions<TData, TSelected>
): SelectorObserver<TSelected> {
  const isEqual = options?.isEqual ?? defaultIsEqual;

  let currentData: TData | undefined = engine.getQueryData<TData>(queryKey);
  let currentSelected: TSelected | undefined =
    currentData !== undefined ? selector(currentData) : undefined;

  const listeners = new Set<() => void>();
  let unsubscribeEngine: (() => void) | undefined;

  function updateSelected(freshData: TData | undefined): boolean {
    if (freshData === currentData && currentSelected !== undefined) {
      return false;
    }
    currentData = freshData;
    const nextSelected =
      freshData !== undefined ? selector(freshData) : undefined;

    if (!isEqual(currentSelected, nextSelected)) {
      currentSelected =
        currentSelected !== undefined && nextSelected !== undefined
          ? replaceEqualDeep(currentSelected, nextSelected)
          : nextSelected;
      return true;
    }
    return false;
  }

  function handleEngineUpdate(): void {
    const freshData = engine.getQueryData<TData>(queryKey);
    const changed = updateSelected(freshData);
    if (changed) {
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (err) {
          console.error('Error in selector observer listener:', err);
        }
      }
    }
  }

  return {
    getSnapshot: () => {
      const freshData = engine.getQueryData<TData>(queryKey);
      if (freshData !== currentData) {
        updateSelected(freshData);
      }
      return currentSelected;
    },

    subscribe: (listener: () => void) => {
      listeners.add(listener);

      if (listeners.size === 1) {
        const freshData = engine.getQueryData<TData>(queryKey);
        updateSelected(freshData);

        unsubscribeEngine = engine.subscribe(queryKey, handleEngineUpdate);

        if (options?.queryFn && currentData === undefined) {
          engine
            .fetchQuery(queryKey, options.queryFn, options.queryOptions)
            .catch(() => {});
        }
      }

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribeEngine) {
          unsubscribeEngine();
          unsubscribeEngine = undefined;
        }
      };
    },
  };
}
