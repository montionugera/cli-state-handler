import { CORE, DART, CS, type Guide } from "./types.js";

export const outbox: Guide = {
  id: "outbox",
  label: "Offline Outbox",
  ts: {
    title: "Offline Mutation Outbox (TypeScript)",
    lang: "typescript",
    available: true,
    sources: [`${CORE}/query/mutation-outbox.ts`, `${CORE}/types.ts`],
    code: `// Checked against: packages/core/src/query/mutation-outbox.ts (MutationOutbox, enqueue, replay)
import { MutationOutbox } from "@montionugera/ucsa-core";

const outbox = new MutationOutbox({
  sqliteAdapter: sqlite,
  maxRetries: 3,
  onRollback: (m) => console.log("rolled back", m.mutation_id),
});

outbox.enqueue({
  mutation_id: "todo-1",
  endpoint: "/api/todos",
  method: "POST",
  payload: { title: "Buy milk" },
  conflictPolicy: "server-wins", // 'server-wins' | 'client-wins' | 'merge'
});

// Nothing in core calls replay for you: call it when your app decides it is online.
const result = await outbox.replay(
  async (m) => {
    const res = await fetch(m.endpoint, {
      method: m.method,
      headers: m.headers,
      body: JSON.stringify(m.payload),
    });
    return { status: res.status, data: await res.json().catch(() => undefined) };
  },
  { rateLimitMs: 200, batchSize: 10 }
);
console.log(result); // { processed, successful, failed }`,
    notes: [
      "Outcomes by status: 2xx removes the row; 409 runs the conflict policy; other 4xx marks the row failed at once; 5xx or a thrown error increments retry_count and becomes failed when it reaches maxRetries (default 3).",
      "There is no backoff delay: a transient failure goes back to pending and is retried on the next replay call. rateLimitMs only paces sends inside one replay.",
      "There is no connectivity check. The outbox does not look at OnlineManager.",
      "A claim takes a lease (owner and expiry, default 30000 ms). An expired lease can be claimed by another worker, and the completion and failure updates are not fenced by lease owner.",
      "The conflict policy, onRollback and mergeResolver given to enqueue are held in memory by that instance and are not stored in SQLite; another process replaying the row will not have them (only the constructor-level onRollback and mergeResolver apply there).",
    ],
  },
  dart: {
    title: "Offline Mutation Outbox (Dart / Flutter)",
    lang: "dart",
    available: true,
    sources: [`${DART}/sqlite_adapter.dart`, `${DART}/types.dart`],
    code: `// Checked against: packages/ucsa_dart/lib/src/sqlite_adapter.dart (setMutation, replayOutbox),
// packages/ucsa_dart/lib/src/types.dart (OutboxMutation, ConflictPolicy)
import 'package:ucsa_dart/ucsa_dart.dart';

// There is no MutationOutbox class in Dart: the outbox lives on SqliteAdapter.
sqlite.setMutation(OutboxMutation<Map<String, dynamic>>(
  mutationId: 'todo-1',
  endpoint: '/api/todos',
  method: 'POST',
  payload: {'title': 'Buy milk'},
  createdAt: DateTime.now().millisecondsSinceEpoch,
  conflictPolicy: ConflictPolicy.serverWins,
));

// sendToServer is your own function returning {'status': int, 'data': ...}.
final result = await sqlite.replayOutbox(
  (mutation) => sendToServer(mutation),
  rateLimit: const Duration(milliseconds: 200),
  batchSize: 10,
);
print('\${result.processed} processed, \${result.failed} failed');`,
    notes: [
      "Partial parity: the retry limit is fixed at 3 inside replayOutbox (no maxRetries option), and there are no onRollback or mergeResolver callbacks.",
      "On 409, the conflict resolver or policy returns 'rollback' (row deleted) or 'force' (row set back to pending). ConflictPolicy.merge is not implemented: without a conflictResolver a 409 is handled as server-wins (row deleted, counted successful). Only a custom resolver returning 'merged' leaves the row in_flight until its lease expires.",
      "If the executor result has no status, Dart treats it as 200 and deletes the row. 'force' here only resets the row to pending; TypeScript also adds the X-Force-Overwrite header.",
      "Same as TypeScript: no backoff, no connectivity check, and nothing calls replayOutbox for you. The conflict policy is stored in the conflict_policy column.",
    ],
  },
  csharp: {
    title: "Offline Mutation Outbox (C# Unity)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Storage/UnitySqliteAdapter.cs`, `${CS}/Core/Types.cs`],
    code: `// Checked against: Runtime/Storage/UnitySqliteAdapter.cs (SetMutation, ReplayOutboxAsync),
// Runtime/Core/Types.cs (OutboxMutation, ConflictPolicy)
using Ucsa.Unity.Core;

// There is no MutationOutbox class in C#: the outbox lives on UnitySqliteAdapter.
sqlite.SetMutation(new OutboxMutation<string>(
    "todo-1", "/api/todos", "POST", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    payload: "{\\"title\\":\\"Buy milk\\"}")
{
    ConflictPolicy = ConflictPolicy.ServerWins
});

// SendToServerAsync is your own method returning (int status, object data).
var result = await sqlite.ReplayOutboxAsync<string>(
    m => SendToServerAsync(m),
    rateLimitMs: 200,
    batchSize: 10);
Debug.Log($"{result.Processed} processed, {result.Failed} failed");`,
    notes: [
      "Partial parity, same shape as Dart: retry limit fixed at 3, no rollback or merge callbacks. ConflictPolicy.Merge is not implemented: without a conflictResolver a 409 is handled as server-wins (row deleted, counted successful). Only a custom resolver returning \"merged\" leaves the row in_flight until its lease expires.",
      "'force' here only resets the row to pending; TypeScript also adds the X-Force-Overwrite header.",
      "No backoff, no connectivity check, and nothing calls ReplayOutboxAsync for you.",
      "ReplayResult property names Processed, Successful and Failed come from the ReplayResult constructor used in ReplayOutboxAsync.",
    ],
  },
};
