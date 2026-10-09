---
title: "Docs visualiser phone-width and cosmetic fixes"
id: I-037
status: idea
---

# Docs visualiser phone-width and cosmetic fixes

## Problem

A real-browser pass (2026-10-09, Chrome, desktop and a 360px viewport) over the five
shipped docs visualisers in `apps/docs` found four defects. All five visualiser features
are already shipped, so no open feature owns these fixes.

1. **CAS playground overflows horizontally at 360px.** `.card` is 352px inside a 346px
   main and grows to about 571px after one store. Long hash/key rows (the object table
   and the "Stored ..." log line) have no wrapping, no `overflow-x: auto` wrapper and no
   `min-width: 0`.
   Files: `apps/docs/src/components/CasPlayground.tsx`, `CasPlayground.css`.
2. **SWR state graph and timeline are unreadable at 360px.** The state graph SVG scales
   to about 0.58x (labels about 7.6px) and the timeline to about 0.53x (labels about 6.4px).
   Files: `LifecycleGraph.tsx/.css`, `StaleTimeline.tsx/.css`.
3. **SWR timeline scrollbar renders as a bright white bar on the dark theme.**
   File: `StaleTimeline.css`.
4. **Outbox: newly enqueued ids carry an "x" suffix** (`mut_001x`, `mut_002x`) beside the
   seeded `mut_001` / `mut_002`, which reads like duplicate ids.
   File: `apps/docs/src/components/OutboxPlayground.tsx`.

## Why now

The epic E-008 docs portal is about to close; these are the only defects the browser
pass found in shipped slices.

## Sketch

- CAS: wrap the object table in an `overflow-x: auto` container, add `min-width: 0` to
  the card / grid children, and let hash/key text wrap (`overflow-wrap: anywhere`).
- SWR: give the two SVG containers a minimum width with horizontal scroll at narrow
  widths so label text renders at 11px or larger, instead of scaling the whole SVG down.
- Timeline scrollbar: dark scrollbar (`color-scheme: dark` or `scrollbar-color`).
- Outbox: new ids continue the seeded sequence (`mut_003`, `mut_004`, ...) with no suffix.

Out of scope: `App.tsx`, `index.css`, `shell.css`, `router.ts`, `routes.ts`, README, and
any change to the tested models' behaviour beyond the outbox id label.

## Acceptance criteria

- [ ] At a 360px viewport, `#/cas` has no horizontal page overflow before and after
      storing three objects (`document.documentElement.scrollWidth <= clientWidth`).
- [ ] At a 360px viewport, every text label in the `#/swr` state graph and timeline
      renders at 11px or larger; any scrolling is inside the diagram container, not the page.
- [ ] The `#/swr` timeline scrollbar is dark on the dark theme.
- [ ] Ids of newly enqueued outbox mutations continue the seeded numbering with no
      letter suffix and never collide with an existing id; a unit test covers this.
- [ ] Existing docs tests still pass and `pnpm --filter @ucsa/docs build` succeeds.
