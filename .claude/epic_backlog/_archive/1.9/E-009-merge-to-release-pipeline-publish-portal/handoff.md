# Handoff: E-009 merge-to-release pipeline

**Goal (verbatim from the user):** "make it automate deploy and quickly add new feature and merge and deploy playground + dev docs with neighbor design server-decor + lib ready + release note ready. also another lib (design and decor)"

**This epic covers:** the pilot in `cli-state-handler`. `node-server-decorator` and `joy-design` follow with their own specs.

- Spec (approved by the user 2026-10-09): `spec.md` in this folder. Checks: `verification.md`.
- Plan: `plan.md` in this folder (5 tasks, one per slice).
- State: spec audited and approved; plan written; `release/1.9` synced with `main`. No implementation yet.
- Next step: audit the plan (`self-grill-audit`), fan the epic out into slices (`psrw epic fanout`), then implement task by task with `subagent-driven-development`, each task in its claimed feature worktree.
- Blocked on the owner: the cross-repo credential `PORTAL_DISPATCH_TOKEN`; the `joy-design` work item is not opened yet.
- Hard constraint: never rename `.github/workflows/release.yml` or add `environment:` to its job (npm trust).
