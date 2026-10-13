using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using NUnit.Framework;
using Ucsa.Ipc;

namespace Ucsa.Core.Tests.Runtime
{
    [TestFixture]
    public class FrameCodecTests
    {
        private FrameDecoder _decoder = null!;

        [SetUp]
        public void SetUp()
        {
            _decoder = new FrameDecoder();
        }

        private static byte[] HexToBytes(string hex)
        {
            var bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
            {
                bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            }
            return bytes;
        }

        private static string BytesToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            foreach (var b in bytes)
            {
                sb.Append(b.ToString("x2"));
            }
            return sb.ToString();
        }

        private static string FindVectorsPath()
        {
            var dir = AppDomain.CurrentDomain.BaseDirectory;
            while (!string.IsNullOrEmpty(dir))
            {
                var candidate = Path.Combine(dir, "contracts", "ipc", "vectors.json");
                if (File.Exists(candidate)) return candidate;
                var parent = Directory.GetParent(dir);
                if (parent == null) break;
                dir = parent.FullName;
            }

            dir = Directory.GetCurrentDirectory();
            while (!string.IsNullOrEmpty(dir))
            {
                var candidate = Path.Combine(dir, "contracts", "ipc", "vectors.json");
                if (File.Exists(candidate)) return candidate;
                var parent = Directory.GetParent(dir);
                if (parent == null) break;
                dir = parent.FullName;
            }

            throw new FileNotFoundException("Could not locate contracts/ipc/vectors.json");
        }

        [Test]
        public void FrameType_DefinesAll11ValuesMatchingWireSpec()
        {
            Assert.That((byte)FrameType.Hello, Is.EqualTo(0x01));
            Assert.That((byte)FrameType.Welcome, Is.EqualTo(0x02));
            Assert.That((byte)FrameType.Subscribe, Is.EqualTo(0x03));
            Assert.That((byte)FrameType.Unsubscribe, Is.EqualTo(0x04));
            Assert.That((byte)FrameType.Publish, Is.EqualTo(0x05));
            Assert.That((byte)FrameType.Event, Is.EqualTo(0x06));
            Assert.That((byte)FrameType.Ping, Is.EqualTo(0x08));
            Assert.That((byte)FrameType.Pong, Is.EqualTo(0x09));
            Assert.That((byte)FrameType.Resync, Is.EqualTo(0x0a));
            Assert.That((byte)FrameType.Bye, Is.EqualTo(0x0b));
            Assert.That((byte)FrameType.Error, Is.EqualTo(0x0f));
        }

        [Test]
        public void RoundTrip_All11FrameTypesEncodeAndDecodeCorrectly()
        {
            var testCases = new (FrameType type, string json)[]
            {
                (FrameType.Hello, "{\"version\":\"1.0\",\"clientId\":\"unity-client\"}"),
                (FrameType.Welcome, "{\"sessionId\":\"sess-123\",\"heartbeatMs\":5000}"),
                (FrameType.Subscribe, "{\"topic\":\"cache:invalidation:users\",\"filter\":\"*\"}"),
                (FrameType.Unsubscribe, "{\"topic\":\"cache:invalidation:users\"}"),
                (FrameType.Publish, "{\"channel\":\"orders\",\"data\":{\"orderId\":42,\"amount\":199.99}}"),
                (FrameType.Event, "{\"eventName\":\"user_updated\",\"id\":\"usr-9\"}"),
                (FrameType.Ping, "{\"timestamp\":1712000000000}"),
                (FrameType.Pong, "{\"timestamp\":1712000000000}"),
                (FrameType.Resync, "{\"lastSeq\":1042}"),
                (FrameType.Bye, "{\"reason\":\"client_shutdown\"}"),
                (FrameType.Error, "{\"code\":\"ERR_TIMEOUT\",\"message\":\"Operation timed out\"}")
            };

            foreach (var (type, json) in testCases)
            {
                var encoded = FrameCodec.EncodeFrame(type, json);
                Assert.That(encoded.Length, Is.GreaterThanOrEqualTo(FrameCodec.HeaderSize));

                // Magic bytes 'U','C','B','1'
                Assert.That(Encoding.ASCII.GetString(encoded, 0, 4), Is.EqualTo("UCB1"));
                Assert.That(encoded[4], Is.EqualTo((byte)type));
                Assert.That(encoded[5], Is.EqualTo(0)); // Flags = 0
                Assert.That(encoded[6], Is.EqualTo(0)); // Reserved = 0
                Assert.That(encoded[7], Is.EqualTo(0));

                var decoded = _decoder.Feed(encoded);
                Assert.That(decoded.Count, Is.EqualTo(1));
                Assert.That(decoded[0].Type, Is.EqualTo(type));

                // Compare JSON structurally
                Assert.That(
                    JsonNode.DeepEquals(JsonNode.Parse(decoded[0].JsonPayload), JsonNode.Parse(json)),
                    Is.True,
                    $"Payload mismatch for FrameType {type}"
                );
            }
        }

