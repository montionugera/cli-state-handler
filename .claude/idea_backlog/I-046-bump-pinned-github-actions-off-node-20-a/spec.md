---
title: "Bump pinned GitHub Actions off Node 20 and confirm Ubuntu 26 readiness"
id: I-046
status: idea
---

# Bump pinned GitHub Actions off Node 20 and confirm Ubuntu 26 readiness

**In plain words.** Our two automation files (`.github/workflows/ci.yml`, which checks every pull request, and `.github/workflows/release.yml`, which publishes the packages to npmjs.com) borrow three ready-made building blocks from GitHub and pnpm. We use old versions of those blocks, built for a runtime (Node.js 20) that GitHub has retired, so GitHub now force-runs them on a newer runtime and prints a warning on every run. This change swaps six version numbers for the current versions and proves, without publishing anything by accident, that both files still work, including on the newer Ubuntu machine image GitHub is about to make the default.

## Problem

- Both workflows pin `actions/checkout@v4`, `pnpm/action-setup@v4` and `actions/setup-node@v4`. All three target Node.js 20.
- Release run 37930906435 (2026-10-09) carries this warning annotation: "Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run on Node.js 24: actions/checkout@v4, actions/setup-node@v4, pnpm/action-setup@v4."
- The same run carries a notice that the `ubuntu-latest` machine label migrates to Ubuntu 26. That run used image `ubuntu-24.04`; nothing in this repository has run on Ubuntu 26 yet.

## Why now

- The forced-runtime shim is temporary; code we do not control is already running on a runtime it was not released for, inside the job that publishes.
- `ubuntu-latest` starts moving to Ubuntu 26.04 on 2026-10-19 and finishes by 2026-11-19 (actions/runner-images issue 14748). The label `ubuntu-26.04` has been generally available since 2026-09-17 (issue 14747), so it can be trialled now.
- Constraint: idea I-038 (adopt the Joymify design system), owned by another session on the same release 1.10, edits both workflow files. This change is implemented only after I-038 has landed on `release/1.10`, on top of it.

## Sketch

Decisions already made (not reopened here): move to the latest majors; keep pinning by major tag, matching the existing style; keep `runs-on: ubuntu-latest`.

Exactly six lines change, three in each file, and nothing else:

| Action | From | To | Latest release checked |
| --- | --- | --- | --- |
| `actions/checkout` | `@v4` | `@v7` | v7.0.1 |
| `pnpm/action-setup` | `@v4` | `@v6` | v6.1.0 |
| `actions/setup-node` | `@v4` | `@v7` | v7.1.0 |

All three declare `using: node24` in their `action.yml` at those tags. Research concluded `runs-on` does not need to change. The commit subject is `ci: bump pinned GitHub Actions to Node 24 majors`; the type `ci` matters (see Verification plan).

## Research findings

Checked with read-only `gh api` calls on 2026-10-09: release notes of every major, `action.yml` and README at the target tags, and this repository's workflow files and scripts.

