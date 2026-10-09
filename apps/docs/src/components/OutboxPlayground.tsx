import React, { useRef, useState } from "react";
import type { ConflictPolicy } from "@montionugera/ucsa-core";
import { OutboxModel } from "../models/outbox-model.js";
import type { OutboxMutation, SettleOutcome } from "../models/outbox-model.js";
import "./outbox-playground.css";

const LEASE_MS = 30000;
const CLOCK_START = 1_700_000_000_000;
const SERVER_DATA = { serverField: "from-server", theme: "light" };

const STATUS_GLYPH: Record<OutboxMutation["status"], string> = {
  pending: "● pending",
  in_flight: "▶ in_flight",
  failed: "✖ failed",
};

const STATUS_CLASS: Record<OutboxMutation["status"], string> = {
  pending: "badge-blue",
  in_flight: "badge-amber",
  failed: "badge-rose",
};

type WorkerId = "worker-a" | "worker-b";
const WORKERS: Array<{ id: WorkerId; label: string }> = [
  { id: "worker-a", label: "Worker A" },
  { id: "worker-b", label: "Worker B" },
];

const OUTCOME_TEXT: Record<SettleOutcome, string> = {
  synced: "synced, removed from outbox",
  "rolled-back": "server-wins: rolled back and removed",
  forced: "client-wins: re-queued with X-Force-Overwrite",
  merged: "merge: payload merged with server data, re-queued",
  failed: "failed permanently",
  retry: "transient failure, back to pending",
};

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergePayload(local: unknown, server: unknown): unknown {
  return isRecord(local) && isRecord(server) ? { ...server, ...local } : local;
}

function leaseText(m: OutboxMutation, now: number): string {
  if (m.status !== "in_flight" || !m.lease_owner || m.lease_until == null) return "none";
  const seconds = Math.ceil(Math.abs(m.lease_until - now) / 1000);
  return m.lease_until < now
    ? `${m.lease_owner}, lease expired ${seconds}s ago (claimable)`
    : `${m.lease_owner}, expires in ${seconds}s`;
}

