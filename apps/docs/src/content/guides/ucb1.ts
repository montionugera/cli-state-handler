import { CORE, DART, CS, type Guide } from "./types.js";

export const ucb1: Guide = {
  id: "ucb1",
  label: "UCB1 Event Bus",
  ts: {
    title: "UCB1 Hub and Client (TypeScript)",
    lang: "typescript",
    available: true,
    sources: [`${CORE}/ipc/bus-hub.ts`, `${CORE}/ipc/bus-client.ts`, `${CORE}/ipc/frame-codec.ts`],
    code: `// Checked against: packages/core/src/ipc/bus-hub.ts (BusHub.electOrConnect),
// packages/core/src/ipc/bus-client.ts (BusClient.connect, publish, subscribeEvents)
import { BusHub, BusClient } from "@montionugera/ucsa-core";

// The first process to elect itself owns the hub; the others get role 'client'.
const hub = new BusHub({ sqliteAdapter: sqlite });
const { endpoint, token } = await hub.electOrConnect();

// connect() sends HELLO with the token first; a wrong token gets ERROR INVALID_TOKEN and is closed.
const client = new BusClient({ endpoint, token, sqliteAdapter: sqlite });
await client.connect();

client.subscribeEvents((event) => console.log("remote change", event.kind));
client.publish({ kind: "invalidate", tags: ["user:42"] });`,
    notes: [
      "Frame layout: 12-byte big-endian header (magic bytes UCB1, type byte, flags byte, 2 reserved bytes, uint32 payload length), then a JSON payload up to 1,048,576 bytes. There is no version field.",
      "A client with no subscriptions receives every event, but BusClient subscribes to invalidate, mutation and reset on connect, so the receive-everything case applies only to raw-protocol clients. Subscriptions are exact-match filters on the payload's kind, tags or topic, plus *. The publisher does not receive its own event.",
      "A frame that fails to decode makes the hub destroy that socket without an ERROR reply. Slow consumers get RESYNC.",
    ],
  },
  dart: {
    title: "UCB1 Frames and Hub Record (Dart / Flutter)",
    lang: "dart",
    available: true,
    sources: [`${DART}/frame_codec.dart`, `${DART}/bus_hub.dart`],
    code: `// Checked against: packages/ucsa_dart/lib/src/frame_codec.dart (encodeFrame, FrameDecoder),
// packages/ucsa_dart/lib/src/bus_hub.dart (BusHub.elect, connectAsClient)
import 'package:ucsa_dart/ucsa_dart.dart';

// Encode and decode UCB1 frames (same wire format as TypeScript).
final bytes = encodeFrame(FrameType.hello, {'proto': 1, 'token': 'abc'});
final frames = FrameDecoder().feed(bytes); // List<Frame>
print(frames.first.type); // FrameType.hello

// BusHub only does election bookkeeping in the ucsa_bus_hub table.
final hub = BusHub(adapter: sqlite);
final election = hub.elect(); // ElectionResult(role, endpoint, token, epoch)`,
    notes: [
      "Partial parity: the codec is complete, but BusHub in Dart only records the election (elect, connectAsClient, getHubRecord, writeHubRecord).",
      "elect() always takes over the hub record and starts no server; do not call it on a database shared with a running TypeScript hub. Use connectAsClient() to read the record.",
      "Not available: a socket server, a bus client, HELLO token checks and subscription filtering. Searched lib/src for Socket, ServerSocket, BusClient and SUBSCRIBE handling and found none outside the frame type enum.",
    ],
  },
  csharp: {
    title: "UCB1 Frames and Hub Record (C# Unity)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Ipc/FrameCodec.cs`, `${CS}/Ipc/BusHub.cs`],
    code: `// Checked against: Runtime/Ipc/FrameCodec.cs (FrameCodec.EncodeFrame, FrameDecoder.Feed),
// Runtime/Ipc/BusHub.cs (BusHubHelper.ResolveBusEndpoint, GetHubRecord)
using Ucsa.Ipc;

// Encode and decode UCB1 frames (same wire format as TypeScript).
byte[] bytes = FrameCodec.EncodeFrame(FrameType.Hello, "{\\"proto\\":1,\\"token\\":\\"abc\\"}");
var frames = new FrameDecoder().Feed(bytes); // List<Frame>
Debug.Log(frames[0].Type);

// BusHubHelper only resolves the endpoint and reads or writes the ucsa_bus_hub row.
string endpoint = BusHubHelper.ResolveBusEndpoint(dbPath);
HubRecord? record = BusHubHelper.GetHubRecord(sqlite);`,
    notes: [
      "Partial parity: BusHub.cs is a static helper (BusHubHelper), not a hub. The file holds endpoint resolution and hub-record persistence only.",
      "Not available: a socket server, bus client, election, HELLO token checks and subscription filtering. Searched Runtime/ for Socket, NamedPipe, BusClient and Subscribe handling and found none outside the frame type enum.",
    ],
  },
};
