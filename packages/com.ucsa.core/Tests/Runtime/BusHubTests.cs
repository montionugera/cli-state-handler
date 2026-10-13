using System;
using System.IO;
using System.Runtime.InteropServices;
using NUnit.Framework;
using Ucsa.Ipc;
using Ucsa.Storage;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class BusHubTests
    {
        private string _tempDbPath = string.Empty;
        private SqliteAdapter _adapter = null!;

        [SetUp]
        public void SetUp()
        {
            _tempDbPath = Path.Combine(Path.GetTempPath(), $"ucsa_bushub_test_{Guid.NewGuid():N}.db");
            _adapter = new SqliteAdapter(_tempDbPath, origin: "test-hub-process");
        }

        [TearDown]
        public void TearDown()
        {
            _adapter.Dispose();
            if (File.Exists(_tempDbPath))
            {
                try { File.Delete(_tempDbPath); } catch { }
            }
        }

        [Test]
        public void ResolveBusEndpoint_ProducesValidDeterministicPathUnder100Chars()
        {
            string endpoint = BusHubHelper.ResolveBusEndpoint(_tempDbPath);
            Assert.That(endpoint, Is.Not.Null.And.Not.Empty);
            Assert.That(endpoint.Length, Is.LessThan(100));

            // Deterministic
            string endpoint2 = BusHubHelper.ResolveBusEndpoint(_tempDbPath);
            Assert.That(endpoint, Is.EqualTo(endpoint2));

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                Assert.That(endpoint, Does.StartWith(@"\\.\pipe\ucsa-"));
            }
            else
            {
                Assert.That(endpoint, Does.Contain("/ucsa/ucsa-"));
                Assert.That(endpoint, Does.EndWith(".sock"));
            }
        }

        [Test]
        public void ResolveBusEndpoint_GeneratesDifferentEndpointsForDifferentDbPaths()
        {
            string endpoint1 = BusHubHelper.ResolveBusEndpoint("/path/to/alpha.sqlite");
            string endpoint2 = BusHubHelper.ResolveBusEndpoint("/path/to/beta.sqlite");

            Assert.That(endpoint1, Is.Not.EqualTo(endpoint2));
            Assert.That(endpoint1.Length, Is.LessThan(100));
            Assert.That(endpoint2.Length, Is.LessThan(100));
        }

        [Test]
        public void GetHubRecord_WhenTableIsEmpty_ReturnsNull()
        {
            var record = BusHubHelper.GetHubRecord(_adapter);
            Assert.That(record, Is.Null);
        }

        [Test]
        public void SaveHubRecord_And_GetHubRecord_StoresAndRetrievesRecordCorrectly()
        {
            string endpoint = BusHubHelper.ResolveBusEndpoint(_tempDbPath);
            var initialRecord = new HubRecord
            {
                Id = 1,
                Epoch = 10,
                Pid = Environment.ProcessId,
                Endpoint = endpoint,
                Token = "secret-token-xyz-123",
                ClaimedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };

            BusHubHelper.SaveHubRecord(_adapter, initialRecord);

            var retrieved = BusHubHelper.GetHubRecord(_adapter);
            Assert.That(retrieved, Is.Not.Null);
            Assert.That(retrieved!.Id, Is.EqualTo(1));
            Assert.That(retrieved.Epoch, Is.EqualTo(10));
            Assert.That(retrieved.Pid, Is.EqualTo(Environment.ProcessId));
            Assert.That(retrieved.Endpoint, Is.EqualTo(endpoint));
            Assert.That(retrieved.Token, Is.EqualTo("secret-token-xyz-123"));
            Assert.That(retrieved.ClaimedAt, Is.EqualTo(initialRecord.ClaimedAt));
        }

        [Test]
        public void SaveHubRecord_ReplacesExistingRecordWithIncrementedEpoch()
        {
            string endpoint = BusHubHelper.ResolveBusEndpoint(_tempDbPath);
            var r1 = new HubRecord(1, 1, Environment.ProcessId, endpoint, "tok-1", 1000L);
            BusHubHelper.SaveHubRecord(_adapter, r1);

            var loaded1 = BusHubHelper.GetHubRecord(_adapter);
            Assert.That(loaded1, Is.Not.Null);
            Assert.That(loaded1!.Epoch, Is.EqualTo(1));
            Assert.That(loaded1.Token, Is.EqualTo("tok-1"));

            var r2 = new HubRecord(1, 2, Environment.ProcessId, endpoint, "tok-2", 2000L);
            BusHubHelper.SaveHubRecord(_adapter, r2);

            var loaded2 = BusHubHelper.GetHubRecord(_adapter);
            Assert.That(loaded2, Is.Not.Null);
            Assert.That(loaded2!.Epoch, Is.EqualTo(2));
            Assert.That(loaded2.Token, Is.EqualTo("tok-2"));
            Assert.That(loaded2.ClaimedAt, Is.EqualTo(2000L));
        }
    }
}
