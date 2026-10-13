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
