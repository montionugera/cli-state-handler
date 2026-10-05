import 'types.dart';

/// Checks deep equality between two values.
bool deepEqual(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a == null || b == null) return false;

  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return a == b;
}

/// Recursively compares `prev` and `next`.
/// - If `identical(prev, next)` or `deepEqual(prev, next)`, returns `prev` preserving exact reference.
/// - If both are Maps or Lists and all children are equal, returns `prev` preserving exact identity.
/// - If some children changed, copies unchanged child references into a new parent reference.
/// - Preserves primitive and unchanged object identities.
dynamic replaceEqualDeep(dynamic prev, dynamic next) {
  if (identical(prev, next)) return prev;

  if (prev is List && next is List) {
    final prevLen = prev.length;
    final nextLen = next.length;
    final copy = List<dynamic>.filled(nextLen, null, growable: true);
    var equalItems = 0;

    for (var i = 0; i < nextLen; i++) {
      final prevItem = i < prevLen ? prev[i] : null;
      final nextItem = next[i];
      final item =
          i < prevLen ? replaceEqualDeep(prevItem, nextItem) : nextItem;
      copy[i] = item;
      if (i < prevLen && identical(item, prev[i])) {
        equalItems++;
      }
    }

    if (prevLen == nextLen && equalItems == nextLen) {
      return prev;
    }
    return copy;
  }

  if (prev is Map && next is Map) {
    final copy = <String, dynamic>{};
    var equalItems = 0;

    for (final key in next.keys) {
      final strKey = key.toString();
      final prevVal = prev[key];
      final nextVal = next[key];
      final val =
          prev.containsKey(key) ? replaceEqualDeep(prevVal, nextVal) : nextVal;
      copy[strKey] = val;
      if (prev.containsKey(key) && identical(val, prevVal)) {
        equalItems++;
      }
    }

    if (prev.length == next.length && equalItems == next.length) {
      return prev;
    }
    return copy;
  }

  if (deepEqual(prev, next)) {
    return prev;
  }

  return next;
}

/// Checks if [target] matches [prefix].
/// A prefix match succeeds if target is at least as long as prefix,
/// and every prefix element matches target. Maps in prefix match if target contains
/// all key-values of prefix.
bool matchQueryKey(QueryKey prefix, QueryKey target) {
  if (prefix.length > target.length) {
    return false;
  }

  for (var i = 0; i < prefix.length; i++) {
    final p = prefix[i];
    final t = target[i];

    if (p is Map && t is Map) {
      for (final key in p.keys) {
        if (!t.containsKey(key)) return false;
        if (!deepEqual(p[key], t[key])) return false;
      }
    } else if (!deepEqual(p, t)) {
      return false;
    }
  }

  return true;
}
