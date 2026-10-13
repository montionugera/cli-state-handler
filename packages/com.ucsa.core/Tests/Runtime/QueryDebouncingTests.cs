using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Core;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class QueryDebouncingTests
    {
        private QueryEngine _engine = null!;

        [SetUp]
        public void SetUp()
        {
            _engine = new QueryEngine();
        }

        [TearDown]
        public void TearDown()
        {
            _engine.Clear();
        }

        [Test]
        public async Task CollapsesRapidCalls_IntoSingleExecution()
        {
            var queryKey = new object[] { "search", "debounced_user" };
            int fetchCount = 0;

            Func<CancellationToken, Task<string>> queryFn = async ct =>
            {
                Interlocked.Increment(ref fetchCount);
                await Task.Delay(10, ct);
                return "payload-v1";
            };

            // Fire 5 rapid debounced calls with 50ms debounce window
            var tasks = new List<Task<string>>();
            for (int i = 0; i < 5; i++)
            {
                tasks.Add(_engine.FetchQueryAsync(queryKey, queryFn, new QueryOptions { DebounceMs = 50 }));
                await Task.Delay(5);
            }

            var results = await Task.WhenAll(tasks);

            // Assertions
            Assert.That(fetchCount, Is.EqualTo(1), "Expected exactly 1 network execution for 5 collapsed debounced calls");
            foreach (var res in results)
            {
                Assert.That(res, Is.EqualTo("payload-v1"));
            }
        }

        [Test]
        public void CancelQuery_CancelsPendingDebounceTimer()
        {
            var queryKey = new object[] { "search", "to_be_cancelled" };
            int fetchCount = 0;

            Func<CancellationToken, Task<string>> queryFn = async ct =>
            {
                Interlocked.Increment(ref fetchCount);
                await Task.Delay(10, ct);
                return "should_not_run";
            };

            var task = _engine.FetchQueryAsync(queryKey, queryFn, new QueryOptions { DebounceMs = 150 });

            // Immediately cancel the query while timer is ticking
            _engine.CancelQuery(queryKey);

            Assert.ThrowsAsync<TaskCanceledException>(async () => await task);
            Assert.That(fetchCount, Is.EqualTo(0), "queryFn should not have executed after cancellation during debounce");
        }

        [Test]
        public async Task DebounceQueryAsync_ConvenienceHelper_CollapsesCalls()
        {
            var queryKey = new object[] { "helper", "test" };
            int fetchCount = 0;

            Func<CancellationToken, Task<int>> queryFn = async ct =>
            {
                Interlocked.Increment(ref fetchCount);
                await Task.Delay(5, ct);
                return 42;
            };

            var t1 = _engine.DebounceQueryAsync(queryKey, queryFn, 40);
            var t2 = _engine.DebounceQueryAsync(queryKey, queryFn, 40);
            var t3 = _engine.DebounceQueryAsync(queryKey, queryFn, 40);

            var results = await Task.WhenAll(t1, t2, t3);

            Assert.That(fetchCount, Is.EqualTo(1));
            Assert.That(results[0], Is.EqualTo(42));
            Assert.That(results[1], Is.EqualTo(42));
            Assert.That(results[2], Is.EqualTo(42));
        }
    }
}
