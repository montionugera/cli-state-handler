import { CORE, DART, CS, UNITY, GODOT, type Guide } from "./types.js";

export const wal: Guide = {
  id: "wal",
  label: "WAL Durability",
  ts: {
    title: "SQLite WAL and Checkpoints (TypeScript)",
    lang: "typescript",
    available: true,
    sources: [`${CORE}/storage/sqlite-adapter.ts`, `${CORE}/cli/durability.ts`],
    code: `// Checked against: packages/core/src/storage/sqlite-adapter.ts (journalMode, checkpoint),
// packages/core/src/cli/durability.ts (registerExitFlush)
import { SqliteAdapter, registerExitFlush } from "@montionugera/ucsa-core";

// journalMode defaults to WAL for files and MEMORY for ':memory:'.
const sqlite = new SqliteAdapter("./app.db", { journalMode: "WAL" });

// checkpoint(mode = 'TRUNCATE') runs PRAGMA wal_checkpoint(mode).
sqlite.checkpoint();

// Flush the WAL when the process exits.
registerExitFlush(() => sqlite.checkpoint());`,
    notes: [
      "If a TRUNCATE checkpoint finds the database busy, checkpoint() falls back to PASSIVE instead of throwing.",
      "The exit hook is something you register; creating a SqliteAdapter does not register it.",
    ],
  },
  dart: {
    title: "SQLite WAL and Checkpoints (Dart / Flutter)",
    lang: "dart",
    available: true,
    sources: [`${DART}/sqlite_adapter.dart`],
    code: `// Checked against: packages/ucsa_dart/lib/src/sqlite_adapter.dart (constructor, checkpoint)
import 'package:ucsa_dart/ucsa_dart.dart';

// A file database is opened with PRAGMA journal_mode = WAL (fixed, no option).
final sqlite = SqliteAdapter.file('app.db');

// Runs PRAGMA wal_checkpoint(TRUNCATE); does nothing for in-memory or closed databases.
sqlite.checkpoint();
sqlite.checkpoint('PASSIVE');`,
    notes: [
      "Partial parity: no journalMode option, no PASSIVE fallback on a busy TRUNCATE, and no exit-time hook (searched lib/ for exit and signal handling and found none). Call checkpoint() yourself, for example when the app is paused.",
    ],
  },
  csharp: {
    title: "SQLite WAL and Checkpoints (C# Unity)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Storage/SqliteAdapter.cs`, `${UNITY}/Unity/UcsaBehaviour.cs`],
    code: `// Checked against: Runtime/Storage/SqliteAdapter.cs (constructor, Checkpoint),
// Runtime/Unity/UcsaBehaviour.cs (CheckpointOnPause, OnCheckpointFlushed)
using Ucsa.Storage;
using Ucsa.Unity.Unity;

// A file database is opened with PRAGMA journal_mode = WAL (fixed, no option).
var sqlite = new SqliteAdapter(Application.persistentDataPath + "/app.db");

// Runs PRAGMA wal_checkpoint(TRUNCATE); skipped for in-memory databases.
sqlite.Checkpoint();

// UcsaBehaviour (a MonoBehaviour you add to a scene) checkpoints on pause and quit.
behaviour.SqliteAdapter = sqlite;
behaviour.CheckpointOnPause = true; // default
behaviour.OnCheckpointFlushed += () => Debug.Log("WAL flushed");`,
    notes: [
      "Partial parity: no journalMode option and no PASSIVE fallback. Unity's pause and quit callbacks play the role of the TypeScript exit hook.",
    ],
  },
  godot: {
    title: "SQLite WAL and Checkpoints (C# Godot)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Storage/SqliteAdapter.cs`, `${GODOT}/UcsaNode.cs`],
    code: `// Checked against: com.ucsa.core Runtime/Storage/SqliteAdapter.cs (constructor, Checkpoint),
// ucsa_godot addons/ucsa/UcsaNode.cs (CheckpointOnPause, OnCheckpointFlushed, _Notification, _ExitTree)
using System.IO;
using Godot;
using Ucsa.Godot;
using Ucsa.Storage;

// A file database is opened with PRAGMA journal_mode = WAL (fixed, no option).
var sqlite = new SqliteAdapter(Path.Combine(ProjectSettings.GlobalizePath("user://"), "app.db"));

// Runs PRAGMA wal_checkpoint(TRUNCATE); skipped for in-memory databases.
sqlite.Checkpoint();

// UcsaNode (a Node you add to the tree) checkpoints on focus-out, pause,
// window close request and when it leaves the tree.
var ucsa = new UcsaNode { SqliteAdapter = sqlite };
ucsa.CheckpointOnPause = true; // default
ucsa.OnCheckpointFlushed += () => GD.Print("WAL flushed");
AddChild(ucsa);`,
    notes: [
      "Partial parity: no journalMode option and no PASSIVE fallback. Godot's focus, pause and close notifications play the role of the TypeScript exit hook.",
      "Focus-out, a close request and leaving the tree each checkpoint and leave the adapter open; the game owns the adapter and may call the public UcsaNode.HandleQuit() to checkpoint and close it. Paused and resumed notifications fire only on mobile; on desktop the focus notifications are used.",
    ],
  },
};
