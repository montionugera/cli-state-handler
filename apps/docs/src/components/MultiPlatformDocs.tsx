import React, { useState } from "react";

type PlatformId = "ts" | "dart" | "csharp";
type ConceptId = "swr" | "observer" | "timing" | "outbox" | "cas";

interface CodeSnippet {
  title: string;
  lang: string;
  code: string;
  notes: string[];
}

const SNIPPETS: Record<ConceptId, Record<PlatformId, CodeSnippet>> = {
  swr: {
    ts: {
      title: "QueryEngine & SWR Lifecycle (TypeScript)",
      lang: "typescript",
      code: `import { QueryEngine, SqliteAdapter } from "@ucsa/core";

const sqlite = new SqliteAdapter({ dbPath: "./app-cache.db" });
const engine = new QueryEngine({
  sqliteAdapter: sqlite,
  defaultStaleTime: 5000 // 5 seconds
});

// Stale-While-Revalidate Query
const user = await engine.fetchQuery(
  ["users", "profile"],
  async ({ signal }) => {
    const res = await fetch("/api/v1/user/profile", { signal });
    return res.json();
  },
  { staleTime: 10000, tags: ["user:42"] }
);`,
      notes: [
        "Returns cached SQLite/memory data synchronously if available.",
        "Triggers asynchronous background refetch if staleAt has passed.",
        "Uses replaceEqualDeep to preserve object reference identities on identical payloads."
      ]
    },
    dart: {
      title: "QueryEngine & SWR Lifecycle (Dart / Flutter)",
      lang: "dart",
      code: `import 'package:ucsa_dart/ucsa_dart.dart';

final sqlite = SqliteAdapter(dbPath: 'app_cache.db');
final engine = QueryEngine(
  sqliteAdapter: sqlite,
  defaultStaleTime: const Duration(seconds: 5),
);

// Stale-While-Revalidate Query
final user = await engine.fetchQuery<Map<String, dynamic>>(
  ['users', 'profile'],
  (ctx) async {
    final response = await http.get(Uri.parse('/api/v1/user/profile'));
    return jsonDecode(response.body);
  },
  staleDuration: const Duration(seconds: 10),
  tags: ['user:42'],
);`,
      notes: [
        "Pure Dart 3+ implementation using async/await and sealed records.",
        "Thread-safe in-memory cache backing with SQLite disk persistence.",
        "Emits reactive Stream updates consumed by Flutter widgets."
      ]
    },
    csharp: {
      title: "QueryEngine & SWR Lifecycle (C# Unity)",
      lang: "csharp",
      code: `using Ucsa.Unity.Core;
using Ucsa.Unity.Storage;

var sqlite = new UnitySqliteAdapter(Application.persistentDataPath + "/app_cache.db");
sqlite.InitSchema();

var engine = new QueryEngine(sqlite, defaultStaleTimeMs: 5000);

// Stale-While-Revalidate Query
var user = await engine.FetchQueryAsync<UserProfile>(
    new object[] { "users", "profile" },
    async (ct) => {
        using var request = UnityWebRequest.Get("/api/v1/user/profile");
        await request.SendWebRequest();
        return JsonUtility.FromJson<UserProfile>(request.downloadHandler.text);
    },
    new QueryOptions { StaleTimeMs = 10000, Tags = new[] { "user:42" } }
);`,
      notes: [
        "Compatible with Unity 2021.3+ LTS and IL2CPP Ahead-of-Time compilation.",
        "Zero GC allocations in dirty-checking and SWR cache lookups.",
        "Integrates cleanly with CancellationToken for frame-rate safe async execution."
      ]
    }
  },
  observer: {
    ts: {
      title: "Zero-Rebuild Selector Observer (React 19)",
      lang: "typescript",
      code: `import { createSelectorObserver } from "@ucsa/core";
import { useSyncExternalStore } from "react";

// Observer extracts ONLY user.name
const nameObserver = createSelectorObserver(
  engine,
  ["users", "profile"],
  (user) => user.name
);

export function UserNameBadge() {
  const name = useSyncExternalStore(
    nameObserver.subscribe,
    nameObserver.getSnapshot
  );

  // Re-renders ONLY when user.name actually changes!
  // Updates to user.avatar, user.metrics, etc. result in ZERO re-renders.
  return <span className="badge">{name}</span>;
}`,
      notes: [
        "Prevents unnecessary React reconciliation cycles.",
        "Works natively with React 19 useSyncExternalStore.",
        "Supports custom equality comparers."
      ]
    },
    dart: {
      title: "Zero-Rebuild Selector Observer (Flutter)",
      lang: "dart",
      code: `import 'package:flutter/material.dart';
import 'package:ucsa_dart/ucsa_dart.dart';

final nameObserver = SelectorObserver<UserProfile, String>(
  engine: engine,
  queryKey: ['users', 'profile'],
  selector: (user) => user.name,
);

class UserNameBadge extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<String?>(
      valueListenable: nameObserver,
      builder: (context, name, _) {
        // Rebuilds ONLY when name changes; suppresses rebuild on other field updates
        return Text(name ?? 'Loading...');
      },
    );
  }
}`,
      notes: [
        "Implements Flutter ValueListenable<T> interface.",
        "Completely suppresses element tree rebuilding when unselected slices update.",
        "Supports disposal via dispose() when widget unmounts."
      ]
    },
    csharp: {
      title: "Zero-Rebuild State Observer (Unity UI / uGUI / UI Toolkit)",
      lang: "csharp",
      code: `using UnityEngine;
using UnityEngine.UI;
using Ucsa.Unity.Core;

public class UserNameBadge : MonoBehaviour
{
    [SerializeField] private Text nameLabel;
    private StateObserver<UserProfile, string> _observer;

    void Start()
    {
        _observer = new StateObserver<UserProfile, string>(u => u.Name);
        _observer.OnValueChanged += newName => {
            // Fired ONLY when Name changes!
            // Suppresses Canvas batch rebuilding on telemetry/sync updates.
            nameLabel.text = newName;
        };
    }
}`,
      notes: [
        "Crucial for mobile and VR Unity titles to maintain 60/90/120 FPS.",
        "Prevents Canvas geometry generation and draw-call overhead on frequent state updates.",
        "Thread-safe invocation on Unity main thread."
      ]
    }
  },
  timing: {
    ts: {
      title: "Observer Throttling & Query Debouncing (TypeScript)",
      lang: "typescript",
      code: `import { createSelectorObserver, debounceQuery } from "@ucsa/core";

// 1. Observer Rate-Limiting: throttle high-frequency 60Hz telemetry to 100ms
const telemetryObserver = createSelectorObserver(
  engine,
  ["system", "telemetry"],
  (data) => data.fps,
  { throttleMs: 100 } // Leading + trailing dispatch
);

// 2. Query Debouncing: search keystrokes collapse into single request
export async function onSearchKey(term: string) {
  return debounceQuery(
    engine,
    ["search", "packages"],
    async () => fetchSearchResults(term),
    { debounceMs: 300 } // Superseded timers automatically cancelled
  );
}`,
      notes: [
        "throttleMs provides leading-edge immediate render plus trailing-edge latest state guarantee.",
        "debounceMs waits for quiet period before dispatching to UI.",
        "debounceQuery collapses rapid calls into a single network execution."
      ]
    },
    dart: {
      title: "Observer Throttling & Query Debouncing (Dart / Flutter)",
      lang: "dart",
      code: `import 'package:ucsa_dart/ucsa_dart.dart';

// Throttled observer for sensor / WebSocket streams
final sensorObserver = SelectorObserver<SensorData, double>(
  engine: engine,
  queryKey: ['hardware', 'sensors'],
  selector: (data) => data.temperature,
  throttleDuration: const Duration(milliseconds: 100),
);

// Debounced search query
Future<List<SearchResult>> onTypeahead(String term) {
  return engine.fetchQuery<List<SearchResult>>(
    ['search', 'query'],
    (ctx) => searchApi(term),
    debounceDuration: const Duration(milliseconds: 300),
  );
}`,
      notes: [
        "Timer management is lifecycle-managed with automatic disposal on cancel.",
        "Prevents Flutter frame drops during rapid sensor or socket ingress.",
        "Zero-allocation internal scheduling."
      ]
    },
    csharp: {
      title: "Observer Throttling & Query Debouncing (C# Unity)",
      lang: "csharp",
      code: `using Ucsa.Unity.Core;

// Throttle high-frequency physics/transform telemetry
var physicsObserver = new StateObserver<RigidBodyState, Vector3>(
    state => state.Position,
    throttleMs: 50 // Max 20 UI updates per second
);

// Debounced query execution
var results = await engine.FetchQueryAsync<SearchResponse>(
    new object[] { "search", "items" },
    (ct) => QueryBackendAsync(term, ct),
    new QueryOptions { DebounceMs = 300 }
);`,
      notes: [
        "Protects frame-rate in game loops with high-frequency tick rates.",
        "Integer millisecond precision using Stopwatch without DateTime allocations.",
        "Integrates with Unity Coroutines or async/await Task system."
      ]
    }
  },
  outbox: {
    ts: {
      title: "Offline Mutation Outbox & Rate-Limiting (TypeScript)",
      lang: "typescript",
      code: `import { MutationOutbox, SqliteAdapter } from "@ucsa/core";

const outbox = new MutationOutbox({ sqliteAdapter: sqlite });

// Enqueue offline action
outbox.enqueue({
  endpoint: "/api/v1/orders/checkout",
  method: "POST",
  payload: { item: "pkg_42", qty: 2 },
  conflictPolicy: "merge"
});

// Replay with rate-limit pacing and batch size chunking
const result = await outbox.replay({
  rateLimitMs: 50, // 50ms pacing between requests
  batchSize: 5,    // Process in batches of 5
  executor: async (mut) => apiCall(mut),
  conflictResolver: async (mut, serverState) => "merged"
});`,
      notes: [
        "Persists mutations in SQLite WAL table ucsa_mutation_outbox.",
        "rateLimitMs and batchSize protect backend gateways from 429 Too Many Requests.",
        "Flexible conflict resolution: server-wins, client-wins, or 3-way merge."
      ]
    },
    dart: {
      title: "Offline Mutation Outbox & Rate-Limiting (Dart / Flutter)",
      lang: "dart",
      code: `import 'package:ucsa_dart/ucsa_dart.dart';

final outbox = MutationOutbox(sqliteAdapter: sqlite);

outbox.enqueue(OutboxMutation(
  mutationId: 'mut_101',
  endpoint: '/api/v1/messages/send',
  method: 'POST',
  payload: '{"text": "Hello offline world"}',
  conflictPolicy: ConflictPolicy.merge,
));

// Replay when connectivity is restored
final result = await sqlite.replayOutbox(
  rateLimit: const Duration(milliseconds: 50),
  batchSize: 5,
  executor: (mut) async => sendNetworkRequest(mut),
);`,
      notes: [
        "Seamless offline-first workflow for mobile field applications.",
        "Survives mobile app backgrounding and app restarts.",
        "Paced batch execution avoids cellular network congestion."
      ]
    },
    csharp: {
      title: "Offline Mutation Outbox & Rate-Limiting (C# Unity)",
      lang: "csharp",
      code: `using Ucsa.Unity.Storage;
using Ucsa.Unity.Core;

sqlite.EnqueueOutboxMutation(new OutboxMutation<string> {
    MutationId = "mut_202",
    Endpoint = "/api/v1/inventory/equip",
    Method = "POST",
    Payload = "{\\"itemId\\": 99}",
    ConflictPolicy = ConflictPolicy.ServerWins
});

// Replay outbox on reconnect
var report = await sqlite.ReplayOutboxAsync(
    executor: async (mut) => await PostMutationAsync(mut),
    rateLimitMs: 50,
    batchSize: 5
);`,
      notes: [
        "Ensures in-game purchases and inventory actions are never lost on network disconnect.",
        "Replay happens asynchronously without blocking rendering or gameplay threads.",
        "Automatic retry counter and status persistence in SQLite."
      ]
    }
  },
  cas: {
    ts: {
      title: "Content-Addressable Storage & LRU Pruning (TypeScript)",
      lang: "typescript",
      code: `import { CasStore, SqliteAdapter } from "@ucsa/core";

const cas = new CasStore({
  baseDir: "./cache/cas",
  sqliteAdapter: sqlite,
  maxSizeBytes: 50 * 1024 * 1024 // 50 MB disk quota
});
await cas.init();

// Store binary package payload
const { hash, size, path } = await cas.put(packageBuffer);
console.log(\`Stored SHA-256: \${hash} at \${path}\`);

// Automatic LRU Pruning when quota exceeded, or manual trigger
const { prunedCount, bytesFreed } = await cas.prune(0.70); // Prune to 70% threshold`,
      notes: [
        "Atomic rename via .tmp/<uuid> guarantees zero corrupt partial files.",
        "Explicit SQLite ucsa_cas_objects table circumvents OS noatime mount limitations.",
        "Subdirectory sharding (objects/ab/c123...) prevents filesystem inode bottlenecks."
      ]
    },
    dart: {
      title: "Content-Addressable Storage & LRU Pruning (Dart / Flutter)",
      lang: "dart",
      code: `import 'package:ucsa_dart/ucsa_dart.dart';

final cas = CasStore(
  baseDir: '/path/to/cas',
  sqliteAdapter: sqlite,
  maxSizeBytes: 50 * 1024 * 1024,
);
await cas.init();

// Store binary asset
final result = await cas.put(assetBytes);

// Retrieve asset and touch access timestamp
final bytes = await cas.get(result.hash);

// LRU Prune
final pruneResult = await cas.prune(targetRatio: 0.7);`,
      notes: [
        "Ideal for caching downloaded game assets, PDF documents, or profile images in Flutter.",
        "Atomic writes prevent corruption if the app is closed mid-download.",
        "Deterministic SHA-256 verification rejects tampered or incomplete payloads."
      ]
    },
    csharp: {
      title: "Content-Addressable Storage & LRU Pruning (C# Unity)",
      lang: "csharp",
      code: `using Ucsa.Unity.Storage;

var cas = new UnityCasStore(
    baseDir: Application.persistentDataPath + "/cas",
    sqliteAdapter: sqlite,
    maxSizeBytes: 100 * 1024 * 1024 // 100 MB AssetBundle cache
);
await cas.InitAsync();

// Store AssetBundle or downloaded texture
var result = await cas.PutAsync(assetBytes);

// Get and touch access time
var data = await cas.GetAsync(result.Hash);

// Prune to 70% of quota
var prune = await cas.PruneAsync(0.70);`,
      notes: [
        "Perfect for caching downloadable Unity AssetBundles and Addressables.",
        "Protects mobile device disk storage from unbounded growth.",
        "SHA-256 integrity check prevents runtime crash from corrupted AssetBundles."
      ]
    }
  }
};

