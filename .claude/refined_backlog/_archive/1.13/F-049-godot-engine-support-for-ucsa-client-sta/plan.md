# Godot Engine Support for UCSA Client State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully deliver Godot engine support in cli-state-handler (the UCSA client-state library), from spec through a shipped, verified package. Owner's words, verbatim: "create hand off for full deliver godot supoort".

**Architecture:** The engine-free C# that lives inside the Unity package moves into a new shared source package, `packages/com.ucsa.core`. Unity (`packages/com.ucsa.unity`) and a new Godot 4 .NET project (`packages/ucsa_godot`) each become a thin engine binding on top of it. Godot is verified by a headless smoke scene that runs in a real Godot .NET build, locally, in the pre-ship check (`scripts/precheck.sh`) and in CI.

**Tech Stack:** C# on .NET 8 (`net8.0`), Godot 4.7.2 .NET (`Godot.NET.Sdk/4.7.2`), `Microsoft.Data.Sqlite` 10.0.12, NUnit 4.2.2, bash, GitHub Actions, pnpm workspace, React + Vitest docs site (`apps/docs`).

**Spec:** `.claude/idea_backlog/I-049-godot-engine-support-for-ucsa-client-sta/spec.md` (owner-approved 2026-10-13). After `psrw refine I-049` the same file is at `.claude/refined_backlog/<F-NNN>/spec.md`. Executors read the spec and this plan together.

## Global Constraints

Process rules (verbatim, they apply to every task):

- implementation happens in a claimed feature worktree, never the main checkout
- a fresh worktree has no node_modules, and installs needing private @montionugera/joy-* packages run via `zsh -ic '<cmd>'` if JOYMIFY_PACKAGES_READ_TOKEN is empty
- never print, read or create a token
- never add a root .npmrc
- never touch .github/workflows/release.yml or pnpm-workspace.yaml
- never `git commit --amend`
- no push, merge or promote without a fresh owner yes
- one commit per task
- mechanical tasks may go to `dispatch-worker --agent agy` with a verify command, never codex, never model fable
- subagents get the goal verbatim and return 15 lines or fewer

Values copied from the spec:

- Godot version: 4.7.2 .NET build. Target framework: `net8.0`.
- `Microsoft.Data.Sqlite` version: 10.0.12 (the version `packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj` uses today).
- New package `packages/com.ucsa.core`: name `com.ucsa.core`, version `0.1.0`, no dependencies, assembly definition with `noEngineReferences: true`.
- Namespaces after the move: `Ucsa.Core`, `Ucsa.Ipc`, `Ucsa.Storage`, `Ucsa.Streaming`. The Unity binding keeps `Ucsa.Unity.Unity` and `Ucsa.Unity.Transports`. The Godot binding uses `Ucsa.Godot`.
- Type renames: `UnitySqliteAdapter` becomes `SqliteAdapter`, `UnityCasStore` becomes `CasStore`. No compatibility aliases.
- The Unity `package.json` does not declare a dependency on the core.
- `packages/ucsa_godot` has no `package.json`.
- Smoke runner contract: exit code 0 and the literal line `SMOKE PASS 4/4`.
- Out of scope, do not add: GDScript API, GDExtension, editor plugin, `plugin.cfg`, publishing to any registry, version automation, mobile or web export, database ownership in `UcsaNode` (open, migrate), any change to `apps/cli`, `packages/core`, the Dart or Flutter packages.
- Writing style in every file this plan creates: plain language, no em dashes, no arrow chains in prose.

Working rules for executors:

- Run every command from the root of the claimed feature worktree. `$WT` below means that root.
- Never use `git add -A` or `git add .`. Stage the exact paths each task lists.
- A phase gate is part of the task that carries it. It is not a permission stop.
- If a step's actual output differs from the stated expected output, stop that task and report the difference. Do not improvise a different design.
- Shell variables do not survive between separate tool calls. When a step uses a variable set in an earlier step (`$PROBE`, `$TMPB`, `$WT`, `GODOT_MONO_BIN`), run those steps in one shell call or set the variable again first. `scripts/godot-smoke.sh` finds `godot-mono` on PATH by itself, so `GODOT_MONO_BIN` only has to be set when the binary is somewhere else.

## Facts already verified while writing this plan (2026-10-13)

These were checked by running commands, so executors do not need to rediscover them.

| Fact | How it was checked |
|---|---|
| Baseline .NET test count is 137 (0 failed, 0 skipped) | `dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj` on `release/1.13` at commit `d4783d5` |
| After the split, core has 127 tests and Unity has 10 | The exact Task 1 commands were run on a scratch copy of the package; both projects built with 0 warnings and passed 127 and 10 |
| Filter `SqliteAdapterTests\|QueryEngineTests` matches 22 tests, all in core | `dotnet test --filter` on the baseline |
| Filter `E2EFullChainTests` matches 1 (Unity); `StateObserverTimingTests\|QueryDebouncingTests\|OutboxRateLimitTests` matches 7 (core) | same |
| A filter that matches nothing exits 0 | `dotnet test --filter "FullyQualifiedName~Nope"` printed "No test matches" and returned 0 |
| The package has no `.meta` files and no test assembly definition | `git ls-files packages/com.ucsa.unity` |
| `Godot.NET.Sdk` 4.7.2 exists on nuget.org and builds a `net8.0` project with .NET SDK 8.0.422 | `dotnet build` of the exact `UcsaGodot.csproj`, `UcsaNode.cs`, `TextureCache.cs` and `Smoke.cs` in this plan, on a scratch copy: 0 warnings, 0 errors |
| A project reference to `Ucsa.Core.csproj` outside the Godot folder builds, and the output folder contains `Ucsa.Core.dll`, `Microsoft.Data.Sqlite.dll` and `runtimes/<rid>/native` | same build; output is `packages/ucsa_godot/.godot/mono/temp/bin/Debug/` |
| The notification constants `NotificationApplicationPaused`, `NotificationApplicationResumed`, `NotificationApplicationFocusIn`, `NotificationApplicationFocusOut`, `NotificationWMCloseRequest` exist on `Node` | same build compiles them |
| A class in namespace `Ucsa.Godot` compiles with the Godot source generators | same build |
| Release assets exist: `Godot_v4.7.2-stable_mono_linux_x86_64.zip`, `Godot_v4.7.2-stable_mono_macos.universal.zip`, `SHA512-SUMS.txt` | HTTP 200 on `https://github.com/godotengine/godot/releases/download/4.7.2-stable/<name>` |
| Homebrew has cask `godot-mono` at 4.7.2; it is not installed here | `brew info --cask godot-mono` |
| Locally installed: standard Godot 4.7.2 at `/usr/local/bin/godot` (version string `4.7.2.stable.official.ed1daf0bf`, no `mono`), .NET SDK 8.0.422, `dart`, `flutter`, `gh`, `pnpm` | `command -v`, `--version` |
| `scripts/godot-smoke.sh` in this plan passes, fails on a wrong marker, fails on a non-zero exit, and kills a hung run with exit 142 | run against four fake binaries |
| After `wal_checkpoint(TRUNCATE)` the `-wal` file is 0 bytes, it is larger than 0 after a write, and a second adapter reads the value | scratch NUnit test against the core |
| The root `.gitignore` already ignores `bin/` and `obj/` everywhere | `.gitignore` lines 18 and 19 |

Still unverified, because no Godot .NET binary is installed here. Task 2 confirms each one before any binding code is written: the .NET build's version string contains `mono`; the built project loads and runs headless; the SQLite native library loads inside Godot; `ImageTexture` reports its size under the headless renderer; `GetTree().Quit(code)` sets the process exit code; whether a headless run needs an import pass first; which files a first run generates; the layout inside the Linux zip.

## Spec statements that differ from the source (decided here, confirm at audit)

1. **The Unity quit handler does close the database.** The spec says `UcsaBehaviour` "does not open, migrate or dispose the database". `packages/com.ucsa.unity/Runtime/Unity/UcsaBehaviour.cs:132` calls `SqliteAdapter.Close()` inside `HandleQuit`, and `Close()` is `Dispose()` (`Runtime/Storage/UnitySqliteAdapter.cs:1793-1796`). Decision (changed at the plan audit): a Godot close request is cancellable and is delivered to other nodes too, so a game that saves on quit could hit a closed database. `NotificationWMCloseRequest` therefore only checkpoints and leaves the adapter open, as the approved spec says. `UcsaNode.HandleQuit()` stays public and mirrors the Unity source (checkpoint, close, raise the event) for games that want to call it explicitly; nothing in `UcsaNode` calls it. The new `_ExitTree` checkpoint does not close the adapter either. `UcsaNode` still never opens or migrates a database.
2. **Two docs components also need the new platform.** The spec lists `types.ts`, `guides/index.ts`, six guide files, `parity.ts` and the docs tests. `apps/docs/src/components/MultiPlatformDocs.tsx:7-11` and `apps/docs/src/components/ParityMatrix.tsx:6` are `Record<PlatformId, string>` maps, so adding `godot` to `PlatformId` fails the typecheck until both get an entry. `apps/docs/src/components/multiplatform.css:20` hard-codes three columns. Task 9 changes all three.
3. **One source-root constant is not enough in phase 1.** `apps/docs/src/content/guides/wal.ts:50` and `apps/docs/src/content/parity.ts:80` cite `${CS}/Unity/UcsaBehaviour.cs`, which stays in the Unity package. Task 1 adds a second constant, `UNITY`.
4. **The Godot project's `bin/` and `obj/` need no ignore entry.** The Godot .NET SDK writes build output under `.godot/mono/temp/`, and the root `.gitignore` already ignores `bin/` and `obj/`. Task 6 adds only `.godot/`.
5. **CI cannot run on a feature branch by itself.** `.github/workflows/ci.yml:23-25` triggers only on pull requests to `main`. The acceptance criterion "a CI run on the feature branch shows the Godot smoke step executed and green" needs a pushed branch and a draft pull request to `main`, which needs a fresh owner yes (Task 7).
6. **A rename the word-boundary pattern misses.** `Tests/Runtime/MigrationTests.cs:318` has a test method named `UnitySqliteAdapter_InitSchema_AutomaticallyRunsMigrations`. Task 1's pattern has no trailing word boundary so this is renamed too.

## File Structure

Created:

- `packages/com.ucsa.core/package.json`: package manifest (name, version, no dependencies).
- `packages/com.ucsa.core/Runtime/com.ucsa.core.asmdef`: Unity assembly definition, `noEngineReferences: true`.
- `packages/com.ucsa.core/Ucsa.Core.csproj`: the .NET library that Godot and both test projects reference.
- `packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj`: NUnit project for the 16 engine-free test files.
- `packages/ucsa_godot/project.godot`, `UcsaGodot.csproj`: the Godot 4 .NET project.
- `packages/ucsa_godot/addons/ucsa/UcsaNode.cs`: lifecycle node, counterpart of `UcsaBehaviour`.
- `packages/ucsa_godot/addons/ucsa/TextureCache.cs`: texture cache producing `ImageTexture`.
- `packages/ucsa_godot/tests/Smoke.tscn`, `tests/Smoke.cs`: the in-engine smoke test.
- `packages/ucsa_godot/README.md`: install and usage.
- `scripts/godot-smoke.sh`: builds, runs under a timeout, checks exit code and marker line.

Moved (with `git mv`):

- `packages/com.ucsa.unity/Runtime/{Core,Ipc,Storage,Streaming}` to `packages/com.ucsa.core/Runtime/` (13 files; `UnitySqliteAdapter.cs` becomes `SqliteAdapter.cs`, `UnityCasStore.cs` becomes `CasStore.cs`).
- 16 test files from `packages/com.ucsa.unity/Tests/Runtime/` to `packages/com.ucsa.core/Tests/Runtime/`. Three stay: `UcsaBehaviourTests.cs`, `TextureCacheTests.cs`, `E2EFullChainTests.cs`.

Modified:

- `packages/com.ucsa.unity/Runtime/com.ucsa.unity.asmdef`, `Linker.xml`, `Tests/Ucsa.Unity.Tests.csproj`, and the six `.cs` files that stay (usings and type names only).
- `scripts/precheck.sh`, `scripts/integration.sh`, `scripts/e2e-full-chain.sh`.
- `pnpm-lock.yaml` (one new empty importer entry).
- `.gitignore` (`.godot/`).
- `.github/workflows/ci.yml` (one step and the header comment).
- `README.md`.
- `apps/docs/src/content/guides/{types,index,swr,timing,outbox,cas,wal,ucb1}.ts`, `apps/docs/src/content/parity.ts`, `apps/docs/src/components/{MultiPlatformDocs,ParityMatrix}.tsx`, `apps/docs/src/components/multiplatform.css`, `apps/docs/tests/{multiplatform-docs,parity}.test.tsx`.

Not touched: `.github/workflows/release.yml`, `pnpm-workspace.yaml`, `apps/cli`, `packages/core`, `packages/ucsa_dart`, `packages/ucsa_flutter`.

Architecture diagrams: the spec's two diagrams (`diagrams/godot-package-layout.drawio`, `diagrams/godot-lifecycle-flow.drawio`) already pass `validate.py --score` with score 0 and describe this plan as written. They change only if Task 2 forces fallback B (source-level sharing instead of a project reference); that fallback's step says so.

---

# Phase 1: Extract the shared core

Move and rename only. No behaviour change. The spec requires this phase to be one mechanical commit that a single revert undoes, and the pre-ship check is red between any two halves of it (the scripts and the docs tests name the moved paths), so the phase is one task.

### Task 1: Extract `packages/com.ucsa.core` from the Unity package

**Files:**
- Create: `packages/com.ucsa.core/package.json`, `packages/com.ucsa.core/Runtime/com.ucsa.core.asmdef`, `packages/com.ucsa.core/Ucsa.Core.csproj`, `packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj`
- Move: the 13 runtime files and 16 test files listed under File Structure
- Modify: `packages/com.ucsa.unity/Runtime/com.ucsa.unity.asmdef`, `packages/com.ucsa.unity/Linker.xml`, `packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj`, `scripts/precheck.sh:81-83`, `scripts/integration.sh:81-83`, `scripts/e2e-full-chain.sh:78-85`, `pnpm-lock.yaml:94`, `apps/docs/src/content/guides/types.ts:29`, `apps/docs/src/content/guides/{swr,timing,outbox,cas,wal,ucb1}.ts`, `apps/docs/src/content/parity.ts`, `README.md`
- Test: `packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj`, `packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj`, `apps/docs/tests/parity.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (later tasks rely on these exact names):
  - Project file `packages/com.ucsa.core/Ucsa.Core.csproj`, assembly name `Ucsa.Core`, target `net8.0`.
  - `Ucsa.Storage.SqliteAdapter` with `SqliteAdapter(string connectionStringOrPath = ":memory:", int busyTimeout = 5000, string? origin = null, int? targetVersion = null)` (the constructor runs `InitSchema`), `void Checkpoint(string mode = "TRUNCATE")`, `void Close()`, `void Dispose()`, `bool IsClosed`, `int GetSchemaVersion()`, `void SetQuery<T>(CacheEntry<T> entry, IEnumerable<string>? tags = null)`, `CacheEntry<T>? GetQuery<T>(string queryHash)`.
  - `Ucsa.Storage.CasStore` with `Task<byte[]?> GetAsync(string hash, CancellationToken ct = default)`, `Task<CasPutResult> PutAsync(byte[] data, string? expectedHash, CancellationToken ct)`, `bool Has(string hash)`; `record CasPutResult(string Hash, long Size, string Path)`.
  - `Ucsa.Core.QueryEngine` with `Task InvalidateQueriesAsync(object[]? prefix = null, CancellationToken ct = default)`; `Ucsa.Core.CacheEntry<T>(string queryHash, object[] queryKey, T dataPayload, long createdAt, long staleAt, long expiresAt, string? etag = null, int payloadVersion = 1)` with property `DataPayload`; `Ucsa.Core.QueryKeyHasher.Hash(params object[] keys)`.
  - `Ucsa.Ipc.FrameCodec.EncodeFrame(FrameType type, string? jsonPayload = null)` returning `byte[]`; `Ucsa.Ipc.FrameDecoder.Feed(byte[] chunk)` returning `List<Frame>`; `Frame.Type`, `Frame.JsonPayload`; `enum FrameType : byte`.
  - Docs constants `CS = "packages/com.ucsa.core/Runtime"` and `UNITY = "packages/com.ucsa.unity/Runtime"` exported from `apps/docs/src/content/guides/types.ts`.

- [ ] **Step 1: Install dependencies and record the baseline**

```bash
[ -n "${JOYMIFY_PACKAGES_READ_TOKEN:-}" ] && echo "token: set" || echo "token: empty"
```

If it prints `token: set`, run `pnpm install --frozen-lockfile 2>&1 | tail -n 3`. If it prints `token: empty`, run `zsh -ic 'pnpm install --frozen-lockfile' 2>&1 | tail -n 3`. Expected last lines include `Done in`.

```bash
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj 2>&1 | tail -n 1
```

Expected: `Passed!  - Failed:     0, Passed:   137, Skipped:     0, Total:   137, ... - Ucsa.Unity.Tests.dll (net8.0)`

The baseline is 137. If the number differs, stop and report it; every later count in this task assumes 137.

- [ ] **Step 2: Move the four engine-free folders and the 16 engine-free test files**

```bash
CORE=packages/com.ucsa.core
UNITY=packages/com.ucsa.unity
mkdir -p "$CORE/Runtime" "$CORE/Tests/Runtime"
for d in Core Ipc Storage Streaming; do git mv "$UNITY/Runtime/$d" "$CORE/Runtime/$d"; done
git mv "$CORE/Runtime/Storage/UnitySqliteAdapter.cs" "$CORE/Runtime/Storage/SqliteAdapter.cs"
git mv "$CORE/Runtime/Storage/UnityCasStore.cs" "$CORE/Runtime/Storage/CasStore.cs"
for t in BusHub CasStore ChangeLog FrameCodec LifecycleFsm Migration OutboxLease OutboxRateLimit QueryDebouncing QueryEngine ResumeStrategy SqliteAdapter StateObserver StateObserverTiming StreamChunk StreamQuery; do
  git mv "$UNITY/Tests/Runtime/${t}Tests.cs" "$CORE/Tests/Runtime/${t}Tests.cs"
