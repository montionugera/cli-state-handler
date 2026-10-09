---
title: "Add pull request CI check workflow"
id: I-045
status: idea
---

# Add pull request CI check workflow

## Problem

The repo has no workflow that runs on pull requests. After F-039 removed `docs.yml`, the only workflow is `release.yml`, which triggers only on a push to `main`. `psrw promote --babysit` treats a PR with zero checks as failed ("no checks reported on the 'release/1.9' branch"), so PR #3 (release 1.9 into main) cannot be merged by the babysit path, and no CI ever runs before a merge that publishes to npmjs.com.

## Why now

Release 1.9 is blocked on it, and the first run of `release.yml` happens on merge. A PR check is the only CI gate that runs before the publish.

## Sketch

Add `.github/workflows/ci.yml`, triggered on `pull_request` (targets: main), that sets up the same toolchain `release.yml` uses and runs the repo's Gate 1 (`bash scripts/precheck.sh`), or the portable subset of it if part of it cannot run on a GitHub runner (state exactly what is dropped and why). Read-only permissions (`contents: read`), no secrets, no `id-token`, no publish. It must NOT touch `release.yml` (its name, its triggers, and the absence of `environment:` are bound to the npm trusted publisher), and must not target GitHub Pages.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` exists, triggers on `pull_request` to `main`, and has `permissions: contents: read` only (no `id-token`, no `contents: write`, no secrets).
- [ ] It runs the repo's pre-merge checks (`scripts/precheck.sh`, or a documented portable subset) with the same Node/pnpm setup as `release.yml`.
- [ ] `release.yml` is unchanged: same name, still triggers only on push to main, still no `environment:` key.
- [ ] `actionlint` passes on both workflow files; `scripts/epic-check.sh E-009` still prints five PASS lines (assertion 4: no workflow targets GitHub Pages).
- [ ] README's release section mentions the PR check.
- [ ] `bash scripts/precheck.sh` ends `Gate 1: ok`.
