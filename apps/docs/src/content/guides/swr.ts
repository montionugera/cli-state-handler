import { CORE, DART, CS, GODOT, type Guide } from "./types.js";

export const swr: Guide = {
  id: "swr",
  label: "SWR Query Engine",
  ts: {
    title: "QueryEngine & SWR Lifecycle (TypeScript)",
    lang: "typescript",
    available: true,
    sources: [`${CORE}/query/query-engine.ts`, `${CORE}/storage/sqlite-adapter.ts`],
    code: `// Checked against: packages/core/src/query/query-engine.ts (useQuery, fetchQuery)
import { QueryEngine, SqliteAdapter } from "@montionugera/ucsa-core";

const sqlite = new SqliteAdapter("./app-cache.db");
const engine = new QueryEngine({ sqliteAdapter: sqlite, defaultStaleTime: 5000 });

// useQuery returns { getSnapshot, subscribe, cancel }.
// No data yet: status is "loading" and the fetch starts.
// Data present but stale: the cached data stays in the snapshot and a
// background fetch starts (isFetching is true).
const profile = engine.useQuery(
  ["users", "profile"],
  async ({ signal }) => (await fetch("/api/v1/user/profile", { signal })).json(),
  { staleTime: 10000, tags: ["user:42"] }
);
const stop = profile.subscribe(() => console.log(profile.getSnapshot().status));

// fetchQuery resolves from memory only while the entry is fresh;
// otherwise it awaits a new fetch (no stale-while-revalidate here).
const user = await engine.fetchQuery(["users", "profile"], async () => ({ name: "Ada" }));`,
    notes: [
      "On a successful fetch the engine stamps stale_at = fetch time + staleTime (default 0) and expires_at = fetch time + gcTime (default 300000). Both are fixed at write time.",
      "Staleness is judged only when a read happens. A staleTime passed to a read overrides the stored stale_at for that read.",
      "There is no observer-based garbage collection and no built-in focus or online refetch. FocusManager and OnlineManager exist, but the application wires them up.",
      "The engine reports loading, success and error. LifecycleFSM has no transition guards and QueryEngine does not use it.",
    ],
  },
  dart: {
    title: "QueryEngine & SWR Lifecycle (Dart / Flutter)",
    lang: "dart",
    available: true,
    sources: [`${DART}/query_engine.dart`, `${DART}/sqlite_adapter.dart`],
    code: `// Checked against: packages/ucsa_dart/lib/src/query_engine.dart (watchQuery, QueryWatcher),
// packages/ucsa_dart/lib/src/sqlite_adapter.dart (SqliteAdapter.file)
import 'package:ucsa_dart/ucsa_dart.dart';

final sqlite = SqliteAdapter.file('app_cache.db');
final engine = QueryEngine(
  sqliteAdapter: sqlite,
  defaultStaleTime: const Duration(seconds: 5),
);

// watchQuery follows TypeScript useQuery: cached data is returned in the
// snapshot and a stale entry is revalidated in the background (staleness
// is computed differently, see the notes).
// fetchProfile is your own function returning Future<Map<String, dynamic>>.
final watcher = engine.watchQuery<Map<String, dynamic>>(
  ['users', 'profile'],
  queryFn: () => fetchProfile(),
  staleTime: const Duration(seconds: 10),
  tags: ['user:42'],
);
final stop = watcher.subscribe(() => print(watcher.getSnapshot().status));

// fetchQuery returns the cached value only while it is fresh, else it awaits a fetch.
final user = await engine.fetchQuery<Map<String, dynamic>>(
  ['users', 'profile'],
  () => fetchProfile(),
);`,
    notes: [
      "The query function takes no context argument in Dart (Future<T> Function()); there is no AbortSignal equivalent on fetchQuery.",
      "Durations are Dart Duration values (staleTime, gcTime), not milliseconds.",
      "Staleness differs from TypeScript: Dart never consults the stored staleAt when an entry exists; it computes createdAt + (staleTime ?? record.staleTime ?? defaultStaleTime). TypeScript uses the stored stale_at unless the read passes staleTime.",
      "Dart has LifecycleFSM and a QueryWatcher, but no FocusManager or OnlineManager (searched lib/src for focus and online).",
    ],
  },
  csharp: {
    title: "QueryEngine & SWR Lifecycle (C# Unity)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Core/QueryEngine.cs`, `${CS}/Core/Types.cs`, `${CS}/Storage/SqliteAdapter.cs`],
    code: `// Checked against: Runtime/Core/QueryEngine.cs (WatchQuery, FetchQueryAsync),
// Runtime/Core/Types.cs (QueryOptions), Runtime/Storage/SqliteAdapter.cs (constructor)
using System.Collections.Generic;
using Ucsa.Core;
using Ucsa.Storage;

// The constructor opens the file and runs InitSchema itself.
var sqlite = new SqliteAdapter(Application.persistentDataPath + "/app_cache.db");
var engine = new QueryEngine(sqlite, defaultStaleTime: 5000);

var options = new QueryOptions { StaleTime = 10000, Tags = new List<string> { "user:42" } };

// WatchQuery: cached data is emitted at once and a stale entry is revalidated in
// the background. UserProfile and LoadProfileAsync are your own code.
IDisposable subscription = engine.WatchQuery<UserProfile>(
    new object[] { "users", "profile" },
    state => Debug.Log(state.Status),
    options,
    ct => LoadProfileAsync(ct));

// FetchQueryAsync returns the cached value only while it is fresh, else it awaits a fetch.
var user = await engine.FetchQueryAsync<UserProfile>(
    new object[] { "users", "profile" }, ct => LoadProfileAsync(ct), options);`,
    notes: [
      "Times are long milliseconds (StaleTime, GcTime, DefaultStaleTime).",
      "Tags is a List<string>, not an array.",
      "Unity's UcsaBehaviour revalidates active subscribers on application resume (RevalidateOnResume, default true). It also marks every cached query stale and deletes the persisted rows. That is the only focus-like hook found in the C# runtime.",
    ],
  },
  godot: {
    title: "QueryEngine & SWR Lifecycle (C# Godot)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Core/QueryEngine.cs`, `${CS}/Core/Types.cs`, `${CS}/Storage/SqliteAdapter.cs`, `${GODOT}/UcsaNode.cs`],
    code: `// Checked against: com.ucsa.core Runtime/Core/QueryEngine.cs (WatchQuery, FetchQueryAsync),
// Runtime/Core/Types.cs (QueryOptions), Runtime/Storage/SqliteAdapter.cs (constructor),
// ucsa_godot addons/ucsa/UcsaNode.cs (QueryEngine, RevalidateOnResume)
using System.Collections.Generic;
using System.IO;
using Godot;
using Ucsa.Core;
using Ucsa.Godot;
using Ucsa.Storage;

// The constructor opens the file and runs InitSchema itself.
var sqlite = new SqliteAdapter(Path.Combine(ProjectSettings.GlobalizePath("user://"), "app_cache.db"));
var engine = new QueryEngine(sqlite, defaultStaleTime: 5000);

var options = new QueryOptions { StaleTime = 10000, Tags = new List<string> { "user:42" } };

// WatchQuery: cached data is emitted at once and a stale entry is revalidated in
// the background. UserProfile and LoadProfileAsync are your own code.
IDisposable subscription = engine.WatchQuery<UserProfile>(
    new object[] { "users", "profile" },
    state => GD.Print(state.Status.ToString()),
    options,
    ct => LoadProfileAsync(ct));

// FetchQueryAsync returns the cached value only while it is fresh, else it awaits a fetch.
var user = await engine.FetchQueryAsync<UserProfile>(
    new object[] { "users", "profile" }, ct => LoadProfileAsync(ct), options);

// UcsaNode revalidates active subscribers on focus-in and resume.
AddChild(new UcsaNode { SqliteAdapter = sqlite, QueryEngine = engine });`,
    notes: [
      "Same engine as the Unity column: the Godot package references the shared core in packages/com.ucsa.core.",
      "Times are long milliseconds (StaleTime, GcTime, DefaultStaleTime). Tags is a List<string>, not an array.",
      "On focus-in or resume UcsaNode calls QueryEngine.InvalidateQueriesAsync() with no prefix, which marks every query stale and deletes the persisted rows, and on desktop this happens on every refocus; a game that does not want that sets RevalidateOnResume to false.",
    ],
  },
};
