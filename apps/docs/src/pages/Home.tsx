import React from "react";
import "./home.css";

export function Home() {
  return (
    <div className="card">
      <h1 className="home__title">
        Unified Client State Architecture (UCSA)
      </h1>
      <p className="home__lead">
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

      <div className="home__panels">
        <div className="home__panel">
          <h3 className="home__panel-title home__panel-title--cyan">
            Core Principles
          </h3>
          <ul className="home__list">
            <li><strong>Deterministic SWR:</strong> Serve immediate local cache; revalidate transparently in background.</li>
            <li><strong>Structural Sharing:</strong> Deep value comparison via <code>replaceEqualDeep</code> suppresses redundant render cycles.</li>
            <li><strong>Content-Addressable Storage:</strong> SHA-256 binary object storage with automatic LRU disk quota protection.</li>
          </ul>
        </div>

        <div className="home__panel">
          <h3 className="home__panel-title home__panel-title--emerald">
            Timing Controls
          </h3>
          <ul className="home__list">
            <li><strong>Observer Throttling & Debouncing:</strong> Rate-limit 60Hz high-frequency stream events.</li>
            <li><strong>Query Debouncing:</strong> Collapse rapid keystrokes into single network executions.</li>
            <li><strong>Outbox Rate-Limiting:</strong> Paced mutation replay preventing HTTP 429 Too Many Requests.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
