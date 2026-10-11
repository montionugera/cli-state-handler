---
title: "Make release.yml publish loop tolerate overlapping runs (skip on staged/409, wait for npm to show version)"
id: F-047
status: refined
from_idea: I-047
---

# Make the release publish loop tolerate overlapping runs

## Problem

Two pushes to `main` land seconds apart (the release merge, then the "finalize cleanup" commit). Each starts a `release.yml` run; the shared `release` concurrency group queues the second behind the first. On 2026-10-11 the first run uploaded `@montionugera/ucsa-core@0.3.0` and the second started before npm showed it. Its `npm view` found nothing, so it uploaded again and failed with `E409 Cannot publish over previously staged version "0.3.0"`. The main run went red and the registry sat half-published (cli 0.3.0 live, core 0.3.0 not yet visible) until npm finished processing. Cause is a strong hypothesis (about 65%), not proven: see the investigation of runs 38113881833 and 38113899301.

## Why now

Release 1.10 just hit it. The same overlap happens on every promote (merge commit plus cleanup commit), so it will recur.

## Sketch

Move the publish loop from `release.yml` into `scripts/release/publish-packages.sh` so it can be tested with a stub `npm`. Behaviour per package, in order core then cli:

1. If `npm view name@version` already shows the version: skip (unchanged).
2. Else pack and `npm publish`. If it succeeds: continue.
3. If it fails and the output contains `E409`, `previously staged` or `Cannot publish over`: poll `npm view name@version` every 15 s for up to 5 minutes. Version appears: print a skip line and continue. Never appears: fail with a message saying the version may be staged and awaiting approval on npmjs.com.
4. Any other publish failure fails at once, exactly as today.

`release.yml` keeps its file name, the step name, and no `environment:` key; the step just calls the script.

## Acceptance criteria

- [ ] A stub-npm test: the version is already visible, so nothing is packed or published.
- [ ] A stub-npm test: publish returns E409 and the version appears on the second poll, so the script exits 0 with a skip line.
- [ ] A stub-npm test: publish returns E409 and the version never appears (poll limit shortened by env), so the script exits non-zero with the "staged" message.
- [ ] A stub-npm test: publish fails with a non-409 error, so the script exits non-zero immediately, with no polling.
- [ ] `release.yml` still has no `environment:` key, the same file name and the same step name "Publish to npmjs.com (trusted publishing)", that step now calls `scripts/release/publish-packages.sh`, `npm publish` appears only in the script, and `actionlint` exits 0.
- [ ] Gate 1 (`scripts/precheck.sh`) exits 0.
- [ ] No real publish is made while testing; the real proof is the next release.

## Audit amendments (independent audit, 2026-10-11)

- [ ] `scripts/epic-check.sh` assertion 3 (publish before docs build) is updated to look for `publish-packages.sh` instead of `npm publish` in `release.yml`, and `bash scripts/test-epic-check.sh`-style checks still pass.
- [ ] The visibility check reads npm's stdout (equals the version = published; E404 = not yet; anything else fails at once) and uses `--prefer-online`, mirroring `scripts/release/next-release.mjs`.
- [ ] The race errors matched are: E409, "previously staged", and E403 "cannot publish over the previously published versions" (case-insensitive). Each is confirmed by polling before it is treated as a skip. The skip line says it assumed the same content (both runs check out `main`).
- [ ] Extra stub tests: core is skipped after a 409 and cli still publishes; the E403 race; the exact E409 message from run 38113899301; the stub `pnpm` writes a real `.tgz` into `--pack-destination`.
- [ ] The script sets `RUNNER_TEMP` safely (`: "${RUNNER_TEMP:?}"`; tests set it), `cd`s to the repo root, and captures output with `if ! npm publish ...; then` (no bare redirect under `set -e`).
- [ ] `shellcheck` exits 0 on the script.
- [ ] README Publishing section (around line 2694-2711) mentions the script.
- [ ] Recorded real-release check: on the next promote, the second run shows a skip line, not E409. npm lag on 2026-10-11 was up to about 158 s for core; the 5-minute limit is sized from that.