done
git ls-files "$CORE" | wc -l
git ls-files "$UNITY/Runtime" "$UNITY/Tests/Runtime"
```

Expected: the count is `29`, and the second listing is exactly these seven files:

```
packages/com.ucsa.unity/Runtime/Transports/TextureCache.cs
packages/com.ucsa.unity/Runtime/Unity/UcsaBehaviour.cs
packages/com.ucsa.unity/Runtime/Unity/UnityCompatibility.cs
packages/com.ucsa.unity/Runtime/com.ucsa.unity.asmdef
packages/com.ucsa.unity/Tests/Runtime/E2EFullChainTests.cs
packages/com.ucsa.unity/Tests/Runtime/TextureCacheTests.cs
packages/com.ucsa.unity/Tests/Runtime/UcsaBehaviourTests.cs
```

- [ ] **Step 3: Rename namespaces and the two prefixed types in every C# file of both packages**

```bash
CORE=packages/com.ucsa.core
UNITY=packages/com.ucsa.unity
git ls-files -z "$CORE/*.cs" "$UNITY/*.cs" | xargs -0 perl -pi -e 's/\bUcsa\.Unity\.(Core|Ipc|Storage|Streaming)\b/Ucsa.$1/g; s/\bUnitySqliteAdapter/SqliteAdapter/g; s/\bUnityCasStore/CasStore/g'
git ls-files -z "$CORE/Tests/*.cs" | xargs -0 perl -pi -e 's/\bnamespace Ucsa\.Unity\.Tests\.Runtime\b/namespace Ucsa.Core.Tests.Runtime/'
git grep -n 'Ucsa\.Unity\|UnitySqlite\|UnityCas' -- "$CORE" "$UNITY"
```

Expected: the final `git grep` prints exactly these 12 lines and nothing from `packages/com.ucsa.core` (the asmdef and Linker lines are rewritten in Step 5):

```
packages/com.ucsa.unity/Linker.xml:3:  <assembly fullname="Ucsa.Unity" preserve="all" />
packages/com.ucsa.unity/Runtime/Transports/TextureCache.cs:10:namespace Ucsa.Unity.Transports
packages/com.ucsa.unity/Runtime/Unity/UcsaBehaviour.cs:5:using Ucsa.Unity.Transports;
packages/com.ucsa.unity/Runtime/Unity/UcsaBehaviour.cs:8:namespace Ucsa.Unity.Unity
packages/com.ucsa.unity/Runtime/com.ucsa.unity.asmdef:3:  "rootNamespace": "Ucsa.Unity",
packages/com.ucsa.unity/Tests/Runtime/E2EFullChainTests.cs:11:using Ucsa.Unity.Transports;
packages/com.ucsa.unity/Tests/Runtime/E2EFullChainTests.cs:12:using Ucsa.Unity.Unity;
packages/com.ucsa.unity/Tests/Runtime/E2EFullChainTests.cs:15:namespace Ucsa.Unity.Tests.Runtime
packages/com.ucsa.unity/Tests/Runtime/TextureCacheTests.cs:8:using Ucsa.Unity.Transports;
packages/com.ucsa.unity/Tests/Runtime/TextureCacheTests.cs:11:namespace Ucsa.Unity.Tests.Runtime
packages/com.ucsa.unity/Tests/Runtime/UcsaBehaviourTests.cs:7:using Ucsa.Unity.Unity;
packages/com.ucsa.unity/Tests/Runtime/UcsaBehaviourTests.cs:9:namespace Ucsa.Unity.Tests.Runtime
```

Note for reviewers: after the rename, several classes have a property whose name equals its type (`public SqliteAdapter? SqliteAdapter { get; set; }`, `public CasStore? CasStore { get; set; }`). C# allows this and the scratch build compiled it without warnings.

- [ ] **Step 4: Create the core package manifest, assembly definition and two project files**

`packages/com.ucsa.core/package.json`:

```json
{
  "name": "com.ucsa.core",
  "version": "0.1.0",
  "displayName": "UCSA Core (engine-free C#)",
  "description": "Engine-free C# runtime of the Unified Client State Architecture (UCSA), shared by the Unity and Godot bindings.",
  "unity": "2021.3",
  "author": {
    "name": "DeepMind UCSA Team"
  }
}
```

`packages/com.ucsa.core/Runtime/com.ucsa.core.asmdef`:

```json
{
  "name": "com.ucsa.core",
  "rootNamespace": "Ucsa",
  "references": [],
  "includePlatforms": [],
  "excludePlatforms": [],
  "allowUnsafeCode": false,
  "autoReferenced": true,
  "noEngineReferences": true
}
```

`packages/com.ucsa.core/Ucsa.Core.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <AssemblyName>Ucsa.Core</AssemblyName>
    <RootNamespace>Ucsa</RootNamespace>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.Data.Sqlite" Version="10.0.12" />
  </ItemGroup>

  <ItemGroup>
    <Compile Include="Runtime/**/*.cs" />
  </ItemGroup>

</Project>
```

`packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="NUnit" Version="4.2.2" />
    <PackageReference Include="NUnit3TestAdapter" Version="4.6.0" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="../Ucsa.Core.csproj" />
  </ItemGroup>

</Project>
```

- [ ] **Step 5: Update the Unity test project, assembly definition and linker file**

Replace the whole of `packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj` with:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="NUnit" Version="4.2.2" />
    <PackageReference Include="NUnit3TestAdapter" Version="4.6.0" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="../../com.ucsa.core/Ucsa.Core.csproj" />
  </ItemGroup>

  <ItemGroup>
    <Compile Include="../Runtime/**/*.cs" />
  </ItemGroup>

</Project>
```

(`Microsoft.Data.Sqlite` now arrives through the project reference, so the direct package reference is gone.)

Replace the whole of `packages/com.ucsa.unity/Runtime/com.ucsa.unity.asmdef` with:

```json
{
  "name": "com.ucsa.unity",
  "rootNamespace": "Ucsa.Unity",
  "references": ["com.ucsa.core"],
  "includePlatforms": [],
  "excludePlatforms": [],
  "allowUnsafeCode": false,
  "autoReferenced": true
}
```

Replace the whole of `packages/com.ucsa.unity/Linker.xml` with:

```xml
<linker>
  <assembly fullname="com.ucsa.core" preserve="all" />
  <assembly fullname="Ucsa.Core" preserve="all" />
  <assembly fullname="com.ucsa.unity" preserve="all" />
  <assembly fullname="Ucsa.Unity" preserve="all" />
  <assembly fullname="System.Text.Json" preserve="all" />
  <assembly fullname="System.Data" preserve="all" />
  <assembly fullname="Mono.Data.Sqlite" preserve="all" />
  <assembly fullname="SQLite-net" preserve="all" />
  <assembly fullname="Microsoft.Data.Sqlite" preserve="all" />
</linker>
```

- [ ] **Step 6: Run both .NET test projects and confirm the combined count equals the baseline**

```bash
dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj 2>&1 | grep -E 'error|warning CS|Passed!|Failed!' | sort -u
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj 2>&1 | grep -E 'error|warning CS|Passed!|Failed!' | sort -u
git grep -l "UnityEngine" -- packages/com.ucsa.core; echo "grep exit: $?"
```

Expected:

```
Passed!  - Failed:     0, Passed:   127, Skipped:     0, Total:   127, ... - Ucsa.Core.Tests.dll (net8.0)
Passed!  - Failed:     0, Passed:    10, Skipped:     0, Total:    10, ... - Ucsa.Unity.Tests.dll (net8.0)
grep exit: 1
```

127 + 10 = 137, equal to the baseline. No `error` and no `warning CS` lines. The `git grep` prints no file name.

- [ ] **Step 7: Repoint the three scripts**

In `scripts/precheck.sh`, replace this block (lines 81-83):

```bash
  if command -v dotnet >/dev/null 2>&1 && [ -f "packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj" ]; then
    dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj
  fi
```

with:

```bash
  if command -v dotnet >/dev/null 2>&1 && [ -f "packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj" ]; then
    dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj
    dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj
  fi
```

In `scripts/integration.sh`, replace this block (lines 81-83):

```bash
  if command -v dotnet >/dev/null 2>&1 && [ -f "packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj" ]; then
    dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj --filter "FullyQualifiedName~SqliteAdapterTests|FullyQualifiedName~QueryEngineTests"
  fi
```

with:

```bash
  if command -v dotnet >/dev/null 2>&1 && [ -f "packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj" ]; then
    dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj --filter "FullyQualifiedName~SqliteAdapterTests|FullyQualifiedName~QueryEngineTests"
  fi
```

In `scripts/e2e-full-chain.sh`, replace this block (lines 78-85):

```bash
# ------------------------------------------------------------------------------
# Phase 4: C# Unity Engine Package (packages/com.ucsa.unity)
# ------------------------------------------------------------------------------
echo ">>> [Phase 4/5] C# Unity Engine Reference Engine Full Chain (packages/com.ucsa.unity)"
echo "    Testing: SWR QueryEngine | Zero-Alloc Observer | TextureCache | Mobile Pause Durability | Timing Controls"
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj --filter "FullyQualifiedName~E2EFullChainTests|FullyQualifiedName~StateObserverTimingTests|FullyQualifiedName~QueryDebouncingTests|FullyQualifiedName~OutboxRateLimitTests"
echo "    ✓ C# Unity full-chain passed cleanly."
echo ""
```

with:

```bash
# ------------------------------------------------------------------------------
# Phase 4: C# shared core and Unity binding (packages/com.ucsa.core, packages/com.ucsa.unity)
# ------------------------------------------------------------------------------
echo ">>> [Phase 4/5] C# Core and Unity Reference Engine Full Chain (packages/com.ucsa.core, packages/com.ucsa.unity)"
echo "    Testing: SWR QueryEngine | Zero-Alloc Observer | TextureCache | Mobile Pause Durability | Timing Controls"

# dotnet test exits 0 when a filter matches nothing, so require at least one test per invocation.
run_dotnet_filtered() {
  local project="$1" filter="$2" out
  if ! out=$(dotnet test "$project" --filter "$filter" 2>&1); then
    echo "$out"
    return 1
  fi
  echo "$out"
  if ! echo "$out" | grep -Eq 'Passed!.*Total: +[1-9]'; then
    echo "    ✗ filter matched no tests in $project"
    return 1
  fi
}

run_dotnet_filtered packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj "FullyQualifiedName~StateObserverTimingTests|FullyQualifiedName~QueryDebouncingTests|FullyQualifiedName~OutboxRateLimitTests"
run_dotnet_filtered packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj "FullyQualifiedName~E2EFullChainTests"
echo "    ✓ C# core and Unity full-chain passed cleanly."
echo ""
```

Check the two filtered invocations and the script syntax:

```bash
bash -n scripts/precheck.sh && bash -n scripts/integration.sh && bash -n scripts/e2e-full-chain.sh && echo "syntax ok"
dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj --no-build --filter "FullyQualifiedName~StateObserverTimingTests|FullyQualifiedName~QueryDebouncingTests|FullyQualifiedName~OutboxRateLimitTests" 2>&1 | tail -n 1
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj --no-build --filter "FullyQualifiedName~E2EFullChainTests" 2>&1 | tail -n 1
dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj --no-build --filter "FullyQualifiedName~SqliteAdapterTests|FullyQualifiedName~QueryEngineTests" 2>&1 | tail -n 1
```

Expected: `syntax ok`, then `Total:     7`, `Total:     1`, `Total:    22` in the three summary lines.

- [ ] **Step 8: Regenerate the lockfile and verify a frozen install**

Use `zsh -ic '<cmd>'` around each pnpm command if Step 1 printed `token: empty`.

```bash
pnpm install --lockfile-only 2>&1 | tail -n 3
git diff --stat pnpm-lock.yaml | tail -n 1
git diff pnpm-lock.yaml | grep '^[+-][^+-]'
```

Expected: ` 1 file changed, 2 insertions(+)` and exactly one changed content line:

```
+  packages/com.ucsa.core: {}
```

If the diff contains anything else, discard it and add the entry by hand:

```bash
git checkout pnpm-lock.yaml
perl -0pi -e 's/\n  packages\/com\.ucsa\.unity: \{\}\n/\n  packages\/com.ucsa.core: {}\n\n  packages\/com.ucsa.unity: {}\n/' pnpm-lock.yaml
```

Then verify, either way:

```bash
pnpm install --frozen-lockfile 2>&1 | tail -n 3
git status --short pnpm-lock.yaml pnpm-workspace.yaml
```

Expected: the install ends with `Done in ...` and no `ERR_PNPM_OUTDATED_LOCKFILE`; the status shows ` M pnpm-lock.yaml` only.

- [ ] **Step 9: Update the docs source paths and names**

```bash
perl -pi -e 's{^export const CS = "packages/com\.ucsa\.unity/Runtime";}{export const CS = "packages/com.ucsa.core/Runtime";\nexport const UNITY = "packages/com.ucsa.unity/Runtime";}' apps/docs/src/content/guides/types.ts
perl -pi -e 's/\bUcsa\.Unity\.(Core|Ipc|Storage|Streaming)\b/Ucsa.$1/g; s/\bUnitySqliteAdapter/SqliteAdapter/g; s/\bUnityCasStore/CasStore/g' apps/docs/src/content/parity.ts apps/docs/src/content/guides/*.ts
perl -pi -e 's/\$\{CS\}\/Unity\/UcsaBehaviour\.cs/\$\{UNITY\}\/Unity\/UcsaBehaviour.cs/; s/^import \{ CORE, DART, CS, /import { CORE, DART, CS, UNITY, /' apps/docs/src/content/guides/wal.ts apps/docs/src/content/parity.ts
tail -n 2 apps/docs/src/content/guides/types.ts
grep -rn 'Ucsa\.Unity\|UnitySqlite\|UnityCas\|UNITY' apps/docs/src/content
```

Expected:

```
export const CS = "packages/com.ucsa.core/Runtime";
export const UNITY = "packages/com.ucsa.unity/Runtime";
apps/docs/src/content/parity.ts:1:import { CORE, DART, CS, UNITY, type GuideId, type PlatformId } from "./guides/types.js";
apps/docs/src/content/parity.ts:80:        sources: [`${CS}/Storage/SqliteAdapter.cs`, `${UNITY}/Unity/UcsaBehaviour.cs`],
apps/docs/src/content/guides/types.ts:30:export const UNITY = "packages/com.ucsa.unity/Runtime";
apps/docs/src/content/guides/wal.ts:1:import { CORE, DART, CS, UNITY, type Guide } from "./types.js";
apps/docs/src/content/guides/wal.ts:50:    sources: [`${CS}/Storage/SqliteAdapter.cs`, `${UNITY}/Unity/UcsaBehaviour.cs`],
apps/docs/src/content/guides/wal.ts:54:using Ucsa.Unity.Unity;
```

The first two lines come from `tail`; the six `grep` lines may print in a different order. (`using Ucsa.Unity.Unity;` in the WAL snippet is correct: `UcsaBehaviour` keeps that namespace.)

```bash
pnpm --filter @ucsa/docs test 2>&1 | tail -n 6
(cd apps/docs && pnpm exec tsc -b) && echo "docs typecheck ok"
```

Expected: all docs test files pass (the "cites source files that exist" and "only cites source paths that exist on disk" tests are the ones this step protects) and `docs typecheck ok`.

- [ ] **Step 10: Update README references to the moved paths and renamed classes**

