using System;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Core;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class StateObserverTimingTests
    {
        private class StockTick
        {
            public string Symbol { get; set; } = "";
            public int Price { get; set; }
        }

        [Test]
        public async Task Throttle_SuppressesRapidUpdates_EmitsLeadingAndTrailing()
        {
            var observer = new StateObserver<StockTick, int>(
                s => s.Price,
                throttleMs: 100
            );

            int callCount = 0;
            int lastPrice = 0;
            observer.OnValueChanged += price =>
            {
                Interlocked.Increment(ref callCount);
                lastPrice = price;
            };

            // 1. Leading edge emits immediately
            observer.Update(new StockTick { Symbol = "AAPL", Price = 150 });
            Assert.That(callCount, Is.EqualTo(1));
            Assert.That(lastPrice, Is.EqualTo(150));

            // 2. Rapid updates in window are throttled
            await Task.Delay(20);
            observer.Update(new StockTick { Symbol = "AAPL", Price = 151 });

            await Task.Delay(20);
            observer.Update(new StockTick { Symbol = "AAPL", Price = 152 });

            await Task.Delay(20);
            observer.Update(new StockTick { Symbol = "AAPL", Price = 153 });

            Assert.That(callCount, Is.EqualTo(1));
            Assert.That(lastPrice, Is.EqualTo(150));

            // 3. Wait for throttle window to expire (100ms total)
            await Task.Delay(60);
            Assert.That(callCount, Is.EqualTo(2));
            Assert.That(lastPrice, Is.EqualTo(153));

            observer.Dispose();
        }

        [Test]
        public async Task Debounce_SuppressesRapidUpdates_EmitsAfterQuiet()
        {
            var observer = new StateObserver<string, string>(
                s => s,
                debounceMs: 60
            );

            int callCount = 0;
            string lastValue = "";
            observer.OnValueChanged += val =>
            {
                Interlocked.Increment(ref callCount);
                lastValue = val;
            };

            // Rapid updates every 15ms
            observer.Update("a");
            await Task.Delay(15);
            Assert.That(callCount, Is.EqualTo(0));

            observer.Update("ap");
            await Task.Delay(15);
            Assert.That(callCount, Is.EqualTo(0));

            observer.Update("app");
            await Task.Delay(15);
            Assert.That(callCount, Is.EqualTo(0));

            observer.Update("apple");
            Assert.That(callCount, Is.EqualTo(0));

            // Wait 30ms (still within 60ms quiet window)
            await Task.Delay(30);
            Assert.That(callCount, Is.EqualTo(0));

            // Wait remaining 45ms (exceeding 60ms)
            await Task.Delay(45);
            Assert.That(callCount, Is.EqualTo(1));
            Assert.That(lastValue, Is.EqualTo("apple"));

            observer.Dispose();
        }
    }
}
