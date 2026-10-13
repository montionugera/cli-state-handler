using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Ucsa.Storage;

namespace Ucsa.Ipc
{
    /// <summary>
    /// Represents an active or historical bus hub record in ucsa_bus_hub (id = 1).
    /// </summary>
    public class HubRecord
    {
        public long Id { get; set; } = 1;
        public long Epoch { get; set; }
        public long Pid { get; set; }
        public string Endpoint { get; set; } = string.Empty;
        public string Token { get; set; } = string.Empty;
        public long ClaimedAt { get; set; }

        public HubRecord() { }

        public HubRecord(long id, long epoch, long pid, string endpoint, string token, long claimedAt)
        {
            Id = id;
            Epoch = epoch;
            Pid = pid;
            Endpoint = endpoint;
            Token = token;
            ClaimedAt = claimedAt;
        }
    }

    /// <summary>
    /// Helper utilities for resolving bus endpoints and querying the elected bus hub.
    /// </summary>
    public static class BusHubHelper
    {
        /// <summary>
        /// Resolves a deterministic IPC endpoint (&lt;100 characters) from the SQLite database path.
        /// Windows: Named pipe "\\.\pipe\ucsa-&lt;shortHash&gt;"
        /// POSIX: Unix domain socket "$XDG_RUNTIME_DIR/ucsa/ucsa-&lt;shortHash&gt;.sock" or "/tmp/ucsa/ucsa-&lt;shortHash&gt;.sock"
        /// </summary>
        public static string ResolveBusEndpoint(string dbPath)
        {
            string fullPath = Path.GetFullPath(dbPath);
            using var sha256 = SHA256.Create();
            byte[] hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(fullPath));
            var sb = new StringBuilder(16);
            for (int i = 0; i < 8; i++)
            {
                sb.Append(hashBytes[i].ToString("x2"));
            }
            string shortHash = sb.ToString();

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                return $@"\\.\pipe\ucsa-{shortHash}";
            }

            string? xdg = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
            string basePath = !string.IsNullOrEmpty(xdg) ? xdg : "/tmp";
            string socketDir = Path.Combine(basePath, "ucsa");
            try
            {
                if (!Directory.Exists(socketDir))
                {
                    Directory.CreateDirectory(socketDir);
                }
            }
            catch
            {
                // Ignore directory creation errors (e.g. read-only filesystem or in-memory tests)
            }

            return Path.Combine(socketDir, $"ucsa-{shortHash}.sock");
        }

        /// <summary>
        /// Reads the current hub record from ucsa_bus_hub table (id = 1).
        /// </summary>
        public static HubRecord? GetHubRecord(SqliteAdapter adapter)
        {
            if (adapter == null || adapter.IsClosed) return null;

            lock (adapter.Connection)
            {
                using var cmd = adapter.Connection.CreateCommand();
                cmd.CommandText = "SELECT id, epoch, pid, endpoint, token, claimed_at FROM ucsa_bus_hub WHERE id = 1;";
                using var reader = cmd.ExecuteReader();
                if (!reader.Read()) return null;

                return new HubRecord(
                    reader.GetInt64(0),
                    reader.GetInt64(1),
                    reader.GetInt64(2),
                    reader.GetString(3),
                    reader.GetString(4),
                    reader.GetInt64(5)
                );
            }
        }

        /// <summary>
        /// Inserts or updates the hub record in the ucsa_bus_hub table.
        /// </summary>
        public static void SaveHubRecord(SqliteAdapter adapter, HubRecord record)
        {
            if (adapter == null || adapter.IsClosed) return;

            lock (adapter.Connection)
            {
                using var cmd = adapter.Connection.CreateCommand();
                cmd.CommandText = @"
                    INSERT OR REPLACE INTO ucsa_bus_hub (id, epoch, pid, endpoint, token, claimed_at)
                    VALUES (1, @epoch, @pid, @endpoint, @token, @claimed_at);";
                cmd.Parameters.AddWithValue("@epoch", record.Epoch);
                cmd.Parameters.AddWithValue("@pid", record.Pid);
                cmd.Parameters.AddWithValue("@endpoint", record.Endpoint);
                cmd.Parameters.AddWithValue("@token", record.Token);
                cmd.Parameters.AddWithValue("@claimed_at", record.ClaimedAt);
                cmd.ExecuteNonQuery();
            }
        }
    }
}