```bash
perl -pi -e 's/\bUcsa\.Unity\.(Core|Ipc|Storage|Streaming)\b/Ucsa.$1/g; s/\bUnitySqliteAdapter/SqliteAdapter/g; s/\bUnityCasStore/CasStore/g' README.md
perl -pi -e 's{packages/com\.ucsa\.unity/Tests/Runtime/(?!(?:UcsaBehaviour|TextureCache|E2EFullChain)Tests\.cs)}{packages/com.ucsa.core/Tests/Runtime/}g; s{^(#### C# / Unity \(`)packages/com\.ucsa\.unity(`\))}{$1packages/com.ucsa.core$2}; s{(`MigrationRunner` in `)packages/com\.ucsa\.unity(`)}{$1packages/com.ucsa.core$2}' README.md
```

Then, in the "Verification Commands" code block, replace these two lines:

```bash
# Run complete C# Unity test suite (137 tests across 19 files)
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj
```

with:

```bash
# Run the shared C# core test suite (127 tests across 16 files)
dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj

# Run the C# Unity binding test suite (10 tests across 3 files)
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj
```

Check:

```bash
grep -c 'packages/com.ucsa.core/Tests/Runtime' README.md
grep -n 'Ucsa\.Unity\|UnitySqlite\|UnityCas' README.md
grep -n 'com\.ucsa\.unity' README.md | cut -c1-90
```

Expected: the count is `16`; the second grep prints two lines, both correct: `using Ucsa.Unity.Transports;` (the texture cache example) and the `Ucsa.Unity.Tests.csproj` test command; the third prints six lines: the section heading, the sentence under it, the three test-table rows for `TextureCacheTests.cs`, `UcsaBehaviourTests.cs` and `E2EFullChainTests.cs`, and the Unity `dotnet test` command.

The "137 C# Unity" figure in the test table's Total row stays: the combined count is unchanged.

- [ ] **Step 11: Run the pre-ship check and the two other scripts**

```bash
bash scripts/precheck.sh 2>&1 | grep -E '^== |^FAILED|^Gate 1|Passed!|Failed!|Test Files|Tests ' | tail -n 20
```

Expected: `Passed!` lines for `Ucsa.Core.Tests.dll` (127) and `Ucsa.Unity.Tests.dll` (10), no `FAILED:` line, last line `Gate 1: ok`.

```bash
bash scripts/e2e-full-chain.sh 2>&1 | grep -E '✓|✗|Passed!|Failed!|FULL CHAIN' | tail -n 12
bash scripts/integration.sh 2>&1 | grep -E '^== |^FAILED|^Gate 2|Passed!' | tail -n 10
```

Expected: the full chain prints `✓ C# core and Unity full-chain passed cleanly.` and `FULL CHAIN COMPLETE`; Gate 2 prints no `FAILED:` line. If `scripts/integration.sh` fails in a slot this task did not touch, record the slot name and its message in the task report; only the .NET line is this task's responsibility.

- [ ] **Step 12: Commit**

```bash
git add packages/com.ucsa.core packages/com.ucsa.unity scripts/precheck.sh scripts/integration.sh scripts/e2e-full-chain.sh pnpm-lock.yaml apps/docs/src/content README.md
git status --short | grep -v '^[MADR] ' ; echo "unstaged check done"
git commit -m "refactor(csharp): extract engine-free core into packages/com.ucsa.core

Move Runtime/Core, Ipc, Storage and Streaming plus their 16 test files out of
packages/com.ucsa.unity. Namespaces drop the Unity segment, UnitySqliteAdapter
becomes SqliteAdapter and UnityCasStore becomes CasStore. No behaviour change:
127 core tests + 10 Unity tests = the 137 recorded before the move.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git show --stat --oneline HEAD | tail -n 3
```

Expected: the `grep -v` prints no line for a file this task changed (every change is staged; `bin/` and `obj/` are ignored), and the commit shows renames for the 29 moved files.

- [ ] **Step 13: Phase gate** (rule 7): verify, independent review, `/simplify`, re-verify.
  1. Verify: Steps 6 and 11 outputs are the evidence. Also run `git diff main -- .github/workflows/release.yml pnpm-workspace.yaml | wc -l` and expect `0`.
  2. Independent review of this commit's diff: dispatch `code-reviewer` (model opus, effort medium) with the goal verbatim and these questions: is anything other than a move, a rename, a manifest or a path changed; does any file under `packages/com.ucsa.core` mention an engine type; do the three scripts still fail when a test fails. For the C# read, ask it to confirm that the three files left in the Unity package compile only against `Ucsa.Core`, `Ucsa.Storage` and the mock `UnityEngine`. Dispatch `typescript-reviewer` on `apps/docs/src/content/**`.
  3. `/simplify` on the diff. Apply only findings inside this task's files.
  4. Re-verify: repeat Step 6 and the `bash scripts/precheck.sh` command of Step 11. Expected: 127, 10, `Gate 1: ok`. If the gate changed any file, commit it as a new commit: `git commit -m "refactor(csharp): phase 1 review fixes"` with the same trailer.

---

# Phase 2: Godot package and smoke test

`scripts/precheck.sh` does not build or run the Godot project until Phase 3, so every commit in this phase leaves the pre-ship check green. Building the Godot project creates an untracked `packages/ucsa_godot/.godot/` folder; it is ignored in Task 6. Until then, stage only the paths each task names.

### Task 2: Verification spike of the Godot 4.7.2 .NET runtime facts

No binding code is written before this task finishes. It uses a throwaway probe project in a temporary folder; the only thing committed is a results section in this plan.

**Files:**
- Modify: `.claude/refined_backlog/<F-NNN>/plan.md` (append a "Spike results (Task 2)" section at the end)
- Temporary, never committed: a probe project under `$(mktemp -d)`; downloaded archives under their own new empty folders

**Interfaces:**
- Consumes: `packages/com.ucsa.core/Ucsa.Core.csproj` and `Ucsa.Storage.SqliteAdapter` from Task 1.
- Produces: `GODOT_MONO_BIN` (absolute path of the local Godot .NET binary) exported in the executor's shell; the recorded answers to facts A to I below; for CI, the confirmed values `GODOT_VERSION`, `GODOT_SHA512` and the binary's path inside the Linux zip, which Task 7 copies.

Facts to confirm, each with its fallback. A fallback is applied in the named later task; it never changes the design.

| Id | Fact assumed by this plan | Fallback if it does not hold |
|---|---|---|
| A | The Godot .NET build's `--version` output contains `mono` | In `scripts/godot-smoke.sh` (Task 3) change `grep -q mono` to match the token actually printed; if no token distinguishes it, remove the PATH search and require `GODOT_MONO_BIN` |
| B | A project that references `Ucsa.Core.csproj` outside its own folder loads and runs in the engine | In `UcsaGodot.csproj` (Task 3) replace the `ProjectReference` with `<Compile Include="../com.ucsa.core/Runtime/**/*.cs" LinkBase="UcsaCore" />` plus `<PackageReference Include="Microsoft.Data.Sqlite" Version="10.0.12" />`. This is the same source-level sharing the Unity test project uses. Then update the spec diagram `diagrams/godot-package-layout.drawio` edge label and re-run `validate.py --score` to score 0 |
| C | Godot 4.7.2 .NET runs a `net8.0` assembly with the installed .NET 8 SDK | In `Ucsa.Core.csproj` use `<TargetFrameworks>net8.0;netX.0</TargetFrameworks>` with the version the engine asks for, set the same single target in `UcsaGodot.csproj`, and add an `actions/setup-dotnet` step in Task 7 |
| D | `Notification((int)NotificationApplicationFocusOut)` reaches `_Notification` on the same node | Use `MainLoop.NotificationApplicationFocusOut` and the matching `MainLoop` constants (same numeric values) in `UcsaNode.cs` and `Smoke.cs` |
| E | `Microsoft.Data.Sqlite`'s native library loads inside Godot on macOS | `SQLitePCLRaw.bundle_e_sqlite3` 2.1.12 already arrives through `Microsoft.Data.Sqlite`, and the build puts the native files under `runtimes/<rid>/native`. Add `<RuntimeIdentifier Condition="'$(RuntimeIdentifier)' == ''">$(NETCoreSdkRuntimeIdentifier)</RuntimeIdentifier>` to the `PropertyGroup` of `UcsaGodot.csproj` so the native library is copied next to the assembly. If it still fails, stop and report to the owner: the spec's core assumption is broken |
| F | `ImageTexture.CreateFromImage` returns a texture that reports 2x2 under `--headless` | Spec fallback: in `Smoke.cs` assertion 4 pass a `TextureDecoder` that decodes the `Image`, records its width and height, and returns `ImageTexture.CreateFromImage(image)`; assert on the recorded image size and the cache hit instead of the texture size |
| G | `GetTree().Quit(code)` sets the process exit code | Keep the marker line as the pass signal and make `scripts/godot-smoke.sh` also fail on a `SMOKE FAIL` line; report this to the owner because the spec requires both signals |
| H | A never-opened project runs headless without an import pass | Add `"$GODOT" --headless --path "$PROJ" --import >/dev/null 2>&1 || true` to `scripts/godot-smoke.sh` after the `dotnet build` line |
| I | The Linux zip contains `Godot_v4.7.2-stable_mono_linux_x86_64/Godot_v4.7.2-stable_mono_linux.x86_64` and its SHA-512 is the value in Step 5 | Use the path and checksum actually observed in Task 7's `ci.yml` step |

Already confirmed at build time while writing this plan, so not repeated here: target framework `net8.0` builds against `Godot.NET.Sdk/4.7.2`; the project reference outside the Godot folder builds; the five notification constant names compile.

- [ ] **Step 1: Install the Godot .NET build beside the standard one**

This installs an application on the machine; it is removed by deleting `~/Applications/godot-mono-4.7.2`. The standard build at `/usr/local/bin/godot` stays.

Do NOT use `brew install --cask godot-mono`: that cask depends on the `dotnet-sdk` cask (.NET SDK 10), and a second `dotnet` on the machine could shadow .NET 8.0.422 and change every `net8.0` test count in this plan. Use the official download, in its own new empty folder:

```bash
DL="$(mktemp -d)"
curl -fsSL -o "$DL/godot-mono-macos.zip" "https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_mono_macos.universal.zip"
shasum -a 512 "$DL/godot-mono-macos.zip" | cut -d' ' -f1
mkdir -p "$HOME/Applications/godot-mono-4.7.2"
unzip -q "$DL/godot-mono-macos.zip" -d "$HOME/Applications/godot-mono-4.7.2"
ls "$HOME/Applications/godot-mono-4.7.2"
```

Expected checksum: `0862c53d7158c7a67f745e2e46f90b68cf5343cbe8b95d6d4333c469e42ca104af9c121d1746a50e5d221a99d09d82ef7016495f8e0d09255842884ed0502795`. Stop if it differs.

Then confirm the .NET toolchain is unchanged: `dotnet --version` must still print `8.0.422`. If Godot later reports that it cannot find the .NET host, export `DOTNET_ROOT` to the directory of the `dotnet` that printed that version and record it in the Task 2 results table; do not install another SDK.

Then export the binary path for this and every later task (use the path that exists on this machine):

```bash
export GODOT_MONO_BIN="$(command -v godot-mono)"
"$GODOT_MONO_BIN" --version
```

Record for fact A whether the version string contains `mono`.

- [ ] **Step 2: Create the probe project**

```bash
WT="$(git rev-parse --show-toplevel)"
PROBE="$(mktemp -d)"
cat > "$PROBE/project.godot" <<'EOF'
config_version=5

[application]

config/name="UcsaProbe"
run/main_scene="res://Probe.tscn"
config/features=PackedStringArray("4.7", "C#")

[dotnet]

project/assembly_name="UcsaProbe"
EOF
cat > "$PROBE/UcsaProbe.csproj" <<EOF
<Project Sdk="Godot.NET.Sdk/4.7.2">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="$WT/packages/com.ucsa.core/Ucsa.Core.csproj" />
  </ItemGroup>
</Project>
EOF
cat > "$PROBE/Probe.tscn" <<'EOF'
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://Probe.cs" id="1"]

[node name="Probe" type="Node"]
script = ExtResource("1")
EOF
cat > "$PROBE/Probe.cs" <<'EOF'
using System;
using System.IO;
using Godot;
using Ucsa.Storage;

public partial class Probe : Node
{
    private const string TinyPngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGP4z8DwHwohFABFzAf5Zsv/OQAAAABJRU5ErkJggg==";

    private bool _focusOutSeen;

    public override void _Notification(int what)
    {
        if (what == NotificationApplicationFocusOut) _focusOutSeen = true;
    }

    public override void _Ready()
    {
        int code = 7;
        try
        {
            GD.Print($"PROBE runtime={System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}");
            GD.Print($"PROBE constants paused={NotificationApplicationPaused} resumed={NotificationApplicationResumed} focus_in={NotificationApplicationFocusIn} focus_out={NotificationApplicationFocusOut} close={NotificationWMCloseRequest}");
            Notification((int)NotificationApplicationFocusOut);
            GD.Print($"PROBE focus_out_delivered={_focusOutSeen}");

            string dir = Path.Combine(ProjectSettings.GlobalizePath("user://"), "probe_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            using (var sqlite = new SqliteAdapter(Path.Combine(dir, "probe.db")))
            {
                GD.Print($"PROBE sqlite=ok schema={sqlite.GetSchemaVersion()}");
            }
            Directory.Delete(dir, true);

            var image = new Image();
            Error err = image.LoadPngFromBuffer(Convert.FromBase64String(TinyPngBase64));
            ImageTexture? texture = ImageTexture.CreateFromImage(image);
            string textureSize = texture == null ? "null" : $"{texture.GetWidth()}x{texture.GetHeight()}";
            GD.Print($"PROBE png={err} image={image.GetWidth()}x{image.GetHeight()} texture={textureSize}");
        }
        catch (Exception ex)
        {
            code = 9;
            GD.PrintErr($"PROBE exception={ex}");
        }

        GetTree().Quit(code);
    }
}
EOF
dotnet build "$PROBE/UcsaProbe.csproj" --nologo -v quiet 2>&1 | tail -n 3
```

Expected: `0 Warning(s)` and `0 Error(s)`. (This exact file compiled while the plan was written.)

- [ ] **Step 3: Run the probe headless under a timeout**

```bash
perl -e 'alarm shift; exec @ARGV' 120 "$GODOT_MONO_BIN" --headless --path "$PROBE" > "$PROBE/run.log" 2>&1; echo "exit=$?"
grep -E 'PROBE|ERROR|error' "$PROBE/run.log"
```

Expected:

```
PROBE runtime=.NET 8.0.x
PROBE constants paused=<number> resumed=<number> focus_in=<number> focus_out=<number> close=<number>
PROBE focus_out_delivered=True
PROBE sqlite=ok schema=4
PROBE png=Ok image=2x2 texture=2x2
```

with `exit=7` printed first.

How to read it: `exit=7` confirms fact G (the code passed to `Quit` reaches the shell); `focus_out_delivered=True` confirms D; `sqlite=ok` confirms E and, because `SqliteAdapter` lives in the referenced core project, B; a `.NET 8` runtime line confirms C; `texture=2x2` confirms F. `exit=9` with a `PROBE exception=` line names the fact that failed. `exit=142` means the run hung for 120 seconds.

If the run fails before any `PROBE` line with a message about a missing assembly, missing `.godot` data or an unimported project, run the import pass once and repeat the command above; record for fact H that the import pass is required:

```bash
"$GODOT_MONO_BIN" --headless --path "$PROBE" --import 2>&1 | tail -n 3
```

- [ ] **Step 4: Note what a run leaves behind**

```bash
ls -a "$PROBE"
```

Record every file that was not created in Step 2 (ignore `run.log`; expected candidates: `.godot/`, and one `<name>.cs.uid` file per script). Task 5 commits the `*.uid` files Godot generates inside `packages/ucsa_godot`; everything else there must be covered by the `.godot/` ignore entry of Task 6.

- [ ] **Step 5: Confirm the Linux archive layout and checksum for CI (fact I)**

```bash
DL2="$(mktemp -d)"
curl -fsSL -o "$DL2/godot-mono-linux.zip" "https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_mono_linux_x86_64.zip"
shasum -a 512 "$DL2/godot-mono-linux.zip" | cut -d' ' -f1
unzip -l "$DL2/godot-mono-linux.zip" | awk '{print $4}' | grep -E 'x86_64$|/$' | head -n 5
rm -rf "$DL2"
```

Expected checksum (read from the release's `SHA512-SUMS.txt` on 2026-10-13): `1855960b27ee3ef5e66e5e228cced69d55637b24334a7411162687dcd077d8f9f645348cdb8eae984bec8135d49ed855a1e3a16476786b8bce60774fd8402d13`. Expected listing includes `Godot_v4.7.2-stable_mono_linux_x86_64/Godot_v4.7.2-stable_mono_linux.x86_64`. Record both as observed. If the checksum differs from the expected value, stop and report it.

- [ ] **Step 6: Record the results in the plan and commit**

Append this section to the end of `.claude/refined_backlog/<F-NNN>/plan.md`, replacing each `observed` cell with what Steps 1 to 5 printed and each `fallback` cell with `none` or the fallback applied:

```markdown
## Spike results (Task 2)

Run on <date> with <output of "$GODOT_MONO_BIN" --version>, .NET SDK <output of dotnet --version>.

| Id | Observed | Fallback applied |
|---|---|---|
| A | version string: ... | ... |
| B | ... | ... |
| C | ... | ... |
| D | ... | ... |
| E | ... | ... |
| F | ... | ... |
| G | ... | ... |
| H | ... | ... |
| I | zip path: ...; sha512: ... | ... |

Local binary: GODOT_MONO_BIN=<absolute path>
Files a headless run generates: ...
```

```bash
rm -rf "$PROBE"
git add .claude/refined_backlog
git commit -m "docs(backlog): record Godot 4.7.2 .NET spike results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If any row needed a fallback, the tasks named in the fallback table apply it; say so in the task report so the orchestrator passes it on.

### Task 3: Godot project scaffold, smoke scene and runner (test first)

This task writes the test before the binding exists. Its commit contains a Godot project that does not compile yet; that is intended and safe because nothing builds it until Phase 3.

**Files:**
- Create: `packages/ucsa_godot/project.godot`, `packages/ucsa_godot/UcsaGodot.csproj`, `packages/ucsa_godot/tests/Smoke.tscn`, `packages/ucsa_godot/tests/Smoke.cs`, `scripts/godot-smoke.sh`

**Interfaces:**
- Consumes: `Ucsa.Core.csproj`, `SqliteAdapter`, `CacheEntry<T>`, `FrameCodec`, `FrameDecoder`, `FrameType` from Task 1; `GODOT_MONO_BIN` and any fallback from Task 2.
- Produces:
  - `scripts/godot-smoke.sh`: no arguments builds and runs the smoke scene, exit 0 only on engine exit code 0 plus the line `SMOKE PASS 4/4`; `--locate` prints the Godot .NET binary and exits 0, or exits 1 when none is found, or 2 when `GODOT_MONO_BIN` is set to something that is not executable. Environment: `GODOT_MONO_BIN`, `GODOT_SMOKE_TIMEOUT_SECS` (default 180).
  - The smoke scene expects these names from Tasks 4 and 5, in namespace `Ucsa.Godot`: `UcsaNode` (a `Node`) with `static UcsaNode? Instance`, `static void ResetInstance()`, `SqliteAdapter? SqliteAdapter { get; set; }`, `event Action<bool>? OnApplicationStateChanged`, `event Action? OnCheckpointFlushed`; `TextureCache` (`IDisposable`) with `TextureCache(TextureCacheOptions? options = null)`, `Task<ImageTexture?> GetTextureAsync(string url, CancellationToken ct = default)`, `bool ContainsInMemory(string url)`; `TextureCacheOptions` with `Func<string, CancellationToken, Task<byte[]>>? DownloadHandler`.

- [ ] **Step 1: Write the project files**

`packages/ucsa_godot/project.godot`:

```ini
; Engine configuration file.
; It's best edited using the editor UI and not directly,
; since the parameters that go here are not all obvious.

config_version=5

[application]

config/name="UcsaGodot"
run/main_scene="res://tests/Smoke.tscn"
config/features=PackedStringArray("4.7", "C#")

[dotnet]

project/assembly_name="UcsaGodot"
```

`packages/ucsa_godot/UcsaGodot.csproj` (apply fallback B, C or E from Task 2 here if one was recorded):

```xml
<Project Sdk="Godot.NET.Sdk/4.7.2">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
    <Nullable>enable</Nullable>
    <RootNamespace>Ucsa.Godot</RootNamespace>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include="../com.ucsa.core/Ucsa.Core.csproj" />
  </ItemGroup>

</Project>
```

`packages/ucsa_godot/tests/Smoke.tscn`:

```ini
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://tests/Smoke.cs" id="1"]

[node name="Smoke" type="Node"]
script = ExtResource("1")
```

- [ ] **Step 2: Write the smoke test**

`packages/ucsa_godot/tests/Smoke.cs`. Inside namespace `Ucsa.Godot`, never write a name qualified with `Godot.` (for example `Godot.Image`): the compiler would resolve `Godot` to `Ucsa.Godot`. The `using Godot;` line at the top of the file is what makes the engine types visible. Engine calls used here that Task 2 exercises at run time: `Notification(int)`, `GetTree().Quit(int)`, `ProjectSettings.GlobalizePath`, `ImageTexture.GetWidth()`. `ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame)`, `AddChild`, `RemoveChild` and `Free` compiled against the 4.7.2 bindings but first run in this task: confirm in Step 4 of Task 5 that the run reaches `SMOKE PASS 4/4`, and treat a hang (exit 142) as a failure of the `ToSignal` wait.

```csharp
using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Godot;
using Ucsa.Core;
using Ucsa.Ipc;
using Ucsa.Storage;

namespace Ucsa.Godot.Tests
{
    /// <summary>
    /// Headless in-engine smoke test. Prints "SMOKE PASS 4/4" and quits with code 0
    /// only when all four assertion groups pass; anything else quits with code 1.
    /// Run through scripts/godot-smoke.sh, which also enforces a timeout.
    /// </summary>
    public partial class Smoke : Node
    {
        private const int Expected = 4;

        // A valid 2x2 RGBA PNG, 73 bytes.
        private const string TinyPngBase64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGP4z8DwHwohFABFzAf5Zsv/OQAAAABJRU5ErkJggg==";

        private int _passed;

        public override async void _Ready()
        {
            int code = 1;
            try
            {
                // Start after the first frame so the scene is fully inside the tree.
                await ToSignal(GetTree(), SceneTree.SignalName.ProcessFrame);

                string dir = Path.Combine(
                    ProjectSettings.GlobalizePath("user://"),
                    "ucsa_smoke_" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(dir);
                try
                {
                    CheckFocusOutCheckpoint(dir);
                    CheckExitTreeCheckpoint(dir);
                    CheckFrameCodecVectors();
                    await CheckTextureCacheAsync();
                }
                finally
                {
                    try { Directory.Delete(dir, true); } catch { }
                }

                if (_passed == Expected)
                {
                    GD.Print($"SMOKE PASS {_passed}/{Expected}");
                    code = 0;
                }
                else
                {
                    GD.PrintErr($"SMOKE FAIL {_passed}/{Expected}");
                }
            }
            catch (Exception ex)
            {
                GD.PrintErr($"SMOKE FAIL {_passed}/{Expected}: {ex}");
            }

            GetTree().Quit(code);
        }

        private static void Require(bool condition, string what)
        {
            if (!condition) throw new InvalidOperationException("assertion failed: " + what);
        }

        private static long WalLength(string dbPath)
        {
            var wal = new FileInfo(dbPath + "-wal");
            return wal.Exists ? wal.Length : 0;
        }

        private static void WriteValue(SqliteAdapter sqlite, string hash, string value)
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            sqlite.SetQuery(new CacheEntry<string>(
                hash, new object[] { "smoke", hash }, value, now, now + 60_000, now + 120_000));
        }

        // 1. Focus-out checkpoints, raises OnCheckpointFlushed, and the value is readable from a fresh adapter.
        private void CheckFocusOutCheckpoint(string dir)
        {
            UcsaNode.ResetInstance();
            string dbPath = Path.Combine(dir, "focus.db");
            using var sqlite = new SqliteAdapter(dbPath);
            var node = new UcsaNode { SqliteAdapter = sqlite };
            AddChild(node);
            try
            {
                Require(UcsaNode.Instance == node, "_Ready registers the singleton");

                int flushed = 0;
                bool? lastState = null;
                node.OnCheckpointFlushed += () => flushed++;
                node.OnApplicationStateChanged += state => lastState = state;

                WriteValue(sqlite, "smoke-focus", "value-focus");
                Require(WalLength(dbPath) > 0, "the write is pending in the write-ahead log");

                node.Notification((int)NotificationApplicationFocusOut);

                Require(lastState == true, "focus-out raises OnApplicationStateChanged(true)");
                Require(flushed == 1, "focus-out raises OnCheckpointFlushed once");
                Require(WalLength(dbPath) == 0, "focus-out truncates the write-ahead log");

                using var reopened = new SqliteAdapter(dbPath);
                var entry = reopened.GetQuery<string>("smoke-focus");
                Require(entry != null && entry.DataPayload == "value-focus", "value readable from a fresh adapter");
            }
            finally
            {
                RemoveChild(node);
                node.Free();
            }

            _passed++;
        }

        // 2. Leaving the tree checkpoints and clears the singleton; the adapter stays open.
        private void CheckExitTreeCheckpoint(string dir)
        {
            UcsaNode.ResetInstance();
            string dbPath = Path.Combine(dir, "exit.db");
            using var sqlite = new SqliteAdapter(dbPath);
            var node = new UcsaNode { SqliteAdapter = sqlite };
            AddChild(node);
            Require(UcsaNode.Instance == node, "_Ready registers the singleton");

            int flushed = 0;
            node.OnCheckpointFlushed += () => flushed++;
            WriteValue(sqlite, "smoke-exit", "value-exit");
            Require(WalLength(dbPath) > 0, "the write is pending in the write-ahead log");

            // Sending the notification to one node does not quit the tree.
            node.Notification((int)NotificationWMCloseRequest);
            Require(flushed == 1, "a close request raises OnCheckpointFlushed once");
            Require(WalLength(dbPath) == 0, "a close request truncates the write-ahead log");
            Require(!sqlite.IsClosed, "a close request leaves the adapter open");

            flushed = 0;
            WriteValue(sqlite, "smoke-exit-2", "value-exit-2");
            Require(WalLength(dbPath) > 0, "the second write is pending in the write-ahead log");

            RemoveChild(node); // runs _ExitTree synchronously
            node.Free();

            Require(flushed == 1, "_ExitTree raises OnCheckpointFlushed once");
            Require(WalLength(dbPath) == 0, "_ExitTree truncates the write-ahead log");
            Require(UcsaNode.Instance == null, "_ExitTree clears the singleton");
            Require(!sqlite.IsClosed, "_ExitTree leaves the adapter open");

            _passed++;
        }

        // 3. Every vector in contracts/ipc/vectors.json decodes and re-encodes to the golden bytes.
        private void CheckFrameCodecVectors()
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(FindVectorsPath()));
            int count = 0;
            foreach (var vector in doc.RootElement.EnumerateArray())
            {
                string name = vector.GetProperty("name").GetString()!;
                var type = (FrameType)(byte)vector.GetProperty("type").GetInt32();
                string payloadJson = JsonSerializer.Serialize(vector.GetProperty("payload"));
                string hex = vector.GetProperty("hex").GetString()!;

                var frames = new FrameDecoder().Feed(Convert.FromHexString(hex));
                Require(frames.Count == 1, $"vector {name} decodes to one frame");
                Require(frames[0].Type == type, $"vector {name} frame type");
                Require(
                    JsonNode.DeepEquals(JsonNode.Parse(frames[0].JsonPayload), JsonNode.Parse(payloadJson)),
                    $"vector {name} payload");

                byte[] encoded = FrameCodec.EncodeFrame(type, payloadJson);
                Require(Convert.ToHexString(encoded).ToLowerInvariant() == hex, $"vector {name} wire bytes");
                count++;
            }

            Require(count >= 10, "at least 10 conformance vectors");
            _passed++;
        }

        private static string FindVectorsPath()
        {
            string? dir = ProjectSettings.GlobalizePath("res://");
            while (!string.IsNullOrEmpty(dir))
            {
                string candidate = Path.Combine(dir, "contracts", "ipc", "vectors.json");
                if (File.Exists(candidate)) return candidate;
                dir = Directory.GetParent(dir.TrimEnd('/', '\\'))?.FullName;
            }
            throw new FileNotFoundException("Could not locate contracts/ipc/vectors.json above res://");
        }

        // 4. TextureCache decodes a PNG into a texture and serves the second request from memory.
        private async Task CheckTextureCacheAsync()
        {
            byte[] png = Convert.FromBase64String(TinyPngBase64);
            int downloads = 0;
            using var cache = new TextureCache(new TextureCacheOptions
            {
                DownloadHandler = (_, _) =>
                {
                    Interlocked.Increment(ref downloads);
                    return Task.FromResult(png);
                }
            });

            const string url = "smoke://tiny.png";
            ImageTexture? first = await cache.GetTextureAsync(url);
            Require(first != null, "first request returns a texture");
            Require(first!.GetWidth() == 2 && first.GetHeight() == 2, "decoded texture is 2x2");

            ImageTexture? second = await cache.GetTextureAsync(url);
            Require(ReferenceEquals(first, second), "second request returns the cached texture");
            Require(downloads == 1, "second request does not download again");
            Require(cache.ContainsInMemory(url), "texture is held in the memory cache");

            _passed++;
        }
    }
}
```

If Task 2 recorded fallback F, replace the body of `CheckTextureCacheAsync` from the `using var cache` line through the "decoded texture is 2x2" line with:

```csharp
            int imageWidth = 0, imageHeight = 0;
            using var cache = new TextureCache(new TextureCacheOptions
            {
                DownloadHandler = (_, _) =>
                {
                    Interlocked.Increment(ref downloads);
                    return Task.FromResult(png);
                },
                TextureDecoder = bytes =>
                {
                    var image = new Image();
                    Require(image.LoadPngFromBuffer(bytes) == Error.Ok, "PNG decodes");
                    imageWidth = image.GetWidth();
                    imageHeight = image.GetHeight();
                    return ImageTexture.CreateFromImage(image);
                }
            });

            const string url = "smoke://tiny.png";
            ImageTexture? first = await cache.GetTextureAsync(url);
            Require(first != null, "first request returns a texture");
            Require(imageWidth == 2 && imageHeight == 2, "decoded image is 2x2");
