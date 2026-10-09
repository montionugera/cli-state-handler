# Multi-Platform Reference POCs Specification (CLI, Dart, C# Unity)

<div class="topic-chip">Specification</div>

## 1. Executive Summary

This specification formalizes the concrete, runnable **Proof of Concept (POC) implementations** for the Unified Client State Architecture (UCSA) across three target application ecosystems:

1. **Interactive Node/TypeScript CLI (`apps/cli`)**: Production-ready terminal CLI demonstrating SWR query caching, atomic CAS package management, offline mutation queueing, and synchronous WAL checkpoint durability on exit.
2. **Dart / Flutter Client (`packages/ucsa_dart`)**: Pure Dart package implementing UCSA contracts for iOS, Android, macOS, Windows, and Web with native `sqlite3` FFI and `ValueNotifier`/Stream zero-rebuild selectors.
3. **C# Unity Engine Package (`packages/com.ucsa.unity`)**: Unity Package Manager (UPM) compatible package tailored for game engine frame loops, using UniTask / R3 zero-allocation reactivity, main-thread dispatching, and off-thread GPU texture decoding.

---

## 2. Multi-Platform Architectural Matrix

<div class="schematic">
+---------------------------------------------------------------------------------------------------+
|                                 UNIFIED CLIENT STATE SPECIFICATION                                |
|    5-Stage FSM  *  SWR Engine  *  SQLite WAL Schema  *  CAS Storage  *  Zero-Redraw Selectors     |
+---------------------------------+---------------------------------+-------------------------------+
                |                                 |                                 |
                v                                 v                                 v
+-------------------------------+ +-------------------------------+ +-------------------------------+
|     F-006: Node / TS CLI      | |    F-007: Dart / Flutter      | |     F-008: C# Unity Engine    |
|   (apps/cli -> @montionugera/ucsa-core)    | |     (packages/ucsa_dart)      | |  (packages/com.ucsa.unity)    |
+-------------------------------+ +-------------------------------+ +-------------------------------+
| - Commander CLI binary        | - Pure Dart 3 sealed classes    | - C# 9+ Unity Package (UPM)     |
| - SQLite WAL disk DB          | - package:sqlite3 FFI + WASM    | - UniTask async + R3 reactivity |
| - CAS storage under ~/.ucsa/  | - crypto SHA-256 + atomic move  | - SQLite WAL + IL2CPP safe      |
| - process.exit() flush hooks  | - ValueNotifier zero-rebuild    | - UnityWebRequestTexture GPU    |
+-------------------------------+ +-------------------------------+ +-------------------------------+
</div>

---

## 3. Slice Breakdown & Acceptance Criteria

### 3.1 F-006: Interactive Node CLI POC (`apps/cli`)
- **Location:** `apps/cli/` within the monorepo workspace.
- **Commands:**
  - `ucsa query <key> [--ttl <ms>]`: Synchronously checks SQLite cache, displays stale data if present, refetches from simulated BFF transport, updates cache with ETag, and prints revalidation latency.
  - `ucsa cas put <filePath>`: Computes SHA-256, writes atomically to `~/.ucsa/cas/objects/<hash>`, updates SQLite access tracking, and triggers LRU pruning if limit exceeded.
  - `ucsa cas get <hash>`: Fetches content from CAS, touches access timestamp, and returns disk path.
  - `ucsa outbox queue <mutationJson>`: Enqueues offline mutation into SQLite.
  - `ucsa outbox replay`: Replays pending mutations against mock handler with conflict resolution policy (`server-wins`, `client-wins`, `merge`).
  - `ucsa status`: Displays SQLite cache size, object counts, outbox count, and WAL file size.
- **Acceptance Criteria:**
  - `apps/cli/bin/ucsa.js` executes directly via `node`.
  - Automated test suite verifies all CLI subcommands against temporary disk stores.

### 3.2 F-007: Dart / Flutter Reference POC (`packages/ucsa_dart`)
- **Location:** `packages/ucsa_dart/`
- **Modules:**
  - `lib/src/lifecycle_fsm.dart`: Sealed class hierarchy (`Idle`, `Loading`, `Retrying`, `Success`, `Error`) with full jitter backoff.
  - `lib/src/sqlite_adapter.dart`: SQLite table initialization matching UCSA schema (`ucsa_query_cache`, `ucsa_cache_tags`, `ucsa_mutation_outbox`).
  - `lib/src/cas_store.dart`: Content-addressable binary storage with SHA-256 hashing and atomic `.tmp` rename.
  - `lib/src/query_engine.dart`: SWR query coordinator with tag invalidation.
  - `lib/src/selector_observer.dart`: `ValueNotifier` / Stream observer that filters emissions when selected slice has not changed.
- **Acceptance Criteria:**
  - 100% pure Dart code with no binary dependencies outside `package:sqlite3` and `package:crypto`.
  - Full automated test suite verifying SWR, tag invalidation, and CAS storage.

### 3.3 F-008: C# Unity Engine Package (`packages/com.ucsa.unity`)
- **Location:** `packages/com.ucsa.unity/`
- **UPM Package Structure:**
  - `package.json` (`com.ucsa.unity`, version `0.1.0`)
  - `Runtime/com.ucsa.unity.asmdef`
  - `Runtime/Core/QueryEngine.cs` (SWR query coordinator, CancellationToken cancellation)
  - `Runtime/Core/LifecycleFsm.cs` (5-stage deterministic FSM)
  - `Runtime/Core/StateObserver.cs` (Zero-allocation / DistinctUntilChanged selector)
  - `Runtime/Storage/UnitySqliteAdapter.cs` (SQLite WAL schema, busy timeout, tag index)
  - `Runtime/Storage/UnityCasStore.cs` (SHA-256 CAS package store with atomic File.Move)
  - `Runtime/Transports/TextureCache.cs` (Off-thread GPU texture decoding via UnityWebRequestTexture)
  - `Runtime/Unity/UcsaBehaviour.cs` (MonoBehaviour lifecycle hook for OnApplicationPause)
  - `Linker.xml` (IL2CPP preservation rules)
- **Acceptance Criteria:**
  - Zero-allocation per-frame observation pattern documented with test cases.
  - Validated C# syntax and clean compilation without Unity engine runtime locks.
