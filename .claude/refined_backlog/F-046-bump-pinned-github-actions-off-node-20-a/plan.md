# Bump pinned GitHub Actions off Node 20 (idea I-046) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap six action version pins in the two GitHub workflow files to their Node.js 24 majors and prove, without publishing anything, that the pull-request check and the release workflow still work, including on Ubuntu 26.

**Architecture:** One six-line commit on a feature branch, then three rehearsals in increasing risk: a draft pull request (runs `ci.yml`), a temporary Ubuntu 26 trial on that pull request, and two hand-started runs of `release.yml` from a throwaway branch whose publish powers have been removed. Only then is the feature merged into the release branch.

**Tech Stack:** GitHub Actions (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`), `gh` CLI, `actionlint`, `psrw` (the ps-release-workflow command that manages the release branch and feature worktrees), pnpm 10, Node.js.

**Spec:** `.claude/idea_backlog/I-046-bump-pinned-github-actions-off-node-20-a/spec.md` (after Task 1 it is copied to `.claude/refined_backlog/<F-NNN>/spec.md`). Read it before starting; this plan argues from it.

## Global Constraints

- The pin table, verbatim: `actions/checkout@v4` to `@v7`, `pnpm/action-setup@v4` to `@v6`, `actions/setup-node@v4` to `@v7`. Exactly six lines change, three in `.github/workflows/ci.yml` and three in `.github/workflows/release.yml`. `runs-on: ubuntu-latest` stays.
- Never rename `.github/workflows/release.yml`, move its publish step, or add `environment:` to its job. npmjs.com trusts exactly that file name with a blank environment; any of the three breaks publishing.
- Never start `release.yml` from the feature branch. Only from the disarmed throwaway branch `rehearsal/i-046` (Task 3).
- **A line starting `STOP — needs the owner's yes:` is irreversible or leaves this machine. Stop, ask the owner (the human who owns this repository), and wait. A yes covers that one line only. Never assume it.**
- Work only in the feature worktree created in Task 1; the main checkout blocks edits. Never `git commit --amend`; one new commit per logical unit. Commit subjects must start with `ci:` (a subject or body line starting `feat`, `fix` or `perf` would make the release script publish).
- Run local commands with the default Node.js (26); do not switch versions. The local `better-sqlite3` binary is x86_64; do not rebuild it for another architecture.
- Repository: `montionugera/cli-state-handler`. `<run>` always means the run id captured in the step just before.
- Evidence file: `EVID="$(git rev-parse --path-format=absolute --git-common-dir)/i-046-evidence.txt"`. It lives in the repository's shared git directory, so it never appears in a diff and survives `psrw ship` (which deletes the feature worktree together with that worktree's own git directory). Append every run id and command output named below to it.
- Shell variables do not survive between tool calls. State file: `ST="$(git rev-parse --path-format=absolute --git-common-dir)/i-046-state.sh"`. Whenever a step sets a variable (`SHA`, `BASE`, `BR`, `PIN`, `PR`, `TRIAL`, `RUN`, `EVID`), also append it: `echo "NAME='value'" >> "$ST"`. Start every new shell with `. "$ST"` and, before any command that uses a variable, confirm it is not empty (`test -n "$BR"`). An empty variable is a stop, never a reason to type a value from memory.
- Finding a run id: always by commit, never "the latest run". `RUN=$(gh run list --workflow <file> --commit "$(git rev-parse HEAD)" --limit 1 --json databaseId -q '.[0].databaseId'); test -n "$RUN" && echo "$RUN"`. Empty means GitHub has not registered the run yet: repeat the command until it prints an id. A lookup without `--commit` can return the previous run and make a check pass on the wrong run.

**README and docs:** no update is needed. The action versions are documented nowhere except the two workflow files: `grep -rnE 'checkout@|setup-node@|action-setup@' --include='*.md' --include='*.mdx' . --exclude-dir=node_modules --exclude-dir=graft` matches only this idea's folder and one archived plan under `.claude/epic_backlog/_archive/1.9/` (history, not edited). Task 1 re-runs that grep to confirm it is still true after I-038.

