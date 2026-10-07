---
title: "timing-controls-simulator"
id: F-013
status: refined
from_idea: I-013
---

# timing-controls-simulator

## Summary

Build interactive timing and persistence simulators in `apps/docs`:
1. **Timing Controls Simulator** (`<TimingPlayground />`):
   - Sliders for `throttleMs` and `debounceMs`.
   - Rapid event burst generator (e.g. 60Hz mouse movement or ticker generator).
   - Real-time comparison graph/metrics showing Raw Event Count vs UI Render Count, demonstrating render suppression.
   - Query debouncing demo showing search input keystrokes collapsing into a single request.
2. **Offline Outbox & Conflict Simulator** (`<OutboxPlayground />`):
   - Online/Offline toggle simulating network drops.
   - Enqueue mutations while offline with visual outbox queue table.
   - Replay controls with `rateLimitMs` pacing and `batchSize` chunking.
   - Interactive conflict simulator testing `server-wins`, `client-wins`, and `merge` policies.
3. **CAS Package Cache Inspector** (`<CasPlayground />`):
   - In-memory / browser virtual CAS store simulator with SHA-256 computation.
   - Drag-and-drop or text payload storage with simulated disk quota and LRU pruning visualization.

## Acceptance criteria

- [ ] `<TimingPlayground />` allows users to adjust `throttleMs` and `debounceMs` and generate rapid event streams.
- [ ] Render counter and visual stream activity bar show suppression ratio (e.g. 50 events -> 2 renders).
- [ ] Query debounce input collapses fast typing into one network execution with countdown indicators.
- [ ] `<OutboxPlayground />` allows enqueuing offline mutations and executing paced replay with `rateLimitMs` and configurable conflict policies.
- [ ] `<CasPlayground />` displays stored CAS objects, hashes, access timestamps, and visualizes LRU eviction when size exceeds limit.
- [ ] Automated tests in `apps/docs/tests/timing-playground.test.tsx` and `apps/docs/tests/outbox-playground.test.tsx` verify logic and rendering.
