/**
 * Mirrors the QueryEngine write-time stamps. On a successful fetch the engine
 * sets `stale_at = fetchedAt + staleTime` and `expires_at = fetchedAt + gcTime`;
 * both are fixed at write time and no observer or subscriber influences them.
 *
 * Phase rule, given a caller-controlled clock in ms:
 *   - empty    if the query was never fetched;
 *   - expired  when now > fetchedAt + gcTime (checked first, so it wins even
 *              if staleTime is larger than gcTime);
 *   - fresh    when now < fetchedAt + staleTime;
 *   - stale    otherwise.
 *
 * Note: the real engine evaluates staleness only when a read happens, and
 * checks expiry lazily when a record is hydrated from SQLite. This model
 * reports what a read at `now` would see.
 */
export interface TimelineState {
  fetchedAt: number | null;
  staleTime: number;
  gcTime: number;
}

export type TimelinePhase = "empty" | "fresh" | "stale" | "expired";

export function phaseAt(s: TimelineState, now: number): TimelinePhase {
  if (s.fetchedAt === null) return "empty";
  if (now > s.fetchedAt + s.gcTime) return "expired";
  return now < s.fetchedAt + s.staleTime ? "fresh" : "stale";
}
