---
title: "Fix flaky Copied timer in MultiPlatformDocs"
id: F-043
status: refined
from_idea: I-044
---

# Fix flaky Copied timer in MultiPlatformDocs

## Problem

`apps/docs/src/components/MultiPlatformDocs.tsx` (`SnippetView.handleCopy`, lines ~20 and ~26) starts a 2-second `setTimeout` to reset the copy status and never clears it. If the component unmounts, or the test environment tears down, before the timer fires, `setStatus` runs against a gone jsdom window and throws `ReferenceError: window is not defined` as an unhandled error. It has failed Gate 1 (pre-ship build/test) intermittently at least twice during epic E-009 (F-038, F-040) and once in the E-008 precheck.

## Why now

The flake can fail any release's Gate 1 and blocks promoting release 1.9. The owner asked for it to be fixed before promoting.

## Sketch

Track the timer id in a ref, clear it on unmount (effect cleanup) and before starting a new one. No behaviour change for users: "Copied!" / "Failed" still reset to idle after 2 seconds.

## Acceptance criteria

- [ ] The reset timer is cleared when `SnippetView` unmounts, so no `setStatus` call happens after unmount.
- [ ] Starting a new copy clears any pending reset timer (no overlapping timers).
- [ ] A test covers it: copy, unmount before 2 seconds with fake timers, advance time, and assert no error and no state update.
- [ ] Visible behaviour is unchanged: status shows "copied" or "failed", then returns to idle after 2 seconds (existing tests still pass).
- [ ] `bash scripts/precheck.sh` ends `Gate 1: ok`.
