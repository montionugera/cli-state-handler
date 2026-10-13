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
