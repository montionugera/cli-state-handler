using System;
using System.Collections.Generic;
using NUnit.Framework;
using Ucsa.Core;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class LifecycleFsmTests
    {
        [Test]
        public void InitialState_IsIdle()
        {
            var fsm = new LifecycleFsm<string, string>();

            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Idle));
            Assert.That(fsm.IsIdle, Is.True);
            Assert.That(fsm.RetryCount, Is.EqualTo(0));
            Assert.That(fsm.Data, Is.Null);
            Assert.That(fsm.Error, Is.Null);
        }

        [Test]
        public void InitialState_WithInitialData_IsSuccess()
        {
            var fsm = new LifecycleFsm<string, string>("preloaded");

            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Success));
            Assert.That(fsm.IsSuccess, Is.True);
            Assert.That(fsm.Data, Is.EqualTo("preloaded"));
            Assert.That(fsm.RetryCount, Is.EqualTo(0));
        }

        [Test]
        public void StartLoading_TransitionsToLoading_AndFiresEvent()
        {
            var fsm = new LifecycleFsm<string, string>();
            QueryStatus? receivedState = null;
            fsm.OnStateChanged += state => receivedState = state;

            fsm.StartLoading();

            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Loading));
            Assert.That(fsm.IsLoading, Is.True);
            Assert.That(receivedState, Is.EqualTo(QueryStatus.Loading));
        }

        [Test]
        public void Transitions_IdleToLoadingToRetryingToSuccess()
        {
            var fsm = new LifecycleFsm<string, string>(maxRetries: 3);
            var statesObserved = new List<QueryStatus>();
            fsm.OnStateChanged += state => statesObserved.Add(state);

            fsm.StartLoading();
            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Loading));

            fsm.RecordError("network error");
            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Retrying));
            Assert.That(fsm.IsRetrying, Is.True);
            Assert.That(fsm.RetryCount, Is.EqualTo(1));
            Assert.That(fsm.Error, Is.EqualTo("network error"));

            fsm.RecordSuccess("data payload");
            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Success));
            Assert.That(fsm.IsSuccess, Is.True);
            Assert.That(fsm.Data, Is.EqualTo("data payload"));
            Assert.That(fsm.Error, Is.Null);
            Assert.That(fsm.RetryCount, Is.EqualTo(0));

            Assert.That(statesObserved, Is.EqualTo(new[]
            {
                QueryStatus.Loading,
                QueryStatus.Retrying,
                QueryStatus.Success
            }));
        }

        [Test]
        public void RecordError_ExhaustingRetries_TransitionsToError()
        {
            var fsm = new LifecycleFsm<string, string>(maxRetries: 2);
            var states = new List<QueryStatus>();
            fsm.OnStateChanged += state => states.Add(state);

            fsm.StartLoading();
            fsm.RecordError("err 1");
            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Retrying));
            Assert.That(fsm.RetryCount, Is.EqualTo(1));

            fsm.RecordError("err 2");
            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Retrying));
            Assert.That(fsm.RetryCount, Is.EqualTo(2));

            fsm.RecordError("err 3");
            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Error));
            Assert.That(fsm.IsError, Is.True);
            Assert.That(fsm.RetryCount, Is.EqualTo(2));
            Assert.That(fsm.Error, Is.EqualTo("err 3"));
        }

        [Test]
        public void Reset_RestoresIdleState()
        {
            var fsm = new LifecycleFsm<string, string>();
            fsm.StartLoading();
            fsm.RecordSuccess("loaded");

            fsm.Reset();

            Assert.That(fsm.State, Is.EqualTo(QueryStatus.Idle));
            Assert.That(fsm.Data, Is.Null);
            Assert.That(fsm.Error, Is.Null);
            Assert.That(fsm.RetryCount, Is.EqualTo(0));
        }

        [Test]
        public void CalculateBackoffDelayMs_ProducesValuesBetweenZeroAndExponentialCeiling()
        {
            var fsm = new LifecycleFsm<string, string>();
            const int baseDelay = 500;
            const int maxDelay = 30000;

            for (int attempt = 0; attempt <= 10; attempt++)
            {
                long expectedCeiling = Math.Min((long)maxDelay, (long)baseDelay * (1L << attempt));
                for (int iter = 0; iter < 100; iter++)
                {
                    int delay = fsm.CalculateBackoffDelayMs(attempt, baseDelay, maxDelay);
                    Assert.That(delay, Is.GreaterThanOrEqualTo(0), $"Delay at attempt {attempt} was negative");
                    Assert.That(delay, Is.LessThanOrEqualTo((int)expectedCeiling), $"Delay at attempt {attempt} exceeded ceiling {expectedCeiling}");
                }
            }
        }

        [Test]
        public void CalculateBackoffDelayMs_HandlesExtremeAttemptsWithoutOverflow()
        {
            var fsm = new LifecycleFsm<string, string>();
            const int baseDelay = 500;
            const int maxDelay = 30000;

            for (int iter = 0; iter < 50; iter++)
            {
                int delay100 = fsm.CalculateBackoffDelayMs(100, baseDelay, maxDelay);
                Assert.That(delay100, Is.InRange(0, maxDelay));

                int delayNegative = fsm.CalculateBackoffDelayMs(-5, baseDelay, maxDelay);
                Assert.That(delayNegative, Is.InRange(0, baseDelay));
            }
        }

        [Test]
        public void QueryKeyHasher_ProducesDeterministicHash()
        {
            string hash1 = QueryKeyHasher.Hash("users", 1);
            string hash2 = QueryKeyHasher.Hash("users", 1);
            Assert.That(hash1, Is.EqualTo(hash2));
            Assert.That(hash1.Length, Is.EqualTo(64));

            var dict1 = new Dictionary<string, object>
            {
                ["b"] = 2,
                ["a"] = 1
            };
            var dict2 = new Dictionary<string, object>
            {
                ["a"] = 1,
                ["b"] = 2
            };

            string hashDict1 = QueryKeyHasher.Hash("items", dict1);
            string hashDict2 = QueryKeyHasher.Hash("items", dict2);
            Assert.That(hashDict1, Is.EqualTo(hashDict2));

            string hashDiff = QueryKeyHasher.Hash("items", 99);
            Assert.That(hashDiff, Is.Not.EqualTo(hash1));
        }

        [Test]
        public void CacheEntry_StaleAndExpirationChecks()
        {
            long now = 10000;
            var entry = new CacheEntry<string>("hash1", new object[] { "test" }, "payload", 9000, 9500, 10500);

            Assert.That(entry.IsStale(now), Is.True);
            Assert.That(entry.IsExpired(now), Is.False);
            Assert.That(entry.IsExpired(11000), Is.True);
        }
    }
}
