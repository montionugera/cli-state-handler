import React, { useEffect, useRef, useState } from "react";
import "./wal-visualiser.css";
import {
  createState,
  write,
  commit,
  openReader,
  closeReader,
  checkpoint,
  crash,
  recover,
  setMode,
  readerView,
  type JournalMode,
  type OpResult,
  type WalState,
} from "../models/wal-model.js";

interface LogEntry {
  id: number;
  ok: boolean;
  message: string;
}

const JOURNAL_MODES: readonly JournalMode[] = ["WAL", "DELETE"];

export function WalVisualiser({ headingLevel: Title = "h1" }: { headingLevel?: "h1" | "h2" } = {}) {
  const [state, setState] = useState<WalState>(() => createState());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [key, setKey] = useState("counter");
  const [value, setValue] = useState("2");
  const nextLogId = useRef(0);
  const logEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: "nearest" });
  }, [log]);

  const run = (op: (s: WalState) => OpResult) => {
    const result = op(state);
    setState(result.state);
    const entry: LogEntry = { id: nextLogId.current++, ok: result.event.ok, message: result.event.message };
    setLog((prev) => [...prev, entry].slice(-30));
  };

  const reset = () => {
    setState(createState());
    setLog([]);
  };

  const mainKeys = Object.keys(state.main);

  return (
    <div className="wal">
      <Title className="wal__title">SQLite WAL Storage Visualiser</Title>
      <p className="wal__sim" role="note">
        <strong>Simulation — not a real SQLite engine.</strong> SQLite (a Node native addon) cannot run in this
        browser bundle, so this page replays the rules in a small model. It illustrates the adapter&apos;s{" "}
        <code>journalMode</code> option (WAL for file databases, MEMORY for <code>:memory:</code>), its{" "}
        <code>checkpoint(mode)</code> method that runs <code>wal_checkpoint</code>, and the exit-time flush in{" "}
        <code>cli/durability.ts</code> (all under <code>packages/core/src</code>, see{" "}
        <code>storage/sqlite-adapter.ts</code>).
      </p>

      <div className="wal__controls">
        <label className="wal__field">
          <span>Key</span>
          <input value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="wal__field">
          <span>Value</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <fieldset className="wal__mode">
          <legend>Journal mode</legend>
          {JOURNAL_MODES.map((m) => (
            <label key={m} className="wal__radio">
              <input
                type="radio"
                name="journal-mode"
                checked={state.mode === m}
                onChange={() => run((s) => setMode(s, m))}
              />
              {m === "WAL" ? "WAL" : "DELETE (rollback journal)"}
            </label>
          ))}
        </fieldset>
        <p className="wal__note">
          DELETE mode here is a simplified contrast: readers and the writer exclude each other for the whole
          transaction, whereas real SQLite only takes the exclusive lock when it first changes the file. The simulated
          WAL checkpoint behaves like TRUNCATE mode, which is this library&apos;s adapter default (the WAL is reset
          to empty once fully copied).
        </p>
      </div>

      <div className="wal__buttons">
        <button type="button" onClick={() => run((s) => write(s, key.trim() || "counter", value))}>Write</button>
        <button type="button" onClick={() => run(commit)}>Commit</button>
        <button type="button" onClick={() => run(openReader)}>Open reader</button>
        <button type="button" onClick={() => run(checkpoint)}>Checkpoint</button>
        <button type="button" className="wal__danger" onClick={() => run(crash)}>Crash</button>
        <button type="button" onClick={() => run(recover)}>Recover</button>
        <button type="button" onClick={reset}>Reset</button>
      </div>

      <p className="wal__status">
        Mode: <strong>{state.mode}</strong>
        {state.txnOpen ? " · write transaction open" : " · no write transaction"}
        {state.crashed ? " · CRASHED (run recovery)" : ""}
      </p>

      <div className="wal__panels">
        <section className="wal__panel" aria-label="Main file">
          <h2>Main database file</h2>
          <div className="wal__scroll">
            <table>
              <thead>
                <tr><th scope="col">Key</th><th scope="col">Value</th></tr>
              </thead>
              <tbody>
                {mainKeys.map((k) => (
                  <tr key={k}><td>{k}</td><td>{state.main[k]}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.mode === "DELETE" && (
            <div className="wal__journal">
              <h3>Rollback journal (original pages saved for rollback)</h3>
              {state.pending.length === 0 ? (
                <p>Journal is not in use.</p>
              ) : (
                <ul>
                  {state.pending.map((f, i) => (
                    <li key={i}>{f.original === null ? `${f.key} = (absent)` : `${f.key} = ${f.original}`}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="wal__panel" aria-label="WAL">
          <h2>Write-ahead log</h2>
          {state.wal.length === 0 ? (
            <p>{state.mode === "WAL" ? "WAL is empty." : "WAL is empty (not used in DELETE mode)."}</p>
          ) : (
            <div className="wal__scroll">
              <table>
                <thead>
                  <tr><th scope="col">#</th><th scope="col">Key</th><th scope="col">Value</th><th scope="col">Status</th></tr>
                </thead>
                <tbody>
                  {state.wal.map((f, i) => {
                    const status =
                      i >= state.committedLen ? "uncommitted" : i < state.checkpointed ? "committed, copied to main" : "committed";
                    return (
                      <tr key={i} className={i >= state.committedLen ? "wal__row--pending" : undefined}>
                        <td>{i + 1}</td><td>{f.key}</td><td>{f.value}</td><td>{status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="wal__panel" aria-label="Readers">
          <h2>Readers</h2>
          {state.readers.length === 0 ? (
            <p>No open readers.</p>
          ) : (
            <ul className="wal__readers">
              {state.readers.map((r) => {
                const view = readerView(state, r.id) ?? {};
                return (
                  <li key={r.id}>
                    <div className="wal__reader-head">
                      <span>{`Reader ${r.id} (snapshot mark ${r.mark})`}</span>
                      <button type="button" aria-label={`Close reader ${r.id}`} onClick={() => run((s) => closeReader(s, r.id))}>
                        Close
                      </button>
                    </div>
                    <div className="wal__view">
                      {Object.keys(view).map((k) => (
                        <span key={k}>{`${k} = ${view[k]}`}</span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <h2 className="wal__log-title">Event log</h2>
      <ul className="wal__log" role="log" aria-label="Event log">
        {log.length === 0 && <li>No events yet.</li>}
        {log.map((e) => (
          <li key={e.id} data-id={e.id}>
            <strong>{e.ok ? "OK" : "Rejected"}:</strong> {e.message}
          </li>
        ))}
        <li ref={logEnd} aria-hidden="true" />
      </ul>
    </div>
  );
}
