---
title: "Outbox playground on a tested model"
id: I-032
status: idea
---

# Outbox playground on a tested model

Slice 6 of epic E-008 (docs portal). Depends on slice 2.

## Problem

`OutboxPlayground.tsx` imports only the `ConflictPolicy` type; its queue is a mock. The real `query/mutation-outbox.ts` is SQLite-bound, and the playground shows none of its lease or rate-limit behaviour.

## Scope

- `apps/docs/src/models/outbox-model.ts`: in-memory outbox with a controllable clock: enqueue, lease (`lease_owner`, `lease_until`), complete, fail with retry/backoff, lease expiry and takeover by another worker, rate limit, and the conflict policies exposed by `ConflictPolicy`. `@ucsa/core` is not modified.
- `apps/docs/tests/outbox-model.parity.test.ts`: drive the same scripted sequence through the real `MutationOutbox` (on an in-memory or temp SQLite database, as the core tests do) and through the model; assert the same status transitions and the same winner on lease takeover.
- `OutboxPlayground.tsx` rewired onto the model: offline/online toggle, two competing workers, visible lease owner and countdown, rate-limit meter, conflict outcome per policy.

## Acceptance criteria

- [ ] `outbox-model.parity.test.ts` passes for: happy path, retry after failure, lease expiry and takeover, each conflict policy.
- [ ] A mutation enqueued while offline stays pending and flushes in order once online.
- [ ] Two workers never hold a live lease on the same mutation at the same time.
- [ ] `apps/docs/tests/outbox-playground.test.tsx` passes against the rewired component.
- [ ] The built bundle contains no `better-sqlite3`.

## Non-goals

Real network calls, persistence across reloads.