        [Test]
        public void EncodeFrame_DefaultsToEmptyObjectWhenPayloadNullOrEmpty()
        {
            var encoded = FrameCodec.EncodeFrame(FrameType.Ping, null);
            var decoded = _decoder.Feed(encoded);
            Assert.That(decoded.Count, Is.EqualTo(1));
            Assert.That(decoded[0].Type, Is.EqualTo(FrameType.Ping));
            Assert.That(decoded[0].JsonPayload, Is.EqualTo("{}"));
        }

        [Test]
        public void StreamingReassembly_HandlesByteByByteChunks()
        {
            var json = "{\"stream\":\"byte-by-byte\",\"count\":12345}";
            var encoded = FrameCodec.EncodeFrame(FrameType.Event, json);

            var frames = new List<Frame>();
            for (int i = 0; i < encoded.Length; i++)
            {
                var chunk = new byte[] { encoded[i] };
                frames.AddRange(_decoder.Feed(chunk));
            }

            Assert.That(frames.Count, Is.EqualTo(1));
            Assert.That(frames[0].Type, Is.EqualTo(FrameType.Event));
            Assert.That(JsonNode.DeepEquals(JsonNode.Parse(frames[0].JsonPayload), JsonNode.Parse(json)), Is.True);
        }

        [Test]
        public void StreamingReassembly_HandlesSplitHeaderAndPayloadBoundaries()
        {
            var json = "{\"key\":\"value\",\"complex\":[1,2,3,{\"nested\":true}]}";
            var encoded = FrameCodec.EncodeFrame(FrameType.Publish, json);
            var halfway = 12 + ((encoded.Length - 12) / 2);
            var splitPositions = new int[] { 1, 2, 11, halfway };

            foreach (var split in splitPositions)
            {
                _decoder.Reset();
                var part1 = encoded.Take(split).ToArray();
                var part2 = encoded.Skip(split).ToArray();

                var out1 = _decoder.Feed(part1);
                Assert.That(out1, Is.Empty);

                var out2 = _decoder.Feed(part2);
                Assert.That(out2.Count, Is.EqualTo(1));
                Assert.That(out2[0].Type, Is.EqualTo(FrameType.Publish));
                Assert.That(JsonNode.DeepEquals(JsonNode.Parse(out2[0].JsonPayload), JsonNode.Parse(json)), Is.True);
            }
        }

        [Test]
        public void StreamingReassembly_HandlesResetCorrectly()
        {
            var encoded = FrameCodec.EncodeFrame(FrameType.Ping, "{\"seq\":1}");
            _decoder.Feed(encoded.Take(5).ToArray());
            _decoder.Reset();

            var decoded = _decoder.Feed(encoded);
            Assert.That(decoded.Count, Is.EqualTo(1));
            Assert.That(JsonNode.DeepEquals(JsonNode.Parse(decoded[0].JsonPayload), JsonNode.Parse("{\"seq\":1}")), Is.True);
        }

        [Test]
        public void Concatenation_DecodesMultipleFramesInSingleBuffer()
        {
            var f1 = FrameCodec.EncodeFrame(FrameType.Hello, "{\"id\":1}");
            var f2 = FrameCodec.EncodeFrame(FrameType.Subscribe, "{\"id\":2}");
            var f3 = FrameCodec.EncodeFrame(FrameType.Event, "{\"id\":3}");

            var concatenated = f1.Concat(f2).Concat(f3).ToArray();
            var decoded = _decoder.Feed(concatenated);

            Assert.That(decoded.Count, Is.EqualTo(3));
            Assert.That(decoded[0].Type, Is.EqualTo(FrameType.Hello));
            Assert.That(decoded[1].Type, Is.EqualTo(FrameType.Subscribe));
            Assert.That(decoded[2].Type, Is.EqualTo(FrameType.Event));
        }

