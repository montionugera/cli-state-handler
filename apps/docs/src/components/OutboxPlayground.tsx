import React, { useState } from "react";
import type { ConflictPolicy } from "@ucsa/core";

interface SimulatedMutation {
  id: string;
  endpoint: string;
  method: string;
  payload: string;
  status: "pending" | "in_flight" | "synced" | "conflict";
  retryCount: number;
  conflictPolicy: ConflictPolicy;
  outcome?: string;
  createdAt: number;
}

export function OutboxPlayground() {
  const [isOnline, setIsOnline] = useState(false);
  const [rateLimitMs, setRateLimitMs] = useState(80);
  const [batchSize, setBatchSize] = useState(2);
  const [selectedPolicy, setSelectedPolicy] = useState<ConflictPolicy>("merge");

  // Mutation form state
  const [endpoint, setEndpoint] = useState("/api/v1/user/settings");
  const [method, setMethod] = useState("PATCH");
  const [payloadStr, setPayloadStr] = useState('{"theme": "dark", "syncInterval": 30}');

  // Queue state
  const [mutations, setMutations] = useState<SimulatedMutation[]>([
    {
      id: "mut_001",
      endpoint: "/api/v1/user/settings",
      method: "PATCH",
      payload: '{"theme": "dark"}',
      status: "pending",
      retryCount: 0,
      conflictPolicy: "merge",
      createdAt: Date.now() - 15000
    },
    {
      id: "mut_002",
      endpoint: "/api/v1/orders/checkout",
      method: "POST",
      payload: '{"item": "item_99", "qty": 1}',
      status: "pending",
      retryCount: 0,
      conflictPolicy: "server-wins",
      createdAt: Date.now() - 10000
    }
  ]);

  const [logs, setLogs] = useState<string[]>([]);
  const [isReplaying, setIsReplaying] = useState(false);

  const addLog = (msg: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 19)]);
  };

  const handleEnqueue = () => {
    const newMut: SimulatedMutation = {
      id: `mut_${Math.random().toString(36).substring(2, 7)}`,
      endpoint,
      method,
      payload: payloadStr,
      status: "pending",
      retryCount: 0,
      conflictPolicy: selectedPolicy,
      createdAt: Date.now()
    };
    setMutations((prev) => [...prev, newMut]);
    addLog(`Enqueued mutation ${newMut.id} (${newMut.method} ${newMut.endpoint}) to offline outbox`);
  };

  const handleReplay = async () => {
    if (!isOnline) {
      addLog("⚠️ Cannot replay outbox while OFFLINE! Toggle status to Online first.");
      return;
    }
    const pending = mutations.filter((m) => m.status === "pending");
    if (pending.length === 0) {
      addLog("ℹ️ No pending mutations in outbox queue.");
      return;
    }

    setIsReplaying(true);
    addLog(`🚀 Starting outbox replay: ${pending.length} pending mutations, rateLimitMs: ${rateLimitMs}ms, batchSize: ${batchSize}`);

    // Process in batches with rate-limiting
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);

      for (const m of batch) {
        // Set in flight
        setMutations((prev) =>
          prev.map((item) => (item.id === m.id ? { ...item, status: "in_flight" } : item))
        );
        addLog(`⏳ In flight: ${m.id} (${m.method} ${m.endpoint})`);

        // Wait rateLimitMs pacing
        if (rateLimitMs > 0) {
          await new Promise((res) => setTimeout(res, rateLimitMs));
        }

        // Simulate random conflict on 2nd mutation to demonstrate policy
        const isConflict = m.id === "mut_002" || m.endpoint.includes("checkout");
        let outcome = "Synced 200 OK";

        if (isConflict) {
          if (m.conflictPolicy === "server-wins") {
            outcome = "409 Conflict: Server-wins applied (Local mutation rolled back)";
          } else if (m.conflictPolicy === "client-wins") {
            outcome = "409 Conflict: Client-wins forced (Overwrote server state)";
          } else {
            outcome = "409 Conflict: Merge applied (Combined non-overlapping fields)";
          }
        }

        setMutations((prev) =>
          prev.map((item) =>
            item.id === m.id
              ? {
                  ...item,
                  status: isConflict ? "conflict" : "synced",
                  outcome
                }
              : item
          )
        );
        addLog(`✅ Resolved ${m.id}: ${outcome}`);
      }
    }

    setIsReplaying(false);
    addLog("🏁 Replay batch complete.");
  };

  const pendingCount = mutations.filter((m) => m.status === "pending").length;
  const syncedCount = mutations.filter((m) => m.status === "synced" || m.status === "conflict").length;

  return (
    <div className="outbox-playground space-y-6">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginBottom: "0.25rem" }}>
              Offline Mutation Outbox & Conflict Resolution
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
              Enqueues mutations when disconnected and replays with rate-limiting pacing (rateLimitMs) and automatic conflict resolution policies.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              onClick={() => {
                const next = !isOnline;
                setIsOnline(next);
                addLog(`Network state changed to: ${next ? "ONLINE 🟢" : "OFFLINE 🔴"}`);
              }}
              className={`btn ${isOnline ? "btn-primary" : "btn-danger"}`}
            >
              {isOnline ? "🟢 Network: ONLINE" : "🔴 Network: OFFLINE"}
            </button>
          </div>
        </div>

        {/* Configuration Bar */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
          <div>
            <label className="stat-label">Rate-Limit Pacing ({rateLimitMs} ms)</label>
            <input
              type="range"
              min="0"
              max="300"
              step="20"
              value={rateLimitMs}
              onChange={(e) => setRateLimitMs(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label className="stat-label">Batch Size</label>
            <select
              className="input"
              style={{ width: "100%" }}
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
            >
              <option value="1">1 mutation / batch</option>
              <option value="2">2 mutations / batch</option>
              <option value="5">5 mutations / batch</option>
            </select>
          </div>
          <div>
            <label className="stat-label">Conflict Policy</label>
            <select
              className="input"
              style={{ width: "100%" }}
              value={selectedPolicy}
              onChange={(e) => setSelectedPolicy(e.target.value as ConflictPolicy)}
            >
              <option value="merge">merge (Field-level 3-way)</option>
              <option value="server-wins">server-wins (Rollback)</option>
              <option value="client-wins">client-wins (Force Overwrite)</option>
            </select>
          </div>
        </div>

        {/* Enqueue Form */}
        <div style={{ background: "var(--bg-sidebar)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--border-card)", marginBottom: "1.5rem" }}>
          <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.75rem" }}>
            Create Mutation (Simulate offline user action)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 1fr auto", gap: "0.75rem", alignItems: "flex-end" }}>
            <div>
              <label className="stat-label">Method</label>
              <select className="input" style={{ width: "100%" }} value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="POST">POST</option>
                <option value="PATCH">PATCH</option>
                <option value="PUT">PUT</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div>
              <label className="stat-label">Endpoint</label>
              <input type="text" className="input" style={{ width: "100%" }} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            </div>
            <div>
              <label className="stat-label">JSON Payload</label>
              <input type="text" className="input" style={{ width: "100%" }} value={payloadStr} onChange={(e) => setPayloadStr(e.target.value)} />
            </div>
            <button className="btn btn-secondary" onClick={handleEnqueue}>
              📥 Enqueue
            </button>
          </div>
        </div>

        {/* Metric Tiles & Replay Action */}
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-label">Pending Outbox Size</div>
            <div className="stat-value" style={{ color: "var(--accent-amber)" }}>{pendingCount}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Synced Mutations</div>
            <div className="stat-value" style={{ color: "var(--accent-emerald)" }}>{syncedCount}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Pacing Rate</div>
            <div className="stat-value" style={{ color: "var(--accent-cyan)" }}>{rateLimitMs} ms</div>
          </div>
          <div className="stat-tile" style={{ display: "flex", alignItems: "center" }}>
            <button
              className="btn btn-primary"
              style={{ width: "100%", height: "42px" }}
              disabled={isReplaying}
              onClick={handleReplay}
            >
              {isReplaying ? "⏳ Replaying..." : "🚀 Replay Outbox"}
            </button>
          </div>
        </div>

        {/* Mutation Table */}
        <div style={{ marginBottom: "1.5rem" }}>
          <div className="stat-label" style={{ marginBottom: "0.5rem" }}>Active Outbox Queue</div>
          <div style={{ overflowX: "auto", border: "1px solid var(--border-card)", borderRadius: "8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", textAlign: "left" }}>
              <thead>
                <tr style={{ background: "var(--bg-sidebar)", borderBottom: "1px solid var(--border-card)", color: "var(--text-muted)" }}>
                  <th style={{ padding: "0.5rem 0.75rem" }}>ID</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Method</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Endpoint</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Payload</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Policy</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {mutations.map((m) => (
                  <tr key={m.id} style={{ borderBottom: "1px solid var(--border-card)", background: "var(--bg-card)" }}>
                    <td style={{ padding: "0.5rem 0.75rem", fontFamily: "var(--font-mono)" }}>{m.id}</td>
                    <td style={{ padding: "0.5rem 0.75rem", fontWeight: 700 }}>{m.method}</td>
                    <td style={{ padding: "0.5rem 0.75rem", fontFamily: "var(--font-mono)" }}>{m.endpoint}</td>
                    <td style={{ padding: "0.5rem 0.75rem", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.payload}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      <span className="badge badge-cyan">{m.conflictPolicy}</span>
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem" }}>
                      <span
                        className={`badge ${
                          m.status === "synced"
                            ? "badge-emerald"
                            : m.status === "in_flight"
                            ? "badge-amber"
                            : m.status === "conflict"
                            ? "badge-rose"
                            : "badge-blue"
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Real-time Event Log */}
        <div>
          <div className="stat-label" style={{ marginBottom: "0.5rem" }}>Replay Activity Log</div>
          <div style={{ background: "var(--bg-sidebar)", padding: "0.75rem", borderRadius: "8px", border: "1px solid var(--border-card)", height: "120px", overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
            {logs.length > 0 ? (
              logs.map((log, i) => (
                <div key={i} style={{ color: log.includes("⚠️") ? "var(--accent-amber)" : log.includes("✅") ? "var(--accent-emerald)" : "var(--text-muted)" }}>
                  {log}
                </div>
              ))
            ) : (
              <div style={{ color: "var(--text-muted)" }}>Logs will appear here during mutation lifecycle and replay.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
