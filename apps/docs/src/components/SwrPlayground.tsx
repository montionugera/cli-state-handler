import React, { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { QueryEngine, hashQueryKey, replaceEqualDeep } from "@ucsa/core";
import type { QueryState } from "@ucsa/core";
import { LifecycleGraph } from "./LifecycleGraph.js";
import { StaleTimeline } from "./StaleTimeline.js";

// Mock remote backend state
let mockServerUser = {
  id: "usr_42",
  name: "Dr. Evelyn Reed",
  role: "Lead Systems Architect",
  tier: "Enterprise",
  preferences: {
    theme: "dark",
    notifications: true
  },
  metrics: {
    syncCount: 120,
    lastPing: "2026-10-07T08:00:00Z"
  }
};

export function SwrPlayground({ headingLevel: Title = "h1" }: { headingLevel?: "h1" | "h2" } = {}) {
  const [engine] = useState(() => new QueryEngine({ defaultStaleTime: 5000 }));
  const [queryKeyStr, setQueryKeyStr] = useState("users/profile");
  const [staleTimeMs, setStaleTimeMs] = useState(4000);
  const [tagInput, setTagInput] = useState("user");
  const [simulateLatencyMs, setSimulateLatencyMs] = useState(600);
  const [activeTab, setActiveTab] = useState<"visualizer" | "cache" | "diff">("visualizer");

  // Track reference identities to demonstrate structural sharing
  const prevRefMap = useRef<Map<string, unknown>>(new Map());
  const [refStatus, setRefStatus] = useState<string>("Waiting for fetch...");
  const [refPreserved, setRefPreserved] = useState<boolean | null>(null);
  const [renderCount, setRenderCount] = useState(0);

  // UCSA useQuery subscription via React useSyncExternalStore
  const queryKey = [queryKeyStr];
  const queryHash = hashQueryKey(queryKey);

  const queryHandle = useRef(
    engine.useQuery(
      queryKey,
      async ({ signal }: { signal: AbortSignal }) => {
        // Simulated network latency
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, simulateLatencyMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Query aborted"));
          });
        });
        // Return deep clone of mock server data
        return JSON.parse(JSON.stringify(mockServerUser));
      },
      { staleTime: staleTimeMs, tags: [tagInput] }
    )
  );

  // Subscribe to engine state
  const snapshot: QueryState<typeof mockServerUser> = useSyncExternalStore(
    queryHandle.current.subscribe,
    queryHandle.current.getSnapshot
  );

  useEffect(() => {
    setRenderCount((c) => c + 1);
    if (snapshot.data) {
      const prev = prevRefMap.current.get(queryHash);
      if (prev !== undefined) {
        if (prev === snapshot.data) {
          setRefPreserved(true);
          setRefStatus("REFERENCE PRESERVED (replaceEqualDeep retained identity - zero downstream re-renders!)");
        } else {
          setRefPreserved(false);
          setRefStatus("REFERENCE CHANGED (Payload mutated - subscribers notified)");
        }
      } else {
        setRefPreserved(true);
        setRefStatus("INITIAL LOAD (Fresh reference stored)");
      }
      prevRefMap.current.set(queryHash, snapshot.data);
    }
  }, [snapshot.data, queryHash]);

  const handleFetch = async () => {
    try {
      await engine.fetchQuery(
        queryKey,
        async ({ signal }: { signal: AbortSignal }) => {
          await new Promise((res, rej) => {
            const t = setTimeout(res, simulateLatencyMs);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              rej(new Error("Query aborted"));
            });
          });
          return JSON.parse(JSON.stringify(mockServerUser));
        },
        { staleTime: staleTimeMs, tags: [tagInput] }
      );
    } catch {
      // Ignored if cancelled
    }
  };

  const handleServerMutateIdentical = async () => {
    const prev = snapshot.data;
    await handleFetch();
    const current = engine.getQueryState(queryKey)?.data;
    if (prev && current && prev === current) {
      setRefPreserved(true);
      setRefStatus("REFERENCE PRESERVED (replaceEqualDeep retained identity - zero downstream re-renders!)");
    }
  };

  const handleServerMutateDifferent = async () => {
    mockServerUser = {
      ...mockServerUser,
      metrics: {
        ...mockServerUser.metrics,
        syncCount: mockServerUser.metrics.syncCount + 1,
        lastPing: new Date().toISOString()
      }
    };
    await handleFetch();
  };

  const handleInvalidateTag = async () => {
    await engine.invalidateByTag(tagInput);
  };

  const isStale = snapshot.dataUpdatedAt ? Date.now() > snapshot.dataUpdatedAt + staleTimeMs : false;

  return (
    <div className="swr-playground space-y-6">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div>
            <Title style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginBottom: "0.25rem" }}>
              SWR & Query Lifecycle Playground
            </Title>
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
              Live interactive query lifecycle demonstrating Stale-While-Revalidate caching, structural sharing reference preservation, and indexed tag invalidations.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <span className={`badge ${snapshot.status === "loading" ? "badge-amber" : snapshot.status === "success" ? "badge-emerald" : "badge-blue"}`}>
              Status: {snapshot.status}
            </span>
            {isStale && <span className="badge badge-rose">Cache Stale</span>}
            {!isStale && snapshot.data && <span className="badge badge-cyan">Cache Fresh</span>}
          </div>
        </div>

        {/* Action Controls */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
          <div>
            <label className="stat-label">Query Key</label>
            <input
              type="text"
              className="input"
              style={{ width: "100%" }}
              value={queryKeyStr}
              onChange={(e) => setQueryKeyStr(e.target.value)}
            />
          </div>
          <div>
            <label className="stat-label">Stale Time (TTL ms)</label>
            <input
              type="number"
              className="input"
              style={{ width: "100%" }}
              value={staleTimeMs}
              onChange={(e) => setStaleTimeMs(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="stat-label">Simulated Latency (ms)</label>
            <input
              type="number"
              data-testid="latency-input"
              className="input"
              style={{ width: "100%" }}
              value={simulateLatencyMs}
              onChange={(e) => setSimulateLatencyMs(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="stat-label">Invalidation Tag</label>
            <input
              type="text"
              className="input"
              style={{ width: "100%" }}
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
            />
          </div>
        </div>

        {/* Button Bar */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginBottom: "1.5rem" }}>
          <button className="btn btn-primary" onClick={handleFetch}>
            🚀 Fetch Query (SWR)
          </button>
          <button className="btn btn-secondary" onClick={handleServerMutateIdentical}>
            🔄 Background Refetch (Identical Payload)
          </button>
          <button className="btn btn-secondary" onClick={handleServerMutateDifferent}>
            ⚡ Mutate Remote Data & Refetch
          </button>
          <button className="btn btn-secondary" onClick={handleInvalidateTag}>
            🏷️ Invalidate Tag ("{tagInput}")
          </button>
          <button className="btn btn-danger" onClick={() => queryHandle.current.cancel()}>
            🛑 Abort Active Fetch
          </button>
        </div>

        {/* Metric Tiles */}
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-label">Component Renders</div>
            <div className="stat-value">{renderCount}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Structural Sharing Status</div>
            <div style={{ fontSize: "0.95rem", fontWeight: 600, color: refPreserved ? "var(--accent-emerald)" : "var(--accent-rose)", marginTop: "0.25rem" }}>
              {refPreserved ? "✓ IDENTICAL REFERENCE" : refPreserved === false ? "⚡ MUTATED REFERENCE" : "STANDBY"}
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Last Updated</div>
            <div style={{ fontSize: "0.95rem", fontFamily: "var(--font-mono)", marginTop: "0.25rem" }}>
              {snapshot.dataUpdatedAt ? new Date(snapshot.dataUpdatedAt).toLocaleTimeString() : "Never"}
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Expires / Stale At</div>
            <div style={{ fontSize: "0.95rem", fontFamily: "var(--font-mono)", marginTop: "0.25rem" }}>
              {snapshot.dataUpdatedAt ? new Date(snapshot.dataUpdatedAt + staleTimeMs).toLocaleTimeString() : "N/A"}
            </div>
          </div>
        </div>

        {/* Structural Sharing Explainer Callout */}
        <div style={{
          padding: "1rem",
          borderRadius: "8px",
          backgroundColor: refPreserved ? "rgba(16, 185, 129, 0.1)" : "rgba(59, 130, 246, 0.1)",
          border: `1px solid ${refPreserved ? "rgba(16, 185, 129, 0.3)" : "rgba(59, 130, 246, 0.3)"}`,
          marginBottom: "1.5rem"
        }}>
          <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" }}>
            🔍 Structural Sharing & SWR Audit:
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            {refStatus}
          </div>
        </div>

        {/* Payload Visualizer */}
        <div>
          <div style={{ display: "flex", gap: "1rem", borderBottom: "1px solid var(--border-card)", marginBottom: "1rem" }}>
            <button
              onClick={() => setActiveTab("visualizer")}
              style={{
                padding: "0.5rem 1rem",
                background: "transparent",
                border: "none",
                borderBottom: activeTab === "visualizer" ? "2px solid var(--border-highlight)" : "none",
                color: activeTab === "visualizer" ? "var(--text-main)" : "var(--text-muted)",
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Live Data Payload
            </button>
            <button
              onClick={() => setActiveTab("cache")}
              style={{
                padding: "0.5rem 1rem",
                background: "transparent",
                border: "none",
                borderBottom: activeTab === "cache" ? "2px solid var(--border-highlight)" : "none",
                color: activeTab === "cache" ? "var(--text-main)" : "var(--text-muted)",
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Cache Metadata
            </button>
          </div>

          {activeTab === "visualizer" && (
            <pre style={{
              background: "var(--bg-sidebar)",
              padding: "1rem",
              borderRadius: "8px",
              border: "1px solid var(--border-card)",
              fontSize: "0.875rem",
              overflowX: "auto"
            }}>
              {snapshot.data ? JSON.stringify(snapshot.data, null, 2) : "// No data loaded yet. Click 'Fetch Query' above."}
            </pre>
          )}

          {activeTab === "cache" && (
            <div style={{ background: "var(--bg-sidebar)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--border-card)", fontSize: "0.875rem" }}>
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "0.5rem", fontFamily: "var(--font-mono)" }}>
                <span style={{ color: "var(--text-muted)" }}>Query Hash:</span>
                <span>{queryHash}</span>
                <span style={{ color: "var(--text-muted)" }}>Query Key:</span>
                <span>{JSON.stringify(queryKey)}</span>
                <span style={{ color: "var(--text-muted)" }}>Status:</span>
                <span>{snapshot.status}</span>
                <span style={{ color: "var(--text-muted)" }}>Last Updated:</span>
                <span>{snapshot.dataUpdatedAt ?? "null"}</span>
                <span style={{ color: "var(--text-muted)" }}>Stale At:</span>
                <span>{snapshot.dataUpdatedAt ? snapshot.dataUpdatedAt + staleTimeMs : "null"}</span>
                <span style={{ color: "var(--text-muted)" }}>Is Stale:</span>
                <span>{isStale ? "TRUE (Needs Revalidation)" : "FALSE (Fresh)"}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      {Title === "h1" && (
        <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginTop: "var(--space-6)" }}>
          State graph and freshness timeline
        </h2>
      )}
      <LifecycleGraph />
      <StaleTimeline />
    </div>
  );
}
