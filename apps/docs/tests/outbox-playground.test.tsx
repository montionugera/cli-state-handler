// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { OutboxPlayground } from "../src/components/OutboxPlayground.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const click = async (name: string | RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

const goOnline = async (): Promise<void> => click(/Network: OFFLINE/);

const batchOfFive = (): void => {
  fireEvent.change(screen.getByLabelText(/Batch size/i), { target: { value: "5" } });
};

const noPacing = (): void => {
  fireEvent.change(screen.getByLabelText(/Rate-limit pacing/i), { target: { value: "0" } });
};

const queueRow = (id: string): HTMLElement => {
  const table = screen.getByRole("table", { name: /outbox queue/i });
  const cell = within(table).getByText(id);
  const row = cell.closest("tr");
  if (!row) throw new Error(`row for ${id} not found`);
  return row;
};

const queueIds = (): string[] => {
  const table = screen.getByRole("table", { name: /outbox queue/i });
  return within(table)
    .queryAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("td")?.textContent ?? "");
};

/** Log lines in chronological order (the log renders newest first). */
const logLines = (): string[] =>
  Array.from(screen.getByRole("log").querySelectorAll("div"))
    .map((d) => d.textContent ?? "")
    .reverse();

const enqueue = async (opts: { policy: string; id?: string; conflict?: boolean }): Promise<void> => {
  fireEvent.change(screen.getByLabelText(/Conflict policy/i), { target: { value: opts.policy } });
  const box = screen.getByLabelText(/Server has a newer version/i) as HTMLInputElement;
  if (box.checked !== Boolean(opts.conflict)) fireEvent.click(box);
  await click(/Enqueue/);
};

