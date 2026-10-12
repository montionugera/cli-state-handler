# Adopt the Joymify design system in the docs portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "using its design system for build doc not move into that repo" — the docs portal `apps/docs` (package `@ucsa/docs`) in cli-state-handler is built with the published Joymify packages.

**Architecture:** The portal's base branch imports the design system under working names (`@joymify/react`, `@joymify/tokens/theme.css`) through aliases to a sibling checkout. Those names were never published: the packages are on GitHub Packages as `@montionugera/joy-react`, `@montionugera/joy-tokens`, `@montionugera/joy-icons` and `@montionugera/joy-brand` (private, account `montionugera`, repository `joy-design`). This plan renames the import specifiers to the published names and swaps the route: registry dependencies, plus a scope mapping that **only pnpm reads** (a `registries` block in `pnpm-workspace.yaml`; no root `.npmrc`, see finding 16), with a read-only token handed to the install step of the two workflows. On top of that it adds a light/dark/system theme toggle driven by the `data-theme` attribute the tokens stylesheet already understands, self-hosted fonts, and Joymify `CodeBlock`, `PolyglotCodeTabs`, `Alert` and `MermaidViewer` behind one lazy-loaded wrapper module.

**Tech Stack:** React 19, Vite 8, Vitest 3 + jsdom + Testing Library, pnpm 10 workspace, `@montionugera/joy-react` 0.2.0, `@montionugera/joy-tokens` 0.2.0, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`, GitHub Actions, GitHub Packages.

**Spec:** `.claude/refined_backlog/F-045-adopt-the-joymify-design-system-in-the-d/spec.md` (read `research.md` beside it). Executors read both.

**Scope of this plan:** phase 1a (registry wiring), phase 1b (themes), phase 2 (code blocks and diagrams). Phase 3 (markdown for release notes and tutorial prose) is a separate feature. `ReleaseNotes.tsx`, `models/changelog.ts` and the tutorial prose stay as they are.

## Global Constraints

Copied from the spec. Every task's requirements include these.

- Dependencies are exactly `@montionugera/joy-react` `^0.2.0` and `@montionugera/joy-tokens` `^0.2.0` in `apps/docs/package.json`. `@montionugera/joy-icons` 0.3.0 and `@montionugera/joy-brand` 0.2.0 arrive transitively. No `workspace:`, no `link:`, no vendored source, no sibling checkout, and no pnpm alias (`npm:`): imports use the published names (finding 16).
- **No root `.npmrc` is created, and no file that npm reads may map the `@montionugera` scope.** This repository publishes `@montionugera/ucsa-core` and `@montionugera/ucsa-cli` to npmjs.com; an `@montionugera:registry=https://npm.pkg.github.com` line in a root `.npmrc` (or in the user-level file the workflows write) sends the release pipeline's `npm view` and `npm publish` to GitHub Packages, and neither `--registry` nor `publishConfig.registry` overrides it (finding 16). The scope mapping lives only in `pnpm-workspace.yaml`, which npm never reads, as `registries: { default: https://registry.npmjs.org/, '@montionugera': https://npm.pkg.github.com/ }`. The `default` entry is required.
- `pnpm publish` is never used for the libraries (pnpm does read the mapping). Publishing stays `pnpm pack` + `npm publish`, as `scripts/release/publish-packages.sh` does today.
- The token line lives only in user-level npm config, as the literal text `//npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}`. The token itself is never written to disk.
- The Actions secret is named `JOYMIFY_PACKAGES_READ_TOKEN`. It is passed as `env` to the install step only; no other step may receive it without the owner's go-ahead. `packages: read` is not added to `permissions`.
- The token line is appended with a leading newline (`printf '\n%s\n' ... >>`), never a bare `echo ... >>`: `actions/setup-node` writes its npm config file without a final newline, so a bare append joins the token line onto `always-auth=false` and the token is lost (audit finding C1).
- Not edited: `scripts/release/next-release.mjs`, `scripts/release/publish-packages.sh`, the publish step in `release.yml` (its name stays "Publish to npmjs.com (trusted publishing)"), `packages/core/package.json`, `apps/cli/package.json`. `release.yml` is not renamed and gets no `environment:`.
- No `uses:` line changes in any workflow (action versions belong to idea I-046, owned by another session).
- Import specifiers use the published names: `from "@montionugera/joy-react"` and `@montionugera/joy-tokens/theme.css`. Task 4 renames every `@joymify/` specifier under `apps/docs/src` (eleven files on the base commit `69f8c42`); after Task 4 the string `@joymify/` appears nowhere under `apps/docs`.
- Theme storage key is `ucsa-docs-theme`; valid saved values are `light` and `dark`; System removes the attribute and the key.
- No font CDN. No full `mermaid` library and no general markdown library in this repository. Gaps in Joymify components are fixed upstream in `joy-design`, never shimmed here.
- The sidebar stays the existing anchor sidebar (`<a href="#/...">`, `aria-current="page"`, drawer focus handling). The Joymify `Menu` is not adopted.
- Routes, page content, playground models and the sandbox do not change.
- The docs test count never drops below the baseline recorded in Task 2. A test may be edited only where it asserts markup a Joymify component replaced; none is deleted.

Repo conventions (from the dispatcher, binding):

