using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;
using Ucsa.Streaming;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class ResumeStrategyTests
    {
        private string _tempDbPath = string.Empty;
        private string _tempDir = string.Empty;
        private SqliteAdapter _adapter = null!;

        [SetUp]
        public void SetUp()
        {
            _tempDir = Path.Combine(Path.GetTempPath(), $"ucsa_unity_resume_tests_{Guid.NewGuid():N}");
            Directory.CreateDirectory(_tempDir);
            _tempDbPath = Path.Combine(_tempDir, "test.db");
            _adapter = new SqliteAdapter(_tempDbPath);
        }

        [TearDown]
        public void TearDown()
        {
            _adapter.Dispose();
            if (Directory.Exists(_tempDir))
            {
                try { Directory.Delete(_tempDir, recursive: true); } catch { }
            }
        }

        #region Resume Strategies Unit Tests

        [Test]
        public void RangeResumeStrategy_FormatsRangeHeaderWithoutEtag()
        {
            var strategy = ResumeStrategies.CreateRange();
            Assert.That(strategy.Kind, Is.EqualTo("range"));

            var ctx = new ResumeContext(
                "q-hash-1",
                new object[] { "llm", "completion" },
                1024,
                5,
                etag: null
            );

            var headers = strategy.BuildHeaders(ctx);
            Assert.That(headers, Has.Count.EqualTo(1));
            Assert.That(headers["Range"], Is.EqualTo("bytes=1024-"));
        }

        [Test]
        public void RangeResumeStrategy_FormatsRangeAndIfRangeWithEtag()
        {
            var strategy = ResumeStrategies.CreateRange();
            var ctx = new ResumeContext(
                "q-hash-1",
                new object[] { "llm", "completion" },
                2048,
                10,
                etag: "\"etag-xyz-123\""
            );

            var headers = strategy.BuildHeaders(ctx);
            Assert.That(headers, Has.Count.EqualTo(2));
            Assert.That(headers["Range"], Is.EqualTo("bytes=2048-"));
            Assert.That(headers["If-Range"], Is.EqualTo("\"etag-xyz-123\""));
        }

        [Test]
        public void LastEventIdResumeStrategy_FormatsLastEventIdWhenPresent()
        {
            var strategy = ResumeStrategies.CreateLastEventId();
            Assert.That(strategy.Kind, Is.EqualTo("last-event-id"));

            var ctx = new ResumeContext(
                "q-hash-2",
                new object[] { "sse", "events" },
                512,
                3,
                lastEventId: "evt_98765"
            );

            var headers = strategy.BuildHeaders(ctx);
            Assert.That(headers, Has.Count.EqualTo(1));
            Assert.That(headers["Last-Event-ID"], Is.EqualTo("evt_98765"));
        }

        [Test]
        public void LastEventIdResumeStrategy_ReturnsEmptyWhenLastEventIdNullOrEmpty()
        {
            var strategy = ResumeStrategies.CreateLastEventId();
            var ctxNull = new ResumeContext("q-hash-2", new object[] { "sse" }, 512, 3, lastEventId: null);
            Assert.That(strategy.BuildHeaders(ctxNull), Is.Empty);

            var ctxEmpty = new ResumeContext("q-hash-2", new object[] { "sse" }, 512, 3, lastEventId: "");
            Assert.That(strategy.BuildHeaders(ctxEmpty), Is.Empty);
        }

        [Test]
        public void ContinuationResumeStrategy_PassesResumeContextToCallback()
        {
            var strategy = ResumeStrategies.CreateContinuation(ctx => new Dictionary<string, object>
            {
                ["prompt"] = $"Continue from: {ctx.AccumulatedText}",
                ["byteOffset"] = ctx.ByteLength,
                ["seq"] = ctx.NextSeq
            });

            Assert.That(strategy.Kind, Is.EqualTo("continuation"));

            var ctx = new ResumeContext(
                "q-hash-3",
                new object[] { "ai", "agent" },
                120,
                4,
                accumulatedText: "Hello world, this is a streaming response."
            );

            var result = strategy.BuildContinuation(ctx) as Dictionary<string, object>;
            Assert.That(result, Is.Not.Null);
            Assert.That(result!["prompt"], Is.EqualTo("Continue from: Hello world, this is a streaming response."));
            Assert.That(result["byteOffset"], Is.EqualTo(120));
            Assert.That(result["seq"], Is.EqualTo(4));
        }

        [Test]
        public void RestartResumeStrategy_ReturnsResetSignal()
        {
            var strategy = ResumeStrategies.CreateRestart();
            Assert.That(strategy.Kind, Is.EqualTo("restart"));

            var ctx = new ResumeContext("q-hash-4", new object[] { "stream" }, 4096, 8);
            var signal = strategy.Reset(ctx);
            Assert.That(signal.Reset, Is.True);
            Assert.That(signal.Seq, Is.EqualTo(0));
            Assert.That(signal.ByteOffset, Is.EqualTo(0));
        }

        #endregion

        #region SQLite ResetStream and UpdateStreamResumeToken

        [Test]
        public void ResetStream_ClearsChunksAndResetsStreamRecord()
        {
            var queryKey = new object[] { "ai", "stream", "session-reset" };
            var stream = _adapter.CreateStream(queryKey);
            string queryHash = stream.QueryHash;

            _adapter.AppendStreamChunk(queryHash, "chunk 1 - ");
            _adapter.AppendStreamChunk(queryHash, "chunk 2 - ");
            _adapter.AppendStreamChunk(queryHash, "chunk 3");

            var chunksBefore = _adapter.GetStreamChunks(queryHash, 0);
            Assert.That(chunksBefore, Has.Count.EqualTo(3));

            var streamBefore = _adapter.GetStream(queryHash);
            Assert.That(streamBefore!.NextSeq, Is.EqualTo(3));
            Assert.That(streamBefore.ByteLength, Is.EqualTo(27));

            _adapter.AbortStream(queryHash, "Connection lost");
            var aborted = _adapter.GetStream(queryHash);
            Assert.That(aborted!.Status, Is.EqualTo(StreamStatus.Aborted));
            Assert.That(aborted.Error, Is.EqualTo("Connection lost"));

            _adapter.ResetStream(queryHash);

            var chunksAfter = _adapter.GetStreamChunks(queryHash, 0);
            Assert.That(chunksAfter, Is.Empty);

            var streamAfter = _adapter.GetStream(queryHash);
            Assert.That(streamAfter, Is.Not.Null);
            Assert.That(streamAfter!.NextSeq, Is.EqualTo(0));
            Assert.That(streamAfter.ByteLength, Is.EqualTo(0));
            Assert.That(streamAfter.Status, Is.EqualTo(StreamStatus.Open));
            Assert.That(streamAfter.Error, Is.Null);
        }

        [Test]
        public void UpdateStreamResumeToken_UpdatesTokenAndResumeKind()
        {
            var queryKey = new object[] { "ai", "stream", "token-test" };
            var stream = _adapter.CreateStream(queryKey);
            string queryHash = stream.QueryHash;

            Assert.That(stream.ResumeToken, Is.Null);
            Assert.That(stream.ResumeKind, Is.Null);

            _adapter.UpdateStreamResumeToken(queryHash, "cursor_123", ResumeKind.Continuation);
            var updated1 = _adapter.GetStream(queryHash);
            Assert.That(updated1!.ResumeToken, Is.EqualTo("cursor_123"));
            Assert.That(updated1.ResumeKind, Is.EqualTo(ResumeKind.Continuation));

            _adapter.UpdateStreamResumeToken(queryHash, "cursor_456");
            var updated2 = _adapter.GetStream(queryHash);
            Assert.That(updated2!.ResumeToken, Is.EqualTo("cursor_456"));
            Assert.That(updated2.ResumeKind, Is.EqualTo(ResumeKind.Continuation));
        }

        #endregion

        #region StreamResumeFsm Tests

        [Test]
        public void StreamResumeFsm_LifecycleTransitions_IdleToStreamingToComplete()
        {
            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = "q-life",
                QueryKey = new object[] { "llm", "stream" },
                Strategy = ResumeStrategies.CreateRange()
            });

            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Idle));
            Assert.That(fsm.RetryCount, Is.EqualTo(0));
            Assert.That(fsm.CommittedByteLength, Is.EqualTo(0));
            Assert.That(fsm.CommittedSeq, Is.EqualTo(0));
            Assert.That(fsm.AccumulatedText, Is.EqualTo(string.Empty));

            fsm.Start();
            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Streaming));

            fsm.Complete();
            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Complete));
        }

        [Test]
        public void StreamResumeFsm_LifecycleTransitions_AbortMarksAbortedInSqlite()
        {
            var queryKey = new object[] { "llm", "stream-abort" };
            var stream = _adapter.CreateStream(queryKey);

            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = stream.QueryHash,
                QueryKey = queryKey,
                Strategy = ResumeStrategies.CreateRange(),
                SqliteAdapter = _adapter
            });

            fsm.Start();
            fsm.Abort("User cancelled");
            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Aborted));

            var row = _adapter.GetStream(stream.QueryHash);
            Assert.That(row!.Status, Is.EqualTo(StreamStatus.Aborted));
            Assert.That(row.Error, Is.EqualTo("User cancelled"));
        }

        [Test]
        public void StreamResumeFsm_SeamlessRangeResume_DeduplicatesOverlappingChunk()
        {
            var queryKey = new object[] { "llm", "range-stream" };
            var stream = _adapter.CreateStream(queryKey);
            string queryHash = stream.QueryHash;

            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = queryHash,
                QueryKey = queryKey,
                Strategy = ResumeStrategies.CreateRange(),
                SqliteAdapter = _adapter
            });
            fsm.Start();

            // 1. Feed 500 bytes ('A')
            byte[] initialBytes = new byte[500];
            Array.Fill(initialBytes, (byte)'A');

            var r1 = fsm.HandleIncomingChunk(initialBytes);
            Assert.That(r1.Accepted, Is.True);
            Assert.That(r1.Duplicate, Is.False);
            Assert.That(r1.Slice.Length, Is.EqualTo(500));
            Assert.That(r1.Seq, Is.EqualTo(0));
            Assert.That(r1.ByteOffset, Is.EqualTo(0));
            Assert.That(fsm.CommittedByteLength, Is.EqualTo(500));
            Assert.That(fsm.CommittedSeq, Is.EqualTo(1));

            // 2. Simulate error
            var err = fsm.HandleError("Connection reset");
            Assert.That(err.CanResume, Is.True);
            Assert.That(err.Restart, Is.False);
            Assert.That(err.Headers!["Range"], Is.EqualTo("bytes=500-"));
            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Resuming));
            Assert.That(fsm.RetryCount, Is.EqualTo(1));

            // 3. Server sends overlapping chunk 450..600 (50 'A's + 100 'B's)
            byte[] overlap = new byte[150];
            Array.Fill(overlap, (byte)'A', 0, 50);
            Array.Fill(overlap, (byte)'B', 50, 100);

            var r2 = fsm.HandleIncomingChunk(overlap, seq: 1, byteOffset: 450);
            Assert.That(r2.Accepted, Is.True);
            Assert.That(r2.Duplicate, Is.False);
            Assert.That(r2.Slice.Length, Is.EqualTo(100));
            Assert.That(Encoding.UTF8.GetString(r2.Slice), Is.EqualTo(new string('B', 100)));
            Assert.That(r2.Seq, Is.EqualTo(1));
            Assert.That(r2.ByteOffset, Is.EqualTo(500));

            Assert.That(fsm.CommittedByteLength, Is.EqualTo(600));
            Assert.That(fsm.CommittedSeq, Is.EqualTo(2));
            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Streaming));
            Assert.That(fsm.RetryCount, Is.EqualTo(0));

            var chunks = _adapter.GetStreamChunks(queryHash, 0);
            Assert.That(chunks, Has.Count.EqualTo(2));
            Assert.That(chunks[0].Seq, Is.EqualTo(0));
            Assert.That(chunks[0].ByteOffset, Is.EqualTo(0));
            Assert.That(chunks[0].Data.Length, Is.EqualTo(500));
            Assert.That(chunks[1].Seq, Is.EqualTo(1));
            Assert.That(chunks[1].ByteOffset, Is.EqualTo(500));
            Assert.That(chunks[1].Data.Length, Is.EqualTo(100));
        }

        [Test]
        public void StreamResumeFsm_RejectsCompletelyDuplicateChunk()
        {
            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = "q-dup",
                QueryKey = new object[] { "test", "dup" },
                Strategy = ResumeStrategies.CreateRange()
            });

            byte[] b300 = new byte[300];
            fsm.HandleIncomingChunk(b300, seq: 0, byteOffset: 0);
            Assert.That(fsm.CommittedByteLength, Is.EqualTo(300));

            byte[] b100 = new byte[100];
            var dup = fsm.HandleIncomingChunk(b100, seq: 0, byteOffset: 100);
            Assert.That(dup.Accepted, Is.False);
            Assert.That(dup.Duplicate, Is.True);
            Assert.That(dup.Slice, Is.Empty);
            Assert.That(dup.Seq, Is.EqualTo(0));
            Assert.That(dup.ByteOffset, Is.EqualTo(100));
            Assert.That(fsm.CommittedByteLength, Is.EqualTo(300));
            Assert.That(fsm.CommittedSeq, Is.EqualTo(1));
        }

        [Test]
        public void StreamResumeFsm_LastEventIdStrategy_UpdatesResumeTokenAndHeader()
        {
            var queryKey = new object[] { "sse", "stream" };
            var stream = _adapter.CreateStream(queryKey);
            string queryHash = stream.QueryHash;

            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = queryHash,
                QueryKey = queryKey,
                Strategy = ResumeStrategies.CreateLastEventId(),
                SqliteAdapter = _adapter
            });

            fsm.HandleIncomingChunk("data: test\n\n", seq: 0, byteOffset: 0, eventId: "evt-42");
            Assert.That(fsm.LastEventId, Is.EqualTo("evt-42"));

            var dbStream = _adapter.GetStream(queryHash);
            Assert.That(dbStream!.ResumeToken, Is.EqualTo("evt-42"));
            Assert.That(dbStream.ResumeKind, Is.EqualTo(ResumeKind.LastEventId));

            var err = fsm.HandleError("disconnect");
            Assert.That(err.CanResume, Is.True);
            Assert.That(err.Headers!["Last-Event-ID"], Is.EqualTo("evt-42"));
        }

        [Test]
        public void StreamResumeFsm_416RangeNotSatisfiable_TriggersRestartAndPurgesChunks()
        {
            var queryKey = new object[] { "llm", "stream-416" };
            var stream = _adapter.CreateStream(queryKey);
            string queryHash = stream.QueryHash;

            bool resetCalled = false;
            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = queryHash,
                QueryKey = queryKey,
                Strategy = ResumeStrategies.CreateRange(),
                SqliteAdapter = _adapter,
                OnReset = () => resetCalled = true
            });

            fsm.HandleIncomingChunk("chunk 1");
            fsm.HandleIncomingChunk("chunk 2");
            Assert.That(_adapter.GetStreamChunks(queryHash, 0), Has.Count.EqualTo(2));

            var err = fsm.HandleError("Range Not Satisfiable", statusCode: 416);
            Assert.That(err.CanResume, Is.True);
            Assert.That(err.Restart, Is.True);
            Assert.That(err.RetryDelayMs, Is.EqualTo(0));
            Assert.That(resetCalled, Is.True);

            Assert.That(fsm.CommittedByteLength, Is.EqualTo(0));
            Assert.That(fsm.CommittedSeq, Is.EqualTo(0));
            Assert.That(fsm.AccumulatedText, Is.EqualTo(string.Empty));
            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Resuming));

            Assert.That(_adapter.GetStreamChunks(queryHash, 0), Is.Empty);
            var dbStream = _adapter.GetStream(queryHash);
            Assert.That(dbStream!.ByteLength, Is.EqualTo(0));
            Assert.That(dbStream.NextSeq, Is.EqualTo(0));
            Assert.That(dbStream.Status, Is.EqualTo(StreamStatus.Open));
        }

        [Test]
        public void StreamResumeFsm_412PreconditionFailed_TriggersRestart()
        {
            bool resetCalled = false;
            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = "q-412",
                QueryKey = new object[] { "llm", "stream-412" },
                Strategy = ResumeStrategies.CreateRange(),
                OnReset = () => resetCalled = true
            });

            fsm.HandleIncomingChunk("data");
            var err = fsm.HandleError("ETag mismatch", statusCode: 412);
            Assert.That(err.CanResume, Is.True);
            Assert.That(err.Restart, Is.True);
            Assert.That(err.RetryDelayMs, Is.EqualTo(0));
            Assert.That(resetCalled, Is.True);
            Assert.That(fsm.CommittedByteLength, Is.EqualTo(0));
        }

        [Test]
        public void StreamResumeFsm_ExponentialBackoffAndMaxRetriesAbort()
        {
            var queryKey = new object[] { "test", "max-retries" };
            var stream = _adapter.CreateStream(queryKey);

            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = stream.QueryHash,
                QueryKey = queryKey,
                Strategy = ResumeStrategies.CreateRange(),
                SqliteAdapter = _adapter,
                MaxRetries = 3,
                BaseDelayMs = 100,
                MaxDelayMs = 1000
            });

            var e1 = fsm.HandleError("e1");
            Assert.That(e1.CanResume, Is.True);
            Assert.That(e1.RetryDelayMs, Is.InRange(0, 100));
            Assert.That(fsm.RetryCount, Is.EqualTo(1));

            var e2 = fsm.HandleError("e2");
            Assert.That(e2.CanResume, Is.True);
            Assert.That(e2.RetryDelayMs, Is.InRange(0, 200));
            Assert.That(fsm.RetryCount, Is.EqualTo(2));

            var e3 = fsm.HandleError("e3");
            Assert.That(e3.CanResume, Is.True);
            Assert.That(e3.RetryDelayMs, Is.InRange(0, 400));
            Assert.That(fsm.RetryCount, Is.EqualTo(3));

            var e4 = fsm.HandleError("e4 fatal");
            Assert.That(e4.CanResume, Is.False);
            Assert.That(e4.Restart, Is.False);
            Assert.That(fsm.State, Is.EqualTo(StreamResumeState.Aborted));

            var dbStream = _adapter.GetStream(stream.QueryHash);
            Assert.That(dbStream!.Status, Is.EqualTo(StreamStatus.Aborted));
            Assert.That(dbStream.Error, Is.EqualTo("e4 fatal"));
        }

        [Test]
        public void StreamResumeFsm_HydratesStateFromExistingSqliteStream()
        {
            var queryKey = new object[] { "llm", "existing" };
            var stream = _adapter.CreateStream(
                queryKey,
                etag: "\"init-etag\"",
                resumeToken: "token-init-1",
                resumeKind: ResumeKind.LastEventId
            );

            _adapter.AppendStreamChunk(stream.QueryHash, "Hello, ");
            _adapter.AppendStreamChunk(stream.QueryHash, "world!");

            var fsm = new StreamResumeFsm(new StreamResumeFsmOptions
            {
                QueryHash = stream.QueryHash,
                QueryKey = queryKey,
                Strategy = ResumeStrategies.CreateLastEventId(),
                SqliteAdapter = _adapter
            });

            Assert.That(fsm.CommittedByteLength, Is.EqualTo(13));
            Assert.That(fsm.CommittedSeq, Is.EqualTo(2));
            Assert.That(fsm.AccumulatedText, Is.EqualTo("Hello, world!"));
            Assert.That(fsm.LastEventId, Is.EqualTo("token-init-1"));
            Assert.That(fsm.Etag, Is.EqualTo("\"init-etag\""));
        }

        #endregion
    }
}
