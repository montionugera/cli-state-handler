using System;
using System.Threading.Tasks;
using Ucsa.Unity.Core;
using Ucsa.Unity.Storage;
using Ucsa.Unity.Transports;
using UnityEngine;

namespace Ucsa.Unity.Unity
{
    /// <summary>
    /// Unity lifecycle integration behaviour for UCSA.
    /// Manages application background pause/resume transitions and synchronous WAL flush durability.
    /// </summary>
    public class UcsaBehaviour : MonoBehaviour
    {
        private static UcsaBehaviour? _instance;
        public static UcsaBehaviour? Instance => _instance;

        public QueryEngine? QueryEngine { get; set; }
        public UnitySqliteAdapter? SqliteAdapter { get; set; }
        public UnityCasStore? CasStore { get; set; }
        public TextureCache? TextureCache { get; set; }

        public bool RevalidateOnResume { get; set; } = true;
        public bool CheckpointOnPause { get; set; } = true;

        /// <summary>
        /// Event fired when application pause state changes (true = backgrounded, false = foregrounded).
        /// </summary>
        public event Action<bool>? OnApplicationStateChanged;

        /// <summary>
        /// Event fired after a WAL checkpoint finishes on pause or exit.
        /// </summary>
        public event Action? OnCheckpointFlushed;

        public void Awake()
        {
            if (_instance == null)
            {
                _instance = this;
            }
        }

        public void OnDestroy()
        {
            if (_instance == this)
            {
                _instance = null;
            }
        }

        /// <summary>
        /// Invoked by Unity when the application pauses (backgrounded) or resumes (foregrounded).
        /// </summary>
        public void OnApplicationPause(bool pauseStatus)
        {
            HandlePauseState(pauseStatus);
        }

        /// <summary>
        /// Invoked by Unity when the application is closing.
        /// </summary>
        public void OnApplicationQuit()
        {
            HandleQuit();
        }

        /// <summary>
        /// Core pause handler, exposed for unit tests.
        /// </summary>
        public void HandlePauseState(bool pauseStatus)
        {
            OnApplicationStateChanged?.Invoke(pauseStatus);

            if (pauseStatus)
            {
                // App is entering background
                if (CheckpointOnPause && SqliteAdapter != null)
                {
                    try
                    {
                        SqliteAdapter.Checkpoint("TRUNCATE");
                        OnCheckpointFlushed?.Invoke();
                    }
                    catch (Exception ex)
                    {
#if UNITY_5_3_OR_NEWER || UNITY_ENGINE
                        Debug.LogError($"[UCSA] Checkpoint on pause failed: {ex.Message}");
#else
                        Console.Error.WriteLine($"[UCSA] Checkpoint on pause failed: {ex.Message}");
#endif
                    }
                }
            }
            else
            {
                // App is resuming to foreground
                if (RevalidateOnResume && QueryEngine != null)
                {
                    // Fire-and-forget SWR query revalidation for active subscribers
                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            await QueryEngine.InvalidateQueriesAsync().ConfigureAwait(false);
                        }
                        catch (Exception ex)
                        {
#if UNITY_5_3_OR_NEWER || UNITY_ENGINE
                            Debug.LogWarning($"[UCSA] Foreground revalidation warning: {ex.Message}");
#else
                            Console.Error.WriteLine($"[UCSA] Foreground revalidation warning: {ex.Message}");
#endif
                        }
                    });
                }
            }
        }

        /// <summary>
        /// Core quit handler, exposed for unit tests.
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
#if UNITY_5_3_OR_NEWER || UNITY_ENGINE
                    Debug.LogError($"[UCSA] Checkpoint on quit failed: {ex.Message}");
#else
                    Console.Error.WriteLine($"[UCSA] Checkpoint on quit failed: {ex.Message}");
#endif
                }
            }
        }
    }
}
