import React, { useId, useState } from "react";
import type { QueryStatus } from "@montionugera/ucsa-core";
import { LIFECYCLE_EDGES, LIFECYCLE_STATES, applyEdge, attemptOf, findEdge, fsmAt } from "../models/lifecycle-graph.js";
import "./LifecycleGraph.css";

const POS: Record<QueryStatus, { x: number; y: number }> = {
  idle: { x: 60, y: 160 },
  loading: { x: 220, y: 160 },
  success: { x: 420, y: 50 },
  retrying: { x: 420, y: 160 },
  error: { x: 420, y: 270 }
};
const R = 34;

function edgePath(from: QueryStatus, to: QueryStatus): string {
  const a = POS[from];
  const b = POS[to];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const sx = a.x + ux * R;
  const sy = a.y + uy * R;
  const ex = b.x - ux * (R + 4);
  const ey = b.y - uy * (R + 4);
  const cx = (sx + ex) / 2 - uy * 20;
  const cy = (sy + ey) / 2 + ux * 20;
  return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
}

interface LogEntry {
  id: number;
  text: string;
}

export function LifecycleGraph({ initialState = "idle" }: { initialState?: QueryStatus }) {
  const [fsm] = useState(() => fsmAt(initialState));
  const [state, setState] = useState<QueryStatus>(fsm.state);
  const arrowId = `lc-arrow-${useId().replace(/:/g, "")}`;
  const [log, setLog] = useState<LogEntry[]>([]);

  function go(to: QueryStatus) {
    const edge = findEdge(fsm.state, to);
    if (!edge) return;
    const from = fsm.state;
    const attempt = attemptOf(fsm, edge);
    applyEdge(fsm, edge);
    setState(fsm.state);
    const call = attempt === undefined ? `${edge.method}()` : `${edge.method}(attempt ${attempt})`;
    setLog((l) => [...l, { id: l.length + 1, text: `${from} to ${fsm.state} via ${call}` }]);
  }

  return (
    <section className="lc" aria-labelledby="lc-title">
      <h3 id="lc-title" className="lc-title">Query lifecycle state graph</h3>
      <p className="lc-note">
        These edges are the intended lifecycle, an editorial choice of this page. The{" "}
        <code>LifecycleFSM</code> class itself accepts any call from any state, so the disabled buttons are a docs
        decision, not enforcement. <code>QueryEngine</code> does not use this class: it reports only loading, success
        or error.
      </p>
      <div className="lc-scroll" tabIndex={0} role="region" aria-label="Lifecycle state graph, scrollable">
        <svg
          className="lc-svg"
          viewBox="0 0 480 320"
          role="img"
          aria-label={`Lifecycle state graph with five states. Current state: ${state}. ${LIFECYCLE_EDGES.length} transitions, listed below.`}
        >
          <defs>
            <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" className="lc-arrow" />
            </marker>
          </defs>
          {LIFECYCLE_EDGES.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              d={edgePath(e.from, e.to)}
              className={`lc-edge${e.from === state ? " lc-edge-live" : ""}`}
              markerEnd={`url(#${arrowId})`}
            />
          ))}
          {LIFECYCLE_STATES.map((s) => (
            <g
              key={s}
              data-testid="lifecycle-node"
              data-state={s}
              aria-current={s === state ? "true" : undefined}
              className={`lc-node${s === state ? " lc-node-current" : ""}`}
            >
              <circle cx={POS[s].x} cy={POS[s].y} r={R} />
              <text x={POS[s].x} y={POS[s].y + 4} textAnchor="middle">
                {s}
              </text>
              {s === state && (
                <text x={POS[s].x} y={POS[s].y + R + 14} textAnchor="middle" className="lc-here">
                  current
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <p className="lc-current">
        Current state: <strong>{state}</strong>
      </p>
      <div className="lc-buttons" role="group" aria-label="Transitions from the current state">
        {LIFECYCLE_STATES.map((s) => (
          <button
            key={s}
            type="button"
            className="btn btn-secondary lc-btn"
            disabled={!findEdge(state, s)}
            onClick={() => go(s)}
          >
            Go to {s}
          </button>
        ))}
      </div>
      <details className="lc-edges">
        <summary>All {LIFECYCLE_EDGES.length} authored edges</summary>
        <ul>
          {LIFECYCLE_EDGES.map((e) => (
            <li key={`${e.from}>${e.to}`}>
              {e.from} to {e.to}: <code>{e.method}()</code>
            </li>
          ))}
        </ul>
      </details>
      <ol className="lc-log" role="log" aria-live="polite" aria-label="Transition log">
        {log.map((l) => (
          <li key={l.id}>{l.text}</li>
        ))}
      </ol>
    </section>
  );
}
