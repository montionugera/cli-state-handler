using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;
using Ucsa.Streaming;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class StreamQueryTests
    {
        private SqliteAdapter _adapter = null!;
        private QueryEngine _engine = null!;

        [SetUp]
        public void SetUp()
        {
            _adapter = new SqliteAdapter(":memory:");
            _engine = new QueryEngine(new QueryEngineOptions(_adapter, defaultStaleTime: 60000, defaultGcTime: 300000));
        }

        [TearDown]
        public void TearDown()
        {
            _engine.Clear();
            _adapter.Close();
        }

        #region Utf8StreamDecoder Tests

        [Test]
        public void Utf8StreamDecoder_DecodesAsciiWithoutBuffering()
        {
            var decoder = new Utf8StreamDecoder();
            Assert.That(decoder.Decode(Encoding.UTF8.GetBytes("hello ")), Is.EqualTo("hello "));
            Assert.That(decoder.Decode(Encoding.UTF8.GetBytes("world")), Is.EqualTo("world"));
            Assert.That(decoder.Flush(), Is.EqualTo(string.Empty));
        }

        [Test]
        public void Utf8StreamDecoder_Splits4ByteEmojiAcrossChunksWithoutReplacementChar()
        {
            var decoder = new Utf8StreamDecoder();
            byte[] rocketBytes = new byte[] { 0xf0, 0x9f, 0x9a, 0x80 }; // 🚀

            // Split into 4 chunks (1 byte each)
            var c1 = decoder.Decode(new byte[] { rocketBytes[0] });
            Assert.That(c1, Is.EqualTo(string.Empty));
            Assert.That(c1.Contains("\uFFFD"), Is.False);

            var c2 = decoder.Decode(new byte[] { rocketBytes[1] });
            Assert.That(c2, Is.EqualTo(string.Empty));
            Assert.That(c2.Contains("\uFFFD"), Is.False);

            var c3 = decoder.Decode(new byte[] { rocketBytes[2] });
            Assert.That(c3, Is.EqualTo(string.Empty));
            Assert.That(c3.Contains("\uFFFD"), Is.False);

            var c4 = decoder.Decode(new byte[] { rocketBytes[3] });
            Assert.That(c4, Is.EqualTo("🚀"));
            Assert.That(c4.Contains("\uFFFD"), Is.False);
            Assert.That(decoder.Flush(), Is.EqualTo(string.Empty));

            // Split into 2 chunks (2 bytes each)
            var c21 = decoder.Decode(new byte[] { rocketBytes[0], rocketBytes[1] });
            Assert.That(c21, Is.EqualTo(string.Empty));

            var c22 = decoder.Decode(new byte[] { rocketBytes[2], rocketBytes[3] });
            Assert.That(c22, Is.EqualTo("🚀"));
            Assert.That(decoder.Flush(), Is.EqualTo(string.Empty));
        }

        [Test]
        public void Utf8StreamDecoder_Splits3ByteMultilingualCharacters()
        {
            var decoder = new Utf8StreamDecoder();
            // 你: [0xE4, 0xBD, 0xA0], 好: [0xE5, 0xA5, 0xBD]
            byte[] niHaoBytes = new byte[] { 0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd };

            var c1 = decoder.Decode(new byte[] { niHaoBytes[0] });
            Assert.That(c1, Is.EqualTo(string.Empty));

            byte[] rest = new byte[5];
            Buffer.BlockCopy(niHaoBytes, 1, rest, 0, 5);
            var c2 = decoder.Decode(rest);
            Assert.That(c2, Is.EqualTo("你好"));
            Assert.That(decoder.Flush(), Is.EqualTo(string.Empty));
        }

        [Test]
        public void Utf8StreamDecoder_FlushesTrailingIncompleteBytes()
        {
            var decoder = new Utf8StreamDecoder();
            decoder.Decode(Encoding.UTF8.GetBytes("hello "));
            decoder.Decode(new byte[] { 0xe4, 0xbd }); // incomplete 3-byte sequence
            var flushed = decoder.Flush();
            Assert.That(flushed.Length, Is.GreaterThan(0));
            Assert.That(decoder.Flush(), Is.EqualTo(string.Empty));
        }

        #endregion

        #region QueryEngine.StreamQueryAsync Tests

        [Test]
        public async Task StreamQueryAsync_StreamsIncrementalTokensAndCompactsIntoCache()
        {
            var tokens = new[] { "The ", "quick ", "brown ", "fox ", "jumps." };
            var queryKey = new object[] { "llm", "completion", "1" };
            string queryHash = QueryKeyHasher.Hash(queryKey);

            async IAsyncEnumerable<byte[]> Producer(StreamFnContext ctx)
            {
                foreach (var token in tokens)
                {
                    if (ctx.CancellationToken.IsCancellationRequested) yield break;
                    await Task.Delay(10);
                    yield return Encoding.UTF8.GetBytes(token);
                }
            }

            var handle = _engine.StreamQueryAsync<string>(queryKey, Producer);

            var receivedSlices = new List<StreamSlice<string>>();
            await foreach (var slice in handle.ReadAllAsync())
            {
                receivedSlices.Add(slice);
            }

            var deltas = new List<string>();
            foreach (var s in receivedSlices)
            {
                if (!string.IsNullOrEmpty(s.Delta))
                {
                    deltas.Add(s.Delta);
                }
            }
            Assert.That(deltas, Is.EqualTo(tokens));

            string finalResult = await handle.Done;
            Assert.That(finalResult, Is.EqualTo("The quick brown fox jumps."));

            var lastSlice = receivedSlices[^1];
            Assert.That(lastSlice.Done, Is.True);
            Assert.That(lastSlice.Cumulative, Is.EqualTo("The quick brown fox jumps."));

            // Stream record and chunks purged after compaction
            Assert.That(_adapter.GetStream(queryHash), Is.Null);
            Assert.That(_adapter.GetStreamChunks(queryHash), Is.Empty);

            // Query cache contains compacted entry
            var cached = _adapter.GetQuery<string>(queryHash);
            Assert.That(cached, Is.Not.Null);
            Assert.That(cached!.DataPayload, Is.EqualTo("The quick brown fox jumps."));

            // Engine in-memory state is success
            var state = _engine.GetQueryState<string>(queryKey);
            Assert.That(state?.Status, Is.EqualTo(QueryStatus.Success));
            Assert.That(state?.Data, Is.EqualTo("The quick brown fox jumps."));
        }

        [Test]
        public async Task StreamQueryAsync_SwrCachedReturnImmediatelyCompletes()
        {
            var queryKey = new object[] { "cached", "stream", "swr" };
            int streamCallCount = 0;

            async IAsyncEnumerable<byte[]> StreamFn(StreamFnContext ctx)
            {
                streamCallCount++;
                await Task.Yield();
                yield return Encoding.UTF8.GetBytes("Initial ");
                yield return Encoding.UTF8.GetBytes("Stream");
            }

            // First execution
            var handle1 = _engine.StreamQueryAsync<string>(
                queryKey,
                StreamFn,
                new StreamQueryOptions { StaleTime = 60000 });
            var result1 = await handle1.Done;
            Assert.That(result1, Is.EqualTo("Initial Stream"));
            Assert.That(streamCallCount, Is.EqualTo(1));

            // Second execution: must hit cache immediately
            var handle2 = _engine.StreamQueryAsync<string>(
                queryKey,
                StreamFn,
                new StreamQueryOptions { StaleTime = 60000 });
            var slices2 = new List<StreamSlice<string>>();
            await foreach (var s in handle2.ReadAllAsync())
            {
                slices2.Add(s);
            }
            var result2 = await handle2.Done;
            Assert.That(result2, Is.EqualTo("Initial Stream"));
            Assert.That(streamCallCount, Is.EqualTo(1)); // Not invoked again!
            Assert.That(slices2.Count, Is.EqualTo(1));
            Assert.That(slices2[0].Done, Is.True);
            Assert.That(slices2[0].Cumulative, Is.EqualTo("Initial Stream"));

            // Subsequent FetchQueryAsync also hits cache
            bool fetchFnCalled = false;
            var fetchData = await _engine.FetchQueryAsync(queryKey, ct =>
            {
                fetchFnCalled = true;
                return Task.FromResult("new data");
            });
            Assert.That(fetchData, Is.EqualTo("Initial Stream"));
            Assert.That(fetchFnCalled, Is.False);
        }

        [Test]
        public async Task StreamQueryAsync_CancellationAbortsStreamAndStopsProducer()
        {
            var queryKey = new object[] { "stream", "cancellation" };
            string queryHash = QueryKeyHasher.Hash(queryKey);
            bool producerCleanedUp = false;

            async IAsyncEnumerable<byte[]> InfiniteStream(StreamFnContext ctx)
            {
                try
                {
                    int i = 0;
                    while (!ctx.CancellationToken.IsCancellationRequested)
                    {
                        yield return Encoding.UTF8.GetBytes($"token-{i++} ");
                        await Task.Delay(15);
                    }
                }
                finally
                {
                    producerCleanedUp = true;
                }
            }

            var handle = _engine.StreamQueryAsync<string>(queryKey, InfiniteStream);

            var received = new List<string>();
            var cts = new CancellationTokenSource();

            var readTask = Task.Run(async () =>
            {
                await foreach (var slice in handle.ReadAllAsync())
                {
                    if (!string.IsNullOrEmpty(slice.Delta))
                    {
                        received.Add(slice.Delta);
                        if (received.Count >= 2)
                        {
                            handle.Cancel("User canceled stream");
                            break;
                        }
                    }
                }
            });

            await readTask;

            Assert.That(handle.IsCancelled, Is.True);
            Assert.That(received.Count, Is.GreaterThanOrEqualTo(2));

            Assert.ThrowsAsync<OperationCanceledException>(async () =>
            {
                await handle.Done;
            });

            await Task.Delay(50);
            Assert.That(producerCleanedUp, Is.True);

            var streamRecord = _adapter.GetStream(queryHash);
            if (streamRecord != null)
            {
                Assert.That(streamRecord.Status, Is.EqualTo(StreamStatus.Aborted));
            }
        }

        #endregion
    }
}
