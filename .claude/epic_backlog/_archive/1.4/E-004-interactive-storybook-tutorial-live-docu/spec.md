---
title: "Interactive Storybook Tutorial & Live Documentation System"
id: E-004
status: epic
---

# Interactive Storybook Tutorial & Live Documentation System

## Outcome

Developers exploring UCSA (Unified Client State Architecture) have an interactive, Storybook-like tutorial and live documentation application (`apps/docs`) that can be explored in-browser or launched directly via CLI (`ucsa tutorial` / `ucsa docs`).
The application features:
1. **Live SWR & Query Lifecycle Playground**: Real-time visualizer of cache hits, SWR background refetches, structural sharing equality diffs, and tag invalidations.
2. **Timing Controls & Conflict Simulator**: Interactive sliders for `throttleMs` and `debounceMs` demonstrating leading/trailing UI render suppression under high-frequency event streams, plus offline network toggles with `rateLimitMs` pacing and conflict policy resolution (`server-wins`, `client-wins`, `merge`).
3. **Multi-Platform Code Tutorial & CLI Launcher**: Interactive side-by-side runnable examples comparing TypeScript Core, Dart 3+, and C# Unity, with built-in dark/light theme, component stories, and terminal integration via `ucsa tutorial`.

## Slices

- `F-012`: live-swr-playground (SWR Cache Inspector, Structural Sharing Diff Visualizer, Tag Invalidation Simulator)
- `F-013`: timing-controls-simulator (Interactive Throttle/Debounce Sliders, Telemetry Stream, and Outbox Rate-Limiter)
- `F-014`: multiplatform-tutorial-docs (Multi-Platform Tutorial Switcher, CLI ucsa tutorial Launcher, Full-Chain E2E Gate)

## Acceptance Criteria

- [ ] `apps/docs` scaffolded with Vite, React 19, and Tailwind CSS as a lightweight, zero-overhead Storybook-like playground linked to `@ucsa/core` via `workspace:*`.
- [ ] Live SWR Playground (`<SwrPlayground />`) shows real-time cache entries, fetch states, structural sharing equality, and tag invalidations.
- [ ] Timing Controls Playground (`<TimingPlayground />`) demonstrates observer throttling/debouncing with visual stream graphs and render counters under rapid bursts.
- [ ] Outbox & CAS Simulator (`<OutboxPlayground />`, `<CasPlayground />`) simulates offline queuing, conflict policies (`server-wins`, `client-wins`, `merge`), and CAS SHA-256 storage with LRU pruning.
- [ ] Multi-Platform code comparison tab (`<MultiPlatformDocs />`) provides interactive snippet walkthroughs for TS Core, Dart 3+, and C# Unity.
- [ ] CLI command `ucsa tutorial` / `ucsa docs` in `apps/cli` starts the local documentation server (or prints direct preview url) with port collision fallback (6006 -> 6007).
- [ ] Automated tests in `apps/docs/tests/` and `apps/cli/tests/` verify component rendering and command routing.
- [ ] Full chain runner (`./scripts/e2e-full-chain.sh`) passes across all tiers.
- [ ] Gate 1 (`precheck.sh`) and Gate 2 (`integration.sh`) pass cleanly.
