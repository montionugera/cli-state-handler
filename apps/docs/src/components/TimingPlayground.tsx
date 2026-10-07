import React, { useState, useEffect, useRef } from "react";
import { QueryEngine, debounceQuery } from "@ucsa/core";

export function TimingPlayground() {
  // --- Section 1: Observer Throttling & Debouncing ---
  const [throttleMs, setThrottleMs] = useState(100);
  const [debounceMs, setDebounceMs] = useState(0);
  const [rawEventCount, setRawEventCount] = useState(0);
  const [uiRenderCount, setUiRenderCount] = useState(0);
  const [latestValue, setLatestValue] = useState<number>(0);
  const [isStreaming, setIsStreaming] = useState(false);

  // References for timing tracking
  const rawCountRef = useRef(0);
  const uiCountRef = useRef(0);
  const lastThrottleTimeRef = useRef(0);
  const debounceTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const throttleTrailingTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const pendingValueRef = useRef<number | null>(null);

  // Function to process an event through throttle/debounce timing logic
  const emitEvent = (val?: number) => {
    const nextVal = val ?? ++rawCountRef.current;
    setRawEventCount(rawCountRef.current);
    pendingValueRef.current = nextVal;

    const now = Date.now();

    // Debounce logic
    if (debounceMs > 0) {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        dispatchToUi(pendingValueRef.current!);
      }, debounceMs);
      return;
    }

    // Throttle logic
    if (throttleMs > 0) {
      const elapsed = now - lastThrottleTimeRef.current;
      if (elapsed >= throttleMs) {
        // Leading edge
        lastThrottleTimeRef.current = now;
        dispatchToUi(nextVal);
      } else {
        // Trailing edge
        if (throttleTrailingTimerRef.current) {
          clearTimeout(throttleTrailingTimerRef.current);
        }
        throttleTrailingTimerRef.current = setTimeout(() => {
          lastThrottleTimeRef.current = Date.now();
          if (pendingValueRef.current !== null) {
            dispatchToUi(pendingValueRef.current);
          }
        }, throttleMs - elapsed);
      }
      return;
    }

    // Unthrottled / Immediate
    dispatchToUi(nextVal);
  };

  const dispatchToUi = (val: number) => {
    uiCountRef.current++;
    setUiRenderCount(uiCountRef.current);
    setLatestValue(val);
  };

  // Burst generator (30 events in 50ms)
  const triggerBurst = () => {
    for (let i = 1; i <= 30; i++) {
      setTimeout(() => {
        emitEvent();
      }, i * 2);
    }
  };

  // 60Hz Telemetry Stream simulation
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      emitEvent();
    }, 16); // ~60fps
    return () => clearInterval(interval);
  }, [isStreaming, throttleMs, debounceMs]);

  const resetObserverStats = () => {
    rawCountRef.current = 0;
    uiCountRef.current = 0;
    setRawEventCount(0);
    setUiRenderCount(0);
    setLatestValue(0);
  };

  const suppressionRatio =
    rawEventCount > 0
      ? Math.max(0, (((rawEventCount - uiRenderCount) / rawEventCount) * 100)).toFixed(1)
      : "0.0";

  // --- Section 2: Query Execution Debouncing ---
  const [queryEngine] = useState(() => new QueryEngine());
  const [searchTerm, setSearchTerm] = useState("");
  const [queryDebounceMs, setQueryDebounceMs] = useState(300);
  const [keystrokesCount, setKeystrokesCount] = useState(0);
  const [networkFetchCount, setNetworkFetchCount] = useState(0);
  const [queryResults, setQueryResults] = useState<string[]>([]);
  const [isQueryPending, setIsQueryPending] = useState(false);

  const mockDatabase = [
    "UCSA Core State Engine",
    "UCSA React Bindings",
    "UCSA Dart & Flutter Client",
    "UCSA C# Unity Package",
    "Content-Addressable Storage (CAS)",
    "Mutation Outbox & Offline Sync",
    "Structural Sharing Diff Engine",
    "Observer Throttle & Debounce"
  ];

  const handleSearchInput = (term: string) => {
    setSearchTerm(term);
    setKeystrokesCount((c) => c + 1);
    setIsQueryPending(true);

    debounceQuery(
      queryEngine,
      ["search", "packages"],
      async () => {
        setNetworkFetchCount((c) => c + 1);
        setIsQueryPending(false);
        if (!term.trim()) return [];
        return mockDatabase.filter((item) =>
          item.toLowerCase().includes(term.toLowerCase())
        );
      },
      { debounceMs: queryDebounceMs }
    ).then((res: string[]) => {
      setQueryResults(res);
      setIsQueryPending(false);
    });
  };

  return (
    <div className="timing-playground space-y-6">
      {/* Observer Throttling Card */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginBottom: "0.25rem" }}>
              Observer Timing & UI Render Suppression
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
              Simulates high-frequency incoming data streams (e.g. 60Hz telemetry, rapid WebSocket feeds) and demonstrates how UCSA observer timing controls suppress redundant downstream UI repaints.
            </p>
          </div>
          <span className="badge badge-emerald">Active Mode: {debounceMs > 0 ? "Debounced" : throttleMs > 0 ? "Throttled" : "Unthrottled"}</span>
        </div>

        {/* Sliders */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginBottom: "1.5rem" }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
              <label className="stat-label">Throttle Window (throttleMs)</label>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.875rem", color: "var(--accent-cyan)" }}>{throttleMs} ms</span>
            </div>
            <input
              type="range"
              min="0"
              max="500"
              step="20"
              value={throttleMs}
              onChange={(e) => {
                setThrottleMs(Number(e.target.value));
                setDebounceMs(0); // Mutually exclusive for clear demo
              }}
              style={{ width: "100%" }}
            />
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
              <label className="stat-label">Debounce Delay (debounceMs)</label>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.875rem", color: "var(--accent-amber)" }}>{debounceMs} ms</span>
            </div>
            <input
              type="range"
              min="0"
              max="500"
              step="20"
              value={debounceMs}
              onChange={(e) => {
                setDebounceMs(Number(e.target.value));
                setThrottleMs(0); // Mutually exclusive for clear demo
              }}
              style={{ width: "100%" }}
            />
          </div>
        </div>

        {/* Interactive Triggers */}
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={triggerBurst}>
            ⚡ Trigger Rapid Burst (30 Events)
          </button>
          <button
            className={`btn ${isStreaming ? "btn-danger" : "btn-secondary"}`}
            onClick={() => setIsStreaming(!isStreaming)}
          >
            {isStreaming ? "⏹️ Stop 60Hz Telemetry" : "▶️ Start 60Hz Telemetry Stream"}
          </button>
          <button className="btn btn-secondary" onClick={() => emitEvent()}>
            Single Event
          </button>
          <button className="btn btn-secondary" onClick={resetObserverStats}>
            Reset Stats
          </button>
        </div>

        {/* Metric Tiles */}
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-label">Raw Events Ingested</div>
            <div className="stat-value">{rawEventCount}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">UI Subscribers Dispatched</div>
            <div className="stat-value" style={{ color: "var(--accent-emerald)" }}>{uiRenderCount}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Render Suppression Ratio</div>
            <div className="stat-value" style={{ color: "var(--accent-cyan)" }}>{suppressionRatio}%</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Latest Dispatched Value</div>
            <div className="stat-value" style={{ fontFamily: "var(--font-mono)", fontSize: "1.25rem" }}>
              #{latestValue}
            </div>
          </div>
        </div>
      </div>

      {/* Query Execution Debouncing Card */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginBottom: "0.25rem" }}>
              Query Execution Debouncing & Cancellation
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
              Collapses rapid keystrokes or UI triggers into a single remote network fetch, automatically cancelling superseded timers.
            </p>
          </div>
          {isQueryPending && <span className="badge badge-amber">⏱️ Debounce Timer Active</span>}
          {!isQueryPending && <span className="badge badge-emerald">Idle</span>}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: "1rem", marginBottom: "1.5rem" }}>
          <div>
            <label className="stat-label">Search Query (Type rapidly to observe debounce collapse)</label>
            <input
              type="text"
              className="input"
              data-testid="search-input"
              style={{ width: "100%" }}
              placeholder="Type e.g. 'unity', 'flutter', 'storage'..."
              value={searchTerm}
              onChange={(e) => handleSearchInput(e.target.value)}
            />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
              <label className="stat-label">Debounce (ms)</label>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.875rem" }}>{queryDebounceMs} ms</span>
            </div>
            <input
              type="range"
              min="50"
              max="800"
              step="50"
              value={queryDebounceMs}
              onChange={(e) => setQueryDebounceMs(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
        </div>

        {/* Query Stats */}
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-label">Keystrokes / Invocations</div>
            <div className="stat-value" data-testid="keystrokes-count">{keystrokesCount}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Network Executions</div>
            <div className="stat-value" style={{ color: "var(--accent-emerald)" }}>{networkFetchCount}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Calls Saved / Cancelled</div>
            <div className="stat-value" style={{ color: "var(--accent-cyan)" }}>
              {Math.max(0, keystrokesCount - networkFetchCount)}
            </div>
          </div>
        </div>

        {/* Results Preview */}
        <div>
          <div className="stat-label" style={{ marginBottom: "0.5rem" }}>Resolved Matches ({queryResults.length})</div>
          <div style={{ background: "var(--bg-sidebar)", padding: "0.75rem", borderRadius: "8px", border: "1px solid var(--border-card)" }}>
            {queryResults.length > 0 ? (
              <ul style={{ paddingLeft: "1.25rem", fontSize: "0.875rem", color: "var(--text-main)" }}>
                {queryResults.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: "0.25rem" }}>{item}</li>
                ))}
              </ul>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
                {searchTerm ? "No matches found." : "Type above to search."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
