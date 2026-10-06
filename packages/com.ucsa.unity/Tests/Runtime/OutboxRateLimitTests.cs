using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Unity.Core;
using Ucsa.Unity.Storage;

namespace Ucsa.Unity.Tests.Runtime
{
    [TestFixture]
    public class OutboxRateLimitTests
    {
        private UnitySqliteAdapter _adapter = null!;

        [SetUp]
        public void SetUp()
        {
            _adapter = new UnitySqliteAdapter(":memory:");
            _adapter.InitSchema();
        }

        [TearDown]
        public void TearDown()
        {
            _adapter.Close();
        }

        [Test]
        public async Task RespectsRateLimitMs_DelayBetweenSequentialExecutions()
        {
            var order = new List<string>();
            var timestamps = new List<long>();

            for (int i = 1; i <= 4; i++)
            {
                _adapter.SetMutation(new OutboxMutation<Dictionary<string, int>>(
                    $"unity-mut-{i}",
                    $"/api/v1/resource/{i}",
                    "POST",
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + i,
                    payload: new Dictionary<string, int> { ["index"] = i }
                ));
            }

            var sw = Stopwatch.StartNew();
            var result = await _adapter.ReplayOutboxAsync<Dictionary<string, int>>(
                async m =>
                {
                    order.Add(m.MutationId);
                    timestamps.Add(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    await Task.CompletedTask;
                    return (200, null);
                },
                rateLimitMs: 25
            );
            sw.Stop();

            Assert.That(result.Processed, Is.EqualTo(4));
            Assert.That(result.Successful, Is.EqualTo(4));
            Assert.That(result.Failed, Is.EqualTo(0));
            Assert.That(order, Is.EqualTo(new[] { "unity-mut-1", "unity-mut-2", "unity-mut-3", "unity-mut-4" }));
            Assert.That(sw.ElapsedMilliseconds, Is.GreaterThanOrEqualTo(70));

            for (int i = 1; i < timestamps.Count; i++)
            {
                long delta = timestamps[i] - timestamps[i - 1];
                Assert.That(delta, Is.GreaterThanOrEqualTo(20));
            }
        }

        [Test]
        public async Task LimitsProcessedMutations_WhenBatchSizeIsSpecified()
        {
            for (int i = 1; i <= 5; i++)
            {
                _adapter.SetMutation(new OutboxMutation<Dictionary<string, int>>(
                    $"unity-batch-{i}",
                    $"/api/v1/batch/{i}",
                    "POST",
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + i,
                    payload: new Dictionary<string, int> { ["val"] = i }
                ));
            }

            Assert.That(_adapter.GetPendingMutations<Dictionary<string, int>>().Count, Is.EqualTo(5));

            // Batch 1: size 2
            var b1 = await _adapter.ReplayOutboxAsync<Dictionary<string, int>>(
                async m => { await Task.CompletedTask; return (200, null); },
                batchSize: 2
            );
            Assert.That(b1.Processed, Is.EqualTo(2));
            Assert.That(b1.Successful, Is.EqualTo(2));
            Assert.That(_adapter.GetPendingMutations<Dictionary<string, int>>().Count, Is.EqualTo(3));

            // Batch 2: size 2
            var b2 = await _adapter.ReplayOutboxAsync<Dictionary<string, int>>(
                async m => { await Task.CompletedTask; return (200, null); },
                batchSize: 2
            );
            Assert.That(b2.Processed, Is.EqualTo(2));
            Assert.That(b2.Successful, Is.EqualTo(2));
            Assert.That(_adapter.GetPendingMutations<Dictionary<string, int>>().Count, Is.EqualTo(1));

            // Batch 3: size 2 (1 remaining)
            var b3 = await _adapter.ReplayOutboxAsync<Dictionary<string, int>>(
                async m => { await Task.CompletedTask; return (200, null); },
                batchSize: 2
            );
            Assert.That(b3.Processed, Is.EqualTo(1));
            Assert.That(b3.Successful, Is.EqualTo(1));
            Assert.That(_adapter.GetPendingMutations<Dictionary<string, int>>().Count, Is.EqualTo(0));
        }
    }
}