- Run every command from the feature worktree root. A fresh worktree needs `pnpm install` then `pnpm --filter @montionugera/ucsa-core build` (the package is named `@montionugera/ucsa-core`; a filter of `@ucsa/core` matches nothing and still exits 0).
- Docs commands: `pnpm --filter @ucsa/docs test` and `pnpm --filter @ucsa/docs build`. The machine is heavily loaded: run one test suite at a time, never two in parallel.
- No prettier config exists: do not run prettier. Match the surrounding style by hand.
- The root `.gitignore` has a bare `build/` rule: never create a folder named `build/`, git would silently skip it.
- Never `git commit --amend`. One new commit per task. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Gate reviewers are `code-reviewer` and `typescript-reviewer`, both on `model: opus`. Browser checks run in a subagent that returns a text verdict, never screenshots into the main thread.
- No `.drawio` diagram covers the docs portal or the CI install path (the only one is `docs/superpowers/specs/diagrams/unified-state-architecture.drawio`, the library's state architecture), so no diagram task exists in this plan.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `pnpm-workspace.yaml` | modify | `registries` block: scope mapping that only pnpm reads |
| `.npmrc` (root) | never created | A mapping there would redirect the library release (finding 16) |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml` | modify | Token line step and `env` on install; `ci.yml` header comment |
| `apps/docs/joy-alias.ts` | delete | Sibling-checkout aliases, no longer needed |
| `apps/docs/vite.config.ts`, `apps/docs/vitest.config.ts`, `apps/docs/tsconfig.json`, `vitest.config.ts` (root) | restore to `release/1.10` content | Drop alias, `dedupe` and type paths |
| `apps/docs/package.json`, `pnpm-lock.yaml` | modify | Registry dependencies, fonts |
| `apps/docs/tests/joymify-wiring.test.ts` | create | Guards alias removal, published names, ranges, the pnpm-only mapping, exports |
| `apps/docs/src/**` (eleven files) | modify | Import specifiers renamed to the published names |
| `apps/docs/src/theme.ts` | create | Read and apply the theme choice |
| `apps/docs/src/components/ThemeToggle.tsx` | create | Joymify `Segmented` with System, Light, Dark |
| `apps/docs/index.html` | modify | Remove forced dark; no-flash inline script |
| `apps/docs/src/App.tsx`, `apps/docs/src/shell.css` | modify | Toggle in the sidebar brand block |
| `apps/docs/src/index.css`, `LifecycleGraph.css`, `StaleTimeline.css`, `main.tsx` | modify | Fonts, scrim, `color-scheme` |
| `apps/docs/tests/theme-toggle.test.tsx`, `apps/docs/tests/theme-assets.test.ts` | create | Theme behaviour and colour/font guards |
| `apps/docs/src/components/rich.tsx`, `rich-impl.ts`, `rich.css` | create | The single lazy wrapper: `Code`, `CodeTabs`, `Diagram` |
| `apps/docs/src/components/Prose.tsx`, `apps/docs/src/prose.css` | modify | `CodeBlock` and `Callout` delegate to Joymify |
| `apps/docs/src/components/MultiPlatformDocs.tsx`, `multiplatform.css` | modify | Platform tabs and code through Joymify |
| `apps/docs/src/pages/Home.tsx`, `home.css` | modify | Request-path flowchart |
| `apps/docs/tests/rich.test.tsx`, `apps/docs/tests/home-diagram.test.tsx`, `apps/docs/tests/multiplatform-docs.test.tsx` | create / modify | Phase 2 tests |
| `README.md` | modify | Install requirement, token setup and expiry, theme and diagram notes |

## Findings that shape the plan

Checked against the source on 2026-10-09 while writing this plan. Each is a deviation from, or a gap in, the spec; the owner has been told. Items 2 to 7 and 13 to 16 are also recorded in the spec itself (its "Appendix: audit trail", entries of 2026-10-10 and 2026-10-11, and the edited lines they name), so a reviewer holding the spec as the authority does not flag them.

1. **`routes.ts` does not conflict.** A trial merge of `69f8c42` into `release/1.10` conflicts in exactly two files: `apps/docs/vite.config.ts` and `apps/docs/src/components/MultiPlatformDocs.tsx`. `README.md` and `routes.ts` merge cleanly.
2. **The root `vitest.config.ts` also imports `joy-alias`.** The spec lists only the two config files under `apps/docs`. Task 4 restores the root file as well, and the wiring test guards it.
3. **The baseline cannot be measured after the cherry-pick.** In a feature worktree under `.claude/worktrees/`, the alias path `../../../joy-design` does not resolve. The two base commits add no test file, so the baseline is the docs test count of the untouched feature branch, measured in Task 2 before the cherry-pick.
4. **No inline style carries a colour literal.** All 54 inline styles already use portal variables that map to `--joy-*` tokens. The real leftovers are `--scrim` and two hard-coded `color-scheme: dark` rules. Task 8 fixes those three and adds a guard test; it does not rewrite 54 styles.
5. **Fontsource variable fonts register as `"Inter Variable"` and `"JetBrains Mono Variable"`,** while the tokens name `Inter` and `JetBrains Mono`. Importing the packages alone would change nothing. Task 8 redefines the two font-family tokens in `index.css`.
6. **Unsupported diagram types are not shown as source.** `renderMermaidToSvg` falls back to "treat it as a flowchart": `pie`, `classDiagram` and `gantt` all return `success: true` and draw a meaningless graph (run against `joy-design` release/3.8). The spec's test "an unsupported diagram type shows its source" cannot pass for those inputs. Task 10 tests the contract that does hold: a definition the renderer rejects (`sequenceDiagram` with no participants) shows its source and does not throw. The fallback is an upstream defect to file in `joy-design`.
7. **Dart and C# snippets get no highlighting.** The Joymify highlighter has grammars for Rust, TypeScript/JavaScript, Python and a few others; `dart` and `csharp` return a single plain token. Two thirds of the platform snippets render as unhighlighted `CodeBlock`. Upstream request to file; nothing is shimmed here.
8. **Lazy loading meets synchronous tests.** `routes.ts` keeps page components eager because playground tests assert synchronously. The lazy wrapper is used only for code, tabs and diagram. Three `getByText` calls on platform tab labels become `await findByText`; everything else stays synchronous because titles and the copy button stay outside the lazy boundary.
9. **The copy button in the platform guide is kept.** Joymify `CodeBlock` swallows a failed clipboard write silently; ten existing tests cover "Copy failed" and the reset timer. The portal keeps its own button and passes `allowCopy={false}`.
10. **An unresolved placeholder does not break npm 11.** With the token line in user config and the variable unset, `npm view @montionugera/ucsa-core version` exits 0 on npm 11.17.0. So the later `npm view` and `npm publish` steps of `release.yml`, which run without the variable, are safe. pnpm's behaviour in `scripts/precheck.sh` is still unproven; Task 6 settles it.
11. **The README needs the token's expiry date, which only the owner knows.** Task 1 asks for it.
12. **`Alert` renders `role="alert"`.** A static callout would be announced on every page load, so the portal passes `role="note"` (the component spreads extra props after its own role).

Added by the audit of 2026-10-10 (each reproduced, see "Audit trail"):

13. **A bare append corrupts the npm config in `release.yml`.** `actions/setup-node@v4` with `registry-url` writes its file ending in `always-auth=false` with no final newline (`src/authutil.ts`). `echo '<token line>' >> file` then produces the single line `always-auth=false//npm.pkg.github.com/:_authToken=...`: no token line exists, the install answers 401 on every merge to main, and library publishing is blocked. `ci.yml` has no such file, so the draft pull request of Task 6 would have stayed green. Task 3 appends with a leading newline and Step 5 replays the line against a copy of that file.
14. **An empty secret fails as an opaque 401.** A run that gets no secrets (fork, Dependabot, deleted secret) expands the placeholder to an empty token. Task 3 makes the install step stop first with one explicit error line. The variable still exists only in the install step.
15. **Some browser checks cannot run with the `claude-in-chrome` tools as first written.** They cannot emulate `prefers-color-scheme` or throttle the network; `document.fonts.check()` answers `true` in Chrome for a family that does not exist; a Chrome window may not shrink to 360px. Tasks 9 and 13 and the browser brief now use checks that can run (a 360px same-origin iframe, `FontFace.status`, resource origins, the order of tags in the built `index.html`) and require `NOT RUN` instead of `PASS` for anything that could not be executed.

Added on 2026-10-11, when the package names were corrected (see "Audit trail"):

16. **The design-system packages share the `@montionugera` scope with this repository's own npmjs.com libraries, so the scope mapping must not be anywhere npm reads.** The names `@joymify/*` were never published (E404; GitHub Packages has no `joymify` owner). The packages are `@montionugera/joy-tokens` 0.2.0, `@montionugera/joy-icons` 0.3.0, `@montionugera/joy-brand` 0.2.0 and `@montionugera/joy-react` 0.2.0, private, published from `montionugera/joy-design`, and the owner has decided they stay private under that name. What that does to the release pipeline, each line reproduced on this machine on 2026-10-11 with npm 11.17.0 and pnpm 10.13.1 against a dead local address standing in for GitHub Packages:
    - *The hazard is real.* With `@montionugera:registry=<other>` in a root `.npmrc`, `npm view @montionugera/ucsa-core version` goes to `<other>`. That is the exact call in `scripts/release/next-release.mjs` ("Decide release", every merge to main) and in `scripts/release/publish-packages.sh`; both run from the repository root. A dry-run `npm publish` of a tarball whose manifest has `publishConfig.registry = https://registry.npmjs.org` (what both library manifests have) also reports `Publishing to <other>`.
    - *The obvious pins do not work.* Adding `--registry=https://registry.npmjs.org` changes neither result: a scope mapping outranks the plain `registry` setting, from the flag and from `publishConfig` alike. Only `--@montionugera:registry=https://registry.npmjs.org` wins. So the "scope line plus explicit registry on the publish side" design needs that exact flag on all three npm calls and a `"@montionugera:registry"` key in both manifests, it edits the release scripts this plan promises not to touch, and it fails open: any npm call added later without the flag is silently redirected.
    - *The same holds for a user-level file.* A mapping in the file named by `NPM_CONFIG_USERCONFIG` redirects `npm view` too, so writing the mapping next to the token line in the workflows is not safe either.
    - *The chosen design.* pnpm 10 reads a `registries` map from `pnpm-workspace.yaml`; npm does not read that file at all. With the map present, `npm config get @montionugera:registry` prints `undefined`, `npm view @montionugera/ucsa-core version` prints the npmjs.com version and a dry-run publish reports `Publishing to https://registry.npmjs.org`, exactly as today, while `pnpm add @montionugera/<name>` goes to the mapped registry. The publish path is unchanged by construction instead of by a flag someone must remember. The map needs `default: https://registry.npmjs.org/`: without it pnpm 10.13.1 crashes on every unscoped package with `Cannot read properties of undefined (reading 'endsWith')`.
    - *Aliases were considered and rejected.* `"@joymify/react": "npm:@montionugera/joy-react@^0.2.0"` would keep the import lines, but it still needs the same scope mapping (so it solves nothing about the registry), `@montionugera/joy-react` depends on its siblings by their real names (so both names would sit in `node_modules`), and every error message, lockfile entry and type path would show a name the imports do not. Eleven one-line renames are simpler than an indirection that hides the real name.
    - *Not proved here (no token exists yet, so nothing can be installed):* that pnpm sends the user-level token to a registry it learned from `pnpm-workspace.yaml` (Task 4 Step 5 proves it locally); that the newest pnpm 10 on the runner honours `registries` the way 10.13.1 does (Task 6 proves it; if it does not, the install fails with a 404 from npmjs.com for `@montionugera/joy-react`, and the answer is to STOP, never to fall back to a `.npmrc` line).

---

## Phase 0: preconditions

### Task 1: Precondition check (stops the run)

**Files:** none.

**Interfaces:**
- Produces: `TOKEN_EXPIRY` (a date string supplied by the owner) used in Task 5.

- [ ] **Step 1: Check the package resolves**

The names are `@montionugera/joy-*`. Do not look for `@joymify/*`: that name was never published.

First confirm the local token setup, because without it a 401 or 404 below says nothing about whether the packages are readable (the registry answers the same way to a caller it cannot identify):
```bash
grep -c 'npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}' ~/.npmrc
test -n "$JOYMIFY_PACKAGES_READ_TOKEN" && echo token-exported
```
Expected: `1` and `token-exported` (on 2026-10-11 both are still missing on this machine). If either is missing, STOP and report the local setup from Step 2 to the owner; do not go on to the registry check. The `grep -c` prints a count only; never print the file or the variable.

Run: `npm view @montionugera/joy-react version --@montionugera:registry=https://npm.pkg.github.com`
Expected: prints `0.2.0`. The scope flag is needed on every such check: nothing maps the scope for npm, on purpose (finding 16), and a plain `--registry` flag is not the same thing.

If it fails with the local setup in place, **STOP the whole run** and report exactly:
```
F-045 is blocked on phase 0. @montionugera/joy-react does not resolve from GitHub Packages
with the local token. The four packages are published (private, account montionugera,
repository joy-design: joy-tokens 0.2.0, joy-icons 0.3.0, joy-brand 0.2.0, joy-react 0.2.0;
confirmed with gh api on 2026-10-11), so the token is the likely cause: missing, expired,
or without read:packages. Owner actions: (a) the local token setup in ~/.npmrc; (b) create
the Actions secret JOYMIFY_PACKAGES_READ_TOKEN in cli-state-handler (classic token,
read:packages, from an account that can read those packages); (c) tell us that token's
expiry date. No code was changed.
```

- [ ] **Step 2: Check the rest of phase 0**
```bash
for p in joy-tokens@0.2.0 joy-icons@0.3.0 joy-brand@0.2.0 joy-react@0.2.0; do
  npm view "@montionugera/$p" version --@montionugera:registry=https://npm.pkg.github.com
done
npm view @montionugera/joy-react@0.2.0 dependencies --@montionugera:registry=https://npm.pkg.github.com
gh secret list | grep -c JOYMIFY_PACKAGES_READ_TOKEN
grep -c 'npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}' ~/.npmrc
test -n "$JOYMIFY_PACKAGES_READ_TOKEN" && echo token-exported
test ! -e .npmrc && echo no-root-npmrc
env NPM_CONFIG_USERCONFIG=/dev/null npm config get @montionugera:registry
```
Expected: the four versions print; the dependencies list shows `@montionugera/joy-*` names with version ranges and none starts with `workspace:`; the two counts print `1`; `token-exported` prints; `no-root-npmrc` prints; the last line prints `undefined`.

Any miss: STOP with the message from Step 1, naming the failing line. If only the last two lines fail, the local setup is missing; the fix is `echo '//npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}' >> ~/.npmrc` and `export JOYMIFY_PACKAGES_READ_TOKEN=$(gh auth token)` after `gh auth refresh -s read:packages`. That edits the owner's personal npm config and handles a token, so report it and let the owner run it; an agent never runs `gh auth token` and never prints a token. If `npm config get @montionugera:registry` prints a URL from the owner's own `~/.npmrc` (run it once more without the `env` prefix to see), STOP as well: a machine-wide mapping redirects the README's manual `npm publish` recipe exactly as a root `.npmrc` would (finding 16), and the owner must remove it.

If the published versions differ from 0.2.0 / 0.3.0, STOP: the spec's ranges are corrected first.

- [ ] **Step 3: Confirm the expiry date was supplied**

`TOKEN_EXPIRY` must be a date given by the owner for the token stored in the secret. If it is missing, STOP and ask for it. Do not guess it and do not read it from a local token (the local token may be a different one).

---

## Phase 1a: registry wiring

### Task 2: Baseline, then bring the base commits onto the feature branch

**Files:**
- Modify (by cherry-pick): everything in commits `68ad8b7` and `69f8c42` (23 + 8 files under `apps/docs`, `README.md`, root `vitest.config.ts`)
- Modify: `.claude/refined_backlog/F-045-adopt-the-joymify-design-system-in-the-d/handoff.md` (baseline line)

**Interfaces:**
- Consumes: the feature branch and worktree created from `release/1.10` by `ps-release-workflow-claim` for F-045. The base worktree `../cli-state-handler-fix-docs-design` is read-only for this plan; nothing is edited there.
- Produces: `BASELINE`, the passing docs test count, written to `handoff.md` as `Baseline docs tests: <n>`.

- [ ] **Step 1: Install and measure the baseline on the untouched branch**
```bash
pnpm install
pnpm --filter @montionugera/ucsa-core build
pnpm --filter @ucsa/docs test 2>&1 | tail -n 6
```
Expected: exit 0. Read the `Tests  <n> passed` line; that `<n>` is `BASELINE` (the old base had 320; `release/1.10` adds two test files).

- [ ] **Step 2: Cherry-pick the two commits**
```bash
git cherry-pick 68ad8b7 69f8c42
```
Expected: the first pick stops with conflicts in exactly `apps/docs/vite.config.ts` and `apps/docs/src/components/MultiPlatformDocs.tsx`.

- [ ] **Step 3: Resolve `apps/docs/vite.config.ts`** by keeping both imports. The import block becomes:
```ts
import { ucsaCoreIife } from "./vite-plugins/ucsa-core-iife.js";
import { versionJson } from "./vite-plugins/version-json.js";
import { joyAlias } from "./joy-alias.js";
```

Leave the rest as merged (`plugins: [react(), ucsaCoreIife(), versionJson()]`, `resolve.dedupe`, `...joyAlias`). Task 4 removes the alias lines again.

- [ ] **Step 4: Resolve `apps/docs/src/components/MultiPlatformDocs.tsx`** by keeping main's hooks and the base branch's Joymify import. The first two lines become:
```tsx
import React, { useEffect, useRef, useState } from "react";
import { Badge, Button } from "@joymify/react";
```

The body merged cleanly: main's `handleCopy` with `status`, `resetTimer`, `mounted`, inside the base branch's `<Button variant="outline">`. Do not change it.

- [ ] **Step 5: Continue and confirm**
```bash
git add apps/docs/vite.config.ts apps/docs/src/components/MultiPlatformDocs.tsx
git cherry-pick --continue --no-edit
git status --short | head -n 5
grep -rn -E '^(<<<<<<<|=======|>>>>>>>)' apps/docs README.md vitest.config.ts | head -n 5
git log --oneline -n 2
```
Expected: the second pick applies with no conflict; `git status` prints nothing; the grep prints nothing; the log shows the two picked commits. If any other file conflicts, stop and report the file names: the trial merge did not predict them.

The branch cannot build or test at this point (the alias target does not exist under `.claude/worktrees/`). That is expected; Task 4 is the first point where the suite runs again.

- [ ] **Step 6: Record the baseline and commit**

Append the line `Baseline docs tests: <n>` to `handoff.md` in the feature folder.

```bash
git add .claude/refined_backlog/F-045-adopt-the-joymify-design-system-in-the-d/handoff.md
git commit -m "chore(F-045): record docs test baseline before the Joymify wiring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Scope mapping for pnpm only, and workflow package access (risky surface, own gate)

**Files:**
- Modify: `pnpm-workspace.yaml` (add the `registries` block)
- Modify: `.github/workflows/ci.yml` (header comment line 4; the install step on line 48)
- Modify: `.github/workflows/release.yml` (the install step on line 52)
- Never created: a root `.npmrc` (finding 16)

**Interfaces:**
- Produces: the scope mapping that Task 4's install relies on, visible to pnpm and invisible to npm; the secret reaches `pnpm install --frozen-lockfile` in both workflows.

- [ ] **Step 1: Prove an unresolved placeholder does not break npm (the red/green check for this task)**
```bash
T=$(mktemp -d)
printf '%s\n' '//npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}' > "$T/npmrc"
env -u JOYMIFY_PACKAGES_READ_TOKEN NPM_CONFIG_USERCONFIG="$T/npmrc" npx -y npm@^11.5.1 view @montionugera/ucsa-core version; echo "exit=$?"
```
Expected: a version and `exit=0`. This is what the "Decide release" and publish steps of `release.yml` will meet after this task. The token line is keyed to the host `npm.pkg.github.com`; it is not a scope mapping and sends no request anywhere.

If `exit` is not 0: in Step 4 also add this step to `release.yml` directly after the install step, and note it in `handoff.md`:
```yaml
      - name: Remove the Joymify token line before any npm call
        run: sed -i '/npm.pkg.github.com\/:_authToken/d' "${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
```

- [ ] **Step 2: Add the mapping to `pnpm-workspace.yaml`.** Insert this block directly after the `packages:` list (before `supportedArchitectures:`), comment included, and create no `.npmrc`:
```yaml
# Only pnpm reads this file. The private @montionugera/joy-* design-system
# packages come from GitHub Packages. Do NOT move this mapping into a .npmrc:
# npm reads .npmrc, and the mapping would send `npm view` and `npm publish`
# for this repository's own @montionugera/ucsa-* libraries to GitHub Packages
# instead of npmjs.com (--registry and publishConfig.registry do not override
# a scope mapping). `default` must stay: without it pnpm crashes on every
# unscoped package.
registries:
  default: https://registry.npmjs.org/
  '@montionugera': https://npm.pkg.github.com/
```

- [ ] **Step 3: Edit `ci.yml`**

Replace the header line `# it is merged. Read-only: no secrets, no id-token, no environment, no Pages.` with:
```yaml
# it is merged. Read-only: one secret (JOYMIFY_PACKAGES_READ_TOKEN, read-only
# for packages, given to the install step only), no id-token, no environment,
# no Pages.
```

Replace the step `      - run: pnpm install --frozen-lockfile` with:
```yaml
      # The private @montionugera/joy-* packages live on GitHub Packages
      # (account montionugera, repository joy-design). Only the token line goes
      # here; the scope mapping is in pnpm-workspace.yaml and must never be
      # written to an npm config file (it would redirect the library release).
      # The line keeps its ${...} placeholder, so the token itself is never
      # written to disk; only the install step has the variable.
      # The leading newline matters: actions/setup-node writes its config file
      # without a final newline, so a bare append would join its last line.
      - name: Point npm at the Joymify package token
        run: |
          printf '\n%s\n' '//npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}' >> "${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"

      - name: Install dependencies
        run: |
          if [ -z "$JOYMIFY_PACKAGES_READ_TOKEN" ]; then
            echo "::error::JOYMIFY_PACKAGES_READ_TOKEN is empty: the secret is missing, or this run gets no secrets (a pull request from a fork or from Dependabot). The private @montionugera/joy-* packages cannot be installed."
            exit 1
          fi
          pnpm install --frozen-lockfile
        env:
          JOYMIFY_PACKAGES_READ_TOKEN: ${{ secrets.JOYMIFY_PACKAGES_READ_TOKEN }}
```

The guard runs inside the install step, so the variable is still given to that one step only. It turns an empty secret into one readable error line instead of a 401 from the registry.

- [ ] **Step 4: Edit `release.yml`** the same way: replace its `      - run: pnpm install --frozen-lockfile` step with the identical two steps from Step 3 (same comment, same names, same `printf` line, same guard). In this file the user-level file is the one `actions/setup-node` already wrote for npmjs.com, and that file has no final newline: the leading `\n` of the `printf` is what keeps the token line on a line of its own. Nothing in the file is replaced. Do not touch `permissions`, any `uses:` line, or any other step; the step "Publish to npmjs.com (trusted publishing)" keeps its name and its body, the file keeps its name, and no `environment:` is added.

- [ ] **Step 5: Verify**
```bash
test ! -e .npmrc && echo no-root-npmrc
ruby -ryaml -e 'r = YAML.load_file("pnpm-workspace.yaml")["registries"]; puts r["default"], r["@montionugera"], r.size'
env -u JOYMIFY_PACKAGES_READ_TOKEN NPM_CONFIG_USERCONFIG=/dev/null npm config get @montionugera:registry
env -u JOYMIFY_PACKAGES_READ_TOKEN NPM_CONFIG_USERCONFIG=/dev/null npm view @montionugera/ucsa-core version
env -u JOYMIFY_PACKAGES_READ_TOKEN NPM_CONFIG_USERCONFIG=/dev/null node scripts/release/next-release.mjs; echo "exit=$?"
grep -c "pnpm publish" scripts/release/publish-packages.sh .github/workflows/release.yml
grep -c -E "@montionugera:registry|registry=https://npm.pkg.github.com" .github/workflows/ci.yml .github/workflows/release.yml
pnpm install --frozen-lockfile 2>&1 | tail -n 3; echo "exit=${PIPESTATUS[0]}"
grep -n "JOYMIFY_PACKAGES_READ_TOKEN" .github/workflows/ci.yml .github/workflows/release.yml
grep -c "packages: read" .github/workflows/ci.yml .github/workflows/release.yml
grep -n "no secrets" .github/workflows/ci.yml
grep -c "Publish to npmjs.com (trusted publishing)" .github/workflows/release.yml; grep -c -E "^ +environment:" .github/workflows/release.yml
git diff -- .github/workflows | grep -E '^[+-] *- uses:|^[+-] *uses:'
git diff --stat -- scripts/release packages/core/package.json apps/cli/package.json
ruby -ryaml -e 'ARGV.each { |f| YAML.load_file(f) }; puts "yaml ok"' .github/workflows/ci.yml .github/workflows/release.yml
grep -c "echo '//npm.pkg.github.com" .github/workflows/ci.yml .github/workflows/release.yml
# Replay the append against a copy of the file actions/setup-node writes (no final newline).
for W in .github/workflows/ci.yml .github/workflows/release.yml; do
  SIM=$(mktemp -d)
  printf '%s\n%s\n%s' '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}' 'registry=https://registry.npmjs.org' 'always-auth=false' > "$SIM/npmrc"
  LINE=$(grep -m1 'npm.pkg.github.com/:_authToken' "$W" | sed 's/^ *//')
  NPM_CONFIG_USERCONFIG="$SIM/npmrc" bash -c "$LINE"
  grep -c -x 'always-auth=false' "$SIM/npmrc"
  grep -c -x -F '//npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}' "$SIM/npmrc"
done
bash scripts/epic-check.sh E-009 2>&1 | tail -n 12
```
Expected, in order: `no-root-npmrc`; `https://registry.npmjs.org/`, `https://npm.pkg.github.com/`, `2`; `undefined` (npm sees no mapping; `NPM_CONFIG_USERCONFIG=/dev/null` isolates the check to what the repository itself supplies); the latest released version, from npmjs.com; `exit=0`; `0` for both files (pnpm, unlike npm, reads the mapping, so it must never publish the libraries); `0` for both files (no mapping line is written into an npm config file by a workflow); the install's last lines and `exit=0` (the dependencies are unchanged at this point, so this proves the `registries` block with its `default` entry does not break unscoped packages); in `ci.yml` five lines (header comment, `printf` line, the `if [ -z` guard, its error message, the `env` line) and in `release.yml` the last four of those, and no line outside the token step and the install step; `0` for both files; nothing; `1` then `0` (the publish step keeps its name; no `environment:` key exists, the pattern skips the header comment that mentions the word); nothing; nothing; `yaml ok`; `0` for both files (no bare `echo` append is left); then `1` and `1` for each workflow (the audit ran this replay: a bare `echo` append gives `0` and `0`); E-009 assertions 1 to 4 `PASS`.

If `npm config get @montionugera:registry` prints anything but `undefined`, or `npm view` fails, STOP: something npm reads maps the scope, and the next merge to main would break "Decide release".

E-009 assertion 5 (it builds the docs) is expected to **FAIL at this point** and is not a finding: after the cherry-pick of Task 2 the alias target does not exist in this worktree, so the docs cannot build until Task 4. Task 4 Step 7 runs E-009 again, and there all five must pass.

- [ ] **Step 6: Commit**
```bash
git add pnpm-workspace.yaml .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci(F-045): map the design-system scope for pnpm only, hand the read token to install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Phase gate (own gate, risky surface).** Verify (Step 5 output) → independent review of this commit's diff by `code-reviewer` and `typescript-reviewer` on `model: opus`, asked specifically: can the token reach any step other than install; does the token line land on a line of its own in both workflows, including after the file `actions/setup-node` writes in `release.yml`; does a run with an empty secret stop with the explicit error; is any `uses:` line, `permissions` block, publish command, the publish step's name or the workflow's file name changed, or an `environment:` added; **does any file npm reads (a root `.npmrc`, the user-level file a workflow writes) now carry a registry mapping for `@montionugera`, and is `pnpm publish` used anywhere** → apply findings → re-run Step 5. Do not advance on an open finding.

### Task 4: Registry dependencies and alias removal

**Files:**
- Create: `apps/docs/tests/joymify-wiring.test.ts`
- Delete: `apps/docs/joy-alias.ts`
- Restore to `release/1.10`: `apps/docs/vite.config.ts`, `apps/docs/vitest.config.ts`, `apps/docs/tsconfig.json`, `vitest.config.ts`
- Modify: `apps/docs/package.json`, `pnpm-lock.yaml`
- Modify: the eleven files under `apps/docs/src` that name `@joymify/` (import specifiers only)

**Interfaces:**
- Consumes: the `registries` mapping in `pnpm-workspace.yaml` from Task 3; the local token setup checked in Task 1.
- Produces: `@montionugera/joy-react` resolved from `apps/docs/node_modules`, exporting `CodeBlock`, `PolyglotCodeTabs`, `MermaidViewer`, `MarkdownViewer`, `Segmented`, `Alert`, `Button`, `Badge`.

- [ ] **Step 1: Write the failing test** `apps/docs/tests/joymify-wiring.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as joy from "@montionugera/joy-react";
const docs = path.resolve(import.meta.dirname, "..");
const root = path.resolve(docs, "../..");
const read = (file: string) => readFileSync(file, "utf8");
// Built from parts so this file never matches the repository-wide grep for the old alias names.
const ALIAS = "joy-" + "alias";
const SIBLING = new RegExp(`${ALIAS}|joy-` + "design");
// The working names the base branch used. They were never published.
const OLD_SCOPE = "@joy" + "mify/";
describe("Joymify packages come from the registry", () => {
  it("has no sibling-checkout alias left", () => {
    expect(existsSync(path.join(docs, `${ALIAS}.ts`))).toBe(false);
    for (const file of ["vite.config.ts", "vitest.config.ts", "tsconfig.json"]) {
      expect(read(path.join(docs, file)), file).not.toMatch(SIBLING);
      expect(read(path.join(docs, file)), file).not.toContain(OLD_SCOPE);
    }
    expect(read(path.join(root, "vitest.config.ts"))).not.toMatch(SIBLING);
  });
  it("depends on published version ranges", () => {
    const deps = JSON.parse(read(path.join(docs, "package.json"))).dependencies;
    expect(deps["@montionugera/joy-react"]).toBe("^0.2.0");
    expect(deps["@montionugera/joy-tokens"]).toBe("^0.2.0");
    expect(Object.keys(deps).filter((name) => name.startsWith(OLD_SCOPE))).toEqual([]);
  });
  it("maps the scope for pnpm only, so the npm release of the libraries is untouched", () => {
    const workspace = read(path.join(root, "pnpm-workspace.yaml"));
    expect(workspace).toMatch(/^registries:\n  default: https:\/\/registry\.npmjs\.org\/\n  '@montionugera': https:\/\/npm\.pkg\.github\.com\/$/m);
    // npm reads .npmrc. A registry line there would send npm view and npm publish
    // for @montionugera/ucsa-* to GitHub Packages. The file must not exist.
    expect(existsSync(path.join(root, ".npmrc"))).toBe(false);
  });
  it("exports the components the portal uses", () => {
    const names = ["Button", "Badge", "CodeBlock", "PolyglotCodeTabs", "MermaidViewer", "MarkdownViewer", "Segmented", "Alert"] as const;
    for (const name of names) expect(joy[name], name).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/joymify-wiring.test.ts 2>&1 | tail -n 15`
Expected: FAIL. The import of `@montionugera/joy-react` cannot be resolved (the alias target is absent in this worktree), or the alias assertions fail.

- [ ] **Step 3: Remove the alias and restore the four config files**
```bash
git rm apps/docs/joy-alias.ts
git checkout release/1.10 -- apps/docs/vite.config.ts apps/docs/vitest.config.ts apps/docs/tsconfig.json vitest.config.ts
git diff release/1.10 --stat -- apps/docs/vite.config.ts apps/docs/vitest.config.ts apps/docs/tsconfig.json vitest.config.ts
```
Expected: the last command prints nothing. The base commits changed these four files only to add the alias, `resolve.dedupe` and the type paths, so the `release/1.10` content is the target state (`tsconfig.json` is back to the single `@montionugera/ucsa-core` path).

- [ ] **Step 4: Rename the import specifiers to the published names**
```bash
grep -rl "@joymify/" apps/docs/src | wc -l
grep -rl "@joymify/" apps/docs/src | xargs perl -pi -e 's{\@joymify/(react|tokens|icons|brand)}{\@montionugera/joy-$1}g'
grep -rn "@joymify" apps/docs --exclude-dir=node_modules | head -n 5
git diff --stat -- apps/docs/src | tail -n 1
```
Expected: `11` (nine components, `main.tsx`, `index.css`, as on the base commit; if the count differs, read the extra or missing file before going on); then the grep prints nothing; the stat shows 11 files with equal insertions and deletions. Nothing but the specifier changes: no import is added, removed or reordered.

- [ ] **Step 5: Add the dependencies**
```bash
pnpm --filter @ucsa/docs add @montionugera/joy-react@^0.2.0 @montionugera/joy-tokens@^0.2.0
grep -n "@montionugera/joy-" apps/docs/package.json
grep -rn -E "@montionugera/joy-(icons|brand)" apps/docs/src | head -n 3
grep -c "npm:@montionugera" apps/docs/package.json
env NPM_CONFIG_USERCONFIG=/dev/null npm config get @montionugera:registry; test ! -e .npmrc && echo no-root-npmrc
node -p "require('./apps/docs/node_modules/@montionugera/joy-react/package.json').version"
```
Expected: two dependency lines with `^0.2.0`; the second grep prints nothing (no direct import of icons or brand, so neither becomes a direct dependency); `0` (no alias); `undefined` and `no-root-npmrc` (`pnpm add` created no npm-visible mapping); the version prints `0.2.0`. This is the first real proof that pnpm sends the user-level token to a registry it learned from `pnpm-workspace.yaml`. A 401 here means the local token setup from Task 1 is gone: stop and report. A 404 that names `registry.npmjs.org` means pnpm did not apply the `registries` block: STOP and report the pnpm version; do not add a `.npmrc` line to get past it (finding 16).

- [ ] **Step 6: Run the test to see it pass**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/joymify-wiring.test.ts 2>&1 | tail -n 8`
Expected: 4 passed.

- [ ] **Step 7: Full phase 1a local verification, one command at a time**
```bash
pnpm --filter @montionugera/ucsa-core build
pnpm --filter @ucsa/docs test 2>&1 | tail -n 6
pnpm typecheck 2>&1 | tail -n 5
pnpm --filter @ucsa/docs build 2>&1 | tail -n 8
test ! -e apps/docs/joy-alias.ts && echo alias-gone
grep -rn -E "joy-design/packages|joy-alias|@joymify/" apps/docs --include='*.ts' --include='*.tsx' --include='*.json' --include='*.css' --exclude-dir=node_modules
grep -c "@montionugera/joy-" apps/docs/tsconfig.json
grep -rl -E "from ['\"]@montionugera/joy-react['\"]" apps/docs/src | wc -l
grep -c "@montionugera/joy-tokens/theme.css" apps/docs/src/main.tsx
grep -c -E "MarkdownViewer|MermaidViewer|CodeBlock|PolyglotCodeTabs|Segmented|Alert" apps/docs/node_modules/@montionugera/joy-react/dist/index.d.ts
bash scripts/epic-check.sh E-009 2>&1 | tail -n 12
```
Expected: the core build prints its build output (if it prints `No projects matched the filters`, the filter name is wrong: stop); tests exit 0 with `BASELINE + 4` passed; typecheck exit 0; build exit 0; `alias-gone`; the grep prints nothing (no alias and no unpublished name is left; the wiring test builds those strings from parts so it does not match); `0` (no type path is needed for the installed packages); at least `9`; `1`; at least `6`; all five E-009 assertions `PASS` (assertion 5 failed in Task 3 only because the docs could not build yet).

If the docs tests fail here with a count below `BASELINE + 4`, the cause is one of two things and the report must say which: the cherry-picked markup against the two test files `release/1.10` added, or the published `dist` behaving differently from the source the base branch aliased. Fix the first in this repository; the second is an upstream defect, STOP and report it.

- [ ] **Step 8: Commit**
```bash
git add apps/docs/src apps/docs/tests/joymify-wiring.test.ts apps/docs/package.json pnpm-lock.yaml apps/docs/vite.config.ts apps/docs/vitest.config.ts apps/docs/tsconfig.json vitest.config.ts
git commit -m "feat(F-045): install the Joymify packages from the registry, drop the sibling aliases

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Phase gate** for Tasks 2 and 4 together: verify (Step 7) → `code-reviewer` + `typescript-reviewer` on `model: opus` over `git diff release/1.10..HEAD -- apps/docs vitest.config.ts` → `/simplify` → re-run the docs tests and the docs build.

### Task 5: README install requirement

**Files:**
- Modify: `README.md` (the `apps/docs` section, the paragraph added by `68ad8b7` that begins "The studio UI reuses the Joymify design system"; it holds the README's one `@joymify/` mention)

**Interfaces:**
- Consumes: `TOKEN_EXPIRY` from Task 1.

- [ ] **Step 1: Replace that paragraph** (it tells readers to check out `joy-design` as a sibling directory) with the text below, putting the real date in place of `TOKEN_EXPIRY`:

````markdown
The studio UI is built with the Joymify design system, installed as the private packages `@montionugera/joy-react` and `@montionugera/joy-tokens` from GitHub Packages (account `montionugera`, repository `joy-design`). They share the `@montionugera` scope with the libraries this repository publishes to npmjs.com, so the scope is mapped to `https://npm.pkg.github.com` for pnpm only, in the `registries` block of `pnpm-workspace.yaml`.

**Never add `@montionugera:registry=...` to a `.npmrc`, here or in your `~/.npmrc`.** npm reads those files, and the line sends `npm view` and `npm publish` for `@montionugera/ucsa-core` and `@montionugera/ucsa-cli` to GitHub Packages instead of npmjs.com; neither `--registry` nor `publishConfig.registry` overrides it. Check at any time with `npm config get @montionugera:registry`, which must print `undefined`. For the same reason the libraries are published with `npm publish`, never `pnpm publish`.

**One-time setup.** `pnpm install` answers 401 for the whole workspace until npm can read those packages. This applies to every contributor and every worktree, including work that does not touch the docs, and to `scripts/precheck.sh` and `scripts/epic-check.sh`.

```bash
# 1. Add the token line to your user-level npm config. Keep the ${...} text as is.
echo '//npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}' >> ~/.npmrc
# 2. Export a token with the read:packages scope from an account that can read the private montionugera/joy-design packages.
gh auth refresh -s read:packages
export JOYMIFY_PACKAGES_READ_TOKEN=$(gh auth token)
```

If you prefer not to export a variable in every shell, store the token itself instead: `npm config set //npm.pkg.github.com/:_authToken <token>`. That writes it to `~/.npmrc` in clear text.

**CI.** Both workflows (`ci.yml`, `release.yml`) read the packages with the Actions secret `JOYMIFY_PACKAGES_READ_TOKEN`, a classic personal access token with the single scope `read:packages`, given to the install step only. **It expires on TOKEN_EXPIRY.** When it expires, installs turn red on the next pull request and on the next merge, which also blocks the library release. The fix is a new token in the same secret, then a re-run of the failed workflow.
````

- [ ] **Step 2: Verify**

Run: `grep -n -E "JOYMIFY_PACKAGES_READ_TOKEN|read:packages" README.md | head -n 8; grep -c "joy-design" README.md; grep -c "TOKEN_EXPIRY" README.md`
Expected: the setup and CI lines print; `0`; `0` (the placeholder word was replaced by the date). Then `grep -c "@joymify/" README.md` prints `0` and `grep -c "Never add" README.md` prints `1`.

- [ ] **Step 3: Commit**
```bash
git add README.md
git commit -m "docs(F-045): README setup for the private Joymify packages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Prove the install on a clean runner

**Files:**
- Modify only if Step 3 demands it: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the feature branch with Tasks 2 to 5.

- [ ] **Step 1: Local gate, then a clean-room install (the cheap proof, run first)**

Run: `bash scripts/precheck.sh 2>&1 | tail -n 15`
Expected: exit 0.

Then prove the lockfile installs from the registry with nothing cached and no sibling checkout, using a throwaway clone and an empty package store:
```bash
CLEAN=$(mktemp -d)
git clone --quiet --no-hardlinks . "$CLEAN/repo"
(cd "$CLEAN/repo" && pnpm install --frozen-lockfile --store-dir "$CLEAN/store" > "$CLEAN/install.log" 2>&1; echo "exit=$?"; tail -n 4 "$CLEAN/install.log")
node -p "require('$CLEAN/repo/apps/docs/node_modules/@montionugera/joy-react/package.json').version"
rm -rf "$CLEAN"
```
Expected: `exit=0` and `0.2.0`. This settles the spec criterion "`pnpm install --frozen-lockfile` exits 0 on a fresh clone that has no sibling `joy-design` directory". It does **not** prove the Actions secret holds a working token; only a run on GitHub can.

- [ ] **Step 2: OWNER GO-AHEAD REQUIRED, then open a draft pull request to main to run `ci.yml`**

**STOP here and ask the owner before running anything in this step.** It is the only outward-facing action in the plan: it pushes the feature branch to GitHub and opens a pull request against `main` that people watching the repository are notified about. A general "continue" or "go ahead" for the plan does not cover it; the owner must approve this step by name. Tell the owner what it buys and what the alternative is:

- *Why it is worth it.* `ci.yml` runs only on pull requests to main, and the value stored in the secret can be tested only by a run on GitHub. Without this step the first test of the secret is the release pull request at promote time, where a red install holds up every feature in `release/1.10`.
- *What it shows publicly.* The branch is based on `release/1.10`, so the pull request lists every unreleased commit of that release, not only F-045. The repository is private.
- *If the owner declines.* Skip Steps 2 to 4, record in `handoff.md` the line `ci.yml proof deferred to the release pull request (owner decision); spec criterion "the pull request's ci.yml run is green" is NOT met by this feature`, and go to Step 5. Do not mark the criterion as met.

With the go-ahead, check that secrets will reach the run, then open the draft. It is never merged from here: the feature ships through the release branch.
```bash
gh secret list | grep -c JOYMIFY_PACKAGES_READ_TOKEN
git push -u origin HEAD
gh pr create --draft --base main --title "F-045 CI proof: Joymify packages from the registry (do not merge)" --body "Draft only. Proves that ci.yml installs the private @montionugera/joy-* packages on a runner with no cache and no sibling checkout. The feature ships through release/1.10.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr view --json isDraft,autoMergeRequest,mergeable -q '[.isDraft, .autoMergeRequest, .mergeable]'
gh pr checks --watch 2>&1 | tail -n 6
```
Expected: `1`; the pull request is a draft with no auto-merge (`[true,null,"MERGEABLE"]`; `"UNKNOWN"` right after creation is normal, ask again after a few seconds); the `precheck` check is green. If `mergeable` is `CONFLICTING`, GitHub builds no merge commit and `ci.yml` never starts: close the draft and report, do not wait on the checks. A pull request from the same repository receives Actions secrets; one from a fork does not, and Task 3's guard would stop it with the explicit error.

- [ ] **Step 3: If the install step is green but "Gate 1 (precheck)" fails on a 401 or a placeholder error** (`scripts/precheck.sh` line 67 re-runs `pnpm install --prefer-offline` without the variable), do **not** hand the token to the precheck step: that step runs every build and test script in the repository, and the rule is that the token reaches install only. Add this step to `ci.yml` directly after the install step instead, and push a new commit:
```yaml
      # Later steps run without the token; drop the line so no tool trips on
      # the unresolved placeholder.
      - name: Remove the Joymify token line after install
        run: sed -i '/npm.pkg.github.com\/:_authToken/d' "${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
```

The packages are already in `node_modules` and the lockfile is satisfied, so the re-install has nothing to fetch. If it still fails with a 401 (it tried to fetch), STOP and ask the owner whether the token may be given to the precheck step as well; the spec allows it, but it widens where the token is visible and is the owner's call.

This is a workflow edit: it gets the Task 3 Step 7 gate again before it is pushed, and if it was needed in `ci.yml` the same step goes into `release.yml` after its install step (Task 3 Step 1 already describes it). If the install step itself is red, read its log first: the explicit "is empty" error means the secret is missing; a 401 means it is wrong, expired or cannot read the private `montionugera/joy-design` packages; a 404 that names `registry.npmjs.org` for `@montionugera/joy-react` means the runner's pnpm did not apply the `registries` block of `pnpm-workspace.yaml` (it was proved on pnpm 10.13.1 only). In every case STOP and report to the owner; do not retry with a different token mechanism, and never work around a 404 by writing a scope mapping into a `.npmrc` (finding 16).

- [ ] **Step 4: Close the draft and record the result**
```bash
gh pr close "$(gh pr view --json number -q .number)" --comment "CI proof complete; shipping through release/1.10."
```

The remote feature branch stays (closing a pull request does not delete it); say so in the report. Add one line to `handoff.md`: `ci.yml run green: <run URL>`, and whether Step 3 was needed. What this run does **not** prove, and `handoff.md` must say so: the token line in `release.yml`, which is appended to a file that `actions/setup-node` wrote. That path is covered only by the replay in Task 3 Step 5 and by the watched first merge. Commit `handoff.md` alone with message `chore(F-045): record the ci.yml proof run` plus the co-author line.

- [ ] **Step 5: Post-merge watch (recorded, not run here).** The criterion "after the merge to main the Release workflow is green through install and Decide release" can only be met at promote time. Add to `handoff.md`: `At promote: watch the Release run (install, Decide release, publish). In the log of the step "Publish to npmjs.com (trusted publishing)" the npm notice must read "Publishing to https://registry.npmjs.org". Then run npm view @montionugera/ucsa-core version --registry=https://registry.npmjs.org/ outside the repository, and from the repository root npm config get @montionugera:registry must print undefined.`

---

## Phase 1b: themes

### Task 7: Theme module, toggle and no-flash script

**Files:**
- Create: `apps/docs/src/theme.ts`, `apps/docs/src/components/ThemeToggle.tsx`, `apps/docs/tests/theme-toggle.test.tsx`
- Modify: `apps/docs/index.html`, `apps/docs/src/App.tsx` (the `sidebar__brand` block, near line 118), `apps/docs/src/shell.css`

**Interfaces:**
- Consumes: `Segmented` from `@montionugera/joy-react`. Its props, from `packages/react/src/Segmented.tsx`: `options: (string | SegmentedOption)[]` with `SegmentedOption = { label: string; value: string; disabled?: boolean }`, `value?: string`, `defaultValue?: string`, `disabled?: boolean`, `size?: 'sm' | 'md' | 'lg'`, `onChange?: (value: string) => void`, plus `div` attributes. It renders `role="radiogroup"` with `role="radio"` buttons carrying `aria-checked`.
- Consumes: the tokens contract in `@montionugera/joy-tokens/theme.css`: `[data-theme="dark"]` forces dark, `[data-theme="light"]` forces light, and with no attribute `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` follows the system.
- Produces: `THEME_KEY = "ucsa-docs-theme"`, `type ThemeChoice = "system" | "light" | "dark"`, `readTheme(): ThemeChoice`, `applyTheme(choice: ThemeChoice): void`, `ThemeToggle(): JSX.Element`.

- [ ] **Step 1: Write the failing test** `apps/docs/tests/theme-toggle.test.tsx`
```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ThemeToggle } from "../src/components/ThemeToggle.js";
import { THEME_KEY } from "../src/theme.js";
const html = readFileSync(path.resolve(import.meta.dirname, "../index.html"), "utf8");
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const runInlineScript = () => new Function(inlineScript)();
const root = document.documentElement;
const checked = (name: string) => screen.getByRole("radio", { name }).getAttribute("aria-checked");
describe("theme toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute("data-theme");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it("choosing Dark sets data-theme and saves the choice", () => {
    render(<ThemeToggle />);
    expect(checked("System")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(checked("Dark")).toBe("true");
  });
  it("choosing System removes the attribute and the saved key", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
  it("index.html no longer forces dark and runs its script inside head", () => {
    expect(html).not.toContain('data-theme="dark"');
    expect(inlineScript.trim()).not.toBe("");
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("</head>"));
  });
  it("applies a saved choice on load, and the toggle shows it", () => {
    localStorage.setItem(THEME_KEY, "light");
    runInlineScript();
    expect(root.getAttribute("data-theme")).toBe("light");
    render(<ThemeToggle />);
    expect(checked("Light")).toBe("true");
  });
  it("ignores a saved value that is neither light nor dark", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    runInlineScript();
    expect(root.hasAttribute("data-theme")).toBe(false);
    render(<ThemeToggle />);
    expect(checked("System")).toBe("true");
  });
  it("keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(runInlineScript).not.toThrow();
    render(<ThemeToggle />);
    expect(checked("System")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/theme-toggle.test.tsx 2>&1 | tail -n 12`
Expected: FAIL, cannot resolve `../src/components/ThemeToggle.js`.

- [ ] **Step 3: Create `apps/docs/src/theme.ts`**
```ts
export const THEME_KEY = "ucsa-docs-theme";
export type ThemeChoice = "system" | "light" | "dark";
/** The saved choice. Anything else, or blocked storage, means "follow the system". */
export function readTheme(): ThemeChoice {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}
/** Light and dark set `data-theme`; system removes it so the tokens follow `prefers-color-scheme`. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage can be blocked (private mode). The choice then lasts for this page only.
  }
}
```

- [ ] **Step 4: Create `apps/docs/src/components/ThemeToggle.tsx`**
```tsx
import React, { useState } from "react";
import { Segmented } from "@montionugera/joy-react";
import { applyTheme, readTheme, type ThemeChoice } from "../theme.js";
const OPTIONS = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  return (
    <Segmented
      className="theme-toggle"
      aria-label="Theme"
      size="sm"
      options={OPTIONS}
      value={choice}
      onChange={(value) => {
        const next: ThemeChoice = value === "light" || value === "dark" ? value : "system";
        applyTheme(next);
        setChoice(next);
      }}
    />
  );
}
```

- [ ] **Step 5: Edit `apps/docs/index.html`.** Change `<html lang="en" data-theme="dark">` to `<html lang="en">`, and add the inline script directly after the `<meta charset>` line, so the top of `<head>` reads:
```html
    <meta charset="UTF-8" />
    <script>
      try {
        var saved = localStorage.getItem("ucsa-docs-theme");
        if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
      } catch (e) {}
    </script>
```

The script sits before any stylesheet (Vite injects its stylesheet link at the end of `<head>`), so the attribute is set before first paint.

- [ ] **Step 6: Put the toggle in the sidebar.** In `apps/docs/src/App.tsx` add `import { ThemeToggle } from "./components/ThemeToggle.js";` and change the brand block to:
```tsx
        <div className="sidebar__brand">
          <span className="sidebar__name">UCSA Studio</span>
          <Badge variant="success">v1.4</Badge>
          <p>Unified Client State Architecture</p>
          <ThemeToggle />
        </div>
```

The sidebar is the phone drawer, so the toggle is reachable there. The drawer still focuses the first `.navlink` on open (`App.tsx` line 38), so the focus tests are unaffected. In `apps/docs/src/shell.css`, after the `.sidebar__brand p` rule, add:
```css
.sidebar__brand .theme-toggle { margin-top: var(--space-3); }
```

- [ ] **Step 7: Run the new test, then the whole docs suite**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/theme-toggle.test.tsx 2>&1 | tail -n 8`
Expected: 6 passed.
Run: `pnpm --filter @ucsa/docs test 2>&1 | tail -n 6`
Expected: exit 0, `BASELINE + 10` passed.
Run: `grep -c 'data-theme="dark"' apps/docs/index.html`
Expected: `0`.

- [ ] **Step 8: Commit**
```bash
git add apps/docs/src/theme.ts apps/docs/src/components/ThemeToggle.tsx apps/docs/tests/theme-toggle.test.tsx apps/docs/index.html apps/docs/src/App.tsx apps/docs/src/shell.css
git commit -m "feat(F-045): light, dark and system theme toggle with no flash on load

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Self-hosted fonts and the last hard-coded colours

**Files:**
- Create: `apps/docs/tests/theme-assets.test.ts`
- Modify: `apps/docs/package.json`, `pnpm-lock.yaml`, `apps/docs/src/main.tsx`, `apps/docs/src/index.css` (the `:root` block, lines 2 to 34), `apps/docs/src/components/LifecycleGraph.css:4`, `apps/docs/src/components/StaleTimeline.css:10`

**Interfaces:**
- Consumes: tokens `--joy-font-family-sans: Inter, -apple-system, BlinkMacSystemFont, sans-serif`, `--joy-font-family-mono: JetBrains Mono, Menlo, monospace`, `--joy-color-navy-900` (the design system's own modal backdrop is `color-mix(in srgb, var(--joy-color-navy-900) 60%, transparent)`).
- Produces: nothing later tasks call.

- [ ] **Step 1: Write the failing test** `apps/docs/tests/theme-assets.test.ts`
```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const src = path.resolve(import.meta.dirname, "../src");
const files = (readdirSync(src, { recursive: true }) as string[]).map((f) => path.join(src, f));
const read = (file: string) => readFileSync(file, "utf8");
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
describe("theme assets", () => {
  it("has no colour literal in any stylesheet", () => {
    const hits = files
      .filter((f) => f.endsWith(".css"))
      .flatMap((f) => read(f).split("\n").filter((l) => LITERAL.test(l)).map((l) => `${path.basename(f)}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
  it("has no colour literal in any inline style", () => {
    const hits = files
      .filter((f) => f.endsWith(".tsx"))
      .flatMap((f) => read(f).split("\n").filter((l) => l.includes("style={{") && LITERAL.test(l)).map((l) => `${path.basename(f)}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
  it("forces a colour scheme only through data-theme", () => {
    const hits = files
      .filter((f) => f.endsWith(".css") && path.basename(f) !== "index.css")
      .filter((f) => /color-scheme\s*:/.test(read(f)))
      .map((f) => path.basename(f));
    expect(hits).toEqual([]);
    const index = read(path.join(src, "index.css"));
    expect(index).toMatch(/\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;/);
    expect(index).toMatch(/\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;/);
  });
  it("loads the self-hosted fonts and names them first", () => {
    const main = read(path.join(src, "main.tsx"));
    expect(main).toContain('import "@fontsource-variable/inter";');
    expect(main).toContain('import "@fontsource-variable/jetbrains-mono";');
    const index = read(path.join(src, "index.css"));
    expect(index).toMatch(/--joy-font-family-sans:\s*"Inter Variable"/);
    expect(index).toMatch(/--joy-font-family-mono:\s*"JetBrains Mono Variable"/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/theme-assets.test.ts 2>&1 | tail -n 20`
Expected: 3 failed (the `--scrim` literal in `index.css`; `LifecycleGraph.css` and `StaleTimeline.css` for `color-scheme`; the font imports), 1 passed (inline styles are already clean).

- [ ] **Step 3: Add the font packages and confirm the family names**
```bash
pnpm --filter @ucsa/docs add @fontsource-variable/inter @fontsource-variable/jetbrains-mono
grep -o "font-family: '[^']*'" apps/docs/node_modules/@fontsource-variable/inter/index.css | sort -u
grep -o "font-family: '[^']*'" apps/docs/node_modules/@fontsource-variable/jetbrains-mono/index.css | sort -u
```
Expected: `font-family: 'Inter Variable'` and `font-family: 'JetBrains Mono Variable'`. If a name differs, use the printed name in Step 5 and in the test, and say so in the commit message.

- [ ] **Step 4: Import the fonts in `apps/docs/src/main.tsx`**, directly above the tokens import:
```tsx
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@montionugera/joy-tokens/theme.css";
import "./index.css";
```

- [ ] **Step 5: Edit `apps/docs/src/index.css`.** In the `:root` block replace the line `  --scrim: rgba(0, 0, 0, 0.6);` with:
```css
  /* Same recipe as the design system's own modal backdrop. */
  --scrim: color-mix(in srgb, var(--joy-color-navy-900) 60%, transparent);
  /* The tokens name "Inter" and "JetBrains Mono" but ship no font files. The self-hosted
     variable fonts register under "... Variable", so those names go first. */
  --joy-font-family-sans: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, sans-serif;
  --joy-font-family-mono: "JetBrains Mono Variable", "JetBrains Mono", Menlo, monospace;
  color-scheme: light dark;
```

and directly after the closing brace of that `:root` block add:
```css
[data-theme="light"] { color-scheme: light; }
[data-theme="dark"] { color-scheme: dark; }
```

`index.css` is imported after `theme.css`, so the two font tokens win by order.

- [ ] **Step 6: Remove the two forced dark schemes.** In `apps/docs/src/components/LifecycleGraph.css` line 4 and `apps/docs/src/components/StaleTimeline.css` line 10, delete the declaration `color-scheme: dark;` and keep the rest of each rule (`overflow-x: auto; scrollbar-color: ...`).

- [ ] **Step 7: Run the test, the suite and the build**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/theme-assets.test.ts 2>&1 | tail -n 8`
Expected: 4 passed.
Run: `pnpm --filter @ucsa/docs test 2>&1 | tail -n 6`
Expected: exit 0, `BASELINE + 14` passed.
Run: `pnpm --filter @ucsa/docs build 2>&1 | tail -n 6; ls apps/docs/dist/assets | grep -c -E "\.woff2$"; grep -rn -E "fonts\.googleapis|fonts\.gstatic" apps/docs/dist | head -n 3`
Expected: build exit 0; a count of at least `2`; the last grep prints nothing.

- [ ] **Step 8: Commit**
```bash
git add apps/docs/tests/theme-assets.test.ts apps/docs/package.json pnpm-lock.yaml apps/docs/src/main.tsx apps/docs/src/index.css apps/docs/src/components/LifecycleGraph.css apps/docs/src/components/StaleTimeline.css
git commit -m "feat(F-045): self-hosted fonts and theme-aware scrim and scrollbars

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Phase gate** for Tasks 7 and 8 together: verify (Step 7) → `code-reviewer` + `typescript-reviewer` on `model: opus` over the two commits → `/simplify` → re-run the docs tests and the docs build.

### Task 9: Browser verification of the themes (subagent, text verdict)

**Files:** none, unless a defect is found; a fix is a new commit with its own test where one can be written.

- [ ] **Step 1: Start the preview**

First the part of "no flash" that can be proved without a browser, on the built page:
```bash
pnpm --filter @ucsa/docs build 2>&1 | tail -n 4
node -e 'const h=require("fs").readFileSync("apps/docs/dist/index.html","utf8");const s=h.indexOf("<script>"),c=h.indexOf("rel=\"stylesheet\""),m=h.indexOf("type=\"module\"");console.log(s>-1&&c>-1&&s<c&&s<m?"inline-first":"WRONG ORDER",s,c,m)'
grep -c 'data-theme=' apps/docs/dist/index.html
```
Expected: `inline-first` (the theme script comes before the stylesheet link and before the module script, so the attribute is set before anything can paint); `0`. `WRONG ORDER` is a defect: fix `index.html` and add the same ordering assertion to `tests/theme-toggle.test.tsx` only if it can be made on the source file.

Then run in the background: `pnpm --filter @ucsa/docs preview` (port 6006; if busy, Vite picks the next port, use the one it prints). The site is served under `/cli-state-handler/`.

- [ ] **Step 2: Dispatch one browser subagent** (`model: sonnet`, it needs the `claude-in-chrome` tools) with the brief in "Appendix: browser brief" below, plus these phase 1b checks:

- Saved choice against the system: read `matchMedia("(prefers-color-scheme: dark)").matches`, save the **opposite** theme in `localStorage["ucsa-docs-theme"]`, reload, and report `document.documentElement.dataset.theme` and `getComputedStyle(document.body).backgroundColor`: they must be the saved theme's, not the system's. Then remove the key, reload, and confirm the attribute is absent and the page follows the system.
- Throttled reload with the system set to dark and Light saved, no dark frame: the `claude-in-chrome` tools cannot throttle the network or emulate a colour scheme. Report this line as `NOT RUN` unless you really did it; never `PASS` by inference.
- Fonts: after `await document.fonts.ready`, `[...document.fonts].filter(f => f.status === "loaded").map(f => f.family.replace(/["']/g, ""))` contains both `Inter Variable` and `JetBrains Mono Variable`. Do not use `document.fonts.check()`: in Chrome it answers `true` for a family that does not exist.
- Same origin only: `performance.getEntriesByType("resource").filter(e => new URL(e.name).origin !== location.origin).length` is `0`.
- At 360px, open the drawer, change the theme with the toggle, close the drawer with Escape: the theme changed and focus returned to the menu button.

- [ ] **Step 3: Act on the verdict.** `PASS` on every line: stop the preview and go on. Any `FAIL`: fix it (token or layout CSS only, no new colour literals), commit, re-run the docs tests, and dispatch the subagent again for the failing routes. Any `NOT RUN`: it is not a pass. Copy the line into `handoff.md` under "Manual checks left for the owner" (the throttled-reload criterion of the spec is expected to land there) and name it in the final report.

---

## Phase 2: code blocks and diagrams

### Task 10: The lazy wrapper, and `Prose` on Joymify components

**Files:**
- Create: `apps/docs/src/components/rich.tsx`, `apps/docs/src/components/rich-impl.ts`, `apps/docs/src/components/rich.css`, `apps/docs/tests/rich.test.tsx`
- Modify: `apps/docs/src/components/Prose.tsx`, `apps/docs/src/prose.css` (lines 11 to 16)

**Interfaces:**
- Consumes, quoted from `joy-design` release/3.8 `packages/react/src/`:
  - `CodeBlockProps extends React.HTMLAttributes<HTMLDivElement>`: `code?: string` (default `''`), `language?: string` (default `'text'`), `title?: string`, `showLineNumbers?: boolean` (default `false`), `allowCopy?: boolean` (default `true`). Root class `joy-code-block`; highlighted tokens are `<span class="joy-syntax-<type>">`.
  - `PolyglotCodeTabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'>`: `items?: PolyglotCodeItem[]`, `activeKey?: string`, `defaultActiveKey?: string`, `onChange?: (key: string) => void`, `showLineNumbers?: boolean`, `allowCopy?: boolean`. `PolyglotCodeItem = { key?: string; language: string; label?: string; code: string; filename?: string }`. It renders `role="tablist"` with `role="tab"` buttons whose text is `label`.
  - `MermaidViewerProps extends React.HTMLAttributes<HTMLDivElement>`: `code?: string`, `title?: string`, `initialView?: 'diagram' | 'source'`, `allowCopy?: boolean`, `allowToggle?: boolean`. A drawn diagram is `<svg class="joy-mermaid__svg">` inside `.joy-mermaid__viewport`; a rejected definition renders a `CodeBlock` with class `joy-mermaid__source`.
  - `AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>`: `title?: string`, `description?: string`, `variant?: 'info' | 'success' | 'warning' | 'danger'`, `closable?: boolean`, `onClose?: () => void`, `children?: React.ReactNode`. Root class `joy-alert joy-alert--<variant>`, default `role="alert"`, extra props spread after it.
- Produces: `Code(props: CodeBlockProps)`, `CodeTabs(props: PolyglotCodeTabsProps)`, `Diagram(props: MermaidViewerProps)` from `./components/rich.js`. `Prose.tsx` keeps its exports `Prose`, `Callout({ tone?: "info" | "warn"; title?: string; children })`, `CodeBlock({ children: string; language?: string })`, so no tutorial file changes.

- [ ] **Step 1: Write the failing test** `apps/docs/tests/rich.test.tsx`
```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Code, Diagram } from "../src/components/rich.js";
import { Callout, CodeBlock } from "../src/components/Prose.js";
const FLOW = "flowchart LR\n  A[Cache] --> B[Network]";
describe("Joymify code and diagram components", () => {
  afterEach(() => cleanup());
  it("shows the plain code first, then Joymify highlight spans", async () => {
    const { container } = render(<Code code={"const a = 1; // note"} language="typescript" />);
    expect(container.textContent).toContain("const a = 1; // note");
    await waitFor(() => expect(container.querySelector('[class^="joy-syntax-"]')).not.toBeNull());
    expect(container.querySelector(".joy-code-block")).not.toBeNull();
  });
  it("draws a flowchart as an svg", async () => {
    const { container } = render(<Diagram code={FLOW} />);
    await waitFor(() => expect(container.querySelector("svg.joy-mermaid__svg")).not.toBeNull());
    expect(container.querySelector("svg.joy-mermaid__svg")?.textContent).toContain("Network");
  });
  it("shows the source of a definition the renderer rejects, and does not throw", async () => {
    const { container } = render(<Diagram code="sequenceDiagram" />);
    await waitFor(() => expect(container.querySelector(".joy-mermaid__source")).not.toBeNull());
    expect(container.querySelector("svg.joy-mermaid__svg")).toBeNull();
    expect(container.querySelector(".joy-mermaid__source")?.textContent).toContain("sequenceDiagram");
  });
  it("Prose CodeBlock renders through the Joymify CodeBlock", async () => {
    const { container } = render(<CodeBlock language="typescript">{"const b = 2;"}</CodeBlock>);
    await waitFor(() => expect(container.querySelector(".joy-code-block.prose-code")).not.toBeNull());
  });
  it("Prose Callout is a Joymify Alert that is not announced as an alert", () => {
    const { container } = render(<Callout tone="warn" title="Careful">Body text</Callout>);
    const alert = container.querySelector(".joy-alert.joy-alert--warning");
    expect(alert?.getAttribute("role")).toBe("note");
    expect(alert?.textContent).toContain("Careful");
    expect(alert?.textContent).toContain("Body text");
    expect(render(<Callout>Info</Callout>).container.querySelector(".joy-alert--info")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/rich.test.tsx 2>&1 | tail -n 12`
Expected: FAIL, cannot resolve `../src/components/rich.js`.

- [ ] **Step 3: Create `apps/docs/src/components/rich-impl.ts`**
```ts
// Loaded only through the dynamic import in rich.tsx. Do not import this file statically.
export { CodeBlock, PolyglotCodeTabs, MermaidViewer } from "@montionugera/joy-react";
```

- [ ] **Step 4: Create `apps/docs/src/components/rich.css`**
```css
/* Shown while the Joymify code and diagram chunk loads: the same text, unhighlighted. */
.rich-fallback { margin: 0; padding: var(--space-4); overflow-x: auto; background: var(--bg-sidebar); border: 1px solid var(--border-card); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--text-sm); }
```

- [ ] **Step 5: Create `apps/docs/src/components/rich.tsx`**
```tsx
import React, { Suspense, lazy } from "react";
import type { CodeBlockProps, MermaidViewerProps, PolyglotCodeTabsProps } from "@montionugera/joy-react";
import "./rich.css";
// One dynamic import for all three, so the highlighter and the diagram renderer
// stay out of the entry chunk. Everything else imports from this module.
const load = () => import("./rich-impl.js");
const LazyCodeBlock = lazy(() => load().then((m) => ({ default: m.CodeBlock })));
const LazyCodeTabs = lazy(() => load().then((m) => ({ default: m.PolyglotCodeTabs })));
const LazyMermaid = lazy(() => load().then((m) => ({ default: m.MermaidViewer })));
function Plain({ code }: { code: string }) {
  return (
    <pre className="rich-fallback">
      <code>{code}</code>
    </pre>
  );
}
export function Code(props: CodeBlockProps) {
  return (
    <Suspense fallback={<Plain code={props.code ?? ""} />}>
      <LazyCodeBlock {...props} />
    </Suspense>
  );
}
export function CodeTabs(props: PolyglotCodeTabsProps) {
  const items = props.items ?? [];
  const active = items.find((item) => (item.key || item.language) === props.activeKey) ?? items[0];
  return (
    <Suspense fallback={<Plain code={active?.code ?? ""} />}>
      <LazyCodeTabs {...props} />
    </Suspense>
  );
}
export function Diagram(props: MermaidViewerProps) {
  return (
    <Suspense fallback={<Plain code={props.code ?? ""} />}>
      <LazyMermaid {...props} />
    </Suspense>
  );
}
```

- [ ] **Step 6: Replace `Callout` and `CodeBlock` in `apps/docs/src/components/Prose.tsx`.** The whole file becomes:
```tsx
import React from "react";
import { Alert } from "@montionugera/joy-react";
import { Code } from "./rich.js";
import "../prose.css";
/** Prose page primitive: styles h1-h3, p, ul/ol, inline code and links for tutorial content. */
export function Prose({ children }: { children: React.ReactNode }) {
  return <article className="prose">{children}</article>;
}
/** A static note. `role="note"` replaces the Alert's default `role="alert"`, which would be announced on load. */
export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Alert className="prose-callout" role="note" variant={tone === "warn" ? "warning" : "info"} title={title}>
      {children}
    </Alert>
  );
}
export function CodeBlock({ children, language }: { children: string; language?: string }) {
  return <Code className="prose-code" code={children} language={language} />;
}
```

- [ ] **Step 7: Trim `apps/docs/src/prose.css`.** Delete the four rules `.prose-callout`, `.prose-callout--info`, `.prose-callout--warn`, `.prose-callout__title` and the rule `.prose-code` (lines 11 to 16), and put this single rule in their place:
```css
.prose-callout, .prose-code { margin: var(--space-4) 0; }
```

- [ ] **Step 8: Run the test, then the suite**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/rich.test.tsx 2>&1 | tail -n 8`
Expected: 5 passed.
Run: `pnpm --filter @ucsa/docs test 2>&1 | tail -n 6`
Expected: exit 0, `BASELINE + 19` passed.

- [ ] **Step 9: Commit**
```bash
git add apps/docs/src/components/rich.tsx apps/docs/src/components/rich-impl.ts apps/docs/src/components/rich.css apps/docs/tests/rich.test.tsx apps/docs/src/components/Prose.tsx apps/docs/src/prose.css
git commit -m "feat(F-045): Joymify CodeBlock and Alert in tutorial prose, behind one lazy wrapper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Platform guide on `PolyglotCodeTabs` and `CodeBlock`

**Files:**
- Modify: `apps/docs/src/components/MultiPlatformDocs.tsx`, `apps/docs/src/components/multiplatform.css:15`, `apps/docs/tests/multiplatform-docs.test.tsx`

**Interfaces:**
- Consumes: `Code`, `CodeTabs` from `./rich.js` (Task 10); `guides`, `platforms: PlatformId[]`, `PlatformId = "ts" | "dart" | "csharp"`, `Snippet = { title; lang; available; code; sources; notes }` from `../content/guides/index.js`.
- Produces: nothing later tasks call.

- [ ] **Step 1: Edit the existing test and add the new ones.** In `apps/docs/tests/multiplatform-docs.test.tsx`:

Add `waitFor` to the Testing Library import. The platform labels now come from the lazily loaded tab list, so in the two tests "switches language tabs to Dart and C# Unity dynamically" and "switches concept tabs to the WAL and UCB1 guides", make the callback `async` and change the three lookups `screen.getByText("🎯 Dart 3+ (Flutter)")` (once) and `screen.getByText("🎮 C# Unity (.NET)")` (twice) to `await screen.findByText(...)` with the same string. Change nothing else in those tests. Then add inside the top-level `describe`:
```tsx
  it("offers the three platforms as Joymify tabs and highlights the TypeScript snippet", async () => {
    const { container } = render(<MultiPlatformDocs />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "🟦 TypeScript (React / Node)",
      "🎯 Dart 3+ (Flutter)",
      "🎮 C# Unity (.NET)",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('.joy-code-block [class^="joy-syntax-"]')).not.toBeNull();
    expect(container.querySelector(".mp-code")).toBeNull();
    fireEvent.click(tabs[2]);
    expect(screen.getByText("QueryEngine & SWR Lifecycle (C# Unity)")).toBeDefined();
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");
  });
  it("renders three Joymify code blocks in the side-by-side view", async () => {
    const { container } = render(<MultiPlatformDocs />);
    fireEvent.click(screen.getByText("Side by side"));
    await waitFor(() => expect(container.querySelectorAll(".mp-side .joy-code-block").length).toBe(3));
    expect(screen.queryByRole("tablist")).toBeNull();
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/multiplatform-docs.test.tsx 2>&1 | tail -n 15`
Expected: the two new tests FAIL (no element with role `tab`; no `.joy-code-block`). The existing ones still pass.

- [ ] **Step 3: Edit `apps/docs/src/components/MultiPlatformDocs.tsx`**

Add the import below the `@montionugera/joy-react` import:
```tsx
import { Code, CodeTabs } from "./rich.js";
```

Change the `SnippetView` signature and its code area. The state, `handleCopy`, the header, the notes list and the sources line stay exactly as they are:
```tsx
function SnippetView({ snippet, children }: { snippet: Snippet; children?: React.ReactNode }) {
```

```tsx
      {children ?? (snippet.available ? (
        <div className="mp-scroll" role="region" aria-label={`${snippet.title} code, scrollable`} tabIndex={0}>
          <Code code={snippet.code} language={snippet.lang} allowCopy={false} />
        </div>
      ) : (
        <p className="mp-unavailable"><strong>Not available on this platform.</strong></p>
      ))}
```

In `MultiPlatformDocs`, below `const guide = guides[concept];` add:
```tsx
  // Tabs need a snippet on every platform; a guide with a gap keeps the plain buttons.
  const allAvailable = platforms.every((p) => guide[p].available);
  const isPlatform = (key: string): key is PlatformId => (platforms as readonly string[]).includes(key);
```

Change the condition of the platform button row from `view === "tabs" ? (` to `view === "tabs" && !allAvailable ? (` (its `<span />` branch stays). Replace the final block `{view === "tabs" ? ( <SnippetView snippet={guide[platform]} /> ) : ( <div className="mp-side">…</div> )}` with:
```tsx
        {view === "side" ? (
          <div className="mp-side">
            {platforms.map((p) => (
              <SnippetView key={p} snippet={guide[p]} />
            ))}
          </div>
        ) : allAvailable ? (
          <SnippetView snippet={guide[platform]}>
            <CodeTabs
              aria-label="Platform code"
              items={platforms.map((p) => ({ key: p, language: guide[p].lang, label: PLATFORM_LABEL[p], code: guide[p].code }))}
              activeKey={platform}
              onChange={(key) => {
                if (isPlatform(key)) setPlatform(key);
              }}
              allowCopy={false}
            />
          </SnippetView>
        ) : (
          <SnippetView snippet={guide[platform]} />
        )}
```

The portal's own copy button stays (it reports a failed copy; the Joymify one does not), which is why `allowCopy` is `false` in both places. The snippet title stays in the header, outside the lazy boundary.

- [ ] **Step 4: Delete the dead rule** `.mp-code { ... }` on line 15 of `apps/docs/src/components/multiplatform.css`. Keep `.mp-scroll` (the parity matrix uses it).

- [ ] **Step 5: Run the test, then the suite**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/multiplatform-docs.test.tsx 2>&1 | tail -n 8`
Expected: all pass, two more than before.
Run: `pnpm --filter @ucsa/docs test 2>&1 | tail -n 6`
Expected: exit 0, `BASELINE + 21` passed.

- [ ] **Step 6: Commit**
```bash
git add apps/docs/src/components/MultiPlatformDocs.tsx apps/docs/src/components/multiplatform.css apps/docs/tests/multiplatform-docs.test.tsx
git commit -m "feat(F-045): platform guide on Joymify PolyglotCodeTabs and CodeBlock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Request-path diagram on the Overview page, and the chunk check

**Files:**
- Create: `apps/docs/tests/home-diagram.test.tsx`
- Modify: `apps/docs/src/pages/Home.tsx`, `apps/docs/src/pages/home.css`

**Interfaces:**
- Consumes: `Diagram` from `../components/rich.js` (Task 10).

- [ ] **Step 1: Write the failing test** `apps/docs/tests/home-diagram.test.tsx`
```tsx
// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Home } from "../src/pages/Home.js";
describe("Overview request-path diagram", () => {
  afterEach(() => cleanup());
  it("draws the cache, write-ahead log and outbox path as an svg", async () => {
    const { container } = render(<Home />);
    await waitFor(() => expect(container.querySelector(".home__diagram svg.joy-mermaid__svg")).not.toBeNull());
    const text = container.querySelector(".home__diagram svg.joy-mermaid__svg")?.textContent ?? "";
    for (const label of ["Memory cache", "Write-ahead log on disk", "Offline outbox"]) expect(text).toContain(label);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/home-diagram.test.tsx 2>&1 | tail -n 10`
Expected: FAIL, the `waitFor` times out (no `.home__diagram`).

- [ ] **Step 3: Add the diagram to `apps/docs/src/pages/Home.tsx`.** Add the import and the constant above `export function Home()`:
```tsx
import { Diagram } from "../components/rich.js";
// Plain arrows and bracket nodes only: that is the subset the Joymify renderer draws.
const REQUEST_PATH = `flowchart LR
  APP[App reads a query] --> CACHE[Memory cache]
  CACHE --> NET[Network fetch when stale]
  NET --> WAL[Write-ahead log on disk]
  WAL --> CACHE
  MUT[App writes a mutation] --> OUTBOX[Offline outbox]
  OUTBOX --> NET`;
```

and directly after the closing `</div>` of `<div className="home__panels">`, still inside the card:
```tsx
      <div className="home__diagram">
        <Diagram code={REQUEST_PATH} title="Request path: cache, write-ahead log and outbox" allowCopy={false} />
      </div>
```

- [ ] **Step 4: Add to `apps/docs/src/pages/home.css`**
```css
.home__diagram { margin-top: var(--space-6); max-width: 100%; overflow-x: auto; }
```

- [ ] **Step 5: Run the test, the suite, the build and the chunk check**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/home-diagram.test.tsx 2>&1 | tail -n 6`
Expected: 1 passed.
Run: `pnpm --filter @ucsa/docs test 2>&1 | tail -n 6`
Expected: exit 0, `BASELINE + 22` passed.

```bash
pnpm --filter @ucsa/docs build 2>&1 | tail -n 12
ENTRY=$(grep -o 'assets/index-[^"]*\.js' apps/docs/dist/index.html | head -n 1)
echo "entry=$ENTRY"; grep -l "joy-mermaid" apps/docs/dist/assets/*.js; grep -c "joy-mermaid" "apps/docs/dist/$ENTRY"
```
Expected: build exit 0; `grep -l` lists at least one file; that file is not `$ENTRY`; the count for the entry file is `0`. Note the gzip size of the stylesheet from the build output in `handoff.md` (the spec asks for it in the pull request).

If the entry chunk contains `joy-mermaid`, the bundler did not drop the unused re-exports of the package's single entry point. STOP and report: the fix is upstream (subpath exports in `@montionugera/joy-react`), not a deep import or a copied renderer here.

- [ ] **Step 6: Commit**
```bash
git add apps/docs/tests/home-diagram.test.tsx apps/docs/src/pages/Home.tsx apps/docs/src/pages/home.css
git commit -m "feat(F-045): request-path flowchart on the Overview page through MermaidViewer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Phase gate** for Tasks 10 to 12 together: verify (Step 5) → `code-reviewer` + `typescript-reviewer` on `model: opus` over the three commits → `/simplify` → re-run the docs tests and the docs build.

### Task 13: Phase 2 browser verification, README, final sweep

**Files:**
- Modify: `README.md` (the `apps/docs` section and the test count line near line 2841), `handoff.md` in the feature folder

- [ ] **Step 1: Browser subagent.** Start the preview as in Task 9 Step 1 and dispatch one browser subagent (`model: sonnet`) with "Appendix: browser brief" plus these phase 2 checks:

- On `#/` the request-path diagram is an `svg` with readable node labels in light and in dark, and at 360px it scrolls inside its own box without widening the page.
- On `#/multiplatform` the three platform tabs switch the code and the title; arrow keys change the selected tab (the Joymify tabs change the selection without moving keyboard focus; that is upstream behaviour, report it, do not fix it here); "Side by side" shows three code blocks; the copy button reports "✓ Copied to Clipboard".
- On each tutorial route the code blocks are highlighted and the callouts are readable in both themes.

Act on the verdict as in Task 9 Step 3.

- [ ] **Step 2: README.** In the `apps/docs` section, after the setup text from Task 5, add:
```markdown
**Themes.** The sidebar has a System / Light / Dark control. The choice is saved in `localStorage` under `ucsa-docs-theme`; System follows the operating system. Fonts (Inter, JetBrains Mono) are bundled into `apps/docs/dist/assets`, so the built site makes no request to another origin.

**Code and diagrams.** Code samples use the Joymify `CodeBlock` and `PolyglotCodeTabs`, and diagrams use `MermaidViewer`, all loaded on demand through `apps/docs/src/components/rich.tsx`. The diagram renderer draws flowcharts and sequence diagrams only, and the highlighter has no Dart or C# grammar yet; both gaps are fixed upstream in `joy-design`, not here.
```

Then run the whole workspace suite once and update the count line near line 2841 with the real numbers:

Run: `pnpm test 2>&1 | tail -n 6`
Expected: exit 0. Put the printed test and file counts into the sentence "Run complete Vitest suite (… tests across … files, …)".

- [ ] **Step 3: Acceptance sweep.** Run each line and compare with the spec's phase 1b and phase 2 criteria:
```bash
grep -c 'data-theme="dark"' apps/docs/index.html
pnpm --filter @ucsa/docs build 2>&1 | tail -n 4
ls apps/docs/dist/assets | grep -c -E "\.woff2$"
grep -rn -E "fonts\.googleapis|fonts\.gstatic" apps/docs/dist | head -n 3
bash scripts/precheck.sh 2>&1 | tail -n 12
git status --short | head -n 5
```
Expected: `0`; build exit 0; at least `2`; nothing; precheck exit 0; a clean tree apart from `README.md` and `handoff.md`.

- [ ] **Step 4: File the off-goal findings, do not fix them.** Record three upstream ideas for `joy-design` in `handoff.md` under "Upstream to file": (1) `renderMermaidToSvg` draws unsupported diagram types as a flowchart instead of returning `success: false`; (2) the highlighter has no Dart or C# grammar; (3) the tokens stylesheet sets no `color-scheme`, so each consumer adds it; (4) `PolyglotCodeTabs` arrow keys change the selected tab but leave focus on the old one. (A fifth idea, about the manifests' `repository` field not matching an organisation `joymify`, was dropped on 2026-10-11: the packages are published from `montionugera/joy-design` under the account `montionugera`, so the field is right.)

- [ ] **Step 5: Commit**
```bash
git add README.md .claude/refined_backlog/F-045-adopt-the-joymify-design-system-in-the-d/handoff.md
git commit -m "docs(F-045): README for themes, code blocks and diagrams; record upstream gaps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Final gate.** `code-reviewer` on `model: opus` over the README diff and over `git diff release/1.10..HEAD --stat` for anything outside this plan's file table → fix → `git status --short` is empty. The feature is then ready for `ps-release-workflow-ship`.

---

## Appendix: browser brief

Give this text to the browser subagent in Tasks 9 and 13, with the task's extra checks appended.

```
Goal: verify the docs portal renders correctly in both themes at two widths. Return text only.
Site: http://localhost:<port>/cli-state-handler/ (the preview server is already running).
Routes (hash routes, from apps/docs/src/routes.ts): #/ , #/tutorial-first-query , #/tutorial-freshness ,
#/tutorial-durable-cache , #/tutorial-outbox , #/tutorial-ucb1 , #/swr , #/timing , #/outbox , #/cas ,
#/ucb1 , #/wal , #/multiplatform , #/parity , #/release-notes , #/sandbox  (16 routes).
Widths: after resizing the window, read window.innerWidth. If it is not the width asked for (a
Chrome window may refuse to go as narrow as 360px), do not report the route at that width from the
wide window. Instead add a same-origin iframe of exactly that width to a blank same-origin page
(style "width:360px;height:800px;border:0", src = the route URL), wait for its load event, and run
the checks on iframe.contentDocument / iframe.contentWindow. Say in the reply which method you used.
For every route, at 360px and at 1280px wide, in light and in dark (set
document.documentElement.dataset.theme to "light" or "dark" in the document under test), check:
  1. documentElement.scrollWidth <= innerWidth of the document under test  (no horizontal page scroll)
  2. the console shows no errors
  3. text is legible on every surface: no dark text on a dark surface, no light on light
At 360px also check once per theme: the menu button opens the drawer, Escape closes it.
A check you could not actually execute is NOT RUN, never PASS. Do not infer a result.
Do not paste screenshots into the reply. Return at most 15 lines:
  line 1: PASS or FAIL overall (FAIL if any check failed; say "PASS with NOT RUN" if some did not run)
  then one line per failing route: route, width, theme, check number, what you saw
  last line: the extra checks, each PASS, FAIL or NOT RUN
```

## Self-review

- **Spec coverage.** Phase 0 → Task 1. Rebase and baseline → Task 2. The pnpm-only scope mapping, both workflows, `ci.yml` header, release regression check, E-009 → Task 3. Dependencies, import rename to the published names, alias removal, exports check, typecheck, build → Task 4. README install and expiry → Task 5. Draft pull request, `precheck.sh`, the unproven `precheck` re-install → Task 6. Toggle, no-flash script, storage failure → Task 7. Fonts, scrim, inline-style guard → Task 8. Route check at 360px and 1280px in both themes → Tasks 9 and 13. `CodeBlock`, `Alert`, lazy wrapper, flowchart and rejected-diagram tests → Task 10. `PolyglotCodeTabs` → Task 11. Overview diagram and the non-entry chunk check → Task 12. Post-merge Release watch → recorded for promote time in Task 6 Step 5 (it cannot run before the release is promoted).
- **Not covered, on purpose.** Phase 3 (markdown). The spec's "unsupported diagram type shows its source" as worded (finding 6). Moving 54 inline styles (finding 4). The throttled-reload check of the no-flash criterion, which no available tool can run (finding 15): it is proved structurally in Task 9 Step 1 and left as a manual check for the owner.
- **Placeholders.** `TOKEN_EXPIRY` is an owner-supplied value with a stop condition in Task 1 and a check in Task 5 Step 2 that the word is gone. `BASELINE` is measured in Task 2. No other open value.
- **Type consistency.** `Code`, `CodeTabs`, `Diagram` (Task 10) are the names used in Tasks 11 and 12. `ThemeChoice`, `THEME_KEY`, `readTheme`, `applyTheme` (Task 7) are used only there. `Prose.tsx` keeps `Callout` and `CodeBlock` with unchanged props.
- **Test count ledger.** Task 4 +4, Task 7 +6, Task 8 +4, Task 10 +5, Task 11 +2, Task 12 +1: `BASELINE + 22` at the end.

## Audit trail

- 2026-10-09: plan written.
- 2026-10-10 `self-grill-audit` (independent; read against `release/1.10`, the base commits `68ad8b7` and `69f8c42` replayed in a throwaway worktree, `joy-design` release/3.8 source, and the `actions/setup-node` v4 source): verdict **safe with fixes, all applied here**. Nothing can run past Task 1 until the owner meets phase 0.
  - CRITICAL (C1), fixed: the token line was appended with `echo ... >>`. In `release.yml` the target file is written by `actions/setup-node` with no final newline, so the result was `always-auth=false//npm.pkg.github.com/:_authToken=...`: no token line, a 401 on every merge to main, library publishing blocked, and invisible to the Task 6 proof because `ci.yml` starts from no file. Reproduced locally. Now `printf '\n%s\n'`, with a replay check in Task 3 Step 5 and a gate question. Spec corrected.
  - HIGH, fixed: `pnpm --filter @ucsa/core build` matched no package and exited 0 in three places (the package is `@montionugera/ucsa-core`), so "build core first" silently did nothing.
  - HIGH, fixed: an empty secret (fork, Dependabot, deleted secret) failed as an opaque 401. The install step now stops with one explicit error; the variable is still scoped to that step.
  - HIGH, fixed: Task 3 Step 5 expected `epic-check.sh E-009` to pass while the docs cannot build (between the cherry-pick and Task 4). Assertion 5 is now an expected failure there and all five are required in Task 4 Step 6. The expected `grep` line counts were also wrong.
  - HIGH, fixed: Task 6 pushed a branch and opened a pull request against `main` with no owner gate, and its fallback handed the token to the whole precheck step, against this plan's own constraint. Now: a local clean-room install first, an explicit owner go-ahead with a recorded "declined" path, a draft and auto-merge check, and a fallback that removes the token line after install instead of widening the token.
  - HIGH, fixed: browser checks that could not run or could not fail (colour-scheme emulation, network throttling, `document.fonts.check()`, a 360px window). Replaced with executable checks and a mandatory `NOT RUN`.
  - HIGH, fixed: findings 2 to 7 departed from the spec without the spec saying so. Recorded in the spec's audit trail; the spec lines for the append, the diagram test, the inline styles and the fonts are corrected.
  - MEDIUM, fixed: Task 1 checked the registry before the local token setup, so "not published" and "not logged in" were indistinguishable.
  - Confirmed against source, no change: the cherry-pick conflicts in exactly `vite.config.ts` and `MultiPlatformDocs.tsx` and the second pick is clean; nine files import `@joymify/react`; the props of `CodeBlock`, `PolyglotCodeTabs`, `MermaidViewer`, `Segmented` and `Alert` and the exported prop types match the plan's code; `renderMermaidToSvg` returns `success: true` for `pie`, `classDiagram` and `gantt` and `success: false` for a bare `sequenceDiagram`; the Overview diagram renders with all four labels; `dart` and `csharp` tokenise as plain text; the only colour literal is `--scrim`, the only forced `color-scheme` rules are the two named; the three label lookups in the existing platform test are the only ones that need `findByText`; no existing test asserts the markup of `Callout`, the prose `CodeBlock` or `index.html`.
  - Recorded, not changed (MEDIUM/LOW): all 18 snippets are available, so the "plain buttons" branch of Task 11 is unreachable today and untested; `mp-scroll` (`role="region"`) now wraps a Joymify `CodeBlock` that is itself a region; `git checkout release/1.10 -- <files>` in Task 4 takes whatever `release/1.10` holds at that moment; the 360px layout of the new tabs, toggle and diagram is guarded only by the browser checks of Tasks 9 and 13, no unit test can catch it.
  - Open, owner: phase 0 (packages published, secret created, token expiry date, local token setup); the go-ahead for Task 6 Step 2; the manual throttled-reload check.
- 2026-10-11 correction of a wrong fact (not a new audit): **the package names**. Checked with `gh api /users/montionugera/packages...`: `@joymify/tokens`, `@joymify/icons`, `@joymify/brand` and `@joymify/react` do not exist (E404, and GitHub Packages has no `joymify` owner). The four packages are published, private, from `montionugera/joy-design`, at the versions this plan assumed, as `@montionugera/joy-tokens` 0.2.0, `@montionugera/joy-icons` 0.3.0, `@montionugera/joy-brand` 0.2.0 and `@montionugera/joy-react` 0.2.0. Owner decision: they stay private and are not republished as `@joymify/*`.
  - Renamed throughout the plan and the spec. `@joymify/` is left only where it describes what the base branch really contains before Task 4 (the Architecture line, the import-rename constraint, Task 2 Step 4, Task 4's rename step and its "nothing is left" checks, the README check in Task 5), in the "never published" warnings, and in the dated history of this trail and of finding 16.
  - CRITICAL, designed out: with the real names the planned root `.npmrc` line becomes `@montionugera:registry=https://npm.pkg.github.com`, the scope of this repository's own npmjs.com libraries. Reproduced on this machine (npm 11.17.0, a dead local address as the mapped registry): `npm view @montionugera/ucsa-core version`, the call "Decide release" makes on every merge to main, goes to the mapped registry; so does a dry-run `npm publish` of a tarball with `publishConfig.registry` set to npmjs.com; `--registry=https://registry.npmjs.org` changes neither; a mapping in the user-level file behaves the same. Only `--@montionugera:registry=...` overrides it.
  - Design chosen: no root `.npmrc`; the mapping is a `registries` block in `pnpm-workspace.yaml`, which pnpm 10.13.1 honours and npm never reads (reproduced: with the block present npm resolves and dry-run publishes to npmjs.com exactly as today). The release scripts, the publish step and the library manifests stay unedited. Rejected: scope line plus pins on the publish side (three call sites and two manifests to edit, and it fails open for any later npm call); a mapping written into the workflow's user-level file (same redirect); pnpm aliases that keep the old import names (they need the same mapping and hide the real name).
  - Guards added: the wiring test fails if a root `.npmrc` exists or the `registries` block changes (it runs in Gate 1, so in `ci.yml`); Task 1, Task 3 Step 5 and Task 4 Step 5 require `npm config get @montionugera:registry` to print `undefined`; Task 3 Step 5 runs the real `npm view` and `next-release.mjs` and checks that no workflow writes a mapping line and nothing uses `pnpm publish`; the gate reviewers are asked the question by name; the README says never to add the line; the promote-time watch reads the registry out of the publish log.
  - Consequence: Task 4 gains a step that renames the import specifiers in eleven files under `apps/docs/src` (steps renumbered, 9 in total). The test count ledger is unchanged (Task 4 still adds 4).
  - Not verified, because no token exists yet and nothing can be installed: that pnpm authenticates to a registry named only in `pnpm-workspace.yaml` with the user-level token line (Task 4 Step 5); that the newest pnpm 10 on the runner honours `registries` (Task 6); that the published `@montionugera/joy-react` 0.2.0 lists its siblings by their `@montionugera/joy-*` names and exports what the spec's table says (Task 1 Step 2, Task 4). The local `joy-design` checkout (main `2be5093e`) still carries the `@joymify/*` names in its manifests, so it was not used as evidence for the published names.
  - Open, owner: the Actions secret `JOYMIFY_PACKAGES_READ_TOKEN`; that token's expiry date; the local token line and variable; the go-ahead for Task 6 Step 2; the manual throttled-reload check.