---

## Phase A: the six-line change

### Task 0: Prove idea I-038 has landed

I-038 (adopting the Joymify design-system packages in the docs site) is owned by another session, edits the same two workflow files, and must already be merged into the release branch `release/1.10`.

- [ ] **Step 1: Run the check** from the release worktree `/Users/pasitnusso/workspace/repos/cli-state-handler/.claude/worktrees/_release`:

```bash
SHA=$(jq -r '.[] | select(.from_idea=="I-038" and .shipped_sha!=null) | .shipped_sha' .claude/refined_backlog/_catalog.json)
test -n "$SHA" && git merge-base --is-ancestor "$SHA" release/1.10 && echo "I-038 landed at $SHA"
```

Expected: one line `I-038 landed at <40-character hash>` (save `SHA` to the state file). If it prints nothing (it prints nothing on 2026-10-09; I-038 is not yet refined), stop the whole plan and report "blocked on I-038". Do not continue.

### Task 1: Claim the feature and bump the pins

**Files:** Modify `.github/workflows/ci.yml` (three `uses:` lines), `.github/workflows/release.yml` (three `uses:` lines).

- [ ] **Step 1: Create the worktree.** `psrw refine` commits with `git add -A`, so it sweeps up every uncommitted file in the release worktree, including another session's. First run `git status --short` there: every line must be under `.claude/idea_backlog/I-046-bump-pinned-github-actions-off-node-20-a/`. Any other line (on 2026-10-09 there is one: a modified `spec.html` in I-038's folder) belongs to someone else: stop and report; do not stash, revert or commit it. Then run `psrw refine I-046` (turns the idea into a feature and prints its id, `F-NNN`), then `psrw claim F-NNN` (creates the feature worktree on branch `feat/F-NNN` and prints its path). `cd` into that path. Both commands are local only (checked in the psrw source on 2026-10-09: neither contains a push or a fetch); if either ever asks to push, stop and ask the owner.
- [ ] **Step 2: Record the base and confirm I-038 is underneath.** `BASE=$(git rev-parse HEAD); BR=$(git branch --show-current); echo "base=$BASE branch=$BR" >> "$EVID"`, then `git merge-base --is-ancestor "$SHA" HEAD && echo ok` (expected `ok`).
- [ ] **Step 3: Confirm the starting pins.** `grep -ohE '(actions|pnpm)/[a-z-]+@v[0-9]+' .github/workflows/ci.yml .github/workflows/release.yml | sort | uniq -c`. Expected exactly `2 actions/checkout@v4`, `2 actions/setup-node@v4`, `2 pnpm/action-setup@v4`. Any other line or count means I-038 changed the picture: stop and report, because the spec's six-line scope no longer holds.
- [ ] **Step 4: Implement.**

```bash
sed -i '' -E 's#actions/checkout@v4#actions/checkout@v7#; s#pnpm/action-setup@v4#pnpm/action-setup@v6#; s#actions/setup-node@v4#actions/setup-node@v7#' .github/workflows/ci.yml .github/workflows/release.yml
```

