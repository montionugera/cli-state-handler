import React from "react";
import { parity, type ParityCell } from "../content/parity.js";
import { platforms, type PlatformId } from "../content/guides/index.js";
import "./multiplatform.css";

const COLUMN: Record<PlatformId, string> = { ts: "TypeScript", dart: "Dart", csharp: "Unity C#", godot: "Godot C#" };

function Cell({ cell }: { cell: ParityCell }) {
  return (
    <td className="mp-cell">
      <span className={`mp-level mp-level--${cell.level}`}>{cell.level}</span>
      {cell.reason && <p className="mp-reason">{cell.reason}</p>}
      <ul className="mp-sources" aria-label="Source files">
        {cell.sources.map((s) => (
          <li key={s}>
            <code>{s}</code>
          </li>
        ))}
      </ul>
    </td>
  );
}

export function ParityMatrix() {
  return (
    <div className="card mp">
      <h1 className="mp-title">Platform Parity Matrix</h1>
      <p className="mp-lead">
        How much of each subsystem exists on each platform, judged from the source files named in each cell. full means the
        same behaviour is present; partial says what is missing; none means no implementation was found.
      </p>
      <div className="mp-scroll" role="region" aria-label="Parity matrix, scrollable" tabIndex={0}>
        <table className="mp-table">
          <thead>
            <tr>
              <th scope="col">Subsystem</th>
              {platforms.map((p) => (
                <th scope="col" key={p}>
                  {COLUMN[p]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {parity.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="mp-rowhead">{row.subsystem}</th>
                {platforms.map((p) => (
                  <Cell key={p} cell={row.cells[p]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mp-lead">
        Side-by-side code for every row is in the <a href="#/multiplatform">TS / Dart / Unity C# guide</a>.
      </p>
    </div>
  );
}
