---
title: "Portal signal to joy-design"
id: I-042
status: idea
---

# Portal signal to joy-design

Slice 4 of epic E-009 (merge-to-release pipeline). The epic spec was approved by the owner on 2026-10-09.

## Scope

Exactly Task 4 of the epic implementation plan, nothing more:
`.claude/epic_backlog/E-009-merge-to-release-pipeline-publish-portal/plan.md`

The plan's "Global Constraints" section applies in full, in particular: never rename `.github/workflows/release.yml` and never add `environment:` to its job.

## Design

See the epic spec: `.claude/epic_backlog/E-009-merge-to-release-pipeline-publish-portal/spec.md`.

## Acceptance criteria

Every step of Task 4 is checked off with its expected output observed, the task is committed, and its phase gate (verify, independent review, simplify, re-verify) has passed.

The portal signal check from Task 4 passes, and the workflow logs a warning and succeeds when `PORTAL_DISPATCH_TOKEN` is absent.