- [ ] **Step 5: Verify.** Run each; all must match.
  - `git diff --numstat` prints exactly `3 3 .github/workflows/ci.yml` and `3 3 .github/workflows/release.yml`.
  - The grep from Step 3 now prints `2 actions/checkout@v7`, `2 actions/setup-node@v7`, `2 pnpm/action-setup@v6`.
  - `grep -cE '^\s+environment:' .github/workflows/release.yml` prints `0`; `grep -c 'npm publish' .github/workflows/release.yml` prints `1`.
  - `actionlint .github/workflows/ci.yml .github/workflows/release.yml; echo exit=$?` prints `exit=0`.
  - The docs grep from "README and docs" above still matches only `.claude/` backlog files.
  - Gate 1 (the repository's fast local check): `pnpm install --frozen-lockfile | tail -n 5`, then `bash -c './scripts/precheck.sh 2>&1 | tail -n 15; echo exit=${PIPESTATUS[0]}'` prints `exit=0`.
- [ ] **Step 6: Commit.** `git add .github/workflows/ci.yml .github/workflows/release.yml && git commit -m "ci: bump pinned GitHub Actions to Node 24 majors"` (add the `Co-Authored-By` trailer the session specifies). Record `PIN=$(git rev-parse HEAD)` in `$EVID`; rollback needs it.
- [ ] **Step 7: Phase gate, review.** Dispatch a `code-reviewer` subagent (`model: sonnet`) with `git show $PIN` and the Global Constraints. It must confirm: six lines only, correct targets, no other line touched, trust constraints intact.
- [ ] **Step 8: Phase gate, refactor.** Apply any finding as a new `ci:` commit. If there are none, record "no findings" in `$EVID`.
- [ ] **Step 9: Phase gate, re-verify.** Re-run Step 5 with `git diff --numstat $BASE..HEAD` in place of `git diff --numstat`. Same expected output.

## Phase B: rehearsals (nothing here may publish)

Tasks 2 and 3 share one quality gate. Task 2 leaves no net diff, so the gate's independent review is Task 3 Step 3 (the disarm diff, reviewed before any run), its refactor is the fix-up in that same step, and its re-verify is Task 3 Step 16.

### Task 2: Pull-request check and Ubuntu 26 trial

`ci.yml` runs only for pull requests into `main`, so a draft pull request is the only way to exercise it. It is never merged: merging would put release 1.10's `feat` commits on `main` and publish.

- [ ] **Step 1:** STOP — needs the owner's yes: `git push -u origin "$BR"` (creates the feature branch on the remote).
- [ ] **Step 2:** STOP — needs the owner's yes: `gh pr create --draft --base main --head "$BR" --title "ci: bump pinned GitHub Actions to Node 24 majors (REHEARSAL, NEVER MERGE)" --body "Draft only, to run ci.yml. Closed after the checks. Do not merge."` Record the pull request number as `PR`.
- [ ] **Step 3: Verify the pull-request run.** Find `RUN` for `ci.yml` by commit (Global Constraints), `gh run watch "$RUN" --exit-status | tail -n 5`, then:
  - `gh pr checks "$PR"` shows `precheck` as `pass`.
  - `gh run view "$RUN" --log | grep -oE 'using pnpm v[0-9]+' | sort -u` prints `using pnpm v10`. This settles the spec's unverified item "pnpm/action-setup v6 resolves `version: 10` to pnpm 10". If it prints `v11`, stop: that is pnpm/action-setup issue 225; go to "If it goes wrong".
  - `JOB=$(gh run view "$RUN" --json jobs -q '.jobs[0].databaseId'); gh api "repos/montionugera/cli-state-handler/check-runs/$JOB/annotations" -q '.[].message' | grep -c 'Node.js 20'` prints `0`. Run the `gh api` call on its own first and confirm it exits 0: a failed call also makes the count `0`. (Checked on the old pins: the same command prints `1` for release run 37930906435, so the check can fail.)
- [ ] **Step 4: Ubuntu 26 trial commit.** In `.github/workflows/ci.yml` change the one line `runs-on: ubuntu-latest` to `runs-on: ubuntu-26.04`. `git commit -am "ci: TEMP trial on ubuntu-26.04 (reverted in the next commit)"`; record `TRIAL=$(git rev-parse HEAD)`.
- [ ] **Step 5:** STOP — needs the owner's yes: `git push origin "$BR"` (starts the trial run on the draft pull request).
- [ ] **Step 6: Verify the trial.** Find `RUN` by commit (it must be the run for `$TRIAL`) and watch as in Step 3, then `gh run view "$RUN" --log | grep -m1 'Image: '` ends with `Image: ubuntu-26.04` and `gh run view "$RUN" --json conclusion -q .conclusion` prints `success`. Also record `gh run view "$RUN" --log | grep -ciE 'node-gyp rebuild|gyp info'`: `0` means the prebuilt `better-sqlite3` binary loaded on Ubuntu 26 (settles the unverified system-library item); above `0` with `success` means the source-compile fallback works with Python 3.14 (settles the other half). A failure here blocks the plan; go to "If it goes wrong".
- [ ] **Step 7: Revert the trial.** `git revert --no-commit "$TRIAL" && git commit -m "ci: revert ubuntu-26.04 trial"`. Verify `git diff --numstat $BASE..HEAD` is back to the two `3 3` lines and `grep -c 'ubuntu-26.04' .github/workflows/ci.yml` prints `0`.
- [ ] **Step 8:** STOP — needs the owner's yes: `git push origin "$BR"` (pushes the revert). Then find `RUN` by commit, watch it as in Step 3, and confirm `gh run view "$RUN" --json conclusion -q .conclusion` prints `success` and `gh run view "$RUN" --log | grep -m1 'Image: '` no longer ends with `ubuntu-26.04`.
- [ ] **Step 9:** STOP — needs the owner's yes: `gh pr close "$PR"` (closes the draft; it was never merged). Verify `gh pr view "$PR" --json state,mergedAt -q '.state + " " + (.mergedAt|tostring)'` prints `CLOSED null`.

### Task 3: Release rehearsal from a disarmed throwaway branch

A hand-started run of `release.yml` uses the branch's copy of the workflow but checks out `main`. `main` is unprotected and npmjs.com does not check which branch asked, so the workflow must have its powers removed before it is ever started.

**Files:** Modify `.github/workflows/release.yml` on branch `rehearsal/i-046` only. This branch is never merged and never opened as a pull request.

- [ ] **Step 1: Implement the disarm.** `git switch -c rehearsal/i-046` (from the feature branch tip). In `release.yml`: change `contents: write` to `contents: read`; delete the `id-token: write` line; leave any other permission line alone; replace the `if:` line of each of these four steps with `if: false`: "Commit version bump and tag", "Publish to npmjs.com (trusted publishing)", "GitHub Release", "Signal the developer portal". `git commit -am "ci: DISARM release.yml for rehearsal (never merge)"`.
- [ ] **Step 2: Verify the disarm.** All must match:
  - `git show rehearsal/i-046:.github/workflows/release.yml | grep -cE 'id-token|contents: write'` prints `0`.
  - `git show rehearsal/i-046:.github/workflows/release.yml | grep -c 'if: false'` prints `4`.
  - `grep -A1 -E 'name: (Commit version bump and tag|Publish to npmjs.com \(trusted publishing\)|GitHub Release|Signal the developer portal)$' .github/workflows/release.yml | grep -c 'if: false'` prints `4` (the four are on the right steps).
  - `grep -cE ':[[:space:]]+write' .github/workflows/release.yml` prints `0` (no write permission of any kind is left, including one I-038 may have added).
  - Every command that can leave the runner sits in a disabled step: `awk '/^      - (name|uses|run)/{step=$0} /if: false/{off[step]=1} /git .*push|npm publish|gh release (upload|create)|gh workflow run|secrets\./{print (off[step]?"DISARMED":"LIVE")}' .github/workflows/release.yml | sort | uniq -c` prints only `DISARMED` lines (exactly `6 DISARMED` against the 2026-10-09 file: one push, one `npm publish`, the release upload and create, the portal secret, the portal dispatch). Any `LIVE` line, which I-038 could have introduced, means a fifth step needs `if: false`: stop and report, because the spec fixes the count at four.
  - `actionlint -ignore 'constant expression "false" in condition' .github/workflows/release.yml; echo exit=$?` prints `exit=0`. The `-ignore` is required: plain `actionlint` rejects every `if: false` and exits 1 (dry-run on 2026-10-09). Do not rewrite the condition to quiet it; the spec's acceptance check counts the literal text `if: false`.
- [ ] **Step 3: Phase gate, review before anything runs.** Dispatch a `code-reviewer` subagent (`model: opus`, this is the publish path) with `git diff "$BR"..rehearsal/i-046` and the spec's "Verification plan" step 3. It must list every step of the file by name and answer one question for each: can it push, tag, upload, signal or publish? Fix findings as new commits and re-run Step 2. Do not go on with an open finding.
- [ ] **Step 4: Record the "before" state.** Append to `$EVID` the output of `npm view @montionugera/ucsa-cli version`, `git ls-remote origin refs/heads/main 'refs/tags/v*'` and `gh release view v0.2.0 --json assets -q '.assets[].updatedAt'`.
- [ ] **Step 5:** STOP — needs the owner's yes: `git push -u origin rehearsal/i-046` (a branch push does not start `release.yml`).
- [ ] **Step 6:** STOP — needs the owner's yes: `gh workflow run release.yml --ref rehearsal/i-046` (Run A: new pins against today's `main` files). Ask now, but do not run it in this step. The yes is spent in Step 7 and lapses if Step 7's barrier fails.
- [ ] **Step 7: Second barrier, then Run A at once.** Only after the yes, and with no pause between the barrier and the dispatch (asking after the barrier would let `main` move while waiting for the answer):
  - `git fetch origin --tags && git switch --detach origin/main && node scripts/release/next-release.mjs; git switch rehearsal/i-046` must print `action=none`.
  - `gh release view v0.2.0 --json assets -q '.assets[].name'` must print `docs-site.tgz`.
  - `gh run list --workflow release.yml --json status -q '[.[]|select(.status!="completed")]|length'` must print `0`. The workflow's concurrency group `release` keeps one waiting run only, so a rehearsal started while real release runs are active could cancel a waiting real one.
  - If any of the three differs, do not start; report. Otherwise run the approved `gh workflow run release.yml --ref rehearsal/i-046`. If GitHub refuses the dispatch (HTTP 403 or 422), that answers the spec's unverified item "starting `release.yml` from a non-default branch is permitted after I-038": stop and report; do not change permissions, they belong to I-038.
