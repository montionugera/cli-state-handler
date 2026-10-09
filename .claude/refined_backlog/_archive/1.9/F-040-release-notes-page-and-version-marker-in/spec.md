---
title: "Release notes page and version marker in docs"
id: F-040
status: refined
from_idea: I-041
---

# Release notes page and version marker in docs

Slice 3 of epic E-009 (merge-to-release pipeline). The epic spec was approved by the owner on 2026-10-09.

## Scope

Exactly Task 3 of the epic implementation plan, nothing more:
`.claude/epic_backlog/E-009-merge-to-release-pipeline-publish-portal/plan.md`

The plan's "Global Constraints" section applies in full, in particular: never rename `.github/workflows/release.yml` and never add `environment:` to its job.

## Design

See the epic spec: `.claude/epic_backlog/E-009-merge-to-release-pipeline-publish-portal/spec.md`.

## Acceptance criteria

- [ ] Every step of Task 3 is checked off with its expected output observed, the task is committed, and its phase gate (verify, independent review, simplify, re-verify) has passed.
- [ ] Epic verification assertion 5 (`verification.md`) holds for this slice.
