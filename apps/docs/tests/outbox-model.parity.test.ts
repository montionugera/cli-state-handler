// @vitest-environment node
/**
 * Parity: the browser OutboxModel must move through the same states as the real,
 * SQLite-backed MutationOutbox. Each script below is driven through both (real on
 * an in-memory database, model on an injected clock) under fake timers, and the
 * full table snapshot after every step must be identical.
 *
 * Two rules are covered by dedicated cases below: the real outbox does not fence
 * completion by lease owner (stale completion after takeover), and a transient
 * failure re-queues the row as pending immediately, with no backoff delay
 * (re-claim right after a failure).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MutationOutbox,
  SqliteAdapter,
  type ConflictPolicy,
  type OutboxMutation,
} from "../../../packages/core/src/index.js";
import { OutboxModel } from "../src/models/outbox-model.js";

type Executor = (m: OutboxMutation) => Promise<{ status: number; data?: unknown }>;

interface OutboxLike {
  enqueue(m: {
    mutation_id: string;
    endpoint: string;
    method?: string;
    payload?: unknown;
    headers?: Record<string, string>;
    conflictPolicy?: ConflictPolicy;
    onRollback?: (m: OutboxMutation) => void | Promise<void>;
    mergeResolver?: (local: unknown, server: unknown) => unknown;
  }): unknown;
  getAllMutations(): OutboxMutation[];
  markStatus(id: string, status: OutboxMutation["status"], error?: string): void;
  claimPendingMutations(workerId?: string, leaseMs?: number, limit?: number): OutboxMutation[];
  replay(
    executor: Executor,
    options?: { rateLimitMs?: number; batchSize?: number; workerId?: string; leaseDurationMs?: number }
  ): Promise<{ processed: number; successful: number; failed: number }>;
}

const T0 = 1_700_000_000_000;

function snapshot(o: OutboxLike): unknown[] {
  return o.getAllMutations().map((m) => ({
    id: m.mutation_id,
    status: m.status,
    retry_count: m.retry_count,
    created_at: m.created_at,
    last_attempt_at: m.last_attempt_at,
    error: m.error,
    forced: m.forced,
    lease_owner: m.lease_owner,
    lease_until: m.lease_until,
    headers: m.headers,
    payload: m.payload,
  }));
}

let adapter: SqliteAdapter;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(T0);
  adapter = new SqliteAdapter(":memory:");
});

afterEach(() => {
  adapter.close();
  vi.useRealTimers();
});

interface CallbackOptions {
  onRollback?: (m: OutboxMutation) => void | Promise<void>;
  mergeResolver?: (local: unknown, server: unknown) => unknown;
}

function makeReal(cb: CallbackOptions = {}): OutboxLike {
  return new MutationOutbox({ sqliteAdapter: adapter, workerId: "worker-a", maxRetries: 3, ...cb });
}
function makeModel(cb: CallbackOptions = {}): OutboxLike {
  return new OutboxModel({ clock: () => Date.now(), workerId: "worker-a", maxRetries: 3, ...cb });
}

/** Run a script against both implementations from the same start time. */
async function both<T>(script: (o: OutboxLike) => Promise<T>, cb: CallbackOptions = {}): Promise<{ real: T; model: T }> {
  vi.setSystemTime(T0);
  const real = await script(makeReal(cb));
  vi.setSystemTime(T0);
  const model = await script(makeModel(cb));
  expect(model).toEqual(real);
  return { real, model };
}

function seed(o: OutboxLike, ids: string[], extra: Partial<Parameters<OutboxLike["enqueue"]>[0]> = {}): void {
  for (const id of ids) {
    o.enqueue({ mutation_id: id, endpoint: `/api/${id}`, method: "POST", payload: { id }, ...extra });
    vi.advanceTimersByTime(1); // distinct created_at so ordering is deterministic
  }
}