- [ ] **Step 8: Verify Run A.** Find `RUN` for `release.yml` by commit (`git rev-parse rehearsal/i-046`; Global Constraints), confirm `gh run view "$RUN" --json event,headBranch -q '.event + " " + .headBranch'` prints `workflow_dispatch rehearsal/i-046`, `gh run watch "$RUN" --exit-status | tail -n 5`, then:
  - `gh run view "$RUN" --json conclusion -q .conclusion` prints `success`, and `gh run view "$RUN" --json jobs -q '.jobs[0].steps[] | select(.name=="Decide release") | .conclusion'` prints `success`. This settles three unverified items: pnpm only warns about the unset `NODE_AUTH_TOKEN`, npmjs.com accepts reads under setup-node v7, and npm tolerates the literal `${NODE_AUTH_TOKEN}` for reads. Record `gh run view "$RUN" --log | grep -ci 'NODE_AUTH_TOKEN'` as a note.
  - `gh run view "$RUN" --log | grep -oE 'action=[a-z-]+' | sort -u` prints `action=none`.
  - `gh run view "$RUN" --json jobs -q '.jobs[0].steps[] | select(.name|test("Commit version|Publish to npmjs|GitHub Release|Signal the developer")) | .conclusion'` prints `skipped` four times (settles "a run from a branch without `id-token: write` behaves as designed").
  - The pnpm-version and `Node.js 20` annotation commands from Task 2 Step 3 print `using pnpm v10` and `0` for this run.
  - The three commands from Step 4 print exactly what they printed before.
