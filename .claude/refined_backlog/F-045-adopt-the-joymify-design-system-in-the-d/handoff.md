# F-045 handoff

**Goal (owner, verbatim):** "using its design system for build doc not move into that repo" — the docs portal `apps/docs` (package `@ucsa/docs`) in cli-state-handler is built with the published Joymify packages, which are named `@montionugera/joy-*` (not `@joymify/*`).

**Plan:** `.claude/refined_backlog/F-045-adopt-the-joymify-design-system-in-the-d/plan.md` (13 tasks: phase 0 check, phase 1a wiring, phase 1b themes, phase 2 code blocks and diagrams). Spec and `research.md` are beside it. Phase 3 (markdown prose) is a separate feature.

**Current state (2026-10-11):** plan and spec corrected on the feature branch `feat/F-045` (worktree `.claude/worktrees/F-045-adopt-the-joymify-design-system-in-the-d`); no implementation code exists. Base work is on `fix/docs-design-nav` (commits `68ad8b7`, `69f8c42`), read-only for this plan; it still imports the unpublished names `@joymify/react` and `@joymify/tokens`, which Task 4 renames.

**Packages: published (checked 2026-10-11 with `gh api /users/montionugera/packages...`).** `@montionugera/joy-tokens` 0.2.0, `@montionugera/joy-icons` 0.3.0, `@montionugera/joy-brand` 0.2.0, `@montionugera/joy-react` 0.2.0: private, account `montionugera`, repository `montionugera/joy-design`. The names `@joymify/tokens|icons|brand|react` that the plan and spec used until today do not exist (E404; GitHub Packages has no `joymify` owner). Owner decision: the packages stay private under `@montionugera/joy-*`.

**Registry design (changed 2026-10-11, plan finding 16).** The packages share the `@montionugera` scope with this repository's own libraries on npmjs.com (`@montionugera/ucsa-core`, `@montionugera/ucsa-cli`). A scope line in a root `.npmrc` would send the release pipeline's `npm view` and `npm publish` to GitHub Packages, and `--registry` / `publishConfig.registry` do not override it (reproduced locally, no upload). So: **no root `.npmrc`**; the mapping is a `registries` block in `pnpm-workspace.yaml`, which only pnpm reads. The release scripts, the step "Publish to npmjs.com (trusted publishing)" and the library manifests are not edited. Never add `@montionugera:registry=...` to any `.npmrc`.

**Still blocked on the owner (phase 0), all three owner-only:** (1) the Actions secret `JOYMIFY_PACKAGES_READ_TOKEN` in cli-state-handler does not exist (classic token, `read:packages`, from an account that can read the four packages); (2) that token's expiry date has not been given (the README needs it); (3) the local setup is missing: the token line in `~/.npmrc` and the exported variable. Until then nothing can be installed, so three things in the corrected design are unproven: pnpm authenticating to a registry named only in `pnpm-workspace.yaml`, the runner's pnpm 10 honouring `registries` (run locally on 10.13.1 only), and the published tarballs' dependency names and exports. Agents do not create, read or print tokens.

**Audit (2026-10-10):** `self-grill-audit` ran; one critical and six high findings are fixed in `plan.md` (see its "Audit trail"), and the spec lines it proved wrong are corrected. Task 6 Step 2 (draft pull request to main) now needs the owner's go-ahead by name.

**Next step:** once phase 0 is met: execute with `subagent-driven-development`, starting at Task 1 (it stops the run if phase 0 is still unmet). Task 3 (mapping and workflows) has its own review gate; at promote time read the registry out of the publish step's log.

**Read first:** "Findings that shape the plan" in `plan.md` lists sixteen places where the plan departs from, or fills a gap in, the spec. Finding 16 (2026-10-11) is the registry design and its evidence.