export function OutboxPlayground({ headingLevel: Title = "h1" }: { headingLevel?: "h1" | "h2" } = {}) {
  const clockRef = useRef(CLOCK_START);
  const logRef = useRef<Array<{ id: number; text: string }>>([]);
  const logSeq = useRef(0);
  const serverConflicts = useRef(new Set<string>());
  const conflicted = useRef(new Set<string>());
  // Each worker keeps the mutations it claimed and settles them by id, as a real caller would.
  const claimedRef = useRef<Record<WorkerId, OutboxMutation[]>>({ "worker-a": [], "worker-b": [] });
  const [, setRev] = useState(0);
  const bump = () => setRev((r) => r + 1);

  const addLog = (msg: string) => {
    logRef.current = [{ id: ++logSeq.current, text: `[t+${Math.round((clockRef.current - CLOCK_START) / 1000)}s] ${msg}` }, ...logRef.current].slice(0, 40);
  };

  const [model] = useState(() => {
    const m = new OutboxModel({
      clock: () => clockRef.current,
      defaultLeaseDurationMs: LEASE_MS,
      onRollback: (mut) => {
        addLog(`↩ Rollback callback ran for ${mut.mutation_id}`);
      },
      mergeResolver: mergePayload,
    });
    m.enqueue({ mutation_id: "mut_001", endpoint: "/api/v1/user/settings", method: "PATCH", payload: { theme: "dark" }, conflictPolicy: "merge" });
    clockRef.current += 1;
    m.enqueue({ mutation_id: "mut_002", endpoint: "/api/v1/orders/checkout", method: "POST", payload: { item: "item_99", qty: 1 }, conflictPolicy: "server-wins" });
    clockRef.current += 1;
    serverConflicts.current.add("mut_002");
    return m;
  });

  const [isOnline, setIsOnline] = useState(false);
  const [rateLimitMs, setRateLimitMs] = useState(80);
  const [batchSize, setBatchSize] = useState(2);
  const [selectedPolicy, setSelectedPolicy] = useState<ConflictPolicy>("merge");
  const [serverNewer, setServerNewer] = useState(false);
  const [endpoint, setEndpoint] = useState("/api/v1/user/settings");
  const [method, setMethod] = useState("PATCH");
  const [payloadStr, setPayloadStr] = useState('{"theme": "dark", "syncInterval": 30}');
  const [isReplaying, setIsReplaying] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [completed, setCompleted] = useState(0);
  // Seeded mutations are mut_001 and mut_002, so new ids continue from 3.
  const nextId = useRef(3);

  const mutations = model.getAllMutations();
  const now = clockRef.current;
  const count = (s: OutboxMutation["status"]) => mutations.filter((m) => m.status === s).length;

  const advance = (ms: number) => {
    clockRef.current += ms;
    addLog(`⏱ Virtual clock advanced ${ms / 1000}s`);
    bump();
  };

  const countOutcome = (outcome: SettleOutcome) => {
    if (outcome === "synced" || outcome === "rolled-back") setCompleted((c) => c + 1);
  };

  const handleEnqueue = () => {
    const id = `mut_${String(nextId.current++).padStart(3, "0")}`;
    model.enqueue({
      mutation_id: id,
      endpoint,
      method,
      payload: parsePayload(payloadStr),
      conflictPolicy: selectedPolicy,
    });
    if (serverNewer) serverConflicts.current.add(id);
    clockRef.current += 1; // one tick per enqueue keeps created_at unique
    addLog(`Enqueued ${id} (${method} ${endpoint}, ${selectedPolicy}) -> pending${isOnline ? "" : " while offline"}`);
    bump();
  };

  const handleToggle = () => {
    const next = !isOnline;
    setIsOnline(next);
    addLog(`Network state changed to: ${next ? "ONLINE" : "OFFLINE"}`);
  };

  const handleClaim = (worker: WorkerId) => {
    const claimed = model.claimPendingMutations(worker, LEASE_MS, batchSize);
    claimedRef.current[worker] = claimed;
    addLog(`${worker} claimed ${claimed.length} mutation(s)${claimed.length ? `: ${claimed.map((m) => m.mutation_id).join(", ")}` : " (every row has a live lease or none are claimable)"}`);
    bump();
  };

  const handleRespond = async (worker: WorkerId, status: number) => {
    const held = claimedRef.current[worker];
    if (held.length === 0) {
      addLog(`${worker} has no claimed mutations to respond to (claim first)`);
      bump();
      return;
    }
    claimedRef.current[worker] = [];
    for (const m of held) {
      const current = model.getMutation(m.mutation_id);
      const gone = !current;
      const notHolder = !!current && (current.lease_owner !== worker || (current.lease_until != null && current.lease_until < clockRef.current));
      const outcome = await model.settle(m, { status, data: status === 409 ? SERVER_DATA : undefined });
      countOutcome(outcome);
      const text = gone
        ? outcome === "rolled-back"
          ? "the row was already gone from the outbox, but the rollback ran again (the option-level fallback survives the row's removal) and the mutation still counts as successful"
          : outcome === "synced"
            ? "the row was already gone from the outbox; nothing was left to remove"
            : "the row was already gone from the outbox; there was no row left to update"
        : OUTCOME_TEXT[outcome];
      const note = notHolder
        ? status >= 200 && status < 300
          ? " [this worker no longer holds a live lease, but completion is not checked against the lease owner in the current library]"
          : outcome === "retry" || outcome === "failed"
            ? ` [this worker no longer holds a live lease; its failure still clears ${current?.lease_owner ?? "the new holder"}'s lease and re-queues the row with its retry count raised, as the current library does]`
            : " [this worker no longer holds a live lease, but completion is not checked against the lease owner in the current library]"
        : "";
      addLog(`${outcome === "synced" || outcome === "rolled-back" ? "✅ " : ""}${worker} got HTTP ${status} for ${m.mutation_id} (${m.conflictPolicy ?? "server-wins"}): ${text}${note}`);
    }
    bump();
  };

  const handleReplay = async () => {
    if (!isOnline) {
      addLog("⚠️ Replay held while OFFLINE. Holding replay until online is a rule of this playground (and of a well-behaved caller); the core outbox has no connectivity check. Replaying offline would make every send throw, raising retry_count until the row is failed at maxRetries.");
      bump();
      return;
    }
    const claimable = model.countClaimable();
    if (claimable === 0) {
      addLog("ℹ️ No claimable mutations in the outbox (nothing pending, and no in_flight row with an expired lease).");
      bump();
      return;
    }
    const total = Math.min(claimable, batchSize);
    setIsReplaying(true);
    setProgress({ sent: 0, total });
    addLog(`🚀 Starting outbox replay as worker-a: ${total} of ${claimable} claimable, rateLimitMs: ${rateLimitMs}ms, batchSize: ${batchSize}`);
    let sent = 0;
    const statuses = new Map<string, number>();
    const result = await model.replay(
      async (m) => {
        sent++;
        setProgress({ sent, total });
        addLog(`⏳ Sent ${m.mutation_id} (${m.method} ${m.endpoint})`);
        bump();
        const wantsConflict = serverConflicts.current.has(m.mutation_id) && !conflicted.current.has(m.mutation_id) && !m.forced;
        if (wantsConflict) {
          conflicted.current.add(m.mutation_id);
          statuses.set(m.mutation_id, 409);
          return { status: 409, data: SERVER_DATA };
        }
        statuses.set(m.mutation_id, 200);
        return { status: 200 };
      },
      {
        rateLimitMs,
        batchSize,
        workerId: "worker-a",
        leaseDurationMs: LEASE_MS,
        sleep: (ms) =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              clockRef.current += ms;
              resolve();
            }, ms)
          ),
        onOutcome: (m, outcome) => {
          const done = outcome === "synced" || outcome === "rolled-back";
          addLog(`${done ? "✅ " : ""}${m.mutation_id} (HTTP ${statuses.get(m.mutation_id) ?? "?"}, ${m.conflictPolicy ?? "server-wins"}): ${OUTCOME_TEXT[outcome]}`);
        },
      }
    );
    setCompleted((c) => c + result.successful);
    setIsReplaying(false);
    addLog(`🏁 Replay batch complete: processed ${result.processed}, successful ${result.successful}, failed ${result.failed}.`);
    bump();
  };

  return (
    <div className="outbox-playground">
      <div className="card">
        <div className="ob-head">
          <div className="ob-head-text">
            <Title className="ob-title">Offline Mutation Outbox & Conflict Resolution</Title>
            <p className="ob-muted">
              Enqueues mutations when disconnected and replays them with rate-limit pacing, per-worker leases and conflict policies.
            </p>
            <p className="ob-muted ob-model-note">
              This is a browser model of the outbox. Its behaviour is checked against the real SQLite-backed MutationOutbox by the parity test suite.
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggle}
            className={`btn ${isOnline ? "btn-primary" : "btn-danger"}`}
          >
            {isOnline ? "🟢 Network: ONLINE" : "🔴 Network: OFFLINE"}
          </button>
        </div>

        <div className="ob-config">
          <div>
            <label className="stat-label" htmlFor="ob-rate">Rate-limit pacing ({rateLimitMs} ms)</label>
            <input id="ob-rate" className="ob-full" type="range" min="0" max="300" step="20" value={rateLimitMs} onChange={(e) => setRateLimitMs(Number(e.target.value))} />
          </div>
          <div>
            <label className="stat-label" htmlFor="ob-batch">Batch size</label>
            <select id="ob-batch" className="input ob-full" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))}>
              <option value="1">1 mutation / batch</option>
              <option value="2">2 mutations / batch</option>
              <option value="5">5 mutations / batch</option>
            </select>
          </div>
          <div>
            <label className="stat-label" htmlFor="ob-policy">Conflict policy</label>
            <select id="ob-policy" className="input ob-full" value={selectedPolicy} onChange={(e) => setSelectedPolicy(e.target.value as ConflictPolicy)}>
              <option value="merge">merge (resolver combines local and server)</option>
              <option value="server-wins">server-wins (rollback)</option>
              <option value="client-wins">client-wins (force overwrite)</option>
            </select>
          </div>
        </div>

        <div className="ob-form">
          <div className="ob-form-title">Create mutation (simulate an offline user action)</div>
          <div className="ob-form-grid">
            <div>
              <label className="stat-label" htmlFor="ob-method">Method</label>
              <select id="ob-method" className="input ob-full" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="POST">POST</option>
                <option value="PATCH">PATCH</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div>
              <label className="stat-label" htmlFor="ob-endpoint">Endpoint</label>
              <input id="ob-endpoint" type="text" className="input ob-full" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            </div>
            <div>
              <label className="stat-label" htmlFor="ob-payload">JSON payload</label>
              <input id="ob-payload" type="text" className="input ob-full" value={payloadStr} onChange={(e) => setPayloadStr(e.target.value)} />
            </div>
            <label className="ob-check">
              <input type="checkbox" checked={serverNewer} onChange={(e) => setServerNewer(e.target.checked)} />
              Server has a newer version (first send gets HTTP 409)
            </label>
          </div>
          <div className="ob-actions">
            <button type="button" className="btn btn-secondary" onClick={handleEnqueue}>📥 Enqueue</button>
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-label">Pending</div>
            <div className="stat-value ob-amber">{count("pending")}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">In flight (leased)</div>
            <div className="stat-value ob-cyan">{count("in_flight")}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Failed</div>
            <div className="stat-value ob-rose">{count("failed")}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Completed</div>
            <div className="stat-value ob-emerald">{completed}</div>
          </div>
        </div>

        <div className="ob-workers">
          {WORKERS.map((w) => (
            <section key={w.id} className="ob-worker" aria-label={w.label}>
              <div className="ob-form-title">{w.label} <code>{w.id}</code></div>
              <div className="ob-actions">
                <button type="button" className="btn btn-secondary" disabled={!isOnline || isReplaying} onClick={() => handleClaim(w.id)}>Claim as {w.label}</button>
                {[200, 503, 409, 400].map((status) => (
                  <button key={status} type="button" className="btn btn-secondary" disabled={!isOnline || isReplaying} onClick={() => void handleRespond(w.id, status)}>
                    {w.label}: respond {status}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        <p className="ob-muted">Conflict policy and the rollback / merge callbacks are held in memory by the outbox instance that enqueued the mutation, not stored in SQLite, so a worker in another process would not have them (a second instance falls back to its own option-level callbacks, and to server-wins when no policy is known); this playground's two workers share one instance.</p>
        {!isOnline && <p className="ob-muted" role="note">This playground only lets workers claim and respond while online, and holds Replay until online; that is a rule of the playground, not of the library. The core outbox does not check connectivity: replaying offline makes each send throw, so retry_count rises and the row becomes failed after maxRetries attempts.</p>}

        <div className="ob-actions ob-clock">
          <span className="stat-label ob-clock-label">Virtual clock: t+{Math.round((now - CLOCK_START) / 1000)}s (lease length {LEASE_MS / 1000}s)</span>
          <button type="button" className="btn btn-secondary" onClick={() => advance(10000)}>Advance clock +10s</button>
          <button type="button" className="btn btn-secondary" onClick={() => advance(31000)}>Advance clock +31s</button>
          <button type="button" className="btn btn-primary" disabled={isReplaying} onClick={() => void handleReplay()}>
            {isReplaying ? "⏳ Replaying..." : "🚀 Replay Outbox"}
          </button>
        </div>

        <div className="ob-meter">
          <label className="stat-label" htmlFor="ob-progress">Rate-limit meter ({rateLimitMs} ms between sends)</label>
          <progress id="ob-progress" className="ob-full" max={Math.max(progress.total, 1)} value={progress.sent} />
          <div className="ob-muted">Sent {progress.sent} of {progress.total}</div>
        </div>

        <div className="ob-section">
          <div className="stat-label">Active outbox queue</div>
          <div className="ob-table-wrap" role="region" aria-label="Outbox queue (scrollable)" tabIndex={0}>
            <table className="ob-table" aria-label="Outbox queue">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Method</th>
                  <th>Endpoint</th>
                  <th>Payload</th>
                  <th>Policy</th>
                  <th>Status</th>
                  <th>Retries</th>
                  <th>Lease</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {mutations.map((m) => (
                  <tr key={m.mutation_id}>
                    <td className="ob-mono">{m.mutation_id}</td>
                    <td className="ob-strong">{m.method}</td>
                    <td className="ob-mono">{m.endpoint}</td>
                    <td className="ob-payload ob-mono">{JSON.stringify(m.payload)}</td>
                    <td><span className="badge badge-cyan">{m.conflictPolicy ?? "server-wins"}</span></td>
                    <td><span className={`badge ${STATUS_CLASS[m.status]}`}>{STATUS_GLYPH[m.status]}</span></td>
                    <td>{m.retry_count}</td>
                    <td>{leaseText(m, now)}</td>
                    <td className="ob-mono">{m.forced ? "forced · X-Force-Overwrite" : "-"}{m.error ? ` · ${m.error}` : ""}</td>
                  </tr>
                ))}
                {mutations.length === 0 && (
                  <tr><td colSpan={9} className="ob-muted">Outbox is empty.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="ob-section">
          <div className="stat-label">Activity log</div>
          <div className="ob-log" role="log" aria-live="polite" aria-label="Outbox activity log" tabIndex={0}>
            {logRef.current.length > 0 ? (
              logRef.current.map((log) => <div key={log.id}>{log.text}</div>)
            ) : (
              <div className="ob-muted">Logs will appear here during the mutation lifecycle and replay.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
