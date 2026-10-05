# F-008: CSharp Unity Reference POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the official Unity C# package reference implementation (`packages/com.ucsa.unity`) of the Unified Client State Architecture (UCSA), tailored for game engine frame loops with zero-allocation reactive state observation, SQLite WAL persistence, Content-Addressable Storage (CAS), asynchronous GPU texture caching, and Unity lifecycle integration.

**Architecture:** `packages/com.ucsa.unity` is a Unity Package Manager (UPM) package:
- `package.json`: package manifest (`com.ucsa.unity`, version `0.1.0`).
- `Linker.xml`: IL2CPP bytecode preservation rules preventing stripping of model classes and SQLite metadata.
- `Runtime/com.ucsa.unity.asmdef`: Unity assembly definition file.
- `Runtime/Core/LifecycleFsm.cs`: 5-stage deterministic FSM with full jitter backoff.
- `Runtime/Core/StateObserver.cs`: zero-allocation / DistinctUntilChanged selector to prevent Canvas/UI dirtying.
- `Runtime/Storage/UnitySqliteAdapter.cs`: executes UCSA SQLite WAL schema with busy timeout and tag index cascade.
- `Runtime/Storage/UnityCasStore.cs`: SHA-256 CAS package store with atomic file promotion and LRU quota pruning.
- `Runtime/Core/QueryEngine.cs`: SWR query coordinator with CancellationToken / UniTask async.
- `Runtime/Transports/TextureCache.cs`: asynchronous texture download using Unity native decoders to bypass main-thread CPU stall.
- `Runtime/Unity/UcsaBehaviour.cs`: MonoBehaviour lifecycle handler reacting to `OnApplicationPause`.
- Test suite verifying C# contract behavior and zero-allocation semantics.

---

## Tasks

### Task 1: Unity Package Layout & Reactivity
**Files:**
- Create: `packages/com.ucsa.unity/package.json`
- Create: `packages/com.ucsa.unity/Linker.xml`
- Create: `packages/com.ucsa.unity/Runtime/com.ucsa.unity.asmdef`
- Create: `packages/com.ucsa.unity/Runtime/Core/Types.cs`
- Create: `packages/com.ucsa.unity/Runtime/Core/LifecycleFsm.cs`
- Create: `packages/com.ucsa.unity/Runtime/Core/StateObserver.cs`
- Create: `packages/com.ucsa.unity/Tests/Runtime/LifecycleFsmTests.cs`
- Create: `packages/com.ucsa.unity/Tests/Runtime/StateObserverTests.cs`

- [x] Create package layout (`package.json`, `Linker.xml`, `asmdef`).
- [x] Implement `Runtime/Core/Types.cs` and `Runtime/Core/LifecycleFsm.cs`.
- [x] Implement `Runtime/Core/StateObserver.cs` with zero-allocation dirty checking to prevent UI rebuilds.
- [x] Write unit tests verifying FSM transitions, backoff jitter, and observer notification suppression.
- [x] Run test verification.
- [x] Commit: `feat(unity): scaffold com.ucsa.unity package, lifecycle FSM, and state observer`.

### Task 2: Unity Persistence, CAS Store & SWR Engine
**Files:**
- Create: `packages/com.ucsa.unity/Runtime/Storage/UnitySqliteAdapter.cs`
- Create: `packages/com.ucsa.unity/Runtime/Storage/UnityCasStore.cs`
- Create: `packages/com.ucsa.unity/Runtime/Core/QueryEngine.cs`
- Create: `packages/com.ucsa.unity/Tests/Runtime/SqliteAdapterTests.cs`
- Create: `packages/com.ucsa.unity/Tests/Runtime/CasStoreTests.cs`
- Create: `packages/com.ucsa.unity/Tests/Runtime/QueryEngineTests.cs`

- [x] Implement `Runtime/Storage/UnitySqliteAdapter.cs` executing UCSA schema in WAL mode.
- [x] Implement `Runtime/Storage/UnityCasStore.cs` with SHA-256 and atomic `File.Move`.
- [x] Implement `Runtime/Core/QueryEngine.cs` with SWR, CancellationToken, and tag invalidation.
- [x] Write tests verifying persistence, CAS atomic operations, SWR cache hits, and tag invalidations.
- [x] Run test verification.
- [x] Commit: `feat(unity): implement SQLite WAL adapter, CAS store, and SWR query engine`.

### Task 3: GPU Texture Cache, Behaviour & Ship
**Files:**
- Create: `packages/com.ucsa.unity/Runtime/Transports/TextureCache.cs`
- Create: `packages/com.ucsa.unity/Runtime/Unity/UcsaBehaviour.cs`
- Create: `packages/com.ucsa.unity/Tests/Runtime/TextureCacheTests.cs`
- Modify: `README.md`
- Run: `./scripts/precheck.sh`

- [x] Implement `Runtime/Transports/TextureCache.cs` with off-thread download and GPU upload logic.
- [x] Implement `Runtime/Unity/UcsaBehaviour.cs` handling `OnApplicationPause` backgrounding and foreground revalidation.
- [x] Update `README.md` with Unity C# installation, UPM configuration, and code examples.
- [x] Run `./scripts/precheck.sh` ensuring Gate 1 passes cleanly (`Gate 1: ok`).
- [x] Commit: `chore(release): verify Gate 1 precheck for F-008`.
