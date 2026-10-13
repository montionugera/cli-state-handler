using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class OutboxLeaseTests
    {
        private SqliteAdapter _adapter = null!;

        [SetUp]
        public void SetUp()
        {
            _adapter = new SqliteAdapter(":memory:");
            _adapter.InitSchema();
        }

        [TearDown]
        public void TearDown()
        {
            _adapter.Close();
        }

        [Test]
        public void ConcurrentWorkers_ClaimPendingMutations_ClaimNonOverlappingSubsets()
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            for (int i = 1; i <= 6; i++)
            {
                _adapter.SetMutation(new OutboxMutation<object>(
                    $"unity-mut-{i}",
                    $"/api/v1/items/{i}",
                    "POST",
                    now + i,
                    payload: new Dictionary<string, int> { ["val"] = i }
                ));
            }

            // Worker 1 claims 3
            var claimed1 = _adapter.ClaimPendingMutations("worker-1", 10000, 3);
            Assert.That(claimed1.Count, Is.EqualTo(3));
            foreach (var m in claimed1)
            {
                Assert.That(m.LeaseOwner, Is.EqualTo("worker-1"));
                Assert.That(m.LeaseUntil, Is.Not.Null);
                Assert.That(m.Status, Is.EqualTo(OutboxMutationStatus.InFlight));
            }

            // Worker 2 claims 3
            var claimed2 = _adapter.ClaimPendingMutations("worker-2", 10000, 3);
            Assert.That(claimed2.Count, Is.EqualTo(3));
            foreach (var m in claimed2)
            {
                Assert.That(m.LeaseOwner, Is.EqualTo("worker-2"));
                Assert.That(m.LeaseUntil, Is.Not.Null);
                Assert.That(m.Status, Is.EqualTo(OutboxMutationStatus.InFlight));
            }

            // Verify non-overlapping subsets
            var ids1 = claimed1.Select(m => m.MutationId).ToHashSet();
            var ids2 = claimed2.Select(m => m.MutationId).ToHashSet();
            Assert.That(ids1.Intersect(ids2), Is.Empty);
            Assert.That(ids1.Union(ids2).Count, Is.EqualTo(6));

            // Worker 3 attempts to claim while leases are active -> gets none
            var claimed3 = _adapter.ClaimPendingMutations("worker-3", 10000, 3);
            Assert.That(claimed3, Is.Empty);
        }

        [Test]
        public async Task ExpiredLease_CanBeReclaimedByAnotherWorker()
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _adapter.SetMutation(new OutboxMutation<object>(
                "unity-mut-expire",
                "/api/v1/expire",
                "PUT",
                now,
                payload: "expiring-soon"
            ));

            // Worker 1 claims with lease of 500ms
            var claimed1 = _adapter.ClaimPendingMutations("worker-1", 500, 1);
            Assert.That(claimed1.Count, Is.EqualTo(1));
            Assert.That(claimed1[0].MutationId, Is.EqualTo("unity-mut-expire"));
            Assert.That(claimed1[0].LeaseOwner, Is.EqualTo("worker-1"));

            // Worker 2 immediately tries to claim -> returns empty
            var claimedEarly = _adapter.ClaimPendingMutations("worker-2", 5000, 1);
            Assert.That(claimedEarly, Is.Empty);

            // Wait for lease to expire
            await Task.Delay(600);

            // Worker 2 reclaims expired in-flight mutation
            var reclaimed = _adapter.ClaimPendingMutations("worker-2", 5000, 1);
            Assert.That(reclaimed.Count, Is.EqualTo(1));
            Assert.That(reclaimed[0].MutationId, Is.EqualTo("unity-mut-expire"));
            Assert.That(reclaimed[0].LeaseOwner, Is.EqualTo("worker-2"));
            Assert.That(reclaimed[0].Status, Is.EqualTo(OutboxMutationStatus.InFlight));
        }

        [Test]
        public async Task ReplayOutboxAsync_UtilizesDistributedLeases_AndPreventsDuplicates()
        {
            var executed = new List<string>();
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            for (int i = 1; i <= 4; i++)
            {
                _adapter.SetMutation(new OutboxMutation<object>(
                    $"unity-replay-{i}",
                    $"/api/v1/replay/{i}",
                    "POST",
                    now + i
                ));
            }

            var r1 = await _adapter.ReplayOutboxAsync<object>(
                async m =>
                {
                    executed.Add($"worker-1:{m.MutationId}");
                    await Task.CompletedTask;
                    return (200, null);
                },
                workerId: "worker-1",
                leaseDurationMs: 10000,
                batchSize: 2
            );

            var r2 = await _adapter.ReplayOutboxAsync<object>(
                async m =>
                {
                    executed.Add($"worker-2:{m.MutationId}");
                    await Task.CompletedTask;
                    return (200, null);
                },
                workerId: "worker-2",
                leaseDurationMs: 10000,
                batchSize: 2
            );

            Assert.That(r1.Successful, Is.EqualTo(2));
            Assert.That(r2.Successful, Is.EqualTo(2));
            Assert.That(executed, Is.EqualTo(new[]
            {
                "worker-1:unity-replay-1",
                "worker-1:unity-replay-2",
                "worker-2:unity-replay-3",
                "worker-2:unity-replay-4",
            }));

            Assert.That(_adapter.GetPendingMutations<object>(), Is.Empty);
        }
    }
}
