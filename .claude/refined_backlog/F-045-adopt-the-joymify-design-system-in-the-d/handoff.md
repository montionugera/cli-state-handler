# F-045 handoff

**Goal (owner, verbatim):** "using its design system for build doc not move into that repo" — the docs portal `apps/docs` (package `@ucsa/docs`) in cli-state-handler is built with the published Joymify packages.

**Plan:** `.claude/refined_backlog/F-045-adopt-the-joymify-design-system-in-the-d/plan.md` (13 tasks: phase 0 check, phase 1a wiring, phase 1b themes, phase 2 code blocks and diagrams). Spec and `research.md` are beside it. Phase 3 (markdown prose) is a separate feature.

**Current state (2026-10-09):** plan written and committed on `release/1.10`; no implementation code exists. The feature is not claimed. Base work is on `fix/docs-design-nav` (commits `68ad8b7`, `69f8c42`), read-only for this plan.

**Blocked on the owner (phase 0):** `npm view @joymify/react version --registry=https://npm.pkg.github.com` answers E404; the four `@joymify/*` packages are not published; the Actions secret `JOYMIFY_PACKAGES_READ_TOKEN` does not exist; the token's expiry date (needed for the README) has not been given.

**Next step:** run `self-grill-audit` on the plan and apply its critical and high findings. Once phase 0 is met: claim F-045 with `ps-release-workflow-claim`, then execute with `subagent-driven-development`, starting at Task 1 (it stops the run if phase 0 is still unmet).

**Read first:** "Findings that shape the plan" in `plan.md` lists twelve places where the plan departs from, or fills a gap in, the spec.
