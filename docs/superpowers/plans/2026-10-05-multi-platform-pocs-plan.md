# Multi-Platform Reference POCs Implementation Plan (Release 1.2)

> **Goal:** Deliver fully functional, verified reference Proof of Concept (POC) implementations of the Unified Client State Architecture across Node/TypeScript CLI, Dart/Flutter, and C# Unity.

---

## Architecture & Work Breakdown

- **Epic E-002: Multi-Platform Reference POCs (CLI, Dart, C# Unity)**
  - **F-006: Interactive Node CLI POC (`apps/cli`)**
    - Task 1: Scaffolding `apps/cli`, package configuration, and CLI entry point (`bin/ucsa.ts` / `bin/ucsa.js`).
    - Task 2: Subcommand implementations (`query`, `cas`, `outbox`, `durability`, `status`) backed by `@montionugera/ucsa-core`.
    - Task 3: Automated CLI integration tests, precheck Gate 1, README update, and ship.
  - **F-007: Dart / Flutter Reference POC (`packages/ucsa_dart`)**
    - Task 1: Dart package structure (`pubspec.yaml`, `lib/ucsa_dart.dart`), `LifecycleFSM`, and SQLite schema adapter.
    - Task 2: Pure Dart SWR `QueryEngine`, `CasStore`, and `ValueNotifier` / Stream selector observer.
    - Task 3: Automated Dart/TS verification suite, precheck Gate 1, README update, and ship.
  - **F-008: C# Unity Reference POC (`packages/com.ucsa.unity`)**
    - Task 1: Unity Package Manager (UPM) layout (`package.json`, `asmdef`, `Linker.xml`), `LifecycleFsm.cs`, and `StateObserver.cs` (zero-allocation).
    - Task 2: `QueryEngine.cs` (UniTask/CancellationToken SWR), `UnitySqliteAdapter.cs`, and `UnityCasStore.cs`.
    - Task 3: `TextureCache.cs` (async GPU texture upload), `UcsaBehaviour.cs`, automated test suite, precheck Gate 1, README update, and ship.

---

## Phase 1: F-006 Interactive Node CLI POC

### Task 1: Scaffolding `apps/cli` & Command Router
- Create `apps/cli/package.json` referencing `@montionugera/ucsa-core` from workspace.
- Create `apps/cli/bin/ucsa.ts` with executable shebang (`#!/usr/bin/env node`).
- Setup CLI argument parsing for subcommands (`query`, `cas`, `outbox`, `status`, `flush-test`).
- Write unit tests in `apps/cli/tests/router.test.ts`.

### Task 2: Subcommands Execution Logic
- Implement `apps/cli/src/commands/query.ts` running real `QueryEngine` with SQLite WAL.
- Implement `apps/cli/src/commands/cas.ts` running `CasStore` (`put`, `get`, `prune`).
- Implement `apps/cli/src/commands/outbox.ts` running `MutationOutbox` with conflict resolution replay.
- Implement `apps/cli/src/commands/status.ts` printing SQLite and CAS statistics.
- Implement `apps/cli/src/commands/durability.ts` testing `CliDurabilityManager` exit checkpointing.
- Write tests in `apps/cli/tests/cli.test.ts`.

### Task 3: Verification Gate & Ship
- Run `./scripts/precheck.sh` ensuring Gate 1 passes.
- Update `README.md` with CLI usage instructions and sample terminal outputs.
- Ship feature via `psrw ship F-006`.

---

## Phase 2: F-007 Dart / Flutter Reference POC

### Task 1: Dart Package Structure & Core State Models
- Create `packages/ucsa_dart/pubspec.yaml` and `packages/ucsa_dart/lib/ucsa_dart.dart`.
- Implement `lib/src/lifecycle_fsm.dart` (sealed class with full jitter exponential backoff).
- Implement `lib/src/sqlite_adapter.dart` matching UCSA SQLite WAL schema (`ucsa_query_cache`, `ucsa_cache_tags`, `ucsa_mutation_outbox`).
- Write tests verifying model serialization and FSM state transitions.

### Task 2: SWR QueryEngine, CAS Store & Selector Observer
- Implement `lib/src/query_engine.dart` with SWR, tag invalidation, and background revalidation.
- Implement `lib/src/cas_store.dart` with SHA-256 content addressing, atomic `.tmp` rename, and LRU pruning.
- Implement `lib/src/selector_observer.dart` emitting updates only when the selected slice changes.
- Write unit tests verifying SWR cache hits, tag invalidations, and zero-rebuild observer filtering.

### Task 3: Verification Gate & Ship
- Run automated verification test suite.
- Update `README.md` with Dart/Flutter usage guide.
- Run `./scripts/precheck.sh` and ship via `psrw ship F-007`.

---

## Phase 3: F-008 C# Unity Reference POC

### Task 1: Unity Package Layout & Reactivity
- Create `packages/com.ucsa.unity/package.json`, `Linker.xml`, and `Runtime/com.ucsa.unity.asmdef`.
- Implement `Runtime/Core/LifecycleFsm.cs` (5-stage deterministic FSM).
- Implement `Runtime/Core/StateObserver.cs` (zero-allocation selector notifying only on distinct value changes).
- Write tests verifying FSM state transitions and selector filtration.

### Task 2: Unity Persistence, CAS Store & SWR Engine
- Implement `Runtime/Storage/UnitySqliteAdapter.cs` (SQLite WAL schema, busy timeout, tag index).
- Implement `Runtime/Storage/UnityCasStore.cs` (SHA-256 CAS store with atomic `File.Move`).
- Implement `Runtime/Core/QueryEngine.cs` (SWR query engine with CancellationToken / UniTask async).
- Write tests verifying SQLite persistence, tag invalidation, and CAS storage.

### Task 3: GPU Texture Cache, Behaviour & Ship
- Implement `Runtime/Transports/TextureCache.cs` (off-thread texture download with `UnityWebRequestTexture` and GPU upload).
- Implement `Runtime/Unity/UcsaBehaviour.cs` (`MonoBehaviour` lifecycle handling `OnApplicationPause`).
- Update `README.md` with Unity C# installation, UPM configuration, and code examples.
- Run `./scripts/precheck.sh` ensuring Gate 1 passes cleanly.
- Ship feature via `psrw ship F-008`.