```

- [ ] **Step 3: Write the runner script**

`scripts/godot-smoke.sh` (apply fallback A or H from Task 2 here if one was recorded):

```bash
#!/usr/bin/env bash
# Godot in-engine smoke test for packages/ucsa_godot.
#   scripts/godot-smoke.sh            build, run headless under a timeout, and require
#                                     both exit code 0 and the literal line "SMOKE PASS 4/4"
#   scripts/godot-smoke.sh --locate   print the Godot .NET binary and exit 0; exit non-zero when none is found
# Binary lookup: $GODOT_MONO_BIN, else `godot-mono` or `godot` on PATH whose --version contains "mono".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$ROOT/packages/ucsa_godot"
TIMEOUT_SECS="${GODOT_SMOKE_TIMEOUT_SECS:-180}"
PASS_LINE="SMOKE PASS 4/4"

locate_godot() {
  if [ -n "${GODOT_MONO_BIN:-}" ]; then
    if [ ! -x "$GODOT_MONO_BIN" ]; then
      echo "godot smoke: GODOT_MONO_BIN is set but is not an executable file: $GODOT_MONO_BIN" >&2
      return 2
    fi
    echo "$GODOT_MONO_BIN"
    return 0
  fi
  local candidate
  for candidate in godot-mono godot; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version 2>/dev/null | grep -q mono; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

if [ "${1:-}" = "--locate" ]; then
  locate_godot
  exit $?
fi

if ! GODOT="$(locate_godot)"; then
  echo "godot smoke: FAILED (no Godot .NET binary; set GODOT_MONO_BIN or install godot-mono)" >&2
  exit 1
fi
if ! command -v dotnet >/dev/null 2>&1; then
  echo "godot smoke: FAILED (dotnet is not installed)" >&2
  exit 1
fi

echo "godot smoke: binary $GODOT ($("$GODOT" --version 2>/dev/null | head -n 1))"
dotnet build "$PROJ/UcsaGodot.csproj" --nologo -v quiet

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# perl's alarm survives exec, so a hung engine is killed after TIMEOUT_SECS (exit code 142).
set +e
perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' "$TIMEOUT_SECS" "$GODOT" --headless --path "$PROJ" >"$LOG" 2>&1
rc=$?
set -e
cat "$LOG"

if [ "$rc" -ne 0 ]; then
  echo "godot smoke: FAILED (exit code $rc; 142 means the ${TIMEOUT_SECS}s timeout fired)"
  exit 1
fi
if ! grep -qx "$PASS_LINE" "$LOG"; then
  echo "godot smoke: FAILED (exit code 0 but no '$PASS_LINE' line in the output)"
  exit 1
fi
echo "godot smoke: ok"
```

```bash
chmod +x scripts/godot-smoke.sh
bash -n scripts/godot-smoke.sh && echo "syntax ok"
bash scripts/godot-smoke.sh --locate
```

Expected: `syntax ok`, then the path of the Godot .NET binary from Task 2.

- [ ] **Step 4: Run the smoke test and confirm it fails for the right reason**

```bash
bash scripts/godot-smoke.sh 2>&1 | grep -oE 'error CS[0-9]+: [^[]*' | sort | uniq -c; bash scripts/godot-smoke.sh >/dev/null 2>&1; echo "exit=$?"
```

Expected: the build fails because the binding does not exist yet, and nothing else is wrong:

```
  10 error CS0103: The name 'UcsaNode' does not exist in the current context
   2 error CS0246: The type or namespace name 'TextureCache' could not be found (are you missing a using directive or an assembly reference?)
   2 error CS0246: The type or namespace name 'TextureCacheOptions' could not be found (are you missing a using directive or an assembly reference?)
   4 error CS0246: The type or namespace name 'UcsaNode' could not be found (are you missing a using directive or an assembly reference?)
exit=1
```

Any other error code means the scaffold itself is wrong: fix it before committing.

- [ ] **Step 5: Commit**

```bash
git add packages/ucsa_godot/project.godot packages/ucsa_godot/UcsaGodot.csproj packages/ucsa_godot/tests/Smoke.tscn packages/ucsa_godot/tests/Smoke.cs scripts/godot-smoke.sh
git commit -m "test(godot): add Godot project scaffold, smoke scene and runner

The smoke scene does not compile yet: UcsaNode and TextureCache arrive in the
next two commits. Nothing builds this project until the pre-ship check is wired.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: `UcsaNode`, the Godot lifecycle node

**Files:**
- Create: `packages/ucsa_godot/addons/ucsa/UcsaNode.cs`
- Test: `packages/ucsa_godot/tests/Smoke.cs` (assertion groups 1 and 2, from Task 3)

**Interfaces:**
- Consumes: `Ucsa.Core.QueryEngine.InvalidateQueriesAsync()`, `Ucsa.Storage.SqliteAdapter` (`Checkpoint`, `Close`, `IsClosed`), `Ucsa.Storage.CasStore` from Task 1; the type name `Ucsa.Godot.TextureCache` from Task 5 (a property of that type; the project compiles only after Task 5).
- Produces, in namespace `Ucsa.Godot`: `public partial class UcsaNode : Node` with the same public members as `UcsaBehaviour`: `static UcsaNode? Instance`, `static void ResetInstance()`, `QueryEngine? QueryEngine`, `SqliteAdapter? SqliteAdapter`, `CasStore? CasStore`, `TextureCache? TextureCache`, `bool RevalidateOnResume` (default true), `bool CheckpointOnPause` (default true), `event Action<bool>? OnApplicationStateChanged`, `event Action? OnCheckpointFlushed`, `void HandlePauseState(bool pauseStatus)`, `void HandleQuit()`; plus the Godot overrides `_Ready`, `_ExitTree`, `_Notification(int what)`.

Member mapping from `packages/com.ucsa.unity/Runtime/Unity/UcsaBehaviour.cs`: `Awake` is `_Ready`; `OnDestroy` is `_ExitTree`; `OnApplicationPause(bool)` and `OnApplicationQuit()` are replaced by `_Notification`; `HandlePauseState` and `HandleQuit` keep their bodies, with `Debug.Log*` replaced by `GD.PushError` and `GD.PushWarning`. Two behaviours are new for Godot, as the spec says: focus-out is treated as a pause, and `_ExitTree` checkpoints.

- [ ] **Step 1: Confirm the failing state**

```bash
bash scripts/godot-smoke.sh 2>&1 | grep -c 'UcsaNode'
```

Expected: a number greater than 0 (the Task 3 build errors that name `UcsaNode`).

- [ ] **Step 2: Write the node**

`packages/ucsa_godot/addons/ucsa/UcsaNode.cs` (apply fallback D from Task 2 here if one was recorded):

```csharp
using System;
using System.Threading.Tasks;
using Godot;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Godot
{
    /// <summary>
    /// Godot lifecycle integration node for UCSA, the counterpart of the Unity UcsaBehaviour.
    /// Checkpoints the SQLite write-ahead log when the application loses focus, pauses,
    /// closes or the node leaves the tree, and revalidates queries on focus-in or resume.
    /// It does not open or migrate the database: the game constructs the SqliteAdapter.
    /// </summary>
    public partial class UcsaNode : Node
    {
        private static UcsaNode? _instance;
        public static UcsaNode? Instance => _instance;
        public static void ResetInstance() => _instance = null;

        public QueryEngine? QueryEngine { get; set; }
        public SqliteAdapter? SqliteAdapter { get; set; }
        public CasStore? CasStore { get; set; }
        public TextureCache? TextureCache { get; set; }

        public bool RevalidateOnResume { get; set; } = true;
        public bool CheckpointOnPause { get; set; } = true;

        /// <summary>
        /// Event fired when application pause state changes (true = backgrounded, false = foregrounded).
        /// </summary>
        public event Action<bool>? OnApplicationStateChanged;

        /// <summary>
        /// Event fired after a WAL checkpoint finishes on focus-out, pause, close or tree exit.
        /// </summary>
        public event Action? OnCheckpointFlushed;

        public override void _Ready()
        {
            if (_instance == null)
            {
                _instance = this;
            }
            else if (_instance != this)
            {
                GD.PushWarning("[UCSA] A second UcsaNode entered the tree; the existing singleton is kept.");
            }
        }

        public override void _ExitTree()
        {
            // New for Godot (not in Unity): a programmatic quit sends no close request,
            // so the node also checkpoints when it leaves the tree. The adapter stays open.
            CheckpointKeepOpen("tree exit");

            if (_instance == this)
            {
                _instance = null;
            }
        }

        public override void _Notification(int what)
        {
            long notification = what;
            if (notification == NotificationApplicationPaused || notification == NotificationApplicationFocusOut)
            {
                HandlePauseState(true);
            }
            else if (notification == NotificationApplicationResumed || notification == NotificationApplicationFocusIn)
            {
                HandlePauseState(false);
            }
            else if (notification == NotificationWMCloseRequest)
            {
                // Checkpoint only: the request is cancellable and other nodes may
                // still write while handling it, so the adapter stays open.
                CheckpointKeepOpen("close request");
            }
        }

        /// <summary>
        /// Core pause handler, exposed for tests. true = backgrounded, false = foregrounded.
        /// </summary>
        public void HandlePauseState(bool pauseStatus)
        {
            OnApplicationStateChanged?.Invoke(pauseStatus);

            if (pauseStatus)
            {
                if (CheckpointOnPause && SqliteAdapter != null)
                {
                    try
                    {
                        SqliteAdapter.Checkpoint("TRUNCATE");
                        OnCheckpointFlushed?.Invoke();
                    }
                    catch (Exception ex)
                    {
                        GD.PushError($"[UCSA] Checkpoint on pause failed: {ex.Message}");
                    }
                }
            }
            else
            {
                if (RevalidateOnResume && QueryEngine != null)
                {
                    var engine = QueryEngine;
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            await engine.InvalidateQueriesAsync().ConfigureAwait(false);
                        }
                        catch (Exception ex)
                        {
                            GD.PushWarning($"[UCSA] Foreground revalidation warning: {ex.Message}");
                        }
                    });
                }
            }
        }

        private void CheckpointKeepOpen(string reason)
        {
            if (SqliteAdapter == null || SqliteAdapter.IsClosed)
            {
                return;
            }

            try
            {
                SqliteAdapter.Checkpoint("TRUNCATE");
                OnCheckpointFlushed?.Invoke();
            }
            catch (Exception ex)
            {
                GD.PushError($"[UCSA] Checkpoint on {reason} failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Explicit shutdown for games that want it. Mirrors UcsaBehaviour.HandleQuit:
        /// checkpoint, close the adapter, then raise OnCheckpointFlushed.
        /// UcsaNode never calls this itself; a close request only checkpoints.
        /// </summary>
        public void HandleQuit()
        {
            if (SqliteAdapter != null)
            {
                try
                {
                    SqliteAdapter.Checkpoint("TRUNCATE");
                    SqliteAdapter.Close();
                    OnCheckpointFlushed?.Invoke();
                }
                catch (Exception ex)
                {
                    GD.PushError($"[UCSA] Checkpoint on quit failed: {ex.Message}");
                }
            }
        }
    }
}
```

Unverified at run time, confirm in Task 5 Step 3: `GD.PushWarning` and `GD.PushError` called from the thread-pool task in `HandlePauseState(false)` compile, but whether Godot accepts them off the main thread is not exercised by the smoke test. If the review flags it, replace those two calls inside `Task.Run` with `GD.PrintErr` and say so in the report; do not add a new test for it.

- [ ] **Step 3: Run the smoke test and confirm only the texture cache is missing**

```bash
bash scripts/godot-smoke.sh 2>&1 | grep -oE 'error CS[0-9]+: [^[]*' | sort | uniq -c
```

Expected: every remaining error names `TextureCache` or `TextureCacheOptions` and none names `UcsaNode`. At the time of writing the compiler reported exactly:

```
   2 error CS0246: The type or namespace name 'TextureCache' could not be found (are you missing a using directive or an assembly reference?)
```

- [ ] **Step 4: Commit**

```bash
git add packages/ucsa_godot/addons/ucsa/UcsaNode.cs
git commit -m "feat(godot): add UcsaNode lifecycle node

Counterpart of the Unity UcsaBehaviour: same public members, checkpoint on
focus-out, pause and close request, revalidate on focus-in and resume. New for
Godot: checkpoint when the node leaves the tree.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Godot `TextureCache`, package README, green smoke run

**Files:**
- Create: `packages/ucsa_godot/addons/ucsa/TextureCache.cs`, `packages/ucsa_godot/README.md`
- Create if Godot generated them: `packages/ucsa_godot/**/*.cs.uid`
- Test: `packages/ucsa_godot/tests/Smoke.cs` (all four assertion groups)

**Interfaces:**
- Consumes: `Ucsa.Storage.CasStore` (`GetAsync`, `PutAsync`, `Has`), `Ucsa.Storage.SqliteAdapter` (`GetQuery<T>`, `SetQuery<T>`), `Ucsa.Core.QueryKeyHasher.Hash`, `Ucsa.Core.CacheEntry<T>` from Task 1.
- Produces, in namespace `Ucsa.Godot`, the same public members as `packages/com.ucsa.unity/Runtime/Transports/TextureCache.cs` with `ImageTexture` in place of `Texture2D`:
  - `class TextureCacheOptions { CasStore? CasStore; SqliteAdapter? SqliteAdapter; int MaxMemoryTextures = 100; Func<string, CancellationToken, Task<byte[]>>? DownloadHandler; Func<byte[], ImageTexture>? TextureDecoder; }` (all properties with get and set)
  - `class TextureCache : IDisposable` with `int MaxMemoryTextures`, `int MemoryCacheCount`, `TextureCache(TextureCacheOptions? options = null)`, `TextureCache(CasStore? casStore, SqliteAdapter? sqliteAdapter = null, int maxMemoryTextures = 100)`, `Task<ImageTexture?> GetTextureAsync(string url, CancellationToken ct = default)`, `Task PreloadAsync(string url, CancellationToken ct = default)`, `bool Evict(string url)`, `void Clear()`, `bool ContainsInMemory(string url)`, `void Dispose()`.

One deliberate difference from Unity: the awaits inside `GetTextureAsync` do not use `ConfigureAwait(false)`, so the decode and the `ImageTexture` creation resume on the caller's context (the main thread when a node calls it). `PreloadAsync` touches no engine object and keeps `ConfigureAwait(false)`.

- [ ] **Step 1: Write the texture cache**

`packages/ucsa_godot/addons/ucsa/TextureCache.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Godot;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Godot
{
    /// <summary>
    /// Configuration options for TextureCache.
    /// </summary>
    public class TextureCacheOptions
    {
        public CasStore? CasStore { get; set; }
        public SqliteAdapter? SqliteAdapter { get; set; }
        public int MaxMemoryTextures { get; set; } = 100;
        public Func<string, CancellationToken, Task<byte[]>>? DownloadHandler { get; set; }
        public Func<byte[], ImageTexture>? TextureDecoder { get; set; }
    }

    /// <summary>
    /// Two-tier texture cache for Godot, the counterpart of the Unity TextureCache:
    /// - Tier 1: In-memory ImageTexture cache (limited by MaxMemoryTextures, least recently used evicted first).
    /// - Tier 2: Persistent Content-Addressable Storage (CAS) with SHA-256 integrity and LRU disk pruning.
    /// Call GetTextureAsync from the main thread: the awaits in it resume on the caller's
    /// context, so the ImageTexture is created on the thread that asked for it.
    /// </summary>
    public class TextureCache : IDisposable
    {
        private static readonly System.Net.Http.HttpClient SharedHttpClient = new();

        private readonly CasStore? _casStore;
        private readonly SqliteAdapter? _sqliteAdapter;
        private readonly int _maxMemoryTextures;
        private readonly Func<string, CancellationToken, Task<byte[]>> _downloadHandler;
        private readonly Func<byte[], ImageTexture> _textureDecoder;

        // In-memory LRU texture cache
        private readonly Dictionary<string, ImageTexture> _memoryCache = new(StringComparer.Ordinal);
        private readonly LinkedList<string> _lruOrder = new();

        // URL -> CAS Content Hash mapping cache
        private readonly Dictionary<string, string> _urlToCasHash = new(StringComparer.Ordinal);
        private readonly object _lock = new();

        public int MaxMemoryTextures => _maxMemoryTextures;
        public int MemoryCacheCount
        {
            get
            {
                lock (_lock)
                {
                    return _memoryCache.Count;
                }
            }
        }

        public TextureCache(TextureCacheOptions? options = null)
        {
            _casStore = options?.CasStore;
            _sqliteAdapter = options?.SqliteAdapter;
            _maxMemoryTextures = options?.MaxMemoryTextures > 0 ? options.MaxMemoryTextures : 100;
            _downloadHandler = options?.DownloadHandler ?? DefaultDownloaderAsync;
            _textureDecoder = options?.TextureDecoder ?? DefaultDecoder;
        }

        public TextureCache(
            CasStore? casStore,
            SqliteAdapter? sqliteAdapter = null,
            int maxMemoryTextures = 100)
            : this(new TextureCacheOptions
            {
                CasStore = casStore,
                SqliteAdapter = sqliteAdapter,
                MaxMemoryTextures = maxMemoryTextures
            })
        {
        }

        /// <summary>
        /// Retrieves an ImageTexture by URL.
        /// Checks the in-memory cache first, then CAS disk storage, and falls back to download.
        /// </summary>
        public async Task<ImageTexture?> GetTextureAsync(string url, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(url)) throw new ArgumentNullException(nameof(url));

            // 1. Check in-memory cache
            lock (_lock)
            {
                if (_memoryCache.TryGetValue(url, out var memoryTex))
                {
                    TouchMemoryLru(url);
                    return memoryTex;
                }
            }

            // 2. Resolve CAS content hash for this URL (from memory mapping or SQLite index)
            string? contentHash = ResolveCasHash(url);
            byte[]? rawBytes = null;

            // 3. Check CAS store on disk
            if (contentHash != null && _casStore != null)
            {
                rawBytes = await _casStore.GetAsync(contentHash, ct);
            }

            // 4. Download if not found in CAS
            if (rawBytes == null)
            {
                rawBytes = await _downloadHandler(url, ct);
                if (rawBytes == null || rawBytes.Length == 0)
                {
                    return null;
                }

                if (_casStore != null)
                {
                    // Store into CAS asynchronously (atomic .tmp write and SHA-256 validation)
                    var putResult = await _casStore.PutAsync(rawBytes, expectedHash: null, ct);
                    RecordUrlMapping(url, putResult.Hash);
                }
            }

            // 5. Decode into an ImageTexture (on the caller's context, see class summary)
            ImageTexture texture = _textureDecoder(rawBytes);

            // 6. Promote to in-memory cache
            lock (_lock)
            {
                SetMemoryCache(url, texture);
            }

            return texture;
        }

        /// <summary>
        /// Preloads texture binary data into the CAS disk store without creating a texture.
        /// </summary>
        public async Task PreloadAsync(string url, CancellationToken ct = default)
        {
            if (string.IsNullOrEmpty(url)) throw new ArgumentNullException(nameof(url));

            string? contentHash = ResolveCasHash(url);
            if (contentHash != null && _casStore != null && _casStore.Has(contentHash))
            {
                return; // Already cached on disk
            }

            byte[] bytes = await _downloadHandler(url, ct).ConfigureAwait(false);
            if (bytes != null && bytes.Length > 0 && _casStore != null)
            {
                var putResult = await _casStore.PutAsync(bytes, expectedHash: null, ct).ConfigureAwait(false);
                RecordUrlMapping(url, putResult.Hash);
            }
        }

        /// <summary>
        /// Evicts a texture from in-memory cache.
        /// </summary>
        public bool Evict(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;

            lock (_lock)
            {
                if (_memoryCache.Remove(url))
                {
                    _lruOrder.Remove(url);
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// Clears all textures from in-memory cache.
        /// </summary>
        public void Clear()
        {
            lock (_lock)
            {
                _memoryCache.Clear();
                _lruOrder.Clear();
            }
        }

        /// <summary>
        /// Determines if the URL is cached in memory.
        /// </summary>
        public bool ContainsInMemory(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;
            lock (_lock)
            {
                return _memoryCache.ContainsKey(url);
            }
        }

        private string? ResolveCasHash(string url)
        {
            lock (_lock)
            {
                if (_urlToCasHash.TryGetValue(url, out var hash))
                {
                    return hash;
                }
            }

            if (_sqliteAdapter != null)
            {
                string queryHash = QueryKeyHasher.Hash("texture", url);
                var entry = _sqliteAdapter.GetQuery<string>(queryHash);
                if (entry != null && !string.IsNullOrEmpty(entry.DataPayload))
                {
                    lock (_lock)
                    {
                        _urlToCasHash[url] = entry.DataPayload;
                    }
                    return entry.DataPayload;
                }
            }

            return null;
        }

        private void RecordUrlMapping(string url, string contentHash)
        {
            lock (_lock)
            {
                _urlToCasHash[url] = contentHash;
            }

            if (_sqliteAdapter != null)
            {
                string queryHash = QueryKeyHasher.Hash("texture", url);
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var entry = new CacheEntry<string>(
                    queryHash,
                    new object[] { "texture", url },
                    contentHash,
                    createdAt: now,
                    staleAt: now + (30L * 24 * 3600 * 1000), // 30 days
                    expiresAt: now + (90L * 24 * 3600 * 1000) // 90 days
                );
                _sqliteAdapter.SetQuery(entry, new[] { "texture" });
            }
        }

        private void TouchMemoryLru(string url)
        {
            _lruOrder.Remove(url);
            _lruOrder.AddLast(url);
        }

        private void SetMemoryCache(string url, ImageTexture texture)
        {
            if (_memoryCache.ContainsKey(url))
            {
                _memoryCache[url] = texture;
                TouchMemoryLru(url);
                return;
            }

            while (_memoryCache.Count >= _maxMemoryTextures && _lruOrder.First != null)
            {
                string oldest = _lruOrder.First.Value;
                _lruOrder.RemoveFirst();
                _memoryCache.Remove(oldest);
            }

            _memoryCache[url] = texture;
            _lruOrder.AddLast(url);
        }

        private static async Task<byte[]> DefaultDownloaderAsync(string url, CancellationToken ct)
        {
            return await SharedHttpClient.GetByteArrayAsync(url, ct).ConfigureAwait(false);
        }

        // PNG and JPEG, the same two formats Unity's LoadImage accepts.
        private static ImageTexture DefaultDecoder(byte[] bytes)
        {
            var image = new Image();
            bool isJpeg = bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
            Error err = isJpeg ? image.LoadJpgFromBuffer(bytes) : image.LoadPngFromBuffer(bytes);
            if (err != Error.Ok)
            {
                throw new InvalidDataException($"[UCSA] Texture decode failed: {err}");
            }
            return ImageTexture.CreateFromImage(image);
        }

        public void Dispose()
        {
            Clear();
        }
    }
}
```

`HttpClient` is written with its full name because Godot also has a class called `HttpClient`. `Image.LoadPngFromBuffer` and `ImageTexture.CreateFromImage` are confirmed at run time by the Task 2 probe; `Image.LoadJpgFromBuffer` compiles against the 4.7.2 bindings and is not exercised by the smoke test.

- [ ] **Step 2: Build with no warnings**

```bash
dotnet build packages/ucsa_godot/UcsaGodot.csproj --nologo -v quiet 2>&1 | tail -n 3
```

Expected: `0 Warning(s)` and `0 Error(s)`.

- [ ] **Step 3: Run the smoke test green**

```bash
bash scripts/godot-smoke.sh 2>&1 | tail -n 6; bash scripts/godot-smoke.sh >/dev/null 2>&1; echo "exit=$?"
```

Expected: the output contains the line `SMOKE PASS 4/4`, ends with `godot smoke: ok`, and prints `exit=0`.

If it prints `SMOKE FAIL n/4: ...`, the text after the colon names the failed assertion; fix the binding, not the assertion, unless Task 2 recorded a fallback for that fact. If it prints exit code 142, the run hung: the first suspect is the `ToSignal` wait at the top of `Smoke._Ready`; replace that line with `await Task.Yield();` only if the probe in Task 2 showed the same hang, and report it.

Also prove the runner cannot pass falsely. Temporarily change `private const int Expected = 4;` to `5` in `Smoke.cs`, run `bash scripts/godot-smoke.sh >/dev/null 2>&1; echo "exit=$?"`, expect `exit=1`, then restore the line with `git checkout packages/ucsa_godot/tests/Smoke.cs` and re-run to `exit=0`.

- [ ] **Step 4: Write the package README**

`packages/ucsa_godot/README.md`:

````markdown
# UCSA for Godot (`packages/ucsa_godot`)

A Godot 4 .NET (C#) binding for UCSA, the Unified Client State Architecture. It is a thin layer over the shared engine-free C# core in `packages/com.ucsa.core`, the same core the Unity package uses. Namespace: `Ucsa.Godot`.

Verified target: desktop (macOS and Linux) on Godot 4.7.2 .NET with .NET 8. Mobile export is not verified. Godot 4 does not support C# web export. There is no GDScript API and no editor plugin. Nothing is published to a registry: install from this repository.

## What is in the box

| File | What it does |
|---|---|
| `addons/ucsa/UcsaNode.cs` | Lifecycle node. Checkpoints the SQLite write-ahead log on focus-out, pause, window close request and when the node leaves the tree; revalidates active queries on focus-in and resume. |
| `addons/ucsa/TextureCache.cs` | Two-tier texture cache producing `ImageTexture`: memory first, then the content-addressable store on disk, then download. |
| `tests/Smoke.tscn`, `tests/Smoke.cs` | Headless in-engine smoke test, run by `scripts/godot-smoke.sh`. |

Everything else (query engine, SQLite adapter, content-addressable store, UCB1 frame codec, streaming) comes from `packages/com.ucsa.core` in namespaces `Ucsa.Core`, `Ucsa.Storage`, `Ucsa.Ipc` and `Ucsa.Streaming`.

## Install

1. Copy or symlink `packages/ucsa_godot/addons/ucsa` into your project's `addons/` folder.
2. Copy or symlink `packages/com.ucsa.core` next to your project and reference it from your project's `.csproj`:

```xml
<ItemGroup>
  <ProjectReference Include="../com.ucsa.core/Ucsa.Core.csproj" />
</ItemGroup>
```

Your project needs the Godot .NET build (not the standard build) and the .NET 8 SDK.

## Use

```csharp
using System.IO;
using Godot;
using Ucsa.Core;
using Ucsa.Godot;
using Ucsa.Storage;

public partial class Main : Node
{
    public override void _Ready()
    {
        // The game owns the database. UcsaNode never opens or migrates it.
        string dbPath = Path.Combine(ProjectSettings.GlobalizePath("user://"), "app_cache.db");
        var sqlite = new SqliteAdapter(dbPath);
        var engine = new QueryEngine(sqlite, defaultStaleTime: 5000);

        var ucsa = new UcsaNode { SqliteAdapter = sqlite, QueryEngine = engine };
        ucsa.OnCheckpointFlushed += () => GD.Print("WAL flushed");
        AddChild(ucsa);
    }
}
```

## Lifecycle mapping

| Unity (`UcsaBehaviour`) | Godot (`UcsaNode`) | Fires on |
|---|---|---|
| `Awake` | `_Ready` | all |
| `OnApplicationPause(true)` | `NotificationApplicationPaused` | mobile |
| (none) | `NotificationApplicationFocusOut` | desktop |
| `OnApplicationPause(false)` | `NotificationApplicationResumed`, `NotificationApplicationFocusIn` | mobile, desktop |
| `OnApplicationQuit` | `NotificationWMCloseRequest` | desktop |
| `OnDestroy` | `_ExitTree` | all |

Two behaviours are specific to Godot. Losing window focus counts as a pause, so an alt-tab checkpoints and the return revalidates queries. Leaving the tree checkpoints too, because a programmatic quit sends no close request. A window close request checkpoints and then closes the adapter, exactly as the Unity quit handler does; leaving the tree does not close it.

A second `UcsaNode` entering the tree logs a warning and does not replace `UcsaNode.Instance`. Checkpoint failures are logged with `GD.PushError` and never thrown into the engine.

## Test

```bash
# needs a Godot .NET build: set GODOT_MONO_BIN, or have godot-mono on PATH
bash scripts/godot-smoke.sh
```

It builds the project, runs `tests/Smoke.tscn` headless under a timeout, and passes only when the engine exits with code 0 and prints `SMOKE PASS 4/4`.
````

- [ ] **Step 5: Commit, including any `.uid` files Godot generated**

```bash
git status --short packages/ucsa_godot
```

Expected: untracked `addons/ucsa/TextureCache.cs`, `README.md`, the `.godot/` folder, and possibly `*.cs.uid` files next to the scripts (Task 2 Step 4 recorded whether Godot generates them). Godot expects `.uid` files to be versioned.

```bash
git add packages/ucsa_godot/addons/ucsa/TextureCache.cs packages/ucsa_godot/README.md
git ls-files --others --exclude-standard packages/ucsa_godot | grep -v '/\.godot/' | grep '\.uid$' | xargs -I{} git add "{}"
git status --short packages/ucsa_godot | grep -v '^A ' ; echo "left unstaged above (only .godot/ is expected)"
git commit -m "feat(godot): add TextureCache and package README, smoke test green

Counterpart of the Unity TextureCache producing ImageTexture. The headless
smoke scene now prints SMOKE PASS 4/4 in Godot 4.7.2 .NET.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Phase gate** (rule 7): verify, independent review, `/simplify`, re-verify.
  1. Verify: `bash scripts/godot-smoke.sh 2>&1 | tail -n 2` shows `SMOKE PASS 4/4` and `godot smoke: ok`; `bash scripts/precheck.sh 2>&1 | tail -n 1` shows `Gate 1: ok`.
  2. Independent review of the Phase 2 diff (Tasks 3 to 5): dispatch `code-reviewer` (model opus, effort medium) with the goal verbatim. Ask for a C# read against `packages/com.ucsa.unity/Runtime/Unity/UcsaBehaviour.cs` and `Runtime/Transports/TextureCache.cs`: does every public member of the Unity classes have a counterpart; is any behaviour added beyond focus-out and `_ExitTree` checkpoints; can any smoke assertion pass when the behaviour is broken; can the runner hang or pass without the marker. Ask it to check `scripts/godot-smoke.sh` for quoting and exit-code mistakes.
  3. `/simplify` on the diff. Apply only findings inside this phase's files.
  4. Re-verify: repeat item 1. If the gate changed any file, commit it as a new commit: `git commit -m "refactor(godot): phase 2 review fixes"` with the same trailer.

---

# Phase 3: Pre-ship check and CI wiring for Godot

### Task 6: Run the Godot smoke test from `scripts/precheck.sh`, ignore `.godot/`

**Files:**
- Modify: `scripts/precheck.sh` (inside `slot_unit_tests`, after the `dotnet` block added in Task 1), `.gitignore` (after line 19, `obj/`)

**Interfaces:**
- Consumes: `scripts/godot-smoke.sh` and its `--locate` mode from Task 3.
- Produces: the pre-ship check prints `godot smoke: ok` when a Godot .NET binary is present, or the exact line `-- godot smoke: SKIPPED (no Godot .NET binary found; set GODOT_MONO_BIN or install godot-mono)` when it is not. Environment variable `UCSA_REQUIRE_GODOT_SMOKE=1` turns the skip into a failure; Task 7 sets it in CI.

- [ ] **Step 1: Write the check for the skip and required paths, and watch it fail**

The block is tested in isolation with a PATH that has no Godot on it (`/usr/bin:/bin`), so the result does not depend on what is installed.

```bash
TMPB="$(mktemp -d)"
sed -n '/# Godot in-engine smoke test/,/^  fi$/p' scripts/precheck.sh > "$TMPB/block.sh"
wc -l < "$TMPB/block.sh"
```

Expected before the edit: `0` (the block does not exist yet).

- [ ] **Step 2: Add the Godot block to `scripts/precheck.sh`**

In `slot_unit_tests`, directly after the `fi` that closes the `dotnet` block and before the function's closing `}`, add:

```bash
  # Godot in-engine smoke test (packages/ucsa_godot). It runs when a Godot .NET
  # binary is found; otherwise it prints a visible skip line. CI sets
  # UCSA_REQUIRE_GODOT_SMOKE=1 so a missing binary fails there instead of skipping.
  if [ -n "${GODOT_MONO_BIN:-}" ] || [ "${UCSA_REQUIRE_GODOT_SMOKE:-0}" = "1" ] || bash scripts/godot-smoke.sh --locate >/dev/null 2>&1; then
    bash scripts/godot-smoke.sh
  else
    echo "-- godot smoke: SKIPPED (no Godot .NET binary found; set GODOT_MONO_BIN or install godot-mono)"
  fi
```

The whole function now reads:

```bash
slot_unit_tests() {
  pnpm test
  if command -v dart >/dev/null 2>&1 && [ -f "packages/ucsa_dart/pubspec.yaml" ]; then
    (cd packages/ucsa_dart && dart test)
  fi
  if command -v flutter >/dev/null 2>&1 && [ -f "packages/ucsa_flutter/pubspec.yaml" ]; then
    (cd packages/ucsa_flutter && flutter test)
  fi
  if command -v dotnet >/dev/null 2>&1 && [ -f "packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj" ]; then
    dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj
    dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj
  fi
  # Godot in-engine smoke test (packages/ucsa_godot). It runs when a Godot .NET
  # binary is found; otherwise it prints a visible skip line. CI sets
  # UCSA_REQUIRE_GODOT_SMOKE=1 so a missing binary fails there instead of skipping.
  if [ -n "${GODOT_MONO_BIN:-}" ] || [ "${UCSA_REQUIRE_GODOT_SMOKE:-0}" = "1" ] || bash scripts/godot-smoke.sh --locate >/dev/null 2>&1; then
    bash scripts/godot-smoke.sh
  else
    echo "-- godot smoke: SKIPPED (no Godot .NET binary found; set GODOT_MONO_BIN or install godot-mono)"
  fi
}
```

Do not write a comment line that starts with `# n/a:` inside the function: the slot runner treats that as "this slot does not apply" and would skip every unit test.

- [ ] **Step 3: Run the isolated check and see it pass**

```bash
bash -n scripts/precheck.sh && echo "syntax ok"
sed -n '/# Godot in-engine smoke test/,/^  fi$/p' scripts/precheck.sh > "$TMPB/block.sh"
wc -l < "$TMPB/block.sh"
env -i PATH=/usr/bin:/bin bash "$TMPB/block.sh"; echo "exit=$?"
env -i PATH=/usr/bin:/bin UCSA_REQUIRE_GODOT_SMOKE=1 bash "$TMPB/block.sh"; echo "exit=$?"
rm -rf "$TMPB"
```

Expected (this exact block was run while the plan was written):

```
syntax ok
8
-- godot smoke: SKIPPED (no Godot .NET binary found; set GODOT_MONO_BIN or install godot-mono)
exit=0
godot smoke: FAILED (no Godot .NET binary; set GODOT_MONO_BIN or install godot-mono)
exit=1
```

- [ ] **Step 4: Ignore the Godot cache folder**

In `.gitignore`, directly after the line `obj/`, add:

```gitignore
# Godot editor cache and .NET build output (packages/ucsa_godot)
.godot/
```

```bash
git check-ignore -v packages/ucsa_godot/.godot/mono/temp/bin/Debug/UcsaGodot.dll
git status --short packages/ucsa_godot
```

Expected: the first command prints a line that starts with `.gitignore:` and names the `.godot/` rule; the second prints nothing.

- [ ] **Step 5: Run the whole pre-ship check with the Godot binary present**

```bash
bash scripts/precheck.sh 2>&1 | grep -E '^== |^FAILED|^Gate 1|Passed!|SMOKE|godot smoke' | tail -n 12
```

Expected: `Passed!` for `Ucsa.Core.Tests.dll` (127) and `Ucsa.Unity.Tests.dll` (10), the lines `SMOKE PASS 4/4` and `godot smoke: ok`, no `FAILED:` line and no `SKIPPED` line, last line `Gate 1: ok`.

- [ ] **Step 6: Commit**

```bash
git add scripts/precheck.sh .gitignore
git commit -m "chore(precheck): run the Godot smoke test when a Godot .NET build is present

Prints an explicit skip line otherwise; UCSA_REQUIRE_GODOT_SMOKE=1 turns the
skip into a failure. Ignore the .godot/ cache folder.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Pinned Godot .NET step in `ci.yml`

**This task changes CI configuration, which is costly to reverse:** a wrong step blocks every pull request to `main` until it is fixed, and the result can only be observed on GitHub, not locally. State what is being changed and why in the task report before editing. `.github/workflows/release.yml` is not touched.

**Files:**
- Modify: `.github/workflows/ci.yml` (header comment lines 11-22; one new step before the `Gate 1 (precheck)` step at line 78)

**Interfaces:**
- Consumes: `UCSA_REQUIRE_GODOT_SMOKE` and `GODOT_MONO_BIN` handling from Tasks 3 and 6; the confirmed `GODOT_VERSION`, `GODOT_SHA512` and in-zip binary path from Task 2 (fact I).
- Produces: a CI job in which `scripts/precheck.sh` runs the Godot smoke test and cannot skip it.

URL pattern for the pinned download: `https://github.com/godotengine/godot/releases/download/<version>-stable/Godot_v<version>-stable_mono_linux_x86_64.zip`. The exact version and checksum are the ones fixed in Task 2 Step 5. The values below are what the release's `SHA512-SUMS.txt` listed on 2026-10-13; if Task 2 recorded different values, use Task 2's.

- [ ] **Step 1: Update the header comment**

Replace these lines of `.github/workflows/ci.yml` (lines 11-22):

```yaml
# It runs scripts/precheck.sh (Gate 1): build + typecheck, unit tests, and the
# docs typecheck and tests. Same Node/pnpm setup as release.yml.
#
# precheck.sh runs the Dart/Flutter suites only when the tool is installed, and
# no setup step is added here, so on a stock ubuntu runner:
#   - Dart tests (packages/ucsa_dart) - skipped, no `dart` on the runner
#   - Flutter tests (packages/ucsa_flutter) - skipped, no `flutter`
# .NET tests (packages/com.ucsa.unity) DO run: ubuntu-latest ships `dotnet`.
# Not verified here, since Actions cannot be run locally; if the NuGet
# restore proves flaky on the runner, that is the first thing to look at.
# Run those locally via `bash scripts/precheck.sh` before shipping.
# Gate 2 (scripts/integration.sh) is not run here.
```

with:

```yaml
# It runs scripts/precheck.sh (Gate 1): build + typecheck, unit tests, and the
# docs typecheck and tests. Same Node/pnpm setup as release.yml.
#
# precheck.sh runs the Dart/Flutter suites only when the tool is installed, and
# no setup step is added here, so on a stock ubuntu runner:
#   - Dart tests (packages/ucsa_dart) - skipped, no `dart` on the runner
#   - Flutter tests (packages/ucsa_flutter) - skipped, no `flutter`
# .NET tests (packages/com.ucsa.core, packages/com.ucsa.unity) DO run:
# ubuntu-latest ships `dotnet`. If the NuGet restore proves flaky on the
# runner, that is the first thing to look at.
# The Godot in-engine smoke test (packages/ucsa_godot) DOES run: one step
# below downloads a pinned Godot .NET build, checks its SHA-512, and sets
# UCSA_REQUIRE_GODOT_SMOKE=1 so precheck.sh fails instead of skipping.
# Run the Dart/Flutter suites locally via `bash scripts/precheck.sh`.
# Gate 2 (scripts/integration.sh) is not run here.
```

- [ ] **Step 2: Add the pinned Godot step**

Directly before this existing step:

```yaml
      - name: Gate 1 (precheck)
        run: bash scripts/precheck.sh
```

And change that existing step so the no-skip flag is set on the gate itself. If the install step is ever removed or made conditional, the gate then fails; it cannot silently skip:

```yaml
      - name: Gate 1 (precheck)
        env:
          UCSA_REQUIRE_GODOT_SMOKE: "1"
        run: bash scripts/precheck.sh
```

insert:

```yaml
      # Godot .NET, pinned, for the in-engine smoke test of packages/ucsa_godot.
      # The archive is checked against the SHA-512 from the release's
      # SHA512-SUMS.txt before it is unpacked. No secret is in scope here.
      - name: Install Godot .NET (pinned)
        env:
          GODOT_VERSION: 4.7.2-stable
          GODOT_SHA512: 1855960b27ee3ef5e66e5e228cced69d55637b24334a7411162687dcd077d8f9f645348cdb8eae984bec8135d49ed855a1e3a16476786b8bce60774fd8402d13
        run: |
          set -euo pipefail
          name="Godot_v${GODOT_VERSION}_mono_linux_x86_64"
          curl -fsSL --retry 3 -o "$RUNNER_TEMP/godot.zip" "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/${name}.zip"
          echo "${GODOT_SHA512}  $RUNNER_TEMP/godot.zip" | sha512sum -c -
          unzip -q "$RUNNER_TEMP/godot.zip" -d "$RUNNER_TEMP/godot"
          bin="$RUNNER_TEMP/godot/${name}/Godot_v${GODOT_VERSION}_mono_linux.x86_64"
          test -x "$bin"
          "$bin" --version
          echo "GODOT_MONO_BIN=$bin" >> "$GITHUB_ENV"

```

If Task 2 recorded fallback C (a newer .NET is required), also insert this step before the Godot step, with the major version Task 2 recorded in place of `9.0.x`:

```yaml
      - uses: actions/setup-dotnet@v6
        with:
          dotnet-version: '9.0.x'
```

Do not add it otherwise.

- [ ] **Step 3: Check what can be checked locally**

```bash
ruby -ryaml -e 'y = YAML.load_file(".github/workflows/ci.yml"); s = y["jobs"]["precheck"]["steps"].map { |x| x["name"] || x["uses"] }; puts s' 2>/dev/null
git diff main -- .github/workflows/release.yml pnpm-workspace.yaml | wc -l
grep -c 'GODOT_SHA512' .github/workflows/ci.yml
```

Expected: the step list ends with `Build native dependencies (no token)`, `Install Godot .NET (pinned)`, `Gate 1 (precheck)`; the diff line count is `0`; the grep count is `2`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the Godot smoke test with a pinned Godot .NET build

Downloads Godot 4.7.2 .NET for Linux, verifies its SHA-512, and makes
precheck.sh fail instead of skip when the binary is missing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Observe a real CI run (needs a fresh owner yes)**

`ci.yml` runs only on pull requests to `main`, so the workflow cannot be seen green without pushing the feature branch and opening a pull request. Pushing is an action the owner must approve. Ask once, through the orchestrator, with these two options: (a) push this feature branch and open a draft pull request to `main` that is closed without merging once CI is green; (b) do not push now, and check this criterion on the release pull request at promote time.

If the owner chooses (a):

```bash
git push -u origin "$(git branch --show-current)"
gh pr create --draft --base main --title "ci check only: Godot smoke step (do not merge)" --body "Draft opened only to observe the CI workflow with the new Godot .NET step. It will be closed without merging; the feature ships through the release branch.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr checks --watch 2>&1 | tail -n 5
RUN_ID="$(gh run list --branch "$(git branch --show-current)" --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run view "$RUN_ID" --log 2>/dev/null | grep -E 'SMOKE PASS 4/4|godot smoke: (ok|SKIPPED|FAILED)|Gate 1:' | tail -n 5
gh run view "$RUN_ID" --json jobs --jq '.jobs[0] | "\(.conclusion) \(.startedAt) \(.completedAt)"'
gh pr close "$(gh pr view --json number --jq .number)"
```

Expected: the check `precheck` passes; the log shows `SMOKE PASS 4/4`, `godot smoke: ok` and `Gate 1: ok`, and no `SKIPPED` line. If the job took more than 12 of its 15 minutes, raise `timeout-minutes` to 25 in a new commit and say so in the report. If the Godot step failed on the runner (a missing system library is the most likely cause), read the failing lines with `gh run view "$RUN_ID" --log-failed | tail -n 30`, fix the step in a new commit, push, and watch again.

If the owner chooses (b): write one line in `.claude/refined_backlog/<F-NNN>/handoff.md` saying the criterion "CI run shows the Godot smoke step executed and green" is open and is checked on the release pull request, and commit that file.

- [ ] **Step 6: Phase gate** (rule 7): verify, independent review, `/simplify`, re-verify.
  1. Verify: Task 6 Step 5 output (`godot smoke: ok`, `Gate 1: ok`) and, if the owner chose (a), the CI log lines from Step 5.
  2. Independent review of the Phase 3 diff (Tasks 6 and 7): dispatch `code-reviewer` (model opus, effort medium) with the goal verbatim. Because this touches CI, ask specifically: can the Godot step run with any secret in scope; is the download verified before it is unpacked or executed; can `precheck.sh` report success on CI without running the smoke test; does the new block change the behaviour of the slot runner (`run_slot`, `is_unfilled`, `na_reason`). Also dispatch `security-reviewer` on `.github/workflows/ci.yml`.
  3. `/simplify` on the diff. Apply only findings inside this phase's files.
  4. Re-verify: `bash scripts/precheck.sh 2>&1 | tail -n 1` prints `Gate 1: ok`. If the gate changed any file, commit it as a new commit: `git commit -m "ci: phase 3 review fixes"` with the same trailer (a change to `ci.yml` after the CI observation needs the observation repeated).

---

# Phase 4: README and docs site for Godot

### Task 8: README Godot section, Unity two-package install note, test commands

**Files:**
- Modify: `README.md` (the Unity section that starts at `## C# / Unity Reference Implementation`; a new section before `## Incompatibility Selective Eviction & Outbox Salvage Protection`; the note under the test table; the `### Verification Commands` block)

**Interfaces:**
- Consumes: the file names and class names from Tasks 1, 4 and 5; `scripts/godot-smoke.sh` from Task 3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the check and watch it fail**

```bash
grep -c '^## C# / Godot Reference Implementation (`packages/ucsa_godot`)$' README.md
grep -c 'A Unity project must list both packages' README.md
grep -c 'scripts/godot-smoke.sh' README.md
```

Expected before the edit: `0`, `0`, `0`.

- [ ] **Step 2: Add the Unity two-package install note**

Directly after the paragraph that starts with `` `com.ucsa.unity` provides a production-grade Unity Package Manager (UPM) reference implementation `` (the first paragraph under the Unity heading) and before `### Game Engine Architecture Highlights`, insert:

````markdown
> **Two packages.** The engine-free runtime (`QueryEngine`, `StateObserver`, `LifecycleFsm`, `SqliteAdapter`, `CasStore`, `MigrationRunner`, the UCB1 frame codec and the streaming classes) lives in `packages/com.ucsa.core`, in namespaces `Ucsa.Core`, `Ucsa.Storage`, `Ucsa.Ipc` and `Ucsa.Streaming`. `packages/com.ucsa.unity` keeps only `UcsaBehaviour` and `TextureCache`. A Unity project must list both packages in its `Packages/manifest.json`, because Unity resolves a package's dependencies only from a registry and neither package is published:
>
> ```json
> {
>   "dependencies": {
>     "com.ucsa.core": "file:../../cli-state-handler/packages/com.ucsa.core",
>     "com.ucsa.unity": "file:../../cli-state-handler/packages/com.ucsa.unity"
>   }
> }
> ```
>
> `UnitySqliteAdapter` is now `SqliteAdapter` and `UnityCasStore` is now `CasStore`; there are no compatibility aliases. This layout is checked by `dotnet test` against mock engine types, not inside a Unity editor.
````

(The two old class names appear here on purpose; they are the only place in the README where they remain.)

- [ ] **Step 3: Add the Godot section**

Directly before the line `## Incompatibility Selective Eviction & Outbox Salvage Protection` (after the `---` that closes the Unity section), insert the following, ending with its own `---` line and a blank line:

````markdown
## C# / Godot Reference Implementation (`packages/ucsa_godot`)

`packages/ucsa_godot` is a Godot 4 .NET (C#) binding for UCSA. It is a thin layer over the shared engine-free C# core in `packages/com.ucsa.core`, the same core the Unity package uses, so the query engine, SQLite storage, content-addressable store, UCB1 frame codec and streaming classes are the same code on both engines. Namespace: `Ucsa.Godot`.

> Verified target: desktop (macOS and Linux) on Godot 4.7.2 .NET with .NET 8. Mobile export is not verified, and Godot 4 does not support C# web export. There is no GDScript API and no editor plugin. Nothing is published to a registry: install from this repository.

### What the binding adds

| Class | File | Role |
|---|---|---|
| `UcsaNode : Node` | `packages/ucsa_godot/addons/ucsa/UcsaNode.cs` | Counterpart of `UcsaBehaviour`. Checkpoints the SQLite write-ahead log on focus-out, pause, window close request and tree exit; revalidates active queries on focus-in and resume. |
| `TextureCache` | `packages/ucsa_godot/addons/ucsa/TextureCache.cs` | Counterpart of the Unity texture cache, producing `ImageTexture`: memory first, then the content-addressable store, then download. |

### Install

1. Copy or symlink `packages/ucsa_godot/addons/ucsa` into your project's `addons/` folder.
2. Copy or symlink `packages/com.ucsa.core` next to your project and reference it from your project's `.csproj`:

```xml
<ItemGroup>
  <ProjectReference Include="../com.ucsa.core/Ucsa.Core.csproj" />
</ItemGroup>
```

### Godot usage example

```csharp
using System.IO;
using Godot;
using Ucsa.Core;
using Ucsa.Godot;
using Ucsa.Storage;

public partial class Main : Node
{
    public override void _Ready()
    {
        // The game owns the database. UcsaNode never opens or migrates it.
        string dbPath = Path.Combine(ProjectSettings.GlobalizePath("user://"), "app_cache.db");
        var sqlite = new SqliteAdapter(dbPath);
        var engine = new QueryEngine(sqlite, defaultStaleTime: 5000);

        var ucsa = new UcsaNode { SqliteAdapter = sqlite, QueryEngine = engine };
        ucsa.OnCheckpointFlushed += () => GD.Print("WAL flushed");
        AddChild(ucsa);
    }
}
```

### Lifecycle mapping

| Unity (`UcsaBehaviour`) | Godot (`UcsaNode`) | Fires on |
|---|---|---|
| `Awake` | `_Ready` | all |
| `OnApplicationPause(true)` | `NotificationApplicationPaused` | mobile |
| (none) | `NotificationApplicationFocusOut` | desktop |
| `OnApplicationPause(false)` | `NotificationApplicationResumed`, `NotificationApplicationFocusIn` | mobile, desktop |
| `OnApplicationQuit` | `NotificationWMCloseRequest` | desktop |
| `OnDestroy` | `_ExitTree` | all |

Two behaviours are specific to Godot. Losing window focus counts as a pause, so an alt-tab checkpoints and the return revalidates queries. Leaving the tree checkpoints too, because a programmatic quit sends no close request. A window close request checkpoints and then closes the adapter, as the Unity quit handler does; leaving the tree does not close it.

### In-engine smoke test

```bash
# needs a Godot .NET build: set GODOT_MONO_BIN, or have godot-mono on PATH
./scripts/godot-smoke.sh
```

The runner builds the project, runs `packages/ucsa_godot/tests/Smoke.tscn` headless under a timeout, and passes only when the engine exits with code 0 and prints `SMOKE PASS 4/4`. The four assertion groups: a focus-out checkpoint with the value readable from a fresh adapter, a checkpoint on tree exit, every UCB1 conformance vector in `contracts/ipc/vectors.json`, and a PNG decoded through `TextureCache` with the second request served from memory. `scripts/precheck.sh` runs it when a Godot .NET build is present and prints a skip line otherwise; CI always runs it.

---

````

- [ ] **Step 4: Update the test-command section**

In the `### Verification Commands` code block, directly after the two lines

```bash
# Run the C# Unity binding test suite (10 tests across 3 files)
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj
```

add:

```bash

# Run the Godot in-engine smoke test (needs a Godot .NET build: GODOT_MONO_BIN, or godot-mono on PATH)
./scripts/godot-smoke.sh
```

Directly after the blockquote paragraph that starts with `> All counts in the Total row come from real runs on this branch.` add a blank line and:

```markdown
> The Godot binding is covered by the in-engine smoke test (`packages/ucsa_godot/tests/Smoke.cs`, 4 assertion groups), which is not an NUnit suite and is not part of the counts above.
```

- [ ] **Step 5: Run the check and see it pass**

```bash
grep -c '^## C# / Godot Reference Implementation (`packages/ucsa_godot`)$' README.md
grep -c 'A Unity project must list both packages' README.md
grep -c 'scripts/godot-smoke.sh' README.md
grep -n 'UnitySqliteAdapter\|UnityCasStore' README.md | wc -l
for f in packages/ucsa_godot/addons/ucsa/UcsaNode.cs packages/ucsa_godot/addons/ucsa/TextureCache.cs packages/ucsa_godot/tests/Smoke.tscn packages/com.ucsa.core/Ucsa.Core.csproj scripts/godot-smoke.sh contracts/ipc/vectors.json; do test -f "$f" && echo "ok $f" || echo "MISSING $f"; done
```

Expected: `1`, `1`, `2` (the Godot section and the Verification Commands block), `1` (the one line of the two-package note), and six `ok` lines.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Godot section, Unity two-package install note and test commands

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Docs site platform `godot`

**Files:**
- Modify: `apps/docs/tests/parity.test.tsx`, `apps/docs/tests/multiplatform-docs.test.tsx`, `apps/docs/src/content/guides/types.ts`, `apps/docs/src/content/guides/index.ts`, `apps/docs/src/content/guides/{swr,timing,outbox,cas,wal,ucb1}.ts`, `apps/docs/src/content/parity.ts`, `apps/docs/src/components/MultiPlatformDocs.tsx:7-11,92`, `apps/docs/src/components/ParityMatrix.tsx:6`, `apps/docs/src/components/multiplatform.css:20`

**Interfaces:**
- Consumes: `CS` and `UNITY` from Task 1; the files `packages/ucsa_godot/addons/ucsa/UcsaNode.cs` and `TextureCache.cs` from Tasks 4 and 5 (the docs tests assert that cited files exist).
- Produces: `PlatformId = "ts" | "dart" | "csharp" | "godot"`; `Guide.godot: Snippet`; `GODOT = "packages/ucsa_godot/addons/ucsa"`; `platforms = ["ts", "dart", "csharp", "godot"]`; tab label `🤖 C# Godot (.NET)`; parity column headers `Unity C#` and `Godot C#`.

Decisions kept small on purpose: the badge text "3 Native Implementations" stays (TypeScript, Dart and C# are the three implementations; Godot is a second binding of the C# one); the route title "TS / Dart / Unity C#" stays, so `apps/docs/tests/app-shell.test.tsx` and the last test of `multiplatform-docs.test.tsx` are untouched.

- [ ] **Step 1: Update the two test files first**

In `apps/docs/tests/parity.test.tsx`:

Replace

```tsx
// Pinned expected levels (columns: ts, dart, csharp).
const EXPECTED_LEVELS: Record<string, [string, string, string]> = {
  swr: ["full", "full", "full"],
  timing: ["full", "full", "partial"],
  outbox: ["full", "partial", "partial"],
  cas: ["full", "full", "full"],
  wal: ["full", "partial", "partial"],
  ucb1: ["full", "partial", "partial"],
};

describe("guide content", () => {
  it("covers the six subsystems in order", () => {
    expect(guideIds).toEqual(SUBSYSTEMS);
  });
```

with

```tsx
// Pinned expected levels (columns: ts, dart, csharp, godot).
const EXPECTED_LEVELS: Record<string, [string, string, string, string]> = {
  swr: ["full", "full", "full", "full"],
  timing: ["full", "full", "partial", "partial"],
  outbox: ["full", "partial", "partial", "partial"],
  cas: ["full", "full", "full", "full"],
  wal: ["full", "partial", "partial", "partial"],
  ucb1: ["full", "partial", "partial", "partial"],
};

describe("guide content", () => {
  it("covers the six subsystems in order", () => {
    expect(guideIds).toEqual(SUBSYSTEMS);
  });

  it("lists godot as the fourth platform", () => {
    expect(platforms).toEqual(["ts", "dart", "csharp", "godot"]);
  });
```

Replace `it("has one row per subsystem and three platform cells each", () => {` with `it("has one row per subsystem and four platform cells each", () => {`.

Replace `it("matches the pinned 6x3 level table", () => {` with `it("matches the pinned 6x4 level table", () => {`.

Replace

```tsx
  it("renders one row per subsystem and three platform columns with text labels", () => {
    render(<ParityMatrix />);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Subsystem", "TypeScript", "Dart", "C#"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBe(6);
    rows.forEach((row, i) => {
      const cells = within(row).getAllByRole("cell");
      expect(cells.length).toBe(3);
```

with

```tsx
  it("renders one row per subsystem and four platform columns with text labels", () => {
    render(<ParityMatrix />);
    const table = screen.getByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Subsystem", "TypeScript", "Dart", "Unity C#", "Godot C#"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBe(6);
    rows.forEach((row, i) => {
      const cells = within(row).getAllByRole("cell");
      expect(cells.length).toBe(4);
```

In `apps/docs/tests/multiplatform-docs.test.tsx`:

Replace

```tsx
    // Switch to C# Unity
    const csharpBtn = await screen.findByText("🎮 C# Unity (.NET)");
    fireEvent.click(csharpBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
  });
```

with

```tsx
    // Switch to C# Unity
    const csharpBtn = await screen.findByText("🎮 C# Unity (.NET)");
    fireEvent.click(csharpBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();

    // Switch to C# Godot
    const godotBtn = await screen.findByText("🤖 C# Godot (.NET)");
    fireEvent.click(godotBtn);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Godot)")).toBeDefined();
  });
```

Replace

```tsx
  it("offers the three platforms as Joymify tabs and highlights the TypeScript snippet", async () => {
    const { container } = render(<MultiPlatformDocs />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "🟦 TypeScript (React / Node)",
      "🎯 Dart 3+ (Flutter)",
      "🎮 C# Unity (.NET)",
    ]);
```

with

```tsx
  it("offers the four platforms as Joymify tabs and highlights the TypeScript snippet", async () => {
    const { container } = render(<MultiPlatformDocs />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "🟦 TypeScript (React / Node)",
      "🎯 Dart 3+ (Flutter)",
      "🎮 C# Unity (.NET)",
      "🤖 C# Godot (.NET)",
    ]);
```

Replace

```tsx
  it("renders three Joymify code blocks in the side-by-side view", async () => {
    const { container } = render(<MultiPlatformDocs />);
    fireEvent.click(screen.getByText("Side by side"));
    await waitFor(() => expect(container.querySelectorAll(".mp-side .joy-code-block").length).toBe(3));
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows all three platforms at once in the side-by-side view", () => {
    render(<MultiPlatformDocs />);

    fireEvent.click(screen.getByText("Side by side"));
    expect(screen.getByText("QueryEngine & SWR Lifecycle (TypeScript)")).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (Dart / Flutter)")).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
    expect(screen.getAllByRole("region", { name: /code, scrollable$/ }).length).toBe(3);
  });
```

with

```tsx
  it("renders four Joymify code blocks in the side-by-side view", async () => {
    const { container } = render(<MultiPlatformDocs />);
    fireEvent.click(screen.getByText("Side by side"));
    await waitFor(() => expect(container.querySelectorAll(".mp-side .joy-code-block").length).toBe(4));
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows all four platforms at once in the side-by-side view", () => {
    render(<MultiPlatformDocs />);

    fireEvent.click(screen.getByText("Side by side"));
    expect(screen.getByText("QueryEngine & SWR Lifecycle (TypeScript)")).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (Dart / Flutter)")).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Godot)")).toBeDefined();
    expect(screen.getAllByRole("region", { name: /code, scrollable$/ }).length).toBe(4);
  });
```

- [ ] **Step 2: Run the docs tests and watch them fail**

```bash
pnpm --filter @ucsa/docs test 2>&1 | grep -E '✓|×|FAIL|Test Files|Tests ' | tail -n 15
```

Expected: FAIL in `tests/parity.test.tsx` and `tests/multiplatform-docs.test.tsx`, including `lists godot as the fourth platform` (expected `[ 'ts', 'dart', 'csharp' ]` to equal the four-item list).

- [ ] **Step 3: Add the platform to the types and the platform list**

In `apps/docs/src/content/guides/types.ts`:

Replace `export type PlatformId = "ts" | "dart" | "csharp";` with `export type PlatformId = "ts" | "dart" | "csharp" | "godot";`.

Replace

```ts
  dart: Snippet;
  csharp: Snippet;
}
```

with

```ts
  dart: Snippet;
  csharp: Snippet;
  godot: Snippet;
}
```

After the line `export const UNITY = "packages/com.ucsa.unity/Runtime";` add:

```ts
export const GODOT = "packages/ucsa_godot/addons/ucsa";
```

In `apps/docs/src/content/guides/index.ts` replace `export const platforms: PlatformId[] = ["ts", "dart", "csharp"];` with `export const platforms: PlatformId[] = ["ts", "dart", "csharp", "godot"];`.

- [ ] **Step 4: Add a Godot snippet to each of the six guide files**

In every file below, add the `godot` property directly after the closing `},` of the `csharp` property and before the final `};`. Each snippet's first comment line contains `Checked against:` because a test requires it.

`apps/docs/src/content/guides/swr.ts`: change the import to `import { CORE, DART, CS, GODOT, type Guide } from "./types.js";` and add:

```ts
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
      "UcsaNode revalidates active subscribers on focus-in and on mobile resume (RevalidateOnResume, default true). On desktop an alt-tab back to the game can therefore trigger refetches.",
    ],
  },
```

`apps/docs/src/content/guides/timing.ts` (import unchanged) add:

```ts
  godot: {
    title: "Debounce and Throttle (C# Godot)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Core/QueryEngine.cs`, `${CS}/Core/StateObserver.cs`],
    code: `// Checked against: com.ucsa.core Runtime/Core/QueryEngine.cs (DebounceQueryAsync),
// Runtime/Core/StateObserver.cs (StateObserver constructor, Update, OnValueChanged)
using Godot;
using Ucsa.Core;

// Observer fed by you: call Update with each new full state.
var fps = new StateObserver<Telemetry, int>(t => t.Fps, throttleMs: 100);
fps.OnValueChanged += value => GD.Print(value.ToString());
fps.Update(latestTelemetry);

// Debounced query: debounceMs is a positional argument.
var results = await engine.DebounceQueryAsync<SearchResponse>(
    new object[] { "search", term },
    ct => SearchAsync(term, ct),
    debounceMs: 300);`,
    notes: [
      "Same classes as the Unity column, from the shared core. StateObserver is not subscribed to the engine by itself; the caller passes data to Update (Update returns true when the selected value changed; with debounceMs the notification fires later).",
      "Telemetry, SearchResponse and SearchAsync are your own types.",
    ],
  },
```

`apps/docs/src/content/guides/outbox.ts` (import unchanged) add:

```ts
  godot: {
    title: "Offline Mutation Outbox (C# Godot)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Storage/SqliteAdapter.cs`, `${CS}/Core/Types.cs`],
    code: `// Checked against: com.ucsa.core Runtime/Storage/SqliteAdapter.cs (SetMutation, ReplayOutboxAsync),
// Runtime/Core/Types.cs (OutboxMutation, ConflictPolicy)
using Godot;
using Ucsa.Core;

// There is no MutationOutbox class in C#: the outbox lives on SqliteAdapter.
sqlite.SetMutation(new OutboxMutation<string>(
    "todo-1", "/api/todos", "POST", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    payload: "{\\"title\\":\\"Buy milk\\"}")
{
    ConflictPolicy = ConflictPolicy.ServerWins
});

// SendToServerAsync is your own method returning (int status, object data).
var result = await sqlite.ReplayOutboxAsync<string>(
    m => SendToServerAsync(m),
    rateLimitMs: 200,
    batchSize: 10);
GD.Print($"{result.Processed} processed, {result.Failed} failed");`,
    notes: [
      "Partial parity, identical to the Unity column because the code is the shared core: retry limit fixed at 3, no rollback or merge callbacks. ConflictPolicy.Merge is not implemented: without a conflictResolver a 409 is handled as server-wins (row deleted, counted successful).",
      "No backoff, no connectivity check, and nothing calls ReplayOutboxAsync for you.",
    ],
  },
```

`apps/docs/src/content/guides/cas.ts` (import unchanged) add:

```ts
  godot: {
    title: "Content-Addressable Storage & LRU Pruning (C# Godot)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Storage/CasStore.cs`],
    code: `// Checked against: com.ucsa.core Runtime/Storage/CasStore.cs (CasStore, PutAsync, GetAsync, PruneAsync)
using System.IO;
using Godot;
using Ucsa.Storage;

var cas = new CasStore(
    Path.Combine(ProjectSettings.GlobalizePath("user://"), "cas"),
    sqlite,
    maxSizeBytes: 50L * 1024 * 1024);
await cas.InitAsync();

CasPutResult put = await cas.PutAsync(System.Text.Encoding.UTF8.GetBytes("payload"));
byte[]? bytes = await cas.GetAsync(put.Hash);
CasPruneResult pruned = await cas.PruneAsync(); // targetRatio defaults to 0.7`,
    notes: [
      "Same class as the Unity column, from the shared core; PutAsync prunes when the total is over maxSizeBytes. A manual PruneAsync evicts whenever the total is above 70% of maxSizeBytes.",
      "No reference counting or pinning. The Godot TextureCache (packages/ucsa_godot/addons/ucsa/TextureCache.cs) stores downloaded images through this store.",
    ],
  },
```

`apps/docs/src/content/guides/wal.ts`: change the import to `import { CORE, DART, CS, UNITY, GODOT, type Guide } from "./types.js";` and add:

```ts
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
      "A window close request checkpoints and then closes the adapter, as the Unity quit handler does. Leaving the tree checkpoints without closing it. Paused and resumed notifications fire only on mobile; on desktop the focus notifications are used.",
    ],
  },
```

`apps/docs/src/content/guides/ucb1.ts` (import unchanged) add:

```ts
  godot: {
    title: "UCB1 Frames and Hub Record (C# Godot)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Ipc/FrameCodec.cs`, `${CS}/Ipc/BusHub.cs`],
    code: `// Checked against: com.ucsa.core Runtime/Ipc/FrameCodec.cs (FrameCodec.EncodeFrame, FrameDecoder.Feed),
// Runtime/Ipc/BusHub.cs (BusHubHelper.ResolveBusEndpoint, GetHubRecord)
using Godot;
using Ucsa.Ipc;

// Encode and decode UCB1 frames (same wire format as TypeScript).
byte[] bytes = FrameCodec.EncodeFrame(FrameType.Hello, "{\\"proto\\":1,\\"token\\":\\"abc\\"}");
var frames = new FrameDecoder().Feed(bytes); // List<Frame>
GD.Print(frames[0].Type.ToString());

// BusHubHelper only resolves the endpoint and reads or writes the ucsa_bus_hub row.
string endpoint = BusHubHelper.ResolveBusEndpoint(dbPath);
HubRecord? record = BusHubHelper.GetHubRecord(sqlite);`,
    notes: [
      "Partial parity, identical to the Unity column because the code is the shared core: BusHub.cs is a static helper (BusHubHelper), not a hub.",
      "Not available: a socket server, bus client, election, HELLO token checks and subscription filtering. The Godot smoke test runs every vector in contracts/ipc/vectors.json through this codec inside the engine.",
    ],
  },
```

- [ ] **Step 5: Add the Godot column to the parity data**

In `apps/docs/src/content/parity.ts` change the import to `import { CORE, DART, CS, UNITY, GODOT, type GuideId, type PlatformId } from "./guides/types.js";`. Then, in each of the six rows, add a `godot` cell directly after the `csharp` cell (after its closing `},` or after the one-line `csharp: { ... },`):

Row `swr`:

```ts
      godot: { level: "full", sources: [`${CS}/Core/QueryEngine.cs`, `${GODOT}/UcsaNode.cs`] },