describe("OutboxPlayground", () => {
  it("new mutation ids continue the seeded numbering with no suffix and never collide", async () => {
    render(<OutboxPlayground />);
    await enqueue({ policy: "server-wins" });
    await enqueue({ policy: "server-wins" });
    const ids = queueIds();
    expect(ids).toEqual(["mut_001", "mut_002", "mut_003", "mut_004"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is labelled as a browser model tested against the real outbox and starts offline", () => {
    render(<OutboxPlayground />);
    expect(screen.getByText("Offline Mutation Outbox & Conflict Resolution")).toBeDefined();
    expect(screen.getByText(/browser model/i).textContent).toMatch(/parity test suite/i);
    expect(screen.getByText(/browser model/i).textContent).not.toMatch(/\bCI\b/);
    expect(screen.getByRole("button", { name: /Network: OFFLINE/ })).toBeDefined();
  });

  it("log is a polite live region", () => {
    render(<OutboxPlayground />);
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("polite");
  });

  it("a mutation enqueued while offline stays pending and cannot be claimed or replayed", async () => {
    render(<OutboxPlayground />);
    await enqueue({ policy: "merge" });
    expect(queueIds()).toHaveLength(3);
    for (const id of queueIds()) expect(within(queueRow(id)).getByText(/pending/i)).toBeDefined();
    expect((screen.getByRole("button", { name: /Claim as Worker A/ }) as HTMLButtonElement).disabled).toBe(true);
    await click(/Replay Outbox/);
    expect(logLines().some((l) => /Replay held while OFFLINE/i.test(l) && /rule of this playground/i.test(l))).toBe(true);
    expect(screen.getByRole("note").textContent).toMatch(/does not check connectivity/i);
    expect(queueIds()).toHaveLength(3);
  });

  it("flushes in created order once online, then reports completion", async () => {
    render(<OutboxPlayground />);
    await enqueue({ policy: "merge" });
    const expected = queueIds();
    await goOnline();
    noPacing();
    batchOfFive();
    await click(/Replay Outbox/);
    const sent = logLines()
      .filter((l) => /Sent mut_/.test(l))
      .map((l) => /Sent (mut_\w+)/.exec(l)?.[1]);
    expect(sent).toEqual(expected);
    expect(logLines().some((l) => /Replay batch complete/i.test(l))).toBe(true);
  });

  it("two workers never hold a live lease on the same mutation; B wins only after expiry", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    expect(screen.getByRole("button", { name: /Network: ONLINE/ })).toBeDefined();
    await click(/Claim as Worker A/);
    expect(within(queueRow("mut_001")).getByText(/worker-a/)).toBeDefined();
    expect(within(queueRow("mut_001")).getByText(/expires in 30s/i)).toBeDefined();

    await click(/Claim as Worker B/);
    expect(logLines().some((l) => /worker-b claimed 0/i.test(l))).toBe(true);
    expect(within(queueRow("mut_001")).queryByText(/worker-b/)).toBeNull();

    await click(/Advance clock \+31s/);
    expect(within(queueRow("mut_001")).getByText(/lease expired/i)).toBeDefined();

    await click(/Claim as Worker B/);
    expect(within(queueRow("mut_001")).getByText(/worker-b/)).toBeDefined();
    expect(within(queueRow("mut_001")).queryByText(/worker-a/)).toBeNull();
    expect(logLines().some((l) => /worker-b claimed 2/i.test(l))).toBe(true);
  });

  it("503 responses retry back to pending, then fail permanently at the retry limit", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    for (let i = 0; i < 3; i++) {
      await click(/Claim as Worker A/);
      await click(/Worker A: respond 503/);
    }
    const row = queueRow("mut_001");
    expect(within(row).getByText(/failed/i)).toBeDefined();
    expect(within(row).getByText("3")).toBeDefined();
  });

  it("conflict outcome per policy: server-wins rolls back, client-wins forces, merge combines", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    noPacing();
    batchOfFive();
    // drop the two seeded rows so only the three policy rows remain
    await click(/Claim as Worker A/);
    await click(/Worker A: respond 200/);
    await enqueue({ policy: "server-wins", conflict: true });
    await enqueue({ policy: "client-wins", conflict: true });
    await enqueue({ policy: "merge", conflict: true });
    expect(queueIds()).toHaveLength(3);
    const [serverWins, clientWins, merge] = queueIds();

    await click(/Replay Outbox/);

    // server-wins: rolled back and removed
    expect(queueIds()).not.toContain(serverWins);
    expect(logLines().some((l) => l.includes(serverWins) && /server-wins/.test(l) && /rolled back/i.test(l))).toBe(true);
    // client-wins: re-queued, forced
    expect(within(queueRow(clientWins)).getByText(/X-Force-Overwrite/)).toBeDefined();
    expect(within(queueRow(clientWins)).getByText(/pending/i)).toBeDefined();
    // merge: payload now includes the server field and the mutation is pending again
    expect(within(queueRow(merge)).getByText(/pending/i)).toBeDefined();
    expect(queueRow(merge).textContent).toMatch(/serverField/);
    expect(logLines().some((l) => l.includes(merge) && /merged/i.test(l))).toBe(true);
  });

  it("rate-limit meter shows one send per pacing interval", async () => {
    render(<OutboxPlayground />);
    await enqueue({ policy: "merge" });
    await goOnline();
    batchOfFive();
    fireEvent.change(screen.getByLabelText(/Rate-limit pacing/i), { target: { value: "100" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Replay Outbox/ }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/Sent 1 of 3/)).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText(/Sent 2 of 3/)).toBeDefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText(/Sent 3 of 3/)).toBeDefined();
    expect(logLines().some((l) => /Replay batch complete/i.test(l))).toBe(true);
  });

  it("worker A's late 200 after B took over removes the row B leases (completion is not fenced)", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    await click(/Claim as Worker A/);
    await click(/Advance clock \+31s/);
    await click(/Claim as Worker B/);
    expect(within(queueRow("mut_001")).getByText(/worker-b/)).toBeDefined();
    await click(/Worker A: respond 200/);
    expect(queueIds()).not.toContain("mut_001");
    expect(logLines().some((l) => /worker-a got HTTP 200 for mut_001/.test(l) && /completion is not checked against the lease owner in the current library/.test(l))).toBe(true);
    expect(logLines().some((l) => /holds no/i.test(l))).toBe(false);
  });

  it("Replay still works on a row whose lease expired (in_flight but claimable)", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    noPacing();
    batchOfFive();
    await click(/Claim as Worker B/); // takes both seeded rows
    expect(within(queueRow("mut_001")).getByText(/in_flight/)).toBeDefined();
    await click(/Replay Outbox/);
    expect(logLines().some((l) => /No claimable mutations/i.test(l))).toBe(true);
    await click(/Advance clock \+31s/);
    await click(/Replay Outbox/);
    expect(logLines().some((l) => /Sent mut_001/.test(l))).toBe(true);
  });

  it("a re-queued replay row is not labelled resolved, and the outcome comes from the model", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    noPacing();
    batchOfFive();
    await click(/Claim as Worker A/);
    await click(/Worker A: respond 200/);
    await enqueue({ policy: "merge", conflict: true });
    const [id] = queueIds();
    await click(/Replay Outbox/);
    const line = logLines().find((l) => l.includes(id) && /merge/.test(l) && /re-queued/.test(l));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/Resolved|✅/);
  });

  it("stale 409 under server-wins: the row is gone but the rollback runs a second time", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    noPacing();
    batchOfFive();
    await click(/Claim as Worker A/);
    await click(/Worker A: respond 200/); // clear the seeded rows
    await enqueue({ policy: "server-wins" });
    const [id] = queueIds();
    await click(/Claim as Worker A/);
    await click(/Advance clock \+31s/);
    await click(/Claim as Worker B/);
    await click(/Worker B: respond 409/);
    expect(queueIds()).not.toContain(id);
    await click(/Worker A: respond 409/);
    const rollbacks = logLines().filter((l) => l.includes(`Rollback callback ran for ${id}`));
    expect(rollbacks).toHaveLength(2);
    const line = logLines().find((l) => /worker-a got HTTP 409/.test(l) && l.includes(id));
    expect(line).toMatch(/already gone/i);
    expect(line).toMatch(/rollback ran again/i);
    expect(line).not.toMatch(/nothing to settle/i);
  });

  it("stale 503 from A clears B's lease and re-queues the row with a higher retry count", async () => {
    render(<OutboxPlayground />);
    await goOnline();
    await click(/Claim as Worker A/);
    await click(/Advance clock \+31s/);
    await click(/Claim as Worker B/);
    expect(within(queueRow("mut_001")).getByText(/worker-b/)).toBeDefined();
    await click(/Worker A: respond 503/);
    const row = queueRow("mut_001");
    expect(within(row).getByText(/pending/i)).toBeDefined();
    expect(within(row).queryByText(/worker-b/)).toBeNull();
    expect(within(row).getByText("1")).toBeDefined();
    const line = logLines().find((l) => /worker-a got HTTP 503 for mut_001/.test(l));
    expect(line).toMatch(/clears worker-b's lease/);
    expect(line).toMatch(/as the current library does/);
  });

  it("explains that policy and callbacks live in the enqueuing instance's memory", () => {
    render(<OutboxPlayground />);
    expect(screen.getByText(/held in memory by the outbox instance that enqueued/i).textContent).toMatch(/not stored in SQLite/i);
  });
});