        [Test]
        public void Concatenation_DecodesSplitConcatenatedFrames()
        {
            var f1 = FrameCodec.EncodeFrame(FrameType.Ping, "{\"n\":1}");
            var f2 = FrameCodec.EncodeFrame(FrameType.Pong, "{\"n\":2}");
            var concatenated = f1.Concat(f2).ToArray();

            var splitPoint = f1.Length + 6; // Split in f2's header
            var part1 = concatenated.Take(splitPoint).ToArray();
            var part2 = concatenated.Skip(splitPoint).ToArray();

            var out1 = _decoder.Feed(part1);
            Assert.That(out1.Count, Is.EqualTo(1));
            Assert.That(out1[0].Type, Is.EqualTo(FrameType.Ping));

            var out2 = _decoder.Feed(part2);
            Assert.That(out2.Count, Is.EqualTo(1));
            Assert.That(out2[0].Type, Is.EqualTo(FrameType.Pong));
        }

        [Test]
        public void ErrorHandling_ThrowsInvalidMagicExceptionOnBadMagicBytes()
        {
            var encoded = FrameCodec.EncodeFrame(FrameType.Ping, "{}");
            encoded[0] = (byte)'B';
            encoded[1] = (byte)'A';
            encoded[2] = (byte)'D';
            encoded[3] = (byte)'!';

            Assert.Throws<InvalidMagicException>(() => _decoder.Feed(encoded));
        }

        [Test]
        public void ErrorHandling_ThrowsReservedFlagsExceptionOnNonZeroFlags()
        {
            var encoded = FrameCodec.EncodeFrame(FrameType.Ping, "{}");
            encoded[5] = 0x01; // Non-zero flags

            Assert.Throws<ReservedFlagsException>(() => _decoder.Feed(encoded));
        }

        [Test]
        public void ErrorHandling_ThrowsReservedFlagsExceptionOnNonZeroReserved()
        {
            var encoded = FrameCodec.EncodeFrame(FrameType.Ping, "{}");
            encoded[7] = 0x01; // Non-zero reserved

            Assert.Throws<ReservedFlagsException>(() => _decoder.Feed(encoded));
        }

        [Test]
        public void ErrorHandling_ThrowsFrameTooLargeExceptionOnPayloadExceeding1MBInEncode()
        {
            var huge = new string('x', FrameCodec.MaxPayloadSize + 10);
            var payload = $"{{\"huge\":\"{huge}\"}}";

            Assert.Throws<FrameTooLargeException>(() => FrameCodec.EncodeFrame(FrameType.Event, payload));
        }

        [Test]
        public void ErrorHandling_ThrowsFrameTooLargeExceptionOnHeaderPayloadLengthExceeding1MBInDecoder()
        {
            var header = new byte[12];
            header[0] = 0x55; // U
            header[1] = 0x43; // C
            header[2] = 0x42; // B
            header[3] = 0x31; // 1
            header[4] = (byte)FrameType.Ping;
            header[5] = 0;
            header[6] = 0;
            header[7] = 0;

            // Length: MaxPayloadSize + 1 (0x00100001 = 1,048,577)
            var len = FrameCodec.MaxPayloadSize + 1;
            header[8] = (byte)((len >> 24) & 0xFF);
            header[9] = (byte)((len >> 16) & 0xFF);
            header[10] = (byte)((len >> 8) & 0xFF);
            header[11] = (byte)(len & 0xFF);

            Assert.Throws<FrameTooLargeException>(() => _decoder.Feed(header));
        }

        [Test]
        public void ErrorHandling_ThrowsInvalidPayloadJsonExceptionOnMalformedJson()
        {
            var badJson = Encoding.UTF8.GetBytes("{not-valid-json");
            var frame = new byte[12 + badJson.Length];
            frame[0] = 0x55;
            frame[1] = 0x43;
            frame[2] = 0x42;
            frame[3] = 0x31;
            frame[4] = (byte)FrameType.Ping;
            frame[5] = 0;
            frame[6] = 0;
            frame[7] = 0;

            frame[8] = (byte)((badJson.Length >> 24) & 0xFF);
            frame[9] = (byte)((badJson.Length >> 16) & 0xFF);
            frame[10] = (byte)((badJson.Length >> 8) & 0xFF);
            frame[11] = (byte)(badJson.Length & 0xFF);

            Array.Copy(badJson, 0, frame, 12, badJson.Length);

            Assert.Throws<InvalidPayloadJsonException>(() => _decoder.Feed(frame));
        }

