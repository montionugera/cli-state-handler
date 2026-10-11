# Release publish loop tolerates overlapping runs (idea I-047) Implementation Plan

**Goal:** "Fix the release.yml publish loop so an overlapping duplicate run cannot fail on a staged or in-flight version (skip on 409, wait for npm to show the version)."

**Architecture:** Move the inline publish loop into `scripts/release/publish-packages.sh` (testable with a stub `npm` on PATH), keep the workflow step name and file name, and make the step call the script.

**Spec:** `spec.md` in this folder (copied to `.claude/refined_backlog/<F-NNN>/` by refine).

## Global Constraints

- Never rename `.github/workflows/release.yml`, change the step name "Publish to npmjs.com (trusted publishing)", move it, or add `environment:`. npmjs.com trusts exactly that file with a blank environment.
- No real publish while testing: tests put a stub `npm` first on PATH. Never run `release.yml`, `npm publish`, or `gh workflow run` for this feature. The real proof is the next release.
- Commit subjects must NOT start with `feat`, `fix` or `perf` (the release script would publish on merge); use `ci:`/`test:`. Never `git commit --amend`. Work only in the feature worktree.
- `STOP — needs the owner's yes:` marks any push, PR, promote or merge. A yes covers that one action.
- README: no update needed unless a doc names the publish loop; Task 3 greps for it.

## Task 1: Script and tests, test-first

**Files:** Create `scripts/release/publish-packages.sh`, `scripts/release/test-publish-packages.sh`. Modify `scripts/precheck.sh` (add the new test next to the other release-script tests).

- [ ] **Step 1:** Write `test-publish-packages.sh`: a temp dir with a stub `npm` and `pnpm` on PATH, driven by env vars (what `view` returns per call, what `publish` returns and prints), `PUBLISH_POLL_SECONDS=0` style overrides (`PUBLISH_POLL_INTERVAL`, `PUBLISH_POLL_LIMIT`) so polling is instant. Four cases from the spec's acceptance criteria. Run it: it must FAIL (script missing).
- [ ] **Step 2:** Write `publish-packages.sh` (`set -euo pipefail`, packages `packages/core` then `apps/cli`, behaviour as in the spec Sketch; defaults interval 15 s, limit 20 polls = 5 minutes). Capture `npm publish` output to a file and echo it; match `E409|previously staged|Cannot publish over`.
- [ ] **Step 3:** Run the test: all four cases pass. Run `bash -n` and `shellcheck` if installed.
- [ ] **Step 4:** Add the test to `scripts/precheck.sh`; run `bash scripts/precheck.sh 2>&1 | tail -n 15` and expect `exit=0` via `bash -c '... ; echo exit=${PIPESTATUS[0]}'`.
- [ ] **Step 5:** Commit `test(ci)`-style but starting with `ci:` e.g. `ci: add tolerant publish-packages script with stub-npm tests`.

## Task 2: Wire the workflow

**Files:** Modify `.github/workflows/release.yml` (the publish step body only).

- [ ] **Step 1:** Replace the `run:` body of the step "Publish to npmjs.com (trusted publishing)" with a call to `bash scripts/release/publish-packages.sh`, keeping `mkdir -p "$RUNNER_TEMP/npmjs"` and the `RUNNER_TEMP` use inside the script. Keep the explanatory comment.
- [ ] **Step 2: Verify.** `actionlint .github/workflows/release.yml; echo exit=$?` is `exit=0`; `grep -cE '^\s+environment:' .github/workflows/release.yml` prints `0`; `grep -c 'name: Publish to npmjs.com (trusted publishing)'` prints `1`; `grep -c 'npm publish' .github/workflows/release.yml` prints `0` and `grep -c 'npm publish' scripts/release/publish-packages.sh` prints at least `1`; `git diff --numstat` touches only the step.
- [ ] **Step 3:** Commit `ci: call publish-packages.sh from the release publish step`.

## Task 3: Quality gate, README, ship

- [ ] **Step 1:** `grep -rn 'publish loop\|Publish to npmjs' README.md docs apps/docs 2>/dev/null | head`; update docs only if one describes the loop.
- [ ] **Step 2: Review.** Dispatch an independent `code-reviewer` (`model: opus`, this is the publish path) with the whole feature diff and the Global Constraints; it must confirm the publish behaviour is unchanged for the happy path (core then cli, skip when visible, fail on other errors) and that trusted publishing still works (OIDC runs in the npm CLI; `id-token: write` permission untouched).
- [ ] **Step 3:** Apply findings as new commits; re-run Gate 1.
- [ ] **Step 4:** `psrw ship --no-deploy` (local only).
- [ ] **Step 5:** STOP — needs the owner's yes: `psrw promote --babysit` (merges to main and runs the real release workflow; the release itself will publish only if a feat/fix commit exists, and these commits use `ci:`, so expect `action=none`).

## Audit amendments (take precedence over Tasks 1-3 above)

- Tests live in a vitest file `scripts/release/publish-packages.test.mjs` (runs the script with a stub `npm`/`pnpm` on PATH and `RUNNER_TEMP` set to a temp dir) instead of a bash test, so `pnpm test` and epic-check assertion 1 pick it up. Drop the `precheck.sh` edit from Task 1 unless the vitest run is not already covered by it.
- Task 1 cases: the four from the spec, plus core-409-then-cli-publishes, the E403 race, and the verbatim E409 text from run 38113899301.
- Task 1 Step 2 rules: `if ! npm publish ... >"$out" 2>&1; then` capture; visibility = `npm view --prefer-online name@version version` stdout equals the version, E404 means not yet, any other error fails at once; `: "${RUNNER_TEMP:?}"`; `cd` to repo root; run `shellcheck`.
- Task 2 also edits `scripts/epic-check.sh` assertion 3 (lines ~24-26) to find `publish-packages.sh`, then runs `bash scripts/test-epic-check.sh` (or the repo's epic-check test) and expects it to pass. The Task 2 Step 2 greps change: `grep -c 'npm publish' release.yml` is `0`, and `grep -c 'publish-packages.sh' release.yml` is `1`.
- Task 3 Step 1 now requires a README Publishing-section update (around lines 2694-2711).
