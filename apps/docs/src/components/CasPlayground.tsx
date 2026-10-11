import React, { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Input } from "@montionugera/joy-react";
import { CasModel, type CasEntry } from "../models/cas-model.js";
import "./CasPlayground.css";

const INITIAL_BUDGET = 256;
const SHORT = (hash: string) => `${hash.slice(0, 8)}…`;

interface Snapshot {
  entries: CasEntry[];
  total: number;
}

export function CasPlayground() {
  const [model] = useState(() => new CasModel({ maxBytes: INITIAL_BUDGET }));
  const logId = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const payloads = useRef(new Map<string, string>());

  const [budget, setBudget] = useState(INITIAL_BUDGET);
  const [inputText, setInputText] = useState(
    "UCSA Native Engine Snapshot — Version 1.4.0 High-Performance Multiplatform Runtime",
  );
  const [snap, setSnap] = useState<Snapshot>({ entries: [], total: 0 });
  const [log, setLog] = useState<{ id: number; text: string }[]>([]);
  const [inspected, setInspected] = useState<{ hash: string; text: string } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Operations run strictly one after another so async hashing never interleaves.
  const enqueue = useCallback((job: () => Promise<string[]> | string[]) => {
    queueRef.current = queueRef.current.then(async () => {
      let messages: string[];
      try {
        messages = await job();
      } catch (err) {
        messages = [
          typeof crypto === "undefined" || !crypto.subtle
            ? "SHA-256 needs a secure context (https or localhost)."
            : `Operation failed: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
      if (!mountedRef.current) return;
      const m = model;
      const entries = m.entries();
      setSnap({ entries, total: m.totalBytes() });
      setInspected((cur) => (cur && entries.some((e) => e.hash === cur.hash) ? cur : null));
      if (messages.length > 0) {
        const items = messages.map((text) => ({ id: logId.current++, text }));
        setLog((prev) => [...items, ...prev].slice(0, 6));
      }
    });
  }, [model]);

  const handleStore = () => {
    const text = inputText;
    if (!text.trim()) return;
    enqueue(async () => {
      const r = await model.put(text);
      payloads.current.set(r.hash, text);
      const messages = [
        r.deduped
          ? `Deduplicated: ${SHORT(r.hash)} already stored, no new blob (${r.size} B).`
          : `Stored ${SHORT(r.hash)} at ${r.key} (${r.size} B).`,
        ...r.evicted.map((h) => `Evicted ${SHORT(h)} (least recently used).`),
      ];
      if (model.has(r.hash)) setInspected({ hash: r.hash, text });
      return messages;
    });
  };

  const handleRead = (hash: string) =>
    enqueue(() => {
      const bytes = model.get(hash);
      if (!bytes) return [];
      setInspected({ hash, text: payloads.current.get(hash) ?? new TextDecoder().decode(bytes) });
      return [`Read ${SHORT(hash)}: access time refreshed.`];
    });

  const handleDelete = (hash: string) =>
    enqueue(() => (model.delete(hash) ? [`Deleted ${SHORT(hash)}.`] : []));

  const handlePrune = () =>
    enqueue(() => {
      const evicted = model.prune(0.7);
      return evicted.length > 0
        ? evicted.map((h) => `Evicted ${SHORT(h)} (least recently used).`)
        : ["Prune: nothing to evict (under budget, or budget is 0 = unbounded)."];
    });

  const handleBudget = (value: string) => {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    setBudget(n);
    enqueue(() => {
      model.setMaxBytes(n);
      return [];
    });
  };

  const percent = budget > 0 ? Math.min(100, (snap.total / budget) * 100) : 0;
  const level = snap.total > budget && budget > 0 ? "over" : percent > 70 ? "warn" : "ok";
  const status = level === "over" ? "over budget" : level === "warn" ? "near budget" : "within budget";

  return (
    <div className="cas-playground">
      <div className="card">
        <div className="cas-head">
          <div>
            <h1 className="cas-title">Content-Addressable Storage (CAS) &amp; LRU Pruning</h1>
            <p className="cas-sub">
              Immutable SHA-256 content-hashed object store with explicit access tracking and LRU pruning.
            </p>
            <p className="cas-model-label">browser model, hash-compatible with the real store</p>
          </div>
          <Badge variant="success">Storage Engine: SHA-256 CAS</Badge>
        </div>

        <div className="cas-gauge">
          <div className="cas-gauge-row">
            <span className="cas-gauge-label">Disk Quota Utilization</span>
            <span className="cas-mono">
              {snap.total} B / {budget} B ({percent.toFixed(1)}%) — {status}
            </span>
          </div>
          <div className="cas-track" role="progressbar" aria-label="Quota utilization" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
            <div className={`cas-fill cas-fill-${level}`} style={{ width: `${percent}%` }} />
          </div>
        </div>

        <div className="cas-controls">
          <div>
            <label className="stat-label" htmlFor="cas-input">
              Payload to store (SHA-256 hashed in the browser)
            </label>
            <Input
              id="cas-input"
              type="text"
              data-testid="cas-input"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
          </div>
          <Button variant="solid" onClick={handleStore}>
            💾 Store in CAS
          </Button>
        </div>

        <div className="cas-budget">
          <label className="stat-label" htmlFor="cas-budget">
            Byte budget
          </label>
          <Input
            id="cas-budget"
            type="number"
            min={0}
            data-testid="cas-budget"
            value={budget}
            onChange={(e) => handleBudget(e.target.value)}
          />
          <p className="cas-note" data-testid="cas-budget-note">
            Going over the budget prunes down to 70% of it, not merely under it; a blob you just stored can be evicted by
            its own prune; a budget of 0 means unbounded.
          </p>
        </div>

        <div className="stat-grid">
          <div className="joy-metric-tile">
            <div className="joy-metric-tile__title">Stored Objects</div>
            <div className="joy-metric-tile__value" data-testid="cas-count">{snap.entries.length}</div>
          </div>
          <div className="joy-metric-tile">
            <div className="joy-metric-tile__title">Total Size</div>
            <div className="joy-metric-tile__value">{snap.total} B</div>
          </div>
          <div className="joy-metric-tile">
            <div className="joy-metric-tile__title">Quota Capacity</div>
            <div className="joy-metric-tile__value">{budget} B</div>
          </div>
        </div>

        <div className="cas-actions">
          <Button variant="outline" onClick={handlePrune}>
            🧹 Prune to 70% LRU
          </Button>
        </div>

        <ul className="cas-log" aria-live="polite" aria-label="Store activity" data-testid="cas-log">
          {log.length === 0 ? <li>No activity yet.</li> : log.map((m) => <li key={m.id}>{m.text}</li>)}
        </ul>

        <div className="stat-label">CAS Object Index (least recently used first)</div>
        <div className="cas-table-wrap" tabIndex={0} role="region" aria-label="CAS object index">
          <table className="cas-table">
            <thead>
              <tr>
                <th>SHA-256 Hash</th>
                <th>Size</th>
                <th>Key</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {snap.entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="cas-empty">No objects stored.</td>
                </tr>
              )}
              {snap.entries.map((o) => (
                <tr key={o.hash} data-testid={`cas-row-${o.hash.slice(0, 8)}`}>
                  <td className="cas-hash">{o.hash}</td>
                  <td className="cas-mono">{o.size} B</td>
                  <td className="cas-key">{o.key}</td>
                  <td>
                    <div className="cas-row-actions">
                      <Button variant="outline" size="sm" onClick={() => handleRead(o.hash)} aria-label={`Touch / read ${SHORT(o.hash)}`}>
                        🔍 Touch / Read
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => handleDelete(o.hash)} aria-label={`Delete ${SHORT(o.hash)}`}>
                        ✕
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {inspected && (
          <div className="cas-inspect">
            <div className="cas-inspect-title">Inspected CAS Payload:</div>
            <pre>{inspected.text}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