        [Test]
        public void ConformanceVectors_DecodesAll10VectorsFromGoldenHex()
        {
            var vectorsPath = FindVectorsPath();
            var jsonString = File.ReadAllText(vectorsPath);
            using var doc = JsonDocument.Parse(jsonString);

            var vectors = doc.RootElement.EnumerateArray().ToList();
            Assert.That(vectors.Count, Is.GreaterThanOrEqualTo(10));

            var expectedNames = new string[]
            {
                "hello", "welcome", "subscribe", "publish", "event",
                "ping", "pong", "resync", "bye", "error"
            };

            var names = vectors.Select(v => v.GetProperty("name").GetString()!).ToList();
            foreach (var expName in expectedNames)
            {
                Assert.That(names, Does.Contain(expName));
            }

            foreach (var vector in vectors)
            {
                var name = vector.GetProperty("name").GetString()!;
                var typeVal = (byte)vector.GetProperty("type").GetInt32();
                var expectedType = (FrameType)typeVal;
                var rawPayload = vector.GetProperty("payload").GetRawText();
                var hex = vector.GetProperty("hex").GetString()!;

                var decoder = new FrameDecoder();
                var bytes = HexToBytes(hex);
                var frames = decoder.Feed(bytes);

                Assert.That(frames.Count, Is.EqualTo(1), $"Vector {name} should yield 1 frame");
                Assert.That(frames[0].Type, Is.EqualTo(expectedType), $"Vector {name} type mismatch");

                Assert.That(
                    JsonNode.DeepEquals(JsonNode.Parse(frames[0].JsonPayload), JsonNode.Parse(rawPayload)),
                    Is.True,
                    $"Vector {name} payload mismatch"
                );
            }
        }

        [Test]
        public void ConformanceVectors_EncodesGoldenHeaderAndWireHex()
        {
            var vectorsPath = FindVectorsPath();
            var jsonString = File.ReadAllText(vectorsPath);
            using var doc = JsonDocument.Parse(jsonString);

            foreach (var vector in doc.RootElement.EnumerateArray())
            {
                var name = vector.GetProperty("name").GetString()!;
                var typeVal = (byte)vector.GetProperty("type").GetInt32();
                var expectedType = (FrameType)typeVal;
                var payloadJson = JsonSerializer.Serialize(vector.GetProperty("payload"));
                var hex = vector.GetProperty("hex").GetString()!;

                var encoded = FrameCodec.EncodeFrame(expectedType, payloadJson);

                // Check 12-byte header (first 24 hex characters)
                var expectedHeaderHex = hex.Substring(0, 24);
                var actualHeaderHex = BytesToHex(encoded.Take(12).ToArray());
                Assert.That(actualHeaderHex, Is.EqualTo(expectedHeaderHex), $"Header mismatch for {name}");

                // Check round-trip decode
                var decoder = new FrameDecoder();
                var decoded = decoder.Feed(encoded);
                Assert.That(decoded.Count, Is.EqualTo(1));
                Assert.That(decoded[0].Type, Is.EqualTo(expectedType));
                Assert.That(
                    JsonNode.DeepEquals(JsonNode.Parse(decoded[0].JsonPayload), JsonNode.Parse(payloadJson)),
                    Is.True,
                    $"Decoded payload mismatch for {name}"
                );

                // Wire hex matches golden vector hex
                Assert.That(BytesToHex(encoded), Is.EqualTo(hex), $"Wire hex mismatch for {name}");
            }
        }

        [Test]
        public void ConformanceVectors_DecodesByteByByteStreamingForAllVectors()
        {
            var vectorsPath = FindVectorsPath();
            var jsonString = File.ReadAllText(vectorsPath);
            using var doc = JsonDocument.Parse(jsonString);

            foreach (var vector in doc.RootElement.EnumerateArray())
            {
                var name = vector.GetProperty("name").GetString()!;
                var typeVal = (byte)vector.GetProperty("type").GetInt32();
                var expectedType = (FrameType)typeVal;
                var rawPayload = vector.GetProperty("payload").GetRawText();
                var hex = vector.GetProperty("hex").GetString()!;

                var decoder = new FrameDecoder();
                var bytes = HexToBytes(hex);
                var frames = new List<Frame>();

                for (int i = 0; i < bytes.Length; i++)
                {
                    frames.AddRange(decoder.Feed(new byte[] { bytes[i] }));
                }

                Assert.That(frames.Count, Is.EqualTo(1), $"Byte streaming {name} failed");
                Assert.That(frames[0].Type, Is.EqualTo(expectedType));
                Assert.That(
                    JsonNode.DeepEquals(JsonNode.Parse(frames[0].JsonPayload), JsonNode.Parse(rawPayload)),
                    Is.True
                );
            }
        }
    }
}