```

Row `timing`:

```ts
      godot: {
        level: "partial",
        sources: [`${CS}/Core/QueryEngine.cs`, `${CS}/Core/StateObserver.cs`],
        reason: "Same shared core as Unity: StateObserver is not connected to QueryEngine; the caller feeds it via Update.",
      },
```

Row `outbox`:

```ts
      godot: {
        level: "partial",
        sources: [`${CS}/Storage/SqliteAdapter.cs`],
        reason: "Same shared core as Unity: lives on SqliteAdapter.ReplayOutboxAsync; retry limit fixed at 3, no rollback or merge callbacks; ConflictPolicy.Merge is not implemented.",
      },
```

Row `cas`:

```ts
      godot: { level: "full", sources: [`${CS}/Storage/CasStore.cs`, `${GODOT}/TextureCache.cs`] },
```

Row `wal`:

```ts
      godot: {
        level: "partial",
        sources: [`${CS}/Storage/SqliteAdapter.cs`, `${GODOT}/UcsaNode.cs`],
        reason: "WAL is fixed for file databases and UcsaNode checkpoints on focus-out, pause, close request and tree exit, but there is no journalMode option or busy fallback.",
      },
```

Row `ucb1`:

```ts
      godot: {
        level: "partial",
        sources: [`${CS}/Ipc/FrameCodec.cs`, `${CS}/Ipc/BusHub.cs`],
        reason: "Same shared core as Unity: frame codec and endpoint/hub-record helpers only; no socket server, bus client, election, token check or subscription filtering.",
      },
