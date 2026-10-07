import React, { useState } from "react";

interface CasVirtualObject {
  hash: string;
  size: number;
  data: string;
  prefixPath: string;
  lastAccessedAt: number;
}

// Compute deterministic SHA-256 hex string
async function computeSha256(content: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback simple hash for older environments
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(64, "0");
}

export function CasPlayground() {
  const [maxQuotaBytes, setMaxQuotaBytes] = useState(150000); // 150 KB
  const [inputText, setInputText] = useState("UCSA Native Engine Snapshot — Version 1.4.0 High-Performance Multiplatform Runtime");
  const [selectedPreset, setSelectedPreset] = useState("core");
  const [inspectedObject, setInspectedObject] = useState<CasVirtualObject | null>(null);

  const [objects, setObjects] = useState<CasVirtualObject[]>([
    {
      hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      size: 42500,
      data: "Unity C# Precompiled Assembly DLL — com.ucsa.unity.dll",
      prefixPath: "objects/e3/e3b0c44298fc1c149afbf4c8996fb924...",
      lastAccessedAt: Date.now() - 3600000
    },
    {
      hash: "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e",
      size: 58200,
      data: "Flutter Kernel Binary Snapshot — app.dill",
      prefixPath: "objects/a5/a591a6d40bf420404a011733cfb7b190...",
      lastAccessedAt: Date.now() - 1800000
    }
  ]);

  const totalUsedBytes = objects.reduce((sum, o) => sum + o.size, 0);
  const usedPercent = Math.min(100, (totalUsedBytes / maxQuotaBytes) * 100);

  const handleStore = async () => {
    if (!inputText.trim()) return;
    const hash = await computeSha256(inputText);
    const size = new TextEncoder().encode(inputText).length * 100; // Simulated realistic package size
    const prefix = hash.slice(0, 2);
    const prefixPath = `objects/${prefix}/${hash.slice(0, 16)}...`;

    const newObj: CasVirtualObject = {
      hash,
      size,
      data: inputText,
      prefixPath,
      lastAccessedAt: Date.now()
    };

    setObjects((prev) => {
      const filtered = prev.filter((o) => o.hash !== hash);
      return [newObj, ...filtered];
    });

    setInspectedObject(newObj);
  };

  const handleRead = (hash: string) => {
    setObjects((prev) =>
      prev.map((o) => (o.hash === hash ? { ...o, lastAccessedAt: Date.now() } : o))
    );
    const found = objects.find((o) => o.hash === hash);
    if (found) {
      setInspectedObject({ ...found, lastAccessedAt: Date.now() });
    }
  };

  const handleDelete = (hash: string) => {
    setObjects((prev) => prev.filter((o) => o.hash !== hash));
    if (inspectedObject?.hash === hash) {
      setInspectedObject(null);
    }
  };

  const handlePrune = (targetRatio = 0.7) => {
    const targetQuota = maxQuotaBytes * targetRatio;
    if (totalUsedBytes <= targetQuota) return;

    // Sort by lastAccessedAt ASC (oldest first)
    const sorted = [...objects].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    let currentBytes = totalUsedBytes;
    const toKeep: CasVirtualObject[] = [];

    for (const obj of sorted) {
      if (currentBytes > targetQuota) {
        currentBytes -= obj.size;
        // Evicted
      } else {
        toKeep.push(obj);
      }
    }

    setObjects(toKeep);
    if (inspectedObject && !toKeep.find((o) => o.hash === inspectedObject.hash)) {
      setInspectedObject(null);
    }
  };

  return (
    <div className="cas-playground space-y-6">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginBottom: "0.25rem" }}>
              Content-Addressable Storage (CAS) & LRU Pruning
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
              Immutable SHA-256 content-hashed object store with explicit access tracking and automatic LRU disk quota high-watermark pruning.
            </p>
          </div>
          <span className="badge badge-emerald">Storage Engine: SHA-256 CAS</span>
        </div>

        {/* Quota Gauge */}
        <div style={{ background: "var(--bg-sidebar)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--border-card)", marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem", fontSize: "0.875rem" }}>
            <span style={{ fontWeight: 600 }}>Disk Quota Utilization</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {(totalUsedBytes / 1024).toFixed(1)} KB / {(maxQuotaBytes / 1024).toFixed(0)} KB ({usedPercent.toFixed(1)}%)
            </span>
          </div>
          <div style={{ height: "10px", width: "100%", background: "var(--bg-card)", borderRadius: "999px", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${usedPercent}%`,
                background: usedPercent > 90 ? "var(--accent-rose)" : usedPercent > 70 ? "var(--accent-amber)" : "var(--accent-emerald)",
                transition: "width 0.3s ease"
              }}
            />
          </div>
        </div>

        {/* Store Controls */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "1rem", marginBottom: "1.5rem", alignItems: "flex-end" }}>
          <div>
            <label className="stat-label">Payload to Store (Computes SHA-256 hash & writes atomically)</label>
            <input
              type="text"
              className="input"
              data-testid="cas-input"
              style={{ width: "100%" }}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" onClick={handleStore}>
            💾 Store in CAS
          </button>
        </div>

        {/* Action Controls & Metric Tiles */}
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-label">Stored Objects</div>
            <div className="stat-value">{objects.length}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Total Size</div>
            <div className="stat-value" style={{ color: "var(--accent-cyan)" }}>
              {(totalUsedBytes / 1024).toFixed(1)} KB
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Quota Capacity</div>
            <div className="stat-value">{(maxQuotaBytes / 1024).toFixed(0)} KB</div>
          </div>
          <div className="stat-tile" style={{ display: "flex", alignItems: "center" }}>
            <button
              className="btn btn-secondary"
              style={{ width: "100%", height: "42px" }}
              onClick={() => handlePrune(0.7)}
            >
              🧹 Prune to 70% LRU
            </button>
          </div>
        </div>

        {/* Objects Table */}
        <div style={{ marginBottom: "1.5rem" }}>
          <div className="stat-label" style={{ marginBottom: "0.5rem" }}>CAS Object Index</div>
          <div style={{ overflowX: "auto", border: "1px solid var(--border-card)", borderRadius: "8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", textAlign: "left" }}>
              <thead>
                <tr style={{ background: "var(--bg-sidebar)", borderBottom: "1px solid var(--border-card)", color: "var(--text-muted)" }}>
                  <th style={{ padding: "0.5rem 0.75rem" }}>SHA-256 Hash</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Size</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Path</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Last Accessed</th>
                  <th style={{ padding: "0.5rem 0.75rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {objects.map((o) => (
                  <tr key={o.hash} style={{ borderBottom: "1px solid var(--border-card)", background: "var(--bg-card)" }}>
                    <td style={{ padding: "0.5rem 0.75rem", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
                      {o.hash.slice(0, 16)}...{o.hash.slice(-8)}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", fontFamily: "var(--font-mono)" }}>
                      {(o.size / 1024).toFixed(1)} KB
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                      {o.prefixPath}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.75rem" }}>
                      {new Date(o.lastAccessedAt).toLocaleTimeString()}
                    </td>
                    <td style={{ padding: "0.5rem 0.75rem", display: "flex", gap: "0.5rem" }}>
                      <button className="btn btn-secondary" style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }} onClick={() => handleRead(o.hash)}>
                        🔍 Touch / Read
                      </button>
                      <button className="btn btn-danger" style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }} onClick={() => handleDelete(o.hash)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Inspected Object Detail */}
        {inspectedObject && (
          <div style={{ background: "var(--bg-sidebar)", padding: "1rem", borderRadius: "8px", border: "1px solid var(--border-card)" }}>
            <div style={{ fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.5rem" }}>
              Inspected CAS Payload:
            </div>
            <pre style={{ fontSize: "0.8rem", color: "var(--text-main)", overflowX: "auto" }}>
              {inspectedObject.data}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
