import { CORE, DART, CS, UNITY, GODOT, type GuideId, type PlatformId } from "./guides/types.js";

export type ParityLevel = "full" | "partial" | "none";

export interface ParityCell {
  level: ParityLevel;
  /** Repo-root-relative files that justify the rating (a test asserts they exist). */
  sources: string[];
  /** Required for `partial`: what is missing. */
  reason?: string;
}

export interface ParityRow {
  id: GuideId;
  subsystem: string;
  cells: Record<PlatformId, ParityCell>;
}

export const parity: ParityRow[] = [
  {
    id: "swr",
    subsystem: "SWR query engine",
    cells: {
      ts: { level: "full", sources: [`${CORE}/query/query-engine.ts`] },
      dart: { level: "full", sources: [`${DART}/query_engine.dart`] },
      csharp: { level: "full", sources: [`${CS}/Core/QueryEngine.cs`] },
      godot: { level: "full", sources: [`${CS}/Core/QueryEngine.cs`, `${GODOT}/UcsaNode.cs`] },
    },
  },
  {
    id: "timing",
    subsystem: "Timing controls (staleTime, debounce, throttle)",
    cells: {
      ts: { level: "full", sources: [`${CORE}/query/query-engine.ts`, `${CORE}/consumer/observer.ts`] },
      dart: { level: "full", sources: [`${DART}/query_engine.dart`, `${DART}/selector_observer.dart`] },
      csharp: {
        level: "partial",
        sources: [`${CS}/Core/QueryEngine.cs`, `${CS}/Core/StateObserver.cs`],
        reason: "StateObserver is not connected to QueryEngine; the caller feeds it via Update.",
      },
      godot: {
        level: "partial",
        sources: [`${CS}/Core/QueryEngine.cs`, `${CS}/Core/StateObserver.cs`],
        reason: "Same shared core as Unity: StateObserver is not connected to QueryEngine; the caller feeds it via Update.",
      },
    },
  },
  {
    id: "outbox",
    subsystem: "Offline mutation outbox",
    cells: {
      ts: { level: "full", sources: [`${CORE}/query/mutation-outbox.ts`] },
      dart: {
        level: "partial",
        sources: [`${DART}/sqlite_adapter.dart`],
        reason: "Lives on SqliteAdapter.replayOutbox; retry limit fixed at 3, no rollback or merge callbacks; ConflictPolicy.merge is not implemented (a 409 without a resolver is handled as server-wins).",
      },
      csharp: {
        level: "partial",
        sources: [`${CS}/Storage/SqliteAdapter.cs`],
        reason: "Lives on SqliteAdapter.ReplayOutboxAsync; retry limit fixed at 3, no rollback or merge callbacks; ConflictPolicy.Merge is not implemented (a 409 without a resolver is handled as server-wins).",
      },
      godot: {
        level: "partial",
        sources: [`${CS}/Storage/SqliteAdapter.cs`],
        reason: "Same shared core as Unity: lives on SqliteAdapter.ReplayOutboxAsync; retry limit fixed at 3, no rollback or merge callbacks; ConflictPolicy.Merge is not implemented.",
      },
    },
  },
  {
    id: "cas",
    subsystem: "CAS package cache (SHA-256, LRU)",
    cells: {
      ts: { level: "full", sources: [`${CORE}/storage/cas-store.ts`, `${CORE}/storage/cas-lru.ts`] },
      dart: { level: "full", sources: [`${DART}/cas_store.dart`] },
      csharp: { level: "full", sources: [`${CS}/Storage/CasStore.cs`] },
      godot: { level: "full", sources: [`${CS}/Storage/CasStore.cs`, `${GODOT}/TextureCache.cs`] },
    },
  },
  {
    id: "wal",
    subsystem: "WAL durability",
    cells: {
      ts: { level: "full", sources: [`${CORE}/storage/sqlite-adapter.ts`, `${CORE}/cli/durability.ts`] },
      dart: {
        level: "partial",
        sources: [`${DART}/sqlite_adapter.dart`],
        reason: "WAL is fixed for file databases and checkpoint() exists, but there is no journalMode option, no busy fallback and no exit hook.",
      },
      csharp: {
        level: "partial",
        sources: [`${CS}/Storage/SqliteAdapter.cs`, `${UNITY}/Unity/UcsaBehaviour.cs`],
        reason: "WAL is fixed for file databases and UcsaBehaviour checkpoints on pause and quit, but there is no journalMode option or busy fallback.",
      },
      godot: {
        level: "partial",
        sources: [`${CS}/Storage/SqliteAdapter.cs`, `${GODOT}/UcsaNode.cs`],
        reason: "WAL is fixed for file databases and UcsaNode checkpoints on focus-out, pause, close request and tree exit, but there is no journalMode option or busy fallback.",
      },
    },
  },
  {
    id: "ucb1",
    subsystem: "UCB1 event bus",
    cells: {
      ts: { level: "full", sources: [`${CORE}/ipc/frame-codec.ts`, `${CORE}/ipc/bus-hub.ts`, `${CORE}/ipc/bus-client.ts`] },
      dart: {
        level: "partial",
        sources: [`${DART}/frame_codec.dart`, `${DART}/bus_hub.dart`],
        reason: "Frame codec and hub-record election bookkeeping only; no socket server, bus client, token check or subscription filtering.",
      },
      csharp: {
        level: "partial",
        sources: [`${CS}/Ipc/FrameCodec.cs`, `${CS}/Ipc/BusHub.cs`],
        reason: "Frame codec and endpoint/hub-record helpers only; no socket server, bus client, election, token check or subscription filtering.",
      },
      godot: {
        level: "partial",
        sources: [`${CS}/Ipc/FrameCodec.cs`, `${CS}/Ipc/BusHub.cs`],
        reason: "Same shared core as Unity: frame codec and endpoint/hub-record helpers only; no socket server, bus client, election, token check or subscription filtering.",
      },
    },
  },
];