```

- [ ] **Step 6: Update the two components and the side-by-side layout**

In `apps/docs/src/components/MultiPlatformDocs.tsx` replace

```tsx
const PLATFORM_LABEL: Record<PlatformId, string> = {
  ts: "🟦 TypeScript (React / Node)",
  dart: "🎯 Dart 3+ (Flutter)",
  csharp: "🎮 C# Unity (.NET)",
};
```

with

```tsx
const PLATFORM_LABEL: Record<PlatformId, string> = {
  ts: "🟦 TypeScript (React / Node)",
  dart: "🎯 Dart 3+ (Flutter)",
  csharp: "🎮 C# Unity (.NET)",
  godot: "🤖 C# Godot (.NET)",
};
```

and replace the text `Cross-platform guide comparing UCSA on TypeScript Core, Dart / Flutter and C# Unity. Every snippet names the` with `Cross-platform guide comparing UCSA on TypeScript Core, Dart / Flutter, C# Unity and C# Godot. Every snippet names the`.

In `apps/docs/src/components/ParityMatrix.tsx` replace

```tsx
const COLUMN: Record<PlatformId, string> = { ts: "TypeScript", dart: "Dart", csharp: "C#" };
```

with

```tsx
const COLUMN: Record<PlatformId, string> = { ts: "TypeScript", dart: "Dart", csharp: "Unity C#", godot: "Godot C#" };
```