- [ ] **Step 9: Prepare Run B** (new pins against release 1.10's own files, which Run A did not cover). In `release.yml` change `ref: main` to `ref: rehearsal/i-046`; `git commit -am "ci: rehearsal run B, check out the rehearsal branch (never merge)"`. Re-run Step 2; same expected output.
- [ ] **Step 10:** STOP — needs the owner's yes: `git push origin rehearsal/i-046` (publishes the Run B commit; starts nothing).
- [ ] **Step 11:** STOP — needs the owner's yes: `gh workflow run release.yml --ref rehearsal/i-046` (Run B). Immediately before it, re-run the third check of Step 7 (no unfinished `release.yml` run); expected `0`.
- [ ] **Step 12: Verify Run B.** Find `RUN` by commit as in Step 8. The Step 9 commit gives Run B a different commit from Run A, so the lookup cannot return Run A; confirm the id differs from Run A's in `$EVID`. Then as Step 8, except the decision may be `action=release` (it only edits files inside the runner): conclusion `success`, "Decide release" `success`, four `skipped`, `using pnpm v10`, annotation count `0`, and the three Step 4 commands unchanged.
- [ ] **Step 13:** STOP — needs the owner's yes: `git push origin --delete rehearsal/i-046` (removes the throwaway branch from the remote).
- [ ] **Step 14:** STOP — needs the owner's yes: `git push origin --delete "$BR"` (removes the feature branch from the remote; the closed draft pull request stays as a record).
- [ ] **Step 15: Local clean-up.** `git switch "$BR" && git branch -D rehearsal/i-046`. Verify `git ls-remote origin refs/heads/rehearsal/i-046` prints nothing and `git branch --show-current` prints `$BR` (`psrw ship` must not run from the rehearsal branch).
- [ ] **Step 16: Phase gate, re-verify.** On `$BR`: `git diff --numstat $BASE..HEAD` prints the two `3 3` lines; `git log --format=%s $BASE..HEAD | grep -cvE '^ci: '` prints `0`; `git status --short` prints nothing.

## Phase C: ship, and what only the real release can prove

### Task 4: Merge into the release branch and hand over

- [ ] **Step 1: Implement.** From the feature worktree run `psrw ship`. Checked in the psrw source on 2026-10-09: it never pushes. It reads from the remote once (`git fetch origin main`), merges any new `main` commits into the local `release/1.10`, runs Gate 1 (`scripts/precheck.sh`), merges the feature locally, and then deletes the feature worktree, so `cd` to the release worktree straight afterwards (the evidence and state files are in the shared git directory and survive). This repository has no `scripts/deploy-local.sh`, so the post-merge local deploy prints "skipped". If `psrw ship` ever asks to push, stop and ask the owner. If it refuses on its readiness check, report it; do not pass `--skip-readiness` or `--no-sync-main`.
- [ ] **Step 2: Verify.** In the release worktree: `git merge-base --is-ancestor "$PIN" release/1.10 && echo shipped` prints `shipped`; the pin grep from Task 1 Step 3 prints the three `@v7`/`@v6` lines; `grep -c 'ubuntu-26.04\|if: false' .github/workflows/*.yml` prints `0` for both files.
- [ ] **Step 3: Review.** Dispatch a `code-reviewer` subagent (`model: sonnet`) with `$EVID` and the spec's acceptance criteria; it ticks each criterion against the recorded output and names any without evidence.
- [ ] **Step 4: Refactor and re-verify.** Close any gap it names by re-running the missing command (not by editing the evidence), then re-run Step 2.
- [ ] **Step 5: Report to the owner** with `$EVID` pasted, and this sentence: "The tag push and the token-free npm publish have not run on the new pins; their first run is the release 1.10 merge."
- [ ] **Step 6:** STOP — needs the owner's yes: the release 1.10 promote (the pull request from `release/1.10` to `main` and its merge). It is not part of this plan and is run by the release owner. Its merge subject `release 1.10 (#N)` always releases, so it performs a real, permanent npm publish through the new pins. When it happens, check the last two unverified items: `gh run list --workflow release.yml --branch main --limit 1` ends `success` with the steps "Commit version bump and tag" and "Publish to npmjs.com (trusted publishing)" both `success`; `npm view @montionugera/ucsa-cli version` prints the new version; the `Node.js 20` annotation count for that run is `0`.

## If it goes wrong

| When | What you see | What to do |
| --- | --- | --- |
| Before shipping (Tasks 1 to 3) | Any verify step fails, pnpm reports v11, or the Ubuntu 26 trial fails | Stop. `git revert "$PIN"` on the feature branch (new commit, subject starting `ci:`). Delete `rehearsal/i-046` locally. If it exists on the remote: STOP — needs the owner's yes: `git push origin --delete rehearsal/i-046`. Report the failing output. An Ubuntu 26 failure with a green `ubuntu-latest` run is a finding for the owner, not a reason to change `runs-on` (out of scope). |
| A rehearsal run shows a guarded step as anything but `skipped` | Possible outside effect | Stop at once. Compare the three Step 4 "before" outputs. Report both to the owner before touching anything. |
| After release 1.10 is on `main`, fully published | Problem found later | STOP — needs the owner's yes: hotfix pull request to `main` whose only commit is the revert, subject `ci: revert action pins`. Its merge prints `action=none` and publishes nothing. |
| Release run failed before the push (no tag, nothing published) | Same hotfix | STOP — needs the owner's yes. The hotfix merge prints `action=release` and performs the 1.10 release on the old pins. This is intended. |
| Release run failed after the push (tag exists, a package missing from npmjs.com) | Same hotfix | STOP — needs the owner's yes. The hotfix merge prints `action=publish-only` and publishes the tagged version on the old pins, skipping a package already there. |
| Any release failure | Temptation to press "Re-run jobs" | Not a rollback: it reuses the failed run's workflow file, so it repeats the new pins. Use it only for a clearly transient failure. Never delete the tag or bump a version by hand. |

## Audit trail

Independent audit, 2026-10-09 (self-grill-audit method, read-only): both workflow files, `scripts/release/next-release.mjs` and `lib.mjs`, the psrw source under `~/.claude/ps-release-workflow/`, `_catalog.json`, release run 37930906435, and scratch-copy dry-runs of the `sed`, the disarm and every `grep`. Verdict: ready after fixes. No CRITICAL: against today's `release.yml` the disarm covers every step that can push, tag, publish, upload or dispatch (6 of 6 such commands sit in the four disabled steps).

| Severity | Finding | What changed |
| --- | --- | --- |
| HIGH | Task 3 Step 2 expected plain `actionlint` to exit 0 on the disarmed file; it exits 1 on each `if: false`. The worker would be stuck or rewrite the condition and break the spec's `if: false` count. | `-ignore` flag added, with a warning not to rewrite the condition. |
| HIGH | The "immediately before" barrier ran before a STOP, so `main` could move while waiting for the owner's answer. | Yes is asked first (Step 6); barrier and dispatch run back to back (Step 7). |
| HIGH | Run ids were taken as "the latest run". Right after a dispatch that is empty or the previous run, so Run B could be "verified" against Run A. | Lookup by commit everywhere, plus an event and branch check. |
| HIGH | Task 3 Step 10 bundled a push and the Run B dispatch under one STOP; Task 2 Step 8 and Task 3 Step 12 each bundled two outward actions; one remote delete had no STOP prefix. | One STOP line per outward action. |
| HIGH | The evidence file lived in the feature worktree's git directory, which `psrw ship` deletes before Task 4 reviews it; variables were assumed to survive between shells. | Evidence and a state file moved to the shared git directory; variable rule added. |
| HIGH | `psrw refine` commits with `git add -A` and would commit another session's modified I-038 file in the release worktree. | Pre-check added; stop if anything outside this idea's folder is dirty. |
| MEDIUM | Disarm checks named only `contents: write` and `id-token`, and trusted the four step names; an I-038 addition would slip through. | Generic write-permission check and a per-command DISARMED/LIVE check added. |
| MEDIUM | A rehearsal dispatch could cancel a waiting real release run (shared concurrency group). | "No unfinished release run" check before each dispatch. |
| MEDIUM | The annotation count prints `0` when the API call itself fails. | Note added; check shown to print `1` on the old pins. |
| INFO | Whether psrw pushes was left open. | Settled from source: refine, claim and ship never push; ship only fetches `main`. |
| LOW (not changed) | Task 0's `jq` yields two lines if I-038 is refined into more than one feature; the `--is-ancestor` test would then error and the plan would stop (fails safe). | None. |
