---
title: "F-029 plan"
id: F-029
---

# F-029 plan: UCB1 event bus visualiser

Goal: browser model of the UCB1 codec with byte parity to packages/core, a visualiser page, one route line. No change to packages/core, README.md, or apps/docs/package.json.

## Task 1: model + parity (test first)
- Write apps/docs/tests/ucb1-codec.parity.test.ts (fixtures: empty, ASCII, UTF-8, max size, every frame type; malformed: bad magic, flags, reserved, oversized, invalid JSON, truncated; fragmented stream). Red.
- Implement apps/docs/src/models/ucb1-codec.ts (Uint8Array/DataView/TextEncoder) and ucb1-hub.ts (fan-out of PUBLISH as EVENT). Green.
- Gate: tests pass; review; re-verify.

## Task 2: component (test first)
- Write tests/ucb1-visualiser.test.tsx: header labels, delivery to subscribers only, bad magic rejected with zero deliveries, flags/length rejected, invalid JSON, 4 processes.
- Implement Ucb1Visualiser.tsx + ucb1-visualiser.css (minmax grids, overflow-x containers, aria-live status, focus-visible, reduced motion).
- Add one route line (plus its import) in routes.ts, "Visualisers" group.

## Task 3: gates
- pnpm --filter @ucsa/docs test; npx tsc -b; pnpm --filter @ucsa/docs build + grep dist for node:/Buffer.from/better-sqlite3; scripts/precheck.sh.
- Docs: README.md is intentionally NOT edited here (a later slice regenerates it).

## Audit notes (self)
- Truncated header: real streaming decoder returns [] rather than throwing; the model mirrors that and adds a model-only TruncatedFrameError for one-shot decode.
- Unknown frame type bytes are not validated by the real codec; the model mirrors that.