describe("OutboxModel parity with the real MutationOutbox", () => {
  it("happy path: claims in created_at order, executes, removes on 2xx", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1", "m2", "m3"]);
      const trace: unknown[] = [snapshot(o)];
      const seen: string[] = [];
      const result = await o.replay(async (m) => {
        seen.push(`${m.mutation_id}:${m.status}:${m.lease_owner}`);
        return { status: 200 };
      });
      trace.push(seen, result, snapshot(o));
      return trace;
    });
    expect((real[1] as string[])).toEqual(["m1:in_flight:worker-a", "m2:in_flight:worker-a", "m3:in_flight:worker-a"]);
    expect(real[2]).toEqual({ processed: 3, successful: 3, failed: 0 });
    expect(real[3]).toEqual([]);
  });

  it("retry after failure: pending with retry_count, failed at maxRetries, lease cleared", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1"]);
      const trace: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        trace.push(await o.replay(async () => ({ status: 503 })));
        trace.push(snapshot(o));
        vi.advanceTimersByTime(10);
      }
      // a failed row is never claimed again, even by a replay that would succeed
      trace.push(await o.replay(async () => ({ status: 200 })), snapshot(o));
      return trace;
    });
    const afterFirst = (real[1] as Array<{ status: string; retry_count: number; lease_owner: string | null }>)[0];
    expect(afterFirst).toMatchObject({ status: "pending", retry_count: 1, lease_owner: null });
    const afterThird = (real[5] as Array<{ status: string; retry_count: number; error: string }>)[0];
    expect(afterThird).toMatchObject({ status: "failed", retry_count: 3, error: "HTTP 503" });
    // failed rows are never claimed again
    expect(real[6]).toEqual({ processed: 0, successful: 0, failed: 0 });
  });

  it("a thrown executor error is transient and keeps the message", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1"]);
      await o.replay(async () => {
        throw new Error("socket hang up");
      });
      return snapshot(o);
    });
    expect((real as Array<{ error: string; status: string; retry_count: number }>)[0]).toMatchObject({
      error: "socket hang up",
      status: "pending",
      retry_count: 1,
    });
  });

  it("non-409 4xx fails immediately without bumping retry_count", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1"]);
      const result = await o.replay(async () => ({ status: 400 }));
      return [result, snapshot(o)];
    });
    expect((real[1] as Array<unknown>)[0]).toMatchObject({ status: "failed", retry_count: 0, error: "HTTP 400" });
    expect(real[0]).toEqual({ processed: 1, successful: 0, failed: 1 });
  });

  it("lease expiry and takeover: one live lease, strict expiry boundary, B wins", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1"]);
      const trace: unknown[] = [];
      const a = o.claimPendingMutations("worker-a", 30_000);
      const leaseUntil = a[0]?.lease_until ?? 0;
      trace.push(a.map((m) => [m.mutation_id, m.lease_owner, m.lease_until]), snapshot(o));
      // B cannot claim while A's lease is live
      trace.push(o.claimPendingMutations("worker-b", 30_000).length);
      // exactly at lease_until the lease is still live (strict <)
      vi.setSystemTime(leaseUntil);
      trace.push(o.claimPendingMutations("worker-b", 30_000).length);
      // one ms later it has expired and B takes over
      vi.setSystemTime(leaseUntil + 1);
      const b = o.claimPendingMutations("worker-b", 30_000);
      trace.push(b.map((m) => [m.mutation_id, m.lease_owner, m.lease_until]), snapshot(o));
      // and now A cannot get it back
      trace.push(o.claimPendingMutations("worker-a", 30_000).length);
      return trace;
    });
    expect(real[2]).toBe(0);
    expect(real[3]).toBe(0);
    expect((real[4] as Array<[string, string, number]>)[0]?.[1]).toBe("worker-b");
    expect(real[6]).toBe(0);
  });

  it("batchSize caps the claim to the oldest mutations", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1", "m2", "m3"]);
      const result = await o.replay(async () => ({ status: 200 }), { batchSize: 2 });
      return [result, snapshot(o)];
    });
    expect(real[0]).toEqual({ processed: 2, successful: 2, failed: 0 });
    expect((real[1] as Array<{ id: string }>).map((r) => r.id)).toEqual(["m3"]);
  });

  describe("conflict policies on HTTP 409", () => {
    it("server-wins: rollback callback runs, mutation is removed", async () => {
      const { real } = await both(async (o) => {
        const rolledBack: string[] = [];
        seed(o, ["m1"], {
          conflictPolicy: "server-wins",
          onRollback: (m) => {
            rolledBack.push(m.mutation_id);
          },
        });
        const result = await o.replay(async () => ({ status: 409, data: { v: 2 } }));
        return [result, rolledBack, snapshot(o)];
      });
      expect(real[0]).toEqual({ processed: 1, successful: 1, failed: 0 });
      expect(real[1]).toEqual(["m1"]);
      expect(real[2]).toEqual([]);
    });

    it("client-wins: re-queued as pending with forced flag and X-Force-Overwrite, then wins", async () => {
      const { real } = await both(async (o) => {
        seed(o, ["m1"], { conflictPolicy: "client-wins" });
        const trace: unknown[] = [];
        trace.push(await o.replay(async () => ({ status: 409 })), snapshot(o));
        vi.advanceTimersByTime(5);
        const headersSeen: unknown[] = [];
        trace.push(
          await o.replay(async (m) => {
            headersSeen.push(m.headers, m.forced);
            return { status: 200 };
          }),
          headersSeen,
          snapshot(o)
        );
        return trace;
      });
      expect((real[1] as Array<unknown>)[0]).toMatchObject({
        status: "pending",
        forced: true,
        headers: { "X-Force-Overwrite": "true" },
        lease_owner: null,
      });
      expect(real[4]).toEqual([]);
    });

    it("merge: mergeResolver(local, server) becomes the payload and the mutation is re-queued", async () => {
      const { real } = await both(async (o) => {
        seed(o, ["m1"], {
          conflictPolicy: "merge",
          payload: { theme: "dark" },
          mergeResolver: (local, server) => ({ ...(server as object), ...(local as object) }),
        });
        const trace: unknown[] = [];
        trace.push(await o.replay(async () => ({ status: 409, data: { theme: "light", lang: "en" } })), snapshot(o));
        return trace;
      });
      expect((real[1] as Array<unknown>)[0]).toMatchObject({
        status: "pending",
        forced: false,
        payload: { theme: "dark", lang: "en" },
        retry_count: 0,
      });
    });

    it("no policy defaults to server-wins (rollback and remove)", async () => {
      const { real } = await both(async (o) => {
        seed(o, ["m1"]);
        const result = await o.replay(async () => ({ status: 409 }));
        return [result, snapshot(o)];
      });
      expect(real[1]).toEqual([]);
    });
  });

  it("rate limit sleeps between mutations in a batch, never before the first", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1", "m2", "m3"]);
      const stamps: number[] = [];
      const run = o.replay(
        async () => {
          stamps.push(Date.now());
          return { status: 200 };
        },
        { rateLimitMs: 100 }
      );
      await vi.advanceTimersByTimeAsync(500);
      await run;
      return stamps.map((s) => s - stamps[0]);
    });
    expect(real).toEqual([0, 100, 200]);
  });

  it("markStatus keeps the lease only for in_flight and clears it otherwise", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1", "m2"]);
      o.claimPendingMutations("worker-a", 30_000);
      vi.advanceTimersByTime(5);
      o.markStatus("m1", "in_flight");
      o.markStatus("m2", "failed", "manual");
      return snapshot(o);
    });
    const rows = real as Array<{ lease_owner: string | null; status: string; error?: string }>;
    expect(rows[0]).toMatchObject({ status: "in_flight", lease_owner: "worker-a" });
    expect(rows[1]).toMatchObject({ status: "failed", lease_owner: null, error: "manual" });
  });

  it("any non-2xx, non-409, non-4xx status (0, 302, 500) is transient", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1", "m2", "m3"]);
      const codes: Record<string, number> = { m1: 0, m2: 302, m3: 500 };
      const result = await o.replay(async (m) => ({ status: codes[m.mutation_id] ?? 200 }));
      return [result, snapshot(o)];
    });
    expect(real[0]).toEqual({ processed: 3, successful: 0, failed: 0 });
    expect((real[1] as Array<{ status: string; retry_count: number }>).map((r) => [r.status, r.retry_count])).toEqual([
      ["pending", 1],
      ["pending", 1],
      ["pending", 1],
    ]);
  });

  it("stale completion after takeover is not fenced: worker A's 200 removes B's row", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1"]);
      const trace: unknown[] = [];
      await o.replay(
        async () => {
          vi.advanceTimersByTime(30_001); // A's lease expires mid-flight
          const b = o.claimPendingMutations("worker-b", 30_000);
          trace.push(b.map((m) => m.lease_owner), snapshot(o));
          return { status: 200 };
        },
        { workerId: "worker-a", leaseDurationMs: 30_000 }
      );
      trace.push(snapshot(o));
      return trace;
    });
    expect(real[0]).toEqual(["worker-b"]);
    expect(real[2]).toEqual([]);
  });

  it("stale failure after takeover is not fenced: worker A's 503 clears B's lease and re-queues the row", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1"]);
      const trace: unknown[] = [];
      await o.replay(
        async () => {
          vi.advanceTimersByTime(30_001); // A's lease expires mid-flight
          o.claimPendingMutations("worker-b", 30_000);
          trace.push(snapshot(o));
          return { status: 503 };
        },
        { workerId: "worker-a", leaseDurationMs: 30_000 }
      );
      trace.push(snapshot(o));
      return trace;
    });
    expect(real[0]).toEqual([expect.objectContaining({ status: "in_flight", lease_owner: "worker-b" })]);
    expect(real[1]).toEqual([
      expect.objectContaining({ status: "pending", retry_count: 1, lease_owner: null, lease_until: null }),
    ]);
  });

  it("re-enqueueing an existing id upserts: created_at and retry_count reset", async () => {
    const { real } = await both(async (o) => {
      seed(o, ["m1"]);
      await o.replay(async () => ({ status: 503 }));
      vi.advanceTimersByTime(50);
      seed(o, ["m1"]);
      return snapshot(o);
    });
    expect((real as Array<{ retry_count: number; status: string }>)[0]).toMatchObject({ retry_count: 0, status: "pending" });
  });

  it("option-level onRollback and mergeResolver are the fallbacks when a mutation has none of its own", async () => {
    const calls: string[] = [];
    const { real } = await both(
      async (o) => {
        calls.length = 0;
        seed(o, ["rb"], { conflictPolicy: "server-wins" });
        seed(o, ["mg"], { conflictPolicy: "merge" });
        const result = await o.replay(async () => ({ status: 409, data: { server: true } }));
        return [result, snapshot(o), [...calls]];
      },
      {
        onRollback: (m) => {
          calls.push(`rollback:${m.mutation_id}`);
        },
        mergeResolver: (local, server) => ({ ...(server as object), ...(local as object), merged: true }),
      }
    );
    expect(real[0]).toEqual({ processed: 2, successful: 1, failed: 0 });
    const rows = real[1] as Array<{ id: string; status: string; payload: unknown }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "mg", status: "pending", payload: { server: true, id: "mg", merged: true } });
    expect((real[2] as string[]).some((c) => c === "rollback:rb")).toBe(true);
  });
});