export function MultiPlatformDocs() {
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId>("ts");
  const [selectedConcept, setSelectedConcept] = useState<ConceptId>("swr");
  const [copied, setCopied] = useState(false);

  const snippet = SNIPPETS[selectedConcept][selectedPlatform];

  const handleCopy = () => {
    navigator.clipboard?.writeText(snippet.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="multiplatform-docs space-y-6">
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "var(--text-main)", marginBottom: "0.25rem" }}>
              Multi-Platform Code Reference & Tutorial
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
              Interactive cross-platform implementation guide comparing UCSA patterns across TypeScript Core, Dart / Flutter, and C# Unity.
            </p>
          </div>
          <span className="badge badge-cyan">3 Native Implementations</span>
        </div>

        {/* Concept Selector Tabs */}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem", borderBottom: "1px solid var(--border-card)", paddingBottom: "0.75rem" }}>
          <button
            className={`btn ${selectedConcept === "swr" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setSelectedConcept("swr")}
          >
            ⚡ 1. SWR Query Engine
          </button>
          <button
            className={`btn ${selectedConcept === "observer" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setSelectedConcept("observer")}
          >
            🎯 2. Zero-Rebuild Observer
          </button>
          <button
            className={`btn ${selectedConcept === "timing" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setSelectedConcept("timing")}
          >
            ⏱️ 3. Timing Controls
          </button>
          <button
            className={`btn ${selectedConcept === "outbox" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setSelectedConcept("outbox")}
          >
            📦 4. Offline Outbox
          </button>
          <button
            className={`btn ${selectedConcept === "cas" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setSelectedConcept("cas")}
          >
            💾 5. CAS Package Cache
          </button>
        </div>

        {/* Platform Language Switcher */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={() => setSelectedPlatform("ts")}
              className={`btn ${selectedPlatform === "ts" ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}
            >
              🟦 TypeScript (React / Node)
            </button>
            <button
              onClick={() => setSelectedPlatform("dart")}
              className={`btn ${selectedPlatform === "dart" ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}
            >
              🎯 Dart 3+ (Flutter)
            </button>
            <button
              onClick={() => setSelectedPlatform("csharp")}
              className={`btn ${selectedPlatform === "csharp" ? "btn-primary" : "btn-secondary"}`}
              style={{ fontSize: "0.8rem", padding: "0.4rem 0.8rem" }}
            >
              🎮 C# Unity (.NET / IL2CPP)
            </button>
          </div>

          <button className="btn btn-secondary" style={{ fontSize: "0.75rem", padding: "0.4rem 0.8rem" }} onClick={handleCopy}>
            {copied ? "✓ Copied to Clipboard" : "📋 Copy Code"}
          </button>
        </div>

        {/* Code Snippet Box */}
        <div style={{ position: "relative", marginBottom: "1.5rem" }}>
          <div style={{ background: "var(--bg-sidebar)", padding: "0.5rem 1rem", borderTopLeftRadius: "8px", borderTopRightRadius: "8px", border: "1px solid var(--border-card)", borderBottom: "none", fontSize: "0.8rem", color: "var(--text-muted)", fontWeight: 600 }}>
            {snippet.title}
          </div>
          <pre style={{
            background: "#05080f",
            padding: "1.25rem",
            borderBottomLeftRadius: "8px",
            borderBottomRightRadius: "8px",
            border: "1px solid var(--border-card)",
            fontSize: "0.85rem",
            lineHeight: 1.6,
            overflowX: "auto",
            color: "#e2e8f0"
          }}>
            <code>{snippet.code}</code>
          </pre>
        </div>

        {/* Architectural Notes */}
        <div style={{ background: "var(--bg-card-subtle)", padding: "1.25rem", borderRadius: "8px", border: "1px solid var(--border-card)" }}>
          <h4 style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--accent-cyan)", marginBottom: "0.5rem" }}>
            Platform Architecture & Engineering Notes:
          </h4>
          <ul style={{ paddingLeft: "1.25rem", fontSize: "0.85rem", color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {snippet.notes.map((note, idx) => (
              <li key={idx}>{note}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
