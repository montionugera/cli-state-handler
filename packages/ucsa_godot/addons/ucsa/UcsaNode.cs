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
