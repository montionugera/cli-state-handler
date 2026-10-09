import { LifecycleFSM } from "@ucsa/core";
import type { QueryStatus } from "@ucsa/core";

export const LIFECYCLE_STATES: readonly QueryStatus[] = ["idle", "loading", "success", "retrying", "error"];

/** Real LifecycleFSM methods that perform a transition. */
export type FsmMethod = "startLoading" | "recordSuccess" | "recordError" | "reset";

export interface LifecycleEdge {
  from: QueryStatus;
  to: QueryStatus;
  method: FsmMethod;
  /** recordError only: "first" = attempt 0 (retries remain), "last" = attempt maxRetries (exhausted). */
  attempt?: "first" | "last";
}

/**
 * Hand-authored edges: the intended lifecycle, an editorial choice of this
 * docs page. LifecycleFSM itself has no guards and no transition table (it
 * accepts any call from any state), and QueryEngine does not use it. Tests
 * prove only that each edge's method lands on its target state.
 */
export const LIFECYCLE_EDGES: readonly LifecycleEdge[] = [
  { from: "idle", to: "loading", method: "startLoading" },
  { from: "loading", to: "success", method: "recordSuccess" },
  { from: "loading", to: "retrying", method: "recordError", attempt: "first" },
  { from: "loading", to: "error", method: "recordError", attempt: "last" },
  { from: "retrying", to: "loading", method: "startLoading" },
  { from: "retrying", to: "success", method: "recordSuccess" },
  { from: "retrying", to: "error", method: "recordError", attempt: "last" },
  { from: "success", to: "loading", method: "startLoading" },
  { from: "success", to: "idle", method: "reset" },
  { from: "error", to: "loading", method: "startLoading" },
  { from: "error", to: "idle", method: "reset" }
];

export function findEdge(from: QueryStatus, to: QueryStatus): LifecycleEdge | undefined {
  return LIFECYCLE_EDGES.find((e) => e.from === from && e.to === to);
}

/** The attempt number passed to recordError for this edge, or undefined for other methods. */
export function attemptOf(fsm: LifecycleFSM, edge: LifecycleEdge): number | undefined {
  if (edge.method !== "recordError") return undefined;
  return edge.attempt === "last" ? fsm.maxRetries : 0;
}

/** Calls the FSM method named by the edge. Returns the FSM's own resulting state. */
export function applyEdge(fsm: LifecycleFSM, edge: LifecycleEdge): QueryStatus {
  switch (edge.method) {
    case "startLoading":
      return fsm.startLoading();
    case "recordSuccess":
      return fsm.recordSuccess({});
    case "recordError":
      return fsm.recordError(new Error("simulated failure"), attemptOf(fsm, edge) ?? 0);
    case "reset":
      fsm.reset();
      return fsm.state;
  }
}

/** Builds a real FSM sitting in `target`, using only authored methods. */
export function fsmAt(target: QueryStatus): LifecycleFSM {
  const fsm = new LifecycleFSM();
  if (target === "loading") fsm.startLoading();
  if (target === "success") fsm.recordSuccess({});
  if (target === "retrying") fsm.recordError(new Error("simulated failure"), 0);
  if (target === "error") fsm.recordError(new Error("simulated failure"), fsm.maxRetries);
  return fsm;
}