In `apps/docs/src/components/multiplatform.css` replace

```css
@media (min-width: 1100px) { .mp-side { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
```

with

```css
@media (min-width: 1100px) { .mp-side { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
```

(four panels read better as two rows of two than as four narrow columns.)

- [ ] **Step 7: Run the docs typecheck, tests and build**

```bash
(cd apps/docs && pnpm exec tsc -b) && echo "docs typecheck ok"
pnpm --filter @ucsa/docs test 2>&1 | grep -E '×|FAIL|Test Files|Tests ' | tail -n 6
pnpm --filter @ucsa/docs build 2>&1 | tail -n 3
test -f apps/docs/dist/index.html && echo "bundle ok"
```

Expected: `docs typecheck ok`; `Test Files` and `Tests` lines with no failed count and no `×` or `FAIL` line; a Vite `built in` line; `bundle ok`.

If `tests/theme-assets.test.ts` fails on the CSS change, read its assertion and keep the three-column rule only if that test pins it; report it either way.

- [ ] **Step 8: Run the pre-ship check and commit**

```bash
bash scripts/precheck.sh 2>&1 | grep -E '^FAILED|^Gate 1|godot smoke' | tail -n 4
git add apps/docs/tests/parity.test.tsx apps/docs/tests/multiplatform-docs.test.tsx apps/docs/src/content/guides apps/docs/src/content/parity.ts apps/docs/src/components/MultiPlatformDocs.tsx apps/docs/src/components/ParityMatrix.tsx apps/docs/src/components/multiplatform.css
git commit -m "docs(site): add Godot as the fourth platform in the guides and parity matrix

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `godot smoke: ok` and `Gate 1: ok`, no `FAILED:` line.

- [ ] **Step 9: Phase gate and acceptance sweep** (rule 7): verify, independent review, `/simplify`, re-verify.
  1. Verify: Step 7 and Step 8 outputs.
  2. Independent review of the Phase 4 diff (Tasks 8 and 9): dispatch `typescript-reviewer` on `apps/docs/**` and `code-reviewer` on `README.md` (model sonnet is enough for a diff under 200 lines; use opus otherwise), each with the goal verbatim. Ask: does every Godot snippet use only members that exist in `packages/com.ucsa.core/Runtime` and `packages/ucsa_godot/addons/ucsa`; does any README or docs sentence claim something the smoke test does not verify (mobile, web, a Unity editor); is any test weakened rather than extended.
  3. `/simplify` on the diff. Apply only findings inside this phase's files.
  4. Re-verify: repeat Step 7. If the gate changed any file, commit it as a new commit: `git commit -m "docs: phase 4 review fixes"` with the same trailer.
  5. Acceptance sweep against the spec's eight criteria, each with a command and its output in the final report:

```bash
git grep -l "UnityEngine" -- packages/com.ucsa.core; echo "1. core engine-free, grep exit $? (1 expected)"
grep -c '"noEngineReferences": true' packages/com.ucsa.core/Runtime/com.ucsa.core.asmdef
dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj 2>&1 | tail -n 1
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj 2>&1 | tail -n 1
pnpm install --frozen-lockfile 2>&1 | tail -n 1
bash scripts/godot-smoke.sh 2>&1 | tail -n 2
bash scripts/precheck.sh 2>&1 | grep -E 'godot smoke|^Gate 1'
git diff main -- .github/workflows/release.yml pnpm-workspace.yaml | wc -l
grep -c '^## C# / Godot Reference Implementation' README.md
pnpm --filter @ucsa/docs test 2>&1 | grep -E 'Test Files|Tests ' ; pnpm --filter @ucsa/docs build 2>&1 | tail -n 1
```

Expected, in order: grep exit 1; `1`; 127 passed; 10 passed (127 + 10 = 137, the recorded baseline); the install finishes without a lockfile error; `SMOKE PASS 4/4` and `godot smoke: ok`; `godot smoke: ok` and `Gate 1: ok`; `0`; `1`; docs tests and build green. The sixth criterion (a CI run with the Godot step green) is the evidence from Task 7 Step 5, or is reported as open if the owner chose option (b).

After the sweep, stop. Shipping the feature into the release (`psrw ship`), pushing and promoting each need a fresh owner yes.

---

## Before Task 1: how this plan gets executed

1. Audit this plan with `self-grill-audit`; apply its critical and high fixes here and note them under "Audit trail" below.
2. `psrw refine I-049` (mints `F-NNN` and copies this folder to `.claude/refined_backlog/<F-NNN>/`).
3. `psrw claim F-NNN` (creates the feature worktree; every task above runs there, never in the main checkout).
4. Execute with `subagent-driven-development`, one fresh subagent per task, each given the goal verbatim and returning 15 lines or fewer. Task 1 Steps 2 to 5, 9 and 10 are purely mechanical and may go to `dispatch-worker --agent agy` with `--verify-cmd 'dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj && dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj'`; never codex, never model fable.

## Self-Review (run while writing, 2026-10-13)

**1. Spec coverage.**

| Spec section or requirement | Task |
|---|---|
| `packages/com.ucsa.core`: four folders, `package.json`, asmdef with `noEngineReferences`, `Ucsa.Core.csproj`, test project, namespaces, two renames, no aliases | Task 1 Steps 2 to 6 |
| `packages/com.ucsa.unity` shrinks: asmdef reference, no `package.json` dependency, `Linker.xml`, three test files, core project reference | Task 1 Step 5 |
| `scripts/precheck.sh` runs both .NET projects; `integration.sh` repointed; `e2e-full-chain.sh` two invocations with zero-match guard | Task 1 Step 7 |
| `pnpm-lock.yaml` importer entry, frozen install verified | Task 1 Step 8 |
| Docs source paths and README references to moved paths, in phase 1 | Task 1 Steps 9 and 10 |
| Phase 1 gate: combined count equals the recorded baseline | Task 1 Steps 1, 6, 13 |
| Unverified Godot 4.7.2 .NET facts confirmed first, each with a fallback | Task 2 |
| `packages/ucsa_godot`: `project.godot`, `UcsaGodot.csproj`, no `package.json` | Task 3 |
| `UcsaNode`: singleton, two events, pause and quit handlers, focus-out and `_ExitTree` checkpoints, best-effort errors, second-instance warning | Task 4 |
| `TextureCache` producing `ImageTexture` | Task 5 |
| Smoke scene with four assertions, try/catch, `Quit(code)`, runner builds first, timeout, marker line and exit code | Tasks 3 and 5 |
| Package `README.md` | Task 5 Step 4 |
| `precheck.sh` Godot phase with visible skip line | Task 6 |
| `.gitignore` `.godot/` | Task 6 Step 4 |
| `ci.yml` pinned Godot .NET step, `GODOT_MONO_BIN`, SDK step only if needed | Task 7 |
| `release.yml` and `pnpm-workspace.yaml` untouched | Checked in Task 1 Step 13, Task 7 Step 3, Task 9 Step 9 |
| Local machine: Godot .NET build beside the standard build | Task 2 Step 1 |
| README Godot section, Unity two-package note, corrected test commands | Task 8 |
| Docs site: `types.ts`, `guides/index.ts`, six guides, `parity.ts`, docs tests | Task 9 |
| Acceptance criteria, all eight | Task 9 Step 9 item 5; criterion six in Task 7 Step 5 |
| Error handling: checkpoint failures logged, never thrown | Task 4 (`GD.PushError` in the three handlers) |

Gaps found and closed while reviewing: the docs components and CSS that the spec did not list (added to Task 9); the second source-root constant `UNITY` (added to Task 1 Step 9); the test method name the word-boundary pattern missed (pattern changed in Task 1 Step 3). Not covered by any automated check, and said so in the README text: the two-package layout inside a real Unity editor (the spec accepts this risk), and a close request delivered by a real window manager (the smoke test sends the close-request notification to the node directly, inside assertion group 2).

**2. Placeholder scan.** No "TBD", "TODO" or "similar to Task N". The only angle-bracket fields are `<F-NNN>` (minted by `psrw refine`) and the result cells of the Task 2 results table, which exist to be filled with observed output.

**3. Type consistency.** `UcsaNode` members used by `Smoke.cs` (`Instance`, `ResetInstance`, `SqliteAdapter`, `OnCheckpointFlushed`, `OnApplicationStateChanged`) match Task 4. `TextureCache` members used by `Smoke.cs` (`TextureCacheOptions.DownloadHandler`, `TextureDecoder`, `GetTextureAsync`, `ContainsInMemory`) match Task 5. Script names and environment variables are the same everywhere: `scripts/godot-smoke.sh`, `--locate`, `GODOT_MONO_BIN`, `GODOT_SMOKE_TIMEOUT_SECS`, `UCSA_REQUIRE_GODOT_SMOKE`. Docs constants `CS`, `UNITY`, `GODOT` and the label `🤖 C# Godot (.NET)` are the same in the tests and the sources. The three C# files and the probe were compiled together against `Godot.NET.Sdk/4.7.2`, so their mutual references are known to resolve.

**4. README and documentation sync.** `README.md` is updated in Task 1 Step 10 (moved paths, renamed classes, split test commands) and Task 8 (Godot section, two-package note, smoke command). `packages/ucsa_godot/README.md` is created in Task 5. The docs site is updated in Task 1 Step 9 and Task 9. The `ci.yml` header comment is updated in Task 7.

## Audit trail

- 2026-10-13: plan written from the approved spec. Not yet audited. `self-grill-audit` findings and the fixes applied go here.

## Appendix: audit trail

- 2026-10-13 self-grill-audit: verdict safe-with-fixes (no critical, two high). The auditor reproduced Phase 1 on a scratch clone (29 files moved, 127 core plus 10 Unity tests, 137 total) and the Godot C# build. Corrected:
  - Godot .NET is installed from the checksum-verified official zip only; the Homebrew cask is ruled out because it pulls in .NET SDK 10.
  - A close request only checkpoints and leaves the adapter open, as the approved spec says; `HandleQuit()` stays public for explicit use. The shared logic is `CheckpointKeepOpen`.
  - Assertion group 2 now sends the close-request notification and checks the adapter stays open.
  - README grep expectation corrected to two lines.
  - `UCSA_REQUIRE_GODOT_SMOKE` moved to the `env:` of the CI gate step.
  - Open for the owner: Task 7's choice of when the first real CI run happens (it needs a push). Not applied: the low-severity notes (the frozen-install step is harmless but not strictly required; feature folders are named `F-NNN-<slug>`).
  - Never run in an engine until Task 2 and Task 5: everything Godot-specific. Not covered even then: a close request from a real window manager, mobile pause delivery, and `TextureCache` JPEG decoding and its default downloader.
