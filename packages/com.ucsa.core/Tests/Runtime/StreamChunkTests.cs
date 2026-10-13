using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using NUnit.Framework;
using Ucsa.Core;
using Ucsa.Storage;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class StreamChunkTests
    {
        private string _tempDbPath = string.Empty;
        private string _tempDir = string.Empty;
        private SqliteAdapter _adapter = null!;

        [SetUp]
        public void SetUp()
        {
            _tempDir = Path.Combine(Path.GetTempPath(), $"ucsa_stream_tests_{Guid.NewGuid():N}");
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

        [Test]
        public void CreateStream_DefaultOptionsAndTags_CreatesOpenStream()
        {
            var queryKey = new object[] { "ai", "generate", "req-1" };
            var stream = _adapter.CreateStream(
                queryKey,
                tags: new List<string> { "llm", "chat" },
                etag: "\"v1-etag\"",
                payloadVersion: 2
            );

            Assert.That(stream.QueryHash, Is.EqualTo(QueryKeyHasher.Hash(queryKey)));
            Assert.That(stream.QueryKey, Is.EqualTo(queryKey));
            Assert.That(stream.Status, Is.EqualTo(StreamStatus.Open));
            Assert.That(stream.Encoding, Is.EqualTo(StreamEncoding.Utf8));
            Assert.That(stream.NextSeq, Is.EqualTo(0));
            Assert.That(stream.ByteLength, Is.EqualTo(0));
            Assert.That(stream.Etag, Is.EqualTo("\"v1-etag\""));
            Assert.That(stream.PayloadVersion, Is.EqualTo(2));
            Assert.That(stream.ExpiresAt, Is.GreaterThan(stream.CreatedAt));

            var retrieved = _adapter.GetStream(stream.QueryHash);
            Assert.That(retrieved, Is.Not.Null);
            Assert.That(retrieved!.QueryHash, Is.EqualTo(stream.QueryHash));
            Assert.That(retrieved.Status, Is.EqualTo(StreamStatus.Open));
            Assert.That(retrieved.NextSeq, Is.EqualTo(0));
            Assert.That(retrieved.ByteLength, Is.EqualTo(0));
        }

        [Test]
        public void AppendStreamChunk_Sequentially_ValidatesOffsetsAndUpdatesStream()
        {
            var queryKey = new object[] { "ai", "stream", "chunks-1" };
            var stream = _adapter.CreateStream(queryKey);

            var c0 = _adapter.AppendStreamChunk(stream.QueryHash, "Hello, ");
            Assert.That(c0.Seq, Is.EqualTo(0));
            Assert.That(c0.ByteOffset, Is.EqualTo(0));
            Assert.That(c0.ByteLength, Is.EqualTo(7));

            var sAfter0 = _adapter.GetStream(stream.QueryHash);
            Assert.That(sAfter0!.NextSeq, Is.EqualTo(1));
            Assert.That(sAfter0.ByteLength, Is.EqualTo(7));

            var c1 = _adapter.AppendStreamChunk(stream.QueryHash, "world!", expectedSeq: 1);
            Assert.That(c1.Seq, Is.EqualTo(1));
            Assert.That(c1.ByteOffset, Is.EqualTo(7));
            Assert.That(c1.ByteLength, Is.EqualTo(6));

            var sAfter1 = _adapter.GetStream(stream.QueryHash);
            Assert.That(sAfter1!.NextSeq, Is.EqualTo(2));
            Assert.That(sAfter1.ByteLength, Is.EqualTo(13));

            var chunks = _adapter.GetStreamChunks(stream.QueryHash);
            Assert.That(chunks.Count, Is.EqualTo(2));
            Assert.That(chunks[0].Seq, Is.EqualTo(0));
            Assert.That(chunks[0].ByteOffset, Is.EqualTo(0));
            Assert.That(Encoding.UTF8.GetString(chunks[0].Data), Is.EqualTo("Hello, "));
            Assert.That(chunks[1].Seq, Is.EqualTo(1));
            Assert.That(chunks[1].ByteOffset, Is.EqualTo(7));
            Assert.That(Encoding.UTF8.GetString(chunks[1].Data), Is.EqualTo("world!"));
        }

        [Test]
        public void AppendStreamChunk_ExpectedSeqMismatch_ThrowsInvalidOperationException()
        {
            var queryKey = new object[] { "ai", "mismatch" };
            var stream = _adapter.CreateStream(queryKey);

            var ex = Assert.Throws<InvalidOperationException>(() =>
            {
                _adapter.AppendStreamChunk(stream.QueryHash, "Chunk 0", expectedSeq: 1);
            });

            Assert.That(ex!.Message, Does.Contain("Sequence mismatch: expected 1, but next sequence is 0"));
        }

        [Test]
        public void AppendStreamChunk_StreamAborted_ThrowsInvalidOperationException()
        {
            var queryKey = new object[] { "ai", "aborted" };
            var stream = _adapter.CreateStream(queryKey);

            _adapter.AbortStream(stream.QueryHash, "User cancelled");

            var s = _adapter.GetStream(stream.QueryHash);
            Assert.That(s!.Status, Is.EqualTo(StreamStatus.Aborted));
            Assert.That(s.Error, Is.EqualTo("User cancelled"));

            var ex = Assert.Throws<InvalidOperationException>(() =>
            {
                _adapter.AppendStreamChunk(stream.QueryHash, "data");
            });

            Assert.That(ex!.Message, Does.Contain("Stream is not open (status: aborted)"));
        }

        [Test]
        public void CascadeDelete_DeletingStreamRow_PurgesChunksAndTags()
        {
            var queryKey = new object[] { "ai", "cascade" };
            var stream = _adapter.CreateStream(queryKey, tags: new List<string> { "cascade-tag" });

            _adapter.AppendStreamChunk(stream.QueryHash, "Chunk data");
            Assert.That(_adapter.GetStreamChunks(stream.QueryHash).Count, Is.EqualTo(1));

            using (var cmd = _adapter.Connection.CreateCommand())
            {
                cmd.CommandText = "DELETE FROM ucsa_streams WHERE query_hash = $hash;";
                cmd.Parameters.AddWithValue("$hash", stream.QueryHash);
                cmd.ExecuteNonQuery();
            }

            Assert.That(_adapter.GetStream(stream.QueryHash), Is.Null);
            Assert.That(_adapter.GetStreamChunks(stream.QueryHash), Is.Empty);

            using (var tagCmd = _adapter.Connection.CreateCommand())
            {
                tagCmd.CommandText = "SELECT count(*) FROM ucsa_stream_tags WHERE query_hash = $hash;";
                tagCmd.Parameters.AddWithValue("$hash", stream.QueryHash);
                long count = Convert.ToInt64(tagCmd.ExecuteScalar());
                Assert.That(count, Is.EqualTo(0));
            }
        }

        [Test]
        public async Task CompactStreamAsync_JsonStream_CompactsIntoQueryCacheAndMovesTags()
        {
            var queryKey = new object[] { "ai", "response", "req-1" };
            var tags = new List<string> { "ai-response", "user-42" };
            var stream = _adapter.CreateStream(
                queryKey,
                encoding: StreamEncoding.Utf8,
                etag: "\"response-etag-123\"",
                tags: tags,
                payloadVersion: 2
            );

            _adapter.AppendStreamChunk(stream.QueryHash, "{\"answer\":");
            _adapter.AppendStreamChunk(stream.QueryHash, " \"Paris\",");
            _adapter.AppendStreamChunk(stream.QueryHash, " \"confidence\": 0.99}");

            var entry = await _adapter.CompactStreamAsync(stream.QueryHash);

            Assert.That(entry.QueryHash, Is.EqualTo(stream.QueryHash));
            Assert.That(entry.Etag, Is.EqualTo("\"response-etag-123\""));
            Assert.That(entry.CreatedAt, Is.EqualTo(stream.CreatedAt));
            Assert.That(entry.StaleAt, Is.EqualTo(stream.CreatedAt + 60000));
            Assert.That(entry.ExpiresAt, Is.EqualTo(stream.ExpiresAt));
            Assert.That(entry.PayloadVersion, Is.EqualTo(2));

            // Stream row, chunks, and stream tags purged
            Assert.That(_adapter.GetStream(stream.QueryHash), Is.Null);
            Assert.That(_adapter.GetStreamChunks(stream.QueryHash), Is.Empty);

            using (var checkCmd = _adapter.Connection.CreateCommand())
            {
                checkCmd.CommandText = "SELECT count(*) FROM ucsa_stream_tags WHERE query_hash = $hash;";
                checkCmd.Parameters.AddWithValue("$hash", stream.QueryHash);
                long tagCount = Convert.ToInt64(checkCmd.ExecuteScalar());
                Assert.That(tagCount, Is.EqualTo(0));
            }

            // Entry retrievable via GetQuery
            var cached = _adapter.GetQuery<JsonElement>(stream.QueryHash);
            Assert.That(cached, Is.Not.Null);
            Assert.That(cached!.DataPayload.GetProperty("answer").GetString(), Is.EqualTo("Paris"));
            Assert.That(cached.DataPayload.GetProperty("confidence").GetDouble(), Is.EqualTo(0.99));

            // Tags moved to ucsa_cache_tags
            var cacheHashes = _adapter.GetQueryHashesByTag("ai-response");
            Assert.That(cacheHashes, Does.Contain(stream.QueryHash));
            var userHashes = _adapter.GetQueryHashesByTag("user-42");
            Assert.That(userHashes, Does.Contain(stream.QueryHash));
        }

        [Test]
        public async Task CompactStreamAsync_PlainTextStream_CompactsIntoQueryCache()
        {
            var queryKey = new object[] { "stream", "text-raw" };
            var stream = _adapter.CreateStream(queryKey, encoding: StreamEncoding.Utf8);

            _adapter.AppendStreamChunk(stream.QueryHash, "Line 1\n");
            _adapter.AppendStreamChunk(stream.QueryHash, "Line 2\n");

            var entry = await _adapter.CompactStreamAsync(stream.QueryHash);
            Assert.That(entry.DataPayload, Is.EqualTo("Line 1\nLine 2\n"));

            var cached = _adapter.GetQuery<string>(stream.QueryHash);
            Assert.That(cached?.DataPayload, Is.EqualTo("Line 1\nLine 2\n"));
        }

        [Test]
        public async Task CompactStreamAsync_BytesStream_CompactsIntoQueryCache()
        {
            var queryKey = new object[] { "stream", "binary-raw" };
            var stream = _adapter.CreateStream(queryKey, encoding: StreamEncoding.Bytes);

            byte[] b1 = new byte[] { 10, 20 };
            byte[] b2 = new byte[] { 30, 40, 50 };
            _adapter.AppendStreamChunk(stream.QueryHash, b1);
            _adapter.AppendStreamChunk(stream.QueryHash, b2);

            var entry = await _adapter.CompactStreamAsync(stream.QueryHash);
            Assert.That(entry.DataPayload, Is.EqualTo(new byte[] { 10, 20, 30, 40, 50 }));
        }

        [Test]
        public async Task CompactStreamAsync_LargeStream_FallsBackToCasStore()
        {
            string casDir = Path.Combine(_tempDir, "cas");
            var casStore = new CasStore(casDir, _adapter);

            var queryKey = new object[] { "stream", "large-payload" };
            var stream = _adapter.CreateStream(
                queryKey,
                encoding: StreamEncoding.Utf8,
                tags: new List<string> { "large-blob" }
            );

            string chunkData = new string('x', 600);
            _adapter.AppendStreamChunk(stream.QueryHash, chunkData, 0);
            _adapter.AppendStreamChunk(stream.QueryHash, chunkData, 1);
            _adapter.AppendStreamChunk(stream.QueryHash, chunkData, 2);

            int totalSize = 1800;
            Assert.That(_adapter.GetStream(stream.QueryHash)?.ByteLength, Is.EqualTo(totalSize));

            var entry = await _adapter.CompactStreamAsync(stream.QueryHash, casStore, casThresholdBytes: 1024);

            var casRef = entry.DataPayload as Dictionary<string, object>;
            Assert.That(casRef, Is.Not.Null);
            Assert.That(casRef!["__cas_ref"], Is.EqualTo(true));
            Assert.That(Convert.ToInt32(casRef["size"]), Is.EqualTo(totalSize));
            string casHash = casRef["hash"].ToString()!;
            Assert.That(casHash.Length, Is.EqualTo(64));

            // Verify file exists on disk
            string casPath = casStore.GetPath(casHash);
            Assert.That(File.Exists(casPath), Is.True);
            Assert.That(File.ReadAllText(casPath), Is.EqualTo(new string('x', 1800)));

            // Stream row purged
            Assert.That(_adapter.GetStream(stream.QueryHash), Is.Null);
            Assert.That(_adapter.GetStreamChunks(stream.QueryHash), Is.Empty);

            // Tags moved
            Assert.That(_adapter.GetQueryHashesByTag("large-blob"), Does.Contain(stream.QueryHash));
        }

        [Test]
        public void CompactStreamAsync_NonexistentStream_ThrowsInvalidOperationException()
        {
            Assert.ThrowsAsync<InvalidOperationException>(async () =>
            {
                await _adapter.CompactStreamAsync("nonexistent-hash");
            });
        }
    }
}
