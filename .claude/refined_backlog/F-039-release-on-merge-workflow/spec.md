---
title: "Release-on-merge workflow"
id: F-039
status: refined
from_idea: I-040
---

# Release-on-merge workflow

Slice 2 of epic E-009 (merge-to-release pipeline). The epic spec was approved by the owner on 2026-10-09.

## Scope

Exactly Task 2 of the epic implementation plan, nothing more:
`.claude/epic_backlog/E-009-merge-to-release-pipeline-publish-portal/plan.md`

The plan's "Global Constraints" section applies in full, in particular: never rename `.github/workflows/release.yml` and never add `environment:` to its job.

## Design

See the epic spec: `.claude/epic_backlog/E-009-merge-to-release-pipeline-publish-portal/spec.md`.

## Acceptance criteria

- [ ] Every step of Task 2 is checked off with its expected output observed, the task is committed, and its phase gate (verify, independent review, simplify, re-verify) has passed.
- [ ] Epic verification assertions 3 and 4 (`verification.md`) hold for this slice.
