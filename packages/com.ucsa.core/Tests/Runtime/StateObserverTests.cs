using System;
using System.Collections.Generic;
using NUnit.Framework;
using Ucsa.Core;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class StateObserverTests
    {
        private class PlayerState
        {
            public string Name { get; set; } = string.Empty;
            public int Level { get; set; }
            public int Gold { get; set; }
        }

        [Test]
        public void NotificationSuppression_PreventsUnnecessaryRedraws()
        {
            var observer = new StateObserver<PlayerState, int>(p => p.Gold);
            int notificationsCount = 0;
            int lastObservedGold = -1;

            observer.OnValueChanged += gold =>
            {
                notificationsCount++;
                lastObservedGold = gold;
            };

            // 1. Initial value emits 1 notification
            bool changed1 = observer.Update(new PlayerState { Name = "Hero", Level = 1, Gold = 100 });
            Assert.That(changed1, Is.True);
            Assert.That(notificationsCount, Is.EqualTo(1));
            Assert.That(lastObservedGold, Is.EqualTo(100));
            Assert.That(observer.CurrentValue, Is.EqualTo(100));

            // 2. Updating unselected fields (Name, Level) emits 0 notifications
            bool changed2 = observer.Update(new PlayerState { Name = "Hero (Promoted)", Level = 2, Gold = 100 });
            Assert.That(changed2, Is.False);
            Assert.That(notificationsCount, Is.EqualTo(1));
            Assert.That(lastObservedGold, Is.EqualTo(100));
            Assert.That(observer.CurrentValue, Is.EqualTo(100));

            // 3. Updating selected slice (Gold) emits 1 notification
            bool changed3 = observer.Update(new PlayerState { Name = "Hero (Promoted)", Level = 2, Gold = 250 });
            Assert.That(changed3, Is.True);
            Assert.That(notificationsCount, Is.EqualTo(2));
            Assert.That(lastObservedGold, Is.EqualTo(250));
            Assert.That(observer.CurrentValue, Is.EqualTo(250));
        }

        [Test]
        public void CustomEqualityComparer_Respected()
        {
            var observer = new StateObserver<PlayerState, string>(
                p => p.Name,
                StringComparer.OrdinalIgnoreCase);

            int notifications = 0;
            observer.OnValueChanged += _ => notifications++;

            observer.Update(new PlayerState { Name = "ARCHER" });
            Assert.That(notifications, Is.EqualTo(1));

            // Changing case only should NOT trigger notification with case-insensitive comparer
            bool changed = observer.Update(new PlayerState { Name = "archer" });
            Assert.That(changed, Is.False);
            Assert.That(notifications, Is.EqualTo(1));

            // Changing actual name triggers notification
            bool changed2 = observer.Update(new PlayerState { Name = "Mage" });
            Assert.That(changed2, Is.True);
            Assert.That(notifications, Is.EqualTo(2));
        }

        [Test]
        public void Reset_ClearsState_AndAllowsReinitialization()
        {
            var observer = new StateObserver<PlayerState, int>(p => p.Level);
            var observed = new List<int>();
            observer.OnValueChanged += lvl => observed.Add(lvl);

            observer.Update(new PlayerState { Level = 5 });
            Assert.That(observed.Count, Is.EqualTo(1));
            Assert.That(observer.HasValue, Is.True);

            observer.Reset();
            Assert.That(observer.HasValue, Is.False);
            Assert.That(observer.CurrentValue, Is.EqualTo(0));

            // Re-updating with level 5 should trigger again because observer was reset
            observer.Update(new PlayerState { Level = 5 });
            Assert.That(observed.Count, Is.EqualTo(2));
        }

        [Test]
        public void Dispose_UnregistersListeners()
        {
            var observer = new StateObserver<PlayerState, int>(p => p.Gold);
            int notifications = 0;
            observer.OnValueChanged += _ => notifications++;

            observer.Update(new PlayerState { Gold = 10 });
            Assert.That(notifications, Is.EqualTo(1));

            observer.Dispose();

            // After dispose, listener is removed
            observer.Update(new PlayerState { Gold = 20 });
            Assert.That(notifications, Is.EqualTo(1));
        }
    }
}
