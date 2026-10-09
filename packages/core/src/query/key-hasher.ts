import type { QueryKey } from '../types.js';
import { isPlainObject } from './structural-sharing.js';

/**
 * Generates a deterministic hash for a QueryKey tuple.
 * Plain objects inside the tuple have their keys sorted to ensure consistent serialization.
 */
export function hashQueryKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey, (_key, val) => {
    if (isPlainObject(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = val[k];
          return acc;
        }, {});
    }
    return val;
  });
}