**1. setup-node v5, v6, v7.**
- v5 turned on automatic dependency caching when `package.json` has a `packageManager` field. v6 narrowed that to npm only. The root `package.json` has no `packageManager` field (`grep -c packageManager package.json` prints `0`) and we use pnpm, so no cache is created or restored. No effect.
- v7 stops exporting a placeholder `NODE_AUTH_TOKEN` (today's logs show `NODE_AUTH_TOKEN: XXXXX-XXXXX-XXXXX-XXXXX` on every step). Its README states npm trusted publishing "is not affected, since it does not use `NODE_AUTH_TOKEN`", and warns that with `registry-url` set and no token "pnpm may warn". `release.yml` sets `registry-url`, so the npm settings file that setup-node writes will reference a variable that is no longer set. Expected result: a pnpm warning, no failure. This is the one behaviour change that touches the publish job, and `ci.yml` cannot exercise it because `ci.yml` sets no `registry-url`.
- `node-version` and `registry-url` inputs are unchanged.

**2. pnpm/action-setup v5, v6.**
- v5 only moved to Node.js 24. v6 changed the mechanism: it installs a newer bootstrap pnpm and then runs `pnpm self-update <version>`. The `version` input still exists and still wins; it throws only if `package.json` also names a different pnpm in `packageManager`, which ours does not.
- Early v6 releases ignored `version: 10` and ran pnpm 11 (pnpm/action-setup issue 225, still open). The fix (pull request 230) merged 2026-04-18 and the v6.1.0 source orders the path entries so the requested version is found first. Because the issue is still open, the pnpm version is asserted in the acceptance criteria rather than assumed.

**3. checkout v5, v6, v7.**
- v5 only moved to Node.js 24. v6 stores persisted credentials in a separate file instead of `.git/config`. v7 blocks checking out fork pull requests for the `pull_request_target` and `workflow_run` triggers.
- Neither change applies. Both workflows set `persist-credentials: false`, so nothing is persisted in either location, and the release job's commit, tag and push pass their own header (`git -c http.extraheader=...`) on each command. `ci.yml` uses the `pull_request` trigger. The `ref`, `fetch-depth` and `persist-credentials` inputs are unchanged.

**4. Ubuntu 26.**
- `better-sqlite3` is locked at 12.11.1, whose release publishes a prebuilt binary for Node.js 22 on 64-bit Linux (`node-v127-linux-x64`). It is chosen by Node.js version and processor, not by Ubuntu version, so the same file is used on Ubuntu 24 and 26.
- If that download fails, pnpm compiles from source. The Ubuntu 26.04 image lists GNU C++ 13/14/15 and Python 3.14.4. The .NET tests need `net8.0`; the image lists .NET SDK 8.0.x.

## Verification plan

The release decision script `scripts/release/next-release.mjs` publishes only when it prints `action=release` or `action=publish-only`. Reading `scripts/release/lib.mjs`: a commit releases only if its subject is `release <major.minor>` or if its subject or any body line starts with `feat`, `fix` or `perf` (or carries `!`). A `ci:` commit yields `action=none`, and every publishing step is skipped. Run on `main` today it prints `action=none` and `version=0.2.0`.

Three checks, in order, all before the change is shipped into the release:

1. **Pull-request check.** Open a draft pull request from the feature branch to `main` (never merged; closed afterwards). `ci.yml` runs only for pull requests into `main`. It proves the three new actions check out, install pnpm 10, set up Node.js 22, install with the frozen lockfile (including `better-sqlite3`) and pass the Gate 1 script `scripts/precheck.sh`.
2. **Ubuntu 26 trial.** On that same draft pull request, push one temporary commit changing `runs-on` in `ci.yml` to `ubuntu-26.04`, read the result, then revert it with a second commit. The final diff stays at six lines.
3. **Release rehearsal without publishing.** Start `release.yml` by hand from the feature branch: `gh workflow run release.yml --ref <feature-branch>`. GitHub then uses the branch's copy of the workflow (new pins) while the job still checks out `main` (`ref: main` is hard-coded), where the decision is `action=none`. Precondition, checked immediately before: `node scripts/release/next-release.mjs` on an up-to-date `main` prints `action=none`. If it prints anything else, do not start the rehearsal. The rehearsal also runs I-038's workflow edits, because the branch sits on top of them.

**What cannot be proven without a real release:** the "Commit version bump and tag" step and the "Publish to npmjs.com" step (the token-free identity exchange with npmjs.com) never run when the decision is `action=none`. Their first run on the new pins is the release 1.10 merge itself. Research finds no change that reaches either step, and the workflow is built to be re-run after a failed publish.

**Rollback.** Before shipping: `git revert <pin-commit>` on the feature branch. After release 1.10 is on `main`: a hotfix pull request to `main` whose only commit is that revert, subject `ci: revert action pins`; being a `ci:` commit, its merge prints `action=none` and publishes nothing.

## Acceptance criteria

`<base>` is the commit the feature branch started from; `<run>` is the run id named in each item.

- [ ] Only six lines change: `git diff --numstat <base>..HEAD` prints exactly `3 3 .github/workflows/ci.yml` and `3 3 .github/workflows/release.yml`.
- [ ] Pins are correct: `grep -ohE '(actions|pnpm)/[a-z-]+@v[0-9]+' .github/workflows/ci.yml .github/workflows/release.yml | sort | uniq -c` prints `2 actions/checkout@v7`, `2 actions/setup-node@v7`, `2 pnpm/action-setup@v6`.
- [ ] Publishing trust is untouched: `test -f .github/workflows/release.yml && grep -cE '^\s+environment:' .github/workflows/release.yml` prints `0`, and `grep -c 'npm publish' .github/workflows/release.yml` prints `1`.
- [ ] Pull-request check passes: `gh pr checks <draft-pr>` shows `precheck` as `pass`.
- [ ] pnpm is still major 10: `gh run view <run> --log | grep -oE 'using pnpm v[0-9]+' | sort -u` prints `using pnpm v10` for the pull-request run and for the rehearsal run.
- [ ] The deprecation warning is gone: `gh api repos/montionugera/cli-state-handler/check-runs/<job-id>/annotations -q '.[].message' | grep -c 'Node.js 20'` prints `0` for both runs.
- [ ] Ubuntu 26 trial passes: for the temporary-commit run, `gh run view <run> --log | grep -m1 'Image: '` ends with `Image: ubuntu-26.04` and `gh run view <run> --json conclusion -q .conclusion` prints `success`.
- [ ] Rehearsal publishes nothing: `gh run view <run> --log | grep -oE 'action=[a-z-]+'` prints `action=none`; `gh run view <run> --json jobs -q '.jobs[0].steps[] | select(.name|test("Commit version|Publish to npmjs")) | .conclusion'` prints `skipped` twice; `npm view @montionugera/ucsa-cli version` still prints the version it printed before the rehearsal.
- [ ] Rehearsal run conclusion is `success`, with the "Decide release" step `success` (this is the step that reads npmjs.com through the settings file setup-node v7 writes).

## Risks

- **Permanent publish (highest).** A version published to npmjs.com cannot be withdrawn and its number can never be reused. The rehearsal starts the real release workflow; if `main` held an unreleased `feat`, `fix` or `perf` commit, it would publish. The precondition check in step 3 is therefore mandatory, not optional.
- **Unrehearsed steps.** The commit-and-push and publish steps first run on the new pins during the release 1.10 merge. A failure before the push publishes nothing; a failure after the tag is pushed is repaired by re-running the workflow, which publishes the tagged version without a second bump.
- **Trust binding.** npmjs.com trusts exactly the file `.github/workflows/release.yml` with a blank environment. Renaming the file, moving the publish step or adding `environment:` breaks publishing. The third acceptance item guards this.
- **Moving tags.** A major tag such as `@v7` follows new minor releases automatically; this is the existing accepted style and is unchanged.
- **Overlap with I-038.** Starting before I-038 lands would cause merge conflicts in both files, and I-038's planned install token could change how the settings file from setup-node v7 behaves. The rehearsal is run after I-038 for this reason.

## Out of scope

- Any workflow change beyond the six pin lines: permissions, caching inputs, `package-manager-cache`, pinning by commit hash, or switching to the newer `pnpm/setup` action.
- Changing `runs-on` permanently, upgrading pnpm, Node.js or `better-sqlite3`, or adding a `packageManager` field.
- Anything owned by I-038, and any change to the release decision script.

## UNVERIFIED

- That pnpm 10 only warns (does not fail) when the settings file references the unset `NODE_AUTH_TOKEN`; stated by the setup-node README, proven only by the rehearsal.
- That npmjs.com accepts read requests from the "Decide release" step under setup-node v7; proven only by the rehearsal.
- That the token-free publish succeeds under setup-node v7; stated by its README, provable only by a real release.
- That starting `release.yml` from a non-default branch is permitted for this repository once I-038 has changed its permissions.
- That `pnpm/action-setup@v6` resolves `version: 10` to pnpm 10 on a GitHub-hosted runner; read from source, not observed in a run.
- The minimum system-library version the `better-sqlite3` prebuilt binary needs, and whether the source-compile fallback works with Python 3.14.
