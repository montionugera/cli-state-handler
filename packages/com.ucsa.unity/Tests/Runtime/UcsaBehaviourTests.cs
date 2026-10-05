using System;
using System.IO;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Unity.Core;
using Ucsa.Unity.Storage;
using Ucsa.Unity.Unity;

namespace Ucsa.Unity.Tests.Runtime
{
    [TestFixture]
    public class UcsaBehaviourTests
    {
        private string _testDir = null!;
        private string _dbPath = null!;
        private UnitySqliteAdapter _sqlite = null!;
        private QueryEngine _engine = null!;

        [SetUp]
        public void Setup()
        {
            _testDir = Path.Combine(Path.GetTempPath(), "ucsa_beh_test_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_testDir);
            _dbPath = Path.Combine(_testDir, "test.db");

            _sqlite = new UnitySqliteAdapter(_dbPath);
            _sqlite.InitSchema();

            _engine = new QueryEngine(new QueryEngineOptions(_sqlite));
        }

        [TearDown]
        public void TearDown()
        {
            _sqlite.Dispose();
            if (Directory.Exists(_testDir))
            {
                try { Directory.Delete(_testDir, true); } catch { }
            }
        }

        [Test]
        public void Awake_SetsInstanceSingleton()
        {
            var behaviour = new UcsaBehaviour();
            behaviour.Awake();

            Assert.That(UcsaBehaviour.Instance, Is.SameAs(behaviour));

            behaviour.OnDestroy();
            Assert.That(UcsaBehaviour.Instance, Is.Null);
        }

        [Test]
        public void HandlePauseState_True_EmitsEventAndCheckpointsWal()
        {
            var behaviour = new UcsaBehaviour
            {
                SqliteAdapter = _sqlite,
                QueryEngine = _engine,
                CheckpointOnPause = true
            };
            behaviour.Awake();

            bool eventReceived = false;
            bool pauseStatusValue = false;
            bool checkpointFlushed = false;

            behaviour.OnApplicationStateChanged += status =>
            {
                eventReceived = true;
                pauseStatusValue = status;
            };

            behaviour.OnCheckpointFlushed += () =>
            {
                checkpointFlushed = true;
            };

            // Insert some data so WAL has pending changes
            _sqlite.SetQuery(new CacheEntry<string>("h1", new object[] { "key1" }, "value1", 100, 200, 300));

            behaviour.HandlePauseState(true);

            Assert.That(eventReceived, Is.True);
            Assert.That(pauseStatusValue, Is.True);
            Assert.That(checkpointFlushed, Is.True);
        }

        [Test]
        public async Task HandlePauseState_False_TriggersForegroundRevalidation()
        {
            var behaviour = new UcsaBehaviour
            {
                SqliteAdapter = _sqlite,
                QueryEngine = _engine,
                RevalidateOnResume = true
            };
            behaviour.Awake();

            int fetchCount = 0;
            // Pre-fetch query so it has data
            await _engine.FetchQueryAsync(
                new object[] { "user", "profile" },
                ct => Task.FromResult($"User_{Interlocked.Increment(ref fetchCount)}")
            );

            // Register a watched query
            using var sub = _engine.WatchQuery<string>(
                new object[] { "user", "profile" },
                state => { },
                null,
                ct => Task.FromResult($"User_{Interlocked.Increment(ref fetchCount)}")
            );

            Assert.That(fetchCount, Is.EqualTo(1));

            // Resume triggers invalidation of queries
            behaviour.HandlePauseState(false);

            // Wait a brief moment for background Task to run
            await Task.Delay(100);

            Assert.That(fetchCount, Is.GreaterThanOrEqualTo(2));
        }

        [Test]
        public void HandleQuit_CheckpointsAndClosesDbCleanly()
        {
            var behaviour = new UcsaBehaviour
            {
                SqliteAdapter = _sqlite,
                QueryEngine = _engine
            };
            behaviour.Awake();

            bool checkpointFlushed = false;
            behaviour.OnCheckpointFlushed += () =>
            {
                checkpointFlushed = true;
            };

            behaviour.HandleQuit();

            Assert.That(checkpointFlushed, Is.True);
        }
    }
}
