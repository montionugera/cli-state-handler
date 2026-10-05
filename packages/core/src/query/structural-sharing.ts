/**
 * Deep structural sharing utility for query cache payloads.
 * Conforms to TanStack Query structural sharing semantics.
 */

/**
 * Checks if a value is a plain JavaScript object (i.e. object literal or Object.create(null)).
 * Non-plain objects like Date, RegExp, Map, Set, or class instances are not plain objects.
 */
export function isPlainObject(
  value: unknown
): value is Record<string | number | symbol, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively compares `prev` and `next`.
 * - If `prev === next`, returns `prev`.
 * - If both are arrays/objects and all children are equal, returns `prev` preserving exact identity.
 * - If some children changed, copies unchanged child references into a new parent reference.
 * - Preserves primitive and non-plain object identities.
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (prev === next) {
    return prev as T;
  }

  const isPrevArr = Array.isArray(prev);
  const isNextArr = Array.isArray(next);

  if (isPrevArr && isNextArr) {
    const prevArr = prev as unknown[];
    const nextArr = next as unknown[];
    const nextLen = nextArr.length;
    const prevLen = prevArr.length;
    const copy: unknown[] = new Array(nextLen);
    let equalItems = 0;

    for (let i = 0; i < nextLen; i++) {
      copy[i] = replaceEqualDeep(prevArr[i], nextArr[i]);
      if (i < prevLen && copy[i] === prevArr[i]) {
        equalItems++;
      }
    }

    if (prevLen === nextLen && equalItems === nextLen) {
      return prev as T;
    }

    return copy as unknown as T;
  }

  if (isPrevArr || isNextArr) {
    return next;
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevObj = prev as Record<string, unknown>;
    const nextObj = next as Record<string, unknown>;
    const prevKeys = Object.keys(prevObj);
    const nextKeys = Object.keys(nextObj);
    const copy: Record<string, unknown> = {};
    let equalItems = 0;

    for (const key of nextKeys) {
      copy[key] = replaceEqualDeep(prevObj[key], nextObj[key]);
      if (
        copy[key] === prevObj[key] &&
        Object.prototype.hasOwnProperty.call(prevObj, key)
      ) {
        equalItems++;
      }
    }

    if (prevKeys.length === nextKeys.length && equalItems === nextKeys.length) {
      return prev as T;
    }

    return copy as T;
  }

  return next;
}
