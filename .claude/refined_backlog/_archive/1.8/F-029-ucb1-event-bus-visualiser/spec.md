---
title: "UCB1 event bus visualiser"
id: F-029
status: refined
from_idea: I-029
---

# UCB1 event bus visualiser

Slice 3 of epic E-008 (docs portal). Depends on slice 2.

## Problem

The UCB1 event bus (README section 9: 12-byte big-endian header, magic `UCB1`) has no visualiser. The real codec, `packages/core/src/ipc/frame-codec.ts`, uses the Node `Buffer` global and cannot be bundled for the browser.

## Scope

- `apps/docs/src/models/ucb1-codec.ts`: encode/decode on `Uint8Array` + `DataView`, mirroring the real codec's header layout, limits and error cases. `@ucsa/core` is not modified.
- `apps/docs/tests/ucb1-codec.parity.test.ts`: for a fixture set (empty payload, ASCII, multi-byte UTF-8, maximum size, each frame type) assert the model's bytes equal the real `frame-codec` output, and that each decodes the other's frames. Malformed input (bad magic, truncated header, oversized length) is rejected by both.
- `apps/docs/src/components/Ucb1Visualiser.tsx` + its CSS: compose a frame, see the header bytes labelled field by field, publish through a simulated hub to 2–4 subscriber "processes", inject a corrupted frame and see it rejected.
- One line in `routes.ts`.

## Acceptance criteria

- [ ] `ucb1-codec.parity.test.ts` passes: identical bytes to the real codec for every fixture, starting with the bytes `UCB1`.
- [ ] Round trip in the model returns the original payload for every fixture.
- [ ] `apps/docs/tests/ucb1-visualiser.test.tsx`: publishing a frame delivers it to every subscribed process and not to an unsubscribed one.
- [ ] The same test: a frame with bad magic shows an error state and is delivered to nobody.
- [ ] The built bundle contains no `Buffer` polyfill and no `node:` import.

## Non-goals

Real sockets, the Dart/C# codecs (covered as code in slice 8).
