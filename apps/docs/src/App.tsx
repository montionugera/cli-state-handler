import React, { useState } from "react";
import { SwrPlayground } from "./components/SwrPlayground.js";
import { TimingPlayground } from "./components/TimingPlayground.js";
import { OutboxPlayground } from "./components/OutboxPlayground.js";
import { CasPlayground } from "./components/CasPlayground.js";
import { MultiPlatformDocs } from "./components/MultiPlatformDocs.js";

type StoryId = "swr" | "timing" | "outbox" | "cas" | "multiplatform" | "overview";

export function App() {
  const [activeStory, setActiveStory] = useState<StoryId>("swr");

  return (
    <div className="storybook-container">
      {/* Sidebar */}
      <aside className="storybook-sidebar">
        <div style={{ padding: "1.25rem", borderBottom: "1px solid var(--border-card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
            <span style={{ fontSize: "1.25rem" }}>⚡</span>
            <span style={{ fontWeight: 800, fontSize: "1.1rem", letterSpacing: "-0.02em" }}>UCSA Studio</span>
            <span className="badge badge-emerald" style={{ marginLeft: "auto", fontSize: "0.65rem" }}>v1.4</span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            Unified Client State Architecture
          </div>
        </div>

        <nav style={{ padding: "1rem 0.5rem", flex: 1, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <div style={{ padding: "0.5rem 0.75rem", fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
            Documentation & Overview
          </div>
          <button
            onClick={() => setActiveStory("overview")}
            className={`btn ${activeStory === "overview" ? "btn-primary" : "btn-secondary"}`}
            style={{ justifyContent: "flex-start", width: "100%", textAlign: "left" }}
          >
            📖 Architecture Overview
          </button>

          <div style={{ padding: "0.75rem 0.75rem 0.25rem", fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
            Interactive Playgrounds
          </div>
          <button
            onClick={() => setActiveStory("swr")}
            className={`btn ${activeStory === "swr" ? "btn-primary" : "btn-secondary"}`}
            style={{ justifyContent: "flex-start", width: "100%", textAlign: "left" }}
          >
            ⚡ SWR & Lifecycle
          </button>
          <button
            onClick={() => setActiveStory("timing")}
            className={`btn ${activeStory === "timing" ? "btn-primary" : "btn-secondary"}`}
            style={{ justifyContent: "flex-start", width: "100%", textAlign: "left" }}
          >
            ⏱️ Timing & Rate-Limiting
          </button>
          <button
            onClick={() => setActiveStory("outbox")}
            className={`btn ${activeStory === "outbox" ? "btn-primary" : "btn-secondary"}`}
            style={{ justifyContent: "flex-start", width: "100%", textAlign: "left" }}
          >
            📦 Offline Outbox & Conflict
          </button>
          <button
            onClick={() => setActiveStory("cas")}
            className={`btn ${activeStory === "cas" ? "btn-primary" : "btn-secondary"}`}
            style={{ justifyContent: "flex-start", width: "100%", textAlign: "left" }}
          >
            💾 CAS Storage & LRU
          </button>

          <div style={{ padding: "0.75rem 0.75rem 0.25rem", fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)", letterSpacing: "0.05em" }}>
            Cross-Platform Code
          </div>
          <button
            onClick={() => setActiveStory("multiplatform")}
            className={`btn ${activeStory === "multiplatform" ? "btn-primary" : "btn-secondary"}`}
            style={{ justifyContent: "flex-start", width: "100%", textAlign: "left" }}
          >
            🌐 TS / Dart / Unity C#
          </button>
        </nav>

        <div style={{ padding: "1rem", borderTop: "1px solid var(--border-card)", fontSize: "0.75rem", color: "var(--text-muted)" }}>
          <div>Terminal Launcher:</div>
          <code style={{ color: "var(--accent-cyan)", display: "block", marginTop: "0.25rem" }}>ucsa tutorial</code>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="storybook-main">
        {activeStory === "swr" && <SwrPlayground />}

        {activeStory === "overview" && (
          <div className="card">
            <h1 style={{ fontSize: "1.75rem", fontWeight: 800, marginBottom: "0.75rem" }}>
              Unified Client State Architecture (UCSA)
            </h1>
            <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem" }}>
              UCSA is an industrial-grade, multi-platform client state management architecture designed for TypeScript, Dart/Flutter, and C# Unity applications.
            </p>

            <div className="stat-grid">
              <div className="stat-tile">
                <div className="stat-label">Platforms</div>
                <div className="stat-value">3 Native</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Cache Strategy</div>
                <div className="stat-value">SWR + WAL</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Structural Sharing</div>
                <div className="stat-value">Zero Redraw</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Test Suites</div>
                <div className="stat-value">100% Green</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div style={{ background: "var(--bg-card-subtle)", padding: "1.25rem", borderRadius: "8px", border: "1px solid var(--border-card)" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.5rem", color: "var(--accent-cyan)" }}>
                  Core Principles
                </h3>
                <ul style={{ paddingLeft: "1.25rem", fontSize: "0.875rem", color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <li><strong>Deterministic SWR:</strong> Serve immediate local cache; revalidate transparently in background.</li>
                  <li><strong>Structural Sharing:</strong> Deep value comparison via <code>replaceEqualDeep</code> suppresses redundant render cycles.</li>
                  <li><strong>Content-Addressable Storage:</strong> SHA-256 binary object storage with automatic LRU disk quota protection.</li>
                </ul>
              </div>

              <div style={{ background: "var(--bg-card-subtle)", padding: "1.25rem", borderRadius: "8px", border: "1px solid var(--border-card)" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 700, marginBottom: "0.5rem", color: "var(--accent-emerald)" }}>
                  Timing Controls
                </h3>
                <ul style={{ paddingLeft: "1.25rem", fontSize: "0.875rem", color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <li><strong>Observer Throttling & Debouncing:</strong> Rate-limit 60Hz high-frequency stream events.</li>
                  <li><strong>Query Debouncing:</strong> Collapse rapid keystrokes into single network executions.</li>
                  <li><strong>Outbox Rate-Limiting:</strong> Paced mutation replay preventing HTTP 429 Too Many Requests.</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {activeStory === "timing" && <TimingPlayground />}

        {activeStory === "outbox" && <OutboxPlayground />}

        {activeStory === "cas" && <CasPlayground />}

        {activeStory === "multiplatform" && <MultiPlatformDocs />}
      </main>
    </div>
  );
}
