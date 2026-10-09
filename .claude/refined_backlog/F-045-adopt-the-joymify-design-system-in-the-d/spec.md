---
title: "Adopt the Joymify design system in the docs portal"
id: F-045
status: refined
from_idea: I-038
---

# Adopt the Joymify design system in the docs portal

## Goal

Owner's words: "using its design system for build doc not move into that repo".

The docs portal in this repository (`apps/docs`, package `@ucsa/docs`, React 19 + Vite, hash routes) is built with the Joymify design system, installed as the published `@joymify/*` packages from GitHub Packages (organisation `joymify`). The portal stays in `cli-state-handler`. It gets a light and a dark theme with a toggle, renders markdown through the Joymify markdown component, and renders Mermaid diagrams.

## Scope and non-goals

In scope:

- Replace the sibling-checkout aliases with registry dependencies on `@joymify/react` 0.2.0 and `@joymify/tokens` 0.2.0 (which pull in `@joymify/icons` 0.3.0 and `@joymify/brand` 0.2.0). All four are to be published; see "Packages" under "Current state".
- A repository `.npmrc` that maps only the `@joymify` scope, and package access for the two GitHub Actions workflows (`ci.yml`, `release.yml`) through one read-only token stored as an Actions secret.
- One regression check that the library release still targets npmjs.com. No change to the release script, the publish commands or the library manifests (see "No scope clash").
- Light and dark themes, a toggle that remembers the choice, no flash of the wrong theme on load.
- Self-hosted fonts (Inter, JetBrains Mono) inside the build output. No font CDN.
- Code samples, platform snippet tabs, markdown content and Mermaid diagrams rendered by Joymify components.
- README update for the new install requirement.

Non-goals:

- Moving the portal into the `joy-design` repository, vendoring Joymify source, or linking a sibling checkout.
- Changing routes, page content, the playground models, or the sandbox.
- Changing where or how `@montionugera/ucsa-core` and `@montionugera/ucsa-cli` are published (npmjs.com, trusted publishing, `release.yml` not renamed, no `environment:`). The libraries keep the `@montionugera` scope.
- Bumping the pinned versions of the workflow actions. Another session owns that (idea I-046); this spec edits steps, not action versions.
- Adding the full `mermaid` npm library, or a general markdown library, inside this repository. Gaps in the Joymify components are fixed upstream in `joy-design` (platform rule: enhance upstream, never shim in the consumer).
- A markdown editor in the portal. `MarkdownEditor` is exported upstream but nothing in the portal is edited by readers.

## Current state

Verified by reading the code on 2026-10-09, not taken from reports.

**Base branch.** `fix/docs-design-nav` (worktree `../cli-state-handler-fix-docs-design`) holds two commits, `68ad8b7` and `69f8c42`, on top of an older main `407ca76`. Main is now `3f6a81c`; release branch `release/1.10` starts from it. Since `407ca76`, main changed nine files under `apps/docs` (a Release notes page, a `version-json` Vite plugin, `MultiPlatformDocs.tsx`, `routes.ts`, two new test files).

**How the base branch reaches Joymify.** `apps/docs/joy-alias.ts` maps the names `@joymify/react`, `@joymify/icons/react`, `@joymify/brand`, `@joymify/tokens/theme.css` to `../../../joy-design/packages/...`. The aliases are spread into `vite.config.ts` and `vitest.config.ts`, and repeated as `paths` in `apps/docs/tsconfig.json` (plus two `react` type paths that exist only to stop duplicate React types from the sibling checkout). Nine source files import from `@joymify/react`; `main.tsx` imports `@joymify/tokens/theme.css`. The import names are already the names the packages will be published under, so the source files need no rename. What is broken is only the route: the aliases point at a sibling checkout that does not exist in CI.

**Theme.** `apps/docs/index.html` hard-codes `<html data-theme="dark">`. `src/index.css` maps the portal's own variables (`--bg-main`, `--text-main`, ...) onto `--joy-*` tokens, so most colours already follow the theme. Leftovers: 54 inline `style={{...}}` props in components and one hard-coded colour (`--scrim: rgba(0, 0, 0, 0.6)`).

**Fonts.** The tokens stylesheet names `Inter` and `JetBrains Mono` but ships no `@font-face`. Nothing loads the font files today, so the portal falls back to system fonts.

**Markdown, code, diagrams.** There is no markdown rendering today. Tutorial pages are hand-written TSX wrapped in `Prose` (`src/components/Prose.tsx`, which also defines a plain `Callout` and an unhighlighted `CodeBlock`). Platform snippets are plain `<pre class="mp-code">` blocks in `MultiPlatformDocs.tsx`. Release notes parse the repo-root `CHANGELOG.md` with a small hand-written parser (`src/models/changelog.ts`). No file under `apps/docs/src` mentions Mermaid.

**Sidebar.** Still main's anchor sidebar in `App.tsx`: real `<a href="#/...">` links with `aria-current="page"`, a phone drawer with focus handling, `inert`, Escape to close.

**CI.** There is no `docs.yml` any more; main deleted it. Two workflows remain:

- `ci.yml` runs on every pull request to main, `permissions: contents: read`, and its header comment states "no secrets". It runs `pnpm install --frozen-lockfile` then `scripts/precheck.sh` (the pre-ship build, typecheck and test check, which includes `apps/docs`).
- `release.yml` runs on every merge to main. It runs `pnpm install --frozen-lockfile` for the whole workspace, publishes the two libraries to npmjs.com through trusted publishing (no stored token), then builds the docs archive `docs-site.tgz` that the Joymify developer portal copies.

The repository has no Actions secrets at all (`gh secret list` is empty).

**Registry calls in the release pipeline (three).** All run with the repository root as working directory, so all read a root `.npmrc`. All three are for `@montionugera/ucsa-*` names:

1. `scripts/release/next-release.mjs` line 41, `npm view <name>@<version> version`, in the "Decide release" step. It runs on **every** merge to main. Only an `E404` counts as "not published"; any other failure throws and stops the run.
2. `release.yml`, "Publish to npmjs.com" step: `npm view "$name@$version" version` (any failure is read as "not published").
3. Same step: `npm publish "$RUNNER_TEMP"/npmjs/*.tgz --access public`.

`packages/core/package.json` and `apps/cli/package.json` already carry `publishConfig: { "access": "public", "registry": "https://registry.npmjs.org" }`. The README (around line 2672) also documents a manual `npm publish` recipe run from the repository root. Nothing in the repository installs `@montionugera/ucsa-*` from a registry: `apps/cli` and `apps/docs` use `workspace:*`, and there are no examples or smoke tests that install the published libraries.

**Other install sites.** Besides the two workflows, `scripts/precheck.sh` line 67 and `scripts/epic-check.sh` line 15 run `pnpm install` locally. Root `pnpm test` (used by `release.yml` "Unit tests" and by `precheck.sh`) runs the `apps/docs` tests too, so the docs dependencies are needed wherever tests run.

**Tool versions.** Both workflows pin `pnpm/action-setup` to `version: 10` (major only, so the runner gets the newest pnpm 10); the root `package.json` has no `packageManager` field; the local machine has pnpm 10.13.1. `release.yml` installs `npm@^11.5.1` for publishing. `actions/setup-node` in `release.yml` is given `registry-url`, which makes it write a user-level npm config file and export its path as `NPM_CONFIG_USERCONFIG`; in `ci.yml` it is not, so the user-level file there is `~/.npmrc`.

**Packages (to be published; not a fact yet).** The owner decided on 2026-10-09 to rename the Joymify packages and republish them as `@joymify/tokens` 0.2.0, `@joymify/icons` 0.3.0, `@joymify/brand` 0.2.0 and `@joymify/react` 0.2.0, private, on GitHub Packages under the organisation `joymify`. The work is `joy-design` feature F-073, shipped into that repository's release 3.8. As reported on 2026-10-09 it is **not yet on `joy-design` main and not yet published**. This spec therefore treats "the four packages resolve from the registry" as a precondition with its own acceptance checks, not as current state. The earlier packages `@montionugera/joy-*` (one version `0.2.0`, private, under the personal account) are superseded and are not used. `cli-state-handler` is private.

**What `@joymify/react` 0.2.0 is expected to export.** The table was read from `joy-design` main `02b1dfc8`, `packages/react/src/index.ts`, which is the source the superseded `@montionugera/joy-react` 0.2.0 was built from: single entry point `"."`, `sideEffects: false`, peers `react` and `react-dom` `^19.0.0`. F-073 is a rename, so the exports are assumed unchanged; that assumption is **not verified** and phase 1a checks it against the installed package.

| Need | Export | Notes from the source |
| --- | --- | --- |
| Markdown | `MarkdownViewer` (`content`, `allowCopy`) | Hand-written line parser: headings 1-3, paragraphs, block quotes, tables, rules, fenced code, inline code, bold, italic. A `mermaid` fence is passed to `MermaidViewer`. **No lists, no links, no images.** |
| Diagrams | `MermaidViewer` (`code`, `title`, `initialView`, `allowToggle`, `allowCopy`), `renderMermaidToSvg` | Zero-dependency renderer written in-house. **Flowcharts and sequence diagrams only.** |
| Code | `CodeBlock` (`code`, `language`, `title`, `showLineNumbers`, `allowCopy`), `PolyglotCodeTabs` (`items`, `activeKey`, `onChange`), `highlightCodeToHtml`, `tokenizeCode`, `normalizeLanguage` | Built-in highlighter, no external library. |
| Theme control | none | No provider or hook. Theming is pure CSS in `@joymify/tokens/theme.css`. `Segmented` and `Switch` are available for the control itself. |
| Navigation | `Menu`, `Anchor`, `Breadcrumb` | `Menu` renders `role="menuitem"` list items with an `onSelect` callback, not links. |

No `@joymify/*` tarball exists to open yet; the table is source, not a published artefact.

## Design

### Dependencies and `.npmrc`

Add to `apps/docs/package.json` dependencies: `@joymify/react` `^0.2.0` and `@joymify/tokens` `^0.2.0` (the stylesheet import needs tokens as a direct dependency under pnpm's strict layout). `@joymify/icons` and `@joymify/brand` arrive as dependencies of `@joymify/react`. If any file under `apps/docs/src` imports `@joymify/icons` or `@joymify/brand` directly (the alias file maps both), that package becomes a direct dependency too, for the same reason.

Add a repository-root `.npmrc` with the scope mapping only:

```
@joymify:registry=https://npm.pkg.github.com
```

The token line does **not** go in the committed file. It goes in the user-level npm config, as the literal text:

```
//npm.pkg.github.com/:_authToken=${JOYMIFY_PACKAGES_READ_TOKEN}
```

"User-level" means `~/.npmrc` on a developer machine, and on a runner the file named by `NPM_CONFIG_USERCONFIG` when that variable is set, otherwise `~/.npmrc`. The token itself is never written to disk; it is present only where the environment variable `JOYMIFY_PACKAGES_READ_TOKEN` is exported. The variable is deliberately not called `GITHUB_TOKEN`, so the workflow's own job token is never the one handed to the installer.

<div class="callout warn">
<strong>Why not a token line in the repository <code>.npmrc</code>.</strong> pnpm no longer expands <code>${NAME}</code> in a project-level <code>.npmrc</code> for registry URLs, URL-scoped keys and credential values: such a line is ignored with a warning. The pnpm 11 documentation dates this to v11.5.3; the pnpm 10 documentation dates the same restriction to v10.34.2 (security advisory GHSA-3qhv-2rgh-x77r; sources: pnpm.io/npmrc and pnpm.io/10.x/npmrc, read 2026-10-09). CI pins pnpm to major 10 only, so the runner is already on a pnpm 10 that ignores such a line: a committed <code>_authToken=${...}</code> line would answer 401 today, not only after a move to pnpm 11. Both documentation sets state that placeholders are still expanded in the user-level <code>.npmrc</code>, and that pnpm honours <code>NPM_CONFIG_USERCONFIG</code>. The scope mapping line has no placeholder, so it is unaffected.
</div>

Two limits of what was checked: the behaviour above is taken from the pnpm documentation, not from a run; and both documentation sets list `~/.npmrc` as a fallback behind pnpm's own auth file, which is fine here because nothing else sets a token for `npm.pkg.github.com`. The green install in `ci.yml` (pnpm 10) is the empirical proof for pnpm 10. No pnpm 11 run exists in this repository, so pnpm 11 stays **documented, not exercised**.

### No scope clash

<div class="callout success">
<strong>The release pipeline is left alone.</strong> A registry mapping is per scope. The new line maps <code>@joymify</code> only. This repository's own libraries are <code>@montionugera/ucsa-core</code> and <code>@montionugera/ucsa-cli</code>; no line mentions <code>@montionugera</code>, so npm keeps resolving that scope the way it does today, through the plain <code>registry</code> setting, which is npmjs.com (default, <code>publishConfig.registry</code> in both manifests, and <code>registry-url</code> in <code>release.yml</code>).
</div>

An earlier revision of this spec had the Joymify packages under `@montionugera`, the same scope as the libraries, and so needed a mitigation: an explicit npmjs.com flag on the three registry calls (the `npm view` in `scripts/release/next-release.mjs` line 41, and the `npm view` and `npm publish` lines in `release.yml`) and a `"@montionugera:registry"` key in the `publishConfig` of both library manifests. With the packages under `@joymify` there is nothing to defend against, so **all of that is removed from the design**: `next-release.mjs`, the publish step, `packages/core/package.json` and `apps/cli/package.json` are not edited.

What stays is one cheap regression check, so that a later edit which adds a `@montionugera` mapping (or a blanket `registry=` line) to the root `.npmrc` is caught before it reaches a release: from the repository root, `npm config get @montionugera:registry` prints `undefined`, and `node scripts/release/next-release.mjs` (no `--apply`, no token in the environment) exits 0, which exercises the real `npm view` against npmjs.com. Both are in the phase 1a acceptance criteria.

`pnpm install` of the workspace does not fetch the libraries at all: `workspace:*` never touches a registry, and no script installs the published libraries.

### Alias removal

Simpler than first specified, because the base branch already imports the final names (nine files import `@joymify/react`; `main.tsx` imports `@joymify/tokens/theme.css`). **No import statement changes.** Only the route to the packages changes, from alias to `node_modules`:

- Delete `apps/docs/joy-alias.ts`; remove it from `apps/docs/vite.config.ts`, `apps/docs/vitest.config.ts` and the repository-root `vitest.config.ts` (which imports it too), along with `resolve.dedupe` (one React copy once the sibling checkout is gone).
- Remove the four `@joymify/*` paths and the two `react` paths from `apps/docs/tsconfig.json`, returning it to main's single `@montionugera/ucsa-core` path.
- Root `pnpm typecheck` then resolves the packages through `apps/docs/node_modules` with no extra configuration.

### CI package access

```mermaid
flowchart LR
  PR[Pull request] --> CI[ci.yml install]
  MERGE[Merge to main] --> REL[release.yml install]
  SECRET[Read token secret] --> CI
  SECRET --> REL
  CI --> GHP[GitHub Packages org joymify]
  REL --> GHP
  REL --> NPMJS[npmjs.com publish]
  GHP --> JOY[joymify packages private]
```

Both workflows install the whole workspace, so both need read access to four private packages owned by the organisation `joymify`. The job's own token cannot read them (they belong to another owner), so access is a stored token:

- **The secret.** An Actions secret in `cli-state-handler` named `JOYMIFY_PACKAGES_READ_TOKEN`. Its value is a classic personal access token with the single scope `read:packages`, created by an account that can read the four packages, and authorised for the `joymify` organisation where the organisation requires it. Classic, because GitHub Packages does not accept fine-grained tokens (GitHub documentation, not re-read in this revision). The token expires; rotation is an owner task and its expiry date belongs in the README.
- **The workflow change, same in both files.** One step before `pnpm install` appends the literal token line shown above (placeholder intact, quoted so the shell does not expand it) to `"${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"`. The install step gets `env: JOYMIFY_PACKAGES_READ_TOKEN: ${{ secrets.JOYMIFY_PACKAGES_READ_TOKEN }}`. In `release.yml` the user-level file is the one `actions/setup-node` already wrote for npmjs.com; the line is appended, nothing in it is replaced. That file has **no final newline** (`actions/setup-node` v4, `src/authutil.ts`), so the append must start with a newline (`printf '\n%s\n' '<line>' >> file`); a bare `echo '<line>' >> file` joins the token line onto `always-auth=false` and the token is lost.
- **No `permissions` change.** `packages: read` is not added: it governs the job token, which is not used for this.
- **Action versions are not touched** (owned by I-046).
- **`ci.yml` no longer "no secrets".** Its header comment says so today and must be corrected in the same change. The secret is read-only for packages and is exposed to the install step only.

Coverage: the only two jobs that run `pnpm install` are `precheck` in `ci.yml` and `publish` in `release.yml`; both are covered. No later step fetches (`pnpm pack`, `pnpm --filter ... build` and `pnpm test` do not). `scripts/precheck.sh` re-runs `pnpm install` inside the CI job after the install step, with the store already filled and without the variable. Whether pnpm then only warns about the unresolved placeholder or fails is **not verified**; if it fails, the same `env` goes on the precheck step as well, and the green `ci.yml` run is what settles it.

Pull requests that do not receive Actions secrets (forks, Dependabot) would fail at install. The repository is private and has no Dependabot configuration today, so no access is designed for them; the install step only checks that the variable is not empty and stops with one explicit error, so such a run fails clearly instead of with a 401 from the registry.

Two consequences the owner should know about:

- **`release.yml` installs the whole workspace, so its install step needs the read token too.** The write-capable job token (`contents: write`, `id-token: write`) is still kept out of install, build and test, as the workflow's own comment intends: the installer sees only the read-only package token. That is an improvement on the earlier design, which passed the job token to install.
- **Library publishing now depends on GitHub Packages.** The whole-workspace install runs before publish, and root `pnpm test` includes the docs tests, so an expired or revoked token, a missing secret or a GitHub Packages outage blocks an npm release, against the workflow's stated intent that a docs break must not block one. Recovery is the existing manual re-run of the Release workflow once access is back. Decoupling (installing only the libraries before publish and the docs afterwards) would need the release test scope split and is left as a separate idea.

### Theme tokens and toggle

The tokens stylesheet already does the work: `[data-theme="dark"]` forces dark, `[data-theme="light"]` forces light, and with no attribute it follows the system setting.

```mermaid
flowchart TD
  LOAD[Page load] --> READ[Read saved choice]
  READ --> SAVED{Choice saved}
  SAVED -->|light or dark| SET[Set data-theme]
  SAVED -->|none| SYS[No attribute follow system]
  SET --> PAINT[First paint]
  SYS --> PAINT
  PAINT --> TOGGLE[Reader uses toggle]
  TOGGLE --> READ2[Save and apply]
```

- Remove the hard-coded `data-theme="dark"` from `index.html`. Add a small inline script in `<head>`, before any stylesheet, that reads `localStorage["ucsa-docs-theme"]` inside `try/catch` and sets `data-theme` when the value is `light` or `dark`. Running before first paint is what prevents the flash.
- Toggle: a Joymify `Segmented` control with three options, System, Light, Dark, in the sidebar brand block and reachable in the phone drawer. System removes the attribute and the saved key.
- Move the hard-coded colours onto `--joy-*` tokens so both themes are legible. As checked for the plan: none of the 54 inline styles carries a colour literal (they already use portal variables mapped to tokens), so the real leftovers are `--scrim` and two forced `color-scheme: dark` rules (`LifecycleGraph.css`, `StaleTimeline.css`); a guard test keeps colour literals out of stylesheets and inline styles.

### Fonts

Add `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` (npmjs.com) and import them in `main.tsx`. Vite copies the font files into `apps/docs/dist/assets`, so the archive stays self-contained and no request leaves the origin. The variable packages register the families as `"Inter Variable"` and `"JetBrains Mono Variable"`, while the tokens name `Inter` and `JetBrains Mono`, so the import alone changes nothing: `index.css` redefines the two custom properties `--joy-font-family-sans` and `--joy-font-family-mono` with the variable names first. Setting a token's custom property is the tokens' intended theming interface, not a shim of a component.

### Component mapping

| Today | Becomes | Phase |
| --- | --- | --- |
| `Button`, `Badge`, `Input`, `MetricTile` via `@joymify/react` through the alias | same components, same import, from the installed `@joymify/react` | 1a |
| `CodeBlock` in `Prose.tsx` (plain `<pre>`) | Joymify `CodeBlock` with highlighting and copy | 2 |
| `<pre class="mp-code">` per platform in `MultiPlatformDocs.tsx` | Joymify `PolyglotCodeTabs` (TypeScript, Dart, C#) where a guide shows all three; `CodeBlock` for single snippets | 2 |
| `Callout` in `Prose.tsx` | Joymify `Alert` | 2 |
| No diagrams | `MermaidViewer`, directly or through a `mermaid` fence in markdown | 2 |
| `ReleaseNotes` hand parser over `CHANGELOG.md` | `MarkdownViewer` with the raw changelog | 3 |
| Tutorial prose in TSX inside `Prose` | markdown segments (`.md` imported with `?raw`) rendered by `MarkdownViewer` between the live playgrounds | 3 |

Phase 3 is gated: `CHANGELOG.md` is all bullet lists and the tutorial prose uses lists and links, which `MarkdownViewer` 0.2.0 does not render. Lists and links are added upstream in `joy-design` (React and Svelte twins) and released first; until then `ReleaseNotes` and `Prose` stay as they are. Phases 1 and 2 do not wait for it.

To satisfy "Mermaid must render" in phase 2 without waiting, the Overview page gains one flowchart of the request path (cache, write-ahead log, outbox) through `MermaidViewer`.

### Sidebar decision

Keep the existing anchor sidebar, styled with tokens. The Joymify `Menu` renders menu items with a callback, not links: adopting it would lose open-in-new-tab, `aria-current="page"`, and the tested drawer focus handling. If a link-based navigation component is wanted, that is an upstream request, filed separately.

### Bundle size

- No Mermaid library is added: the upstream renderer is in-house code (about 740 lines), so the cost is small.
- `@joymify/react` has one entry point and `sideEffects: false`; Vite drops unused components.
- The markdown, code and diagram components are loaded with `React.lazy` from a single wrapper module, so the first page does not pay for them.
- The tokens stylesheet is about 240 kB before compression and covers every Joymify component. It is accepted as is; the gzip size is recorded in the pull request.

## Testing

- **Baseline.** Record the passing docs test count of `release/1.10` before the base commits are brought over (320 on the old base, plus main's two new test files); the two base commits add no test file, and the branch cannot run its tests between the cherry-pick and the alias removal. That number never drops. A test may be edited only where it asserts markup a Joymify component replaced; none is deleted.
- **New unit tests (Vitest + jsdom):** the toggle sets and clears `data-theme` and the saved key; the saved choice is applied on load; storage that throws does not break render; `CodeBlock` output contains highlight spans; a flowchart source produces an `<svg>`; a definition the renderer rejects (a `sequenceDiagram` with no participants) shows its source and does not throw. (Corrected 2026-10-10: the earlier wording "an unsupported diagram type shows its source" cannot pass, because the upstream renderer draws `pie`, `classDiagram` and `gantt` as a flowchart and reports success. That is filed upstream, not shimmed.)
- **Release safety check:** with the root `.npmrc` in place and no token in the environment, `npm config get @montionugera:registry` prints `undefined` and `node scripts/release/next-release.mjs` exits 0. No new unit test and no change to the release script: the earlier scope flag, and the test asserting it, are gone with the scope clash.
- **Browser check:** every route in `src/routes.ts` at 360px and 1280px, in light and in dark: no horizontal page scroll, drawer opens and closes at 360px, no console errors, text legible on every surface.

## Risks and open questions

- **Packages not published yet (blocks everything).** F-073 is not on `joy-design` main and nothing is on the registry. No phase starts until the four packages resolve (rollout step 0). If the published versions differ from 0.2.0 / 0.3.0, the ranges in this spec are corrected first.
- **CI package access (highest risk once published).** The secret `JOYMIFY_PACKAGES_READ_TOKEN` is created by the owner in GitHub settings; its value cannot be checked from a local machine, only its presence (`gh secret list`). If it is missing, wrong or expired, `release.yml` fails at install, which **blocks library publishing**, not just the docs. Mitigation: the same install runs in `ci.yml` on the pull request, so a red check appears before merge. Do not merge on a red or skipped install.
- **Token expiry.** A classic token expires. An expiry between releases shows up as a red install on the next pull request or merge. Mitigation: expiry date in the README, and the fix is a new token in the same secret, then a re-run.
- **Release pipeline regression.** The `.npmrc` does not map `@montionugera`, so no clash exists. The regression check in phase 1a guards against a later edit introducing one.
- **First merge is still watched.** Trusted publishing cannot be exercised before merge. The first merge to main after phase 1a must be watched: install green, "Decide release" green, and a publish (if one is due) landing on npmjs.com. Undo is a revert of the phase 1a commit, which removes the `.npmrc` and the workflow steps.
- **pnpm versions.** A committed token line is already ignored by current pnpm 10 and by pnpm 11; the design avoids it by keeping the token line in user-level config. pnpm 11 behaviour is from documentation only.
- **Tarball contents.** `@joymify/react` source declares its siblings as `workspace:*`. The published 0.2.0 must list real `@joymify/*` versions; if it does not, install fails and the fix is upstream.
- **Local installs now need a token.** `pnpm install` fails with 401 unless the user-level `~/.npmrc` has the token line and `JOYMIFY_PACKAGES_READ_TOKEN` is exported with a token that has `read:packages` and can read the `joymify` organisation's packages (for example `export JOYMIFY_PACKAGES_READ_TOKEN=$(gh auth token)` once the `gh` login has that scope, added with `gh auth refresh -s read:packages`). This affects every contributor and every agent worktree, including work unrelated to docs, and the local gates `scripts/precheck.sh` and `scripts/epic-check.sh`. In shells where the variable is not exported, npm and pnpm meet an unresolved placeholder in `~/.npmrc`; whether that is silent, a warning or an error in other projects is **not verified**. The fallback is to store the token itself with `npm config set //npm.pkg.github.com/:_authToken <token>`, which writes it to `~/.npmrc` in clear text. The README must give the one-time setup and both forms.
- **Markdown and Mermaid coverage.** No lists, links or images; flowcharts and sequence diagrams only. Phase 3 depends on an upstream release.
- **Rebase conflicts.** `vite.config.ts` and `MultiPlatformDocs.tsx` conflict; `routes.ts` and `README.md` merge cleanly (replayed 2026-10-10).
- **Worktree ownership.** The base worktree is owned by another session; the feature claim must take it over rather than edit beside it.
- **No open question on access.** The owner chose the stored read-only token. The earlier "Manage Actions access" grant on the personal-account packages is void and is not requested.

## Rollout

Each phase is shippable alone: after it, `main` builds, tests pass, and the release pipeline still publishes to npmjs.com.

0. Preconditions, not code changes, both owner actions. (a) `joy-design` F-073 reaches main and the four `@joymify/*` packages are published. (b) The secret `JOYMIFY_PACKAGES_READ_TOKEN` exists in `cli-state-handler`. Nothing merges before both, because the install in `ci.yml` cannot go green without them.
1. Rebase `fix/docs-design-nav` onto `release/1.10`; resolve conflicts; record the test baseline.
2. **Phase 1a, wiring.** Registry dependencies, `.npmrc`, alias removal, the token step and `env` in both workflows, the `ci.yml` header comment, README. No change to the release script, the publish commands or the library manifests. Open a draft pull request first to prove the install in `ci.yml`. The portal looks as it does on the base branch (dark only). Ships alone.
3. **Phase 1b, themes.** Toggle, no-flash script, fonts, inline styles onto tokens. Depends on 1a only.
4. **Phase 2, code and diagrams.** `CodeBlock`, `PolyglotCodeTabs`, `Alert`, the Overview diagram, lazy loading. Depends on 1a only.
5. **Phase 3**, a separate feature after the upstream release: markdown for release notes and tutorial prose. It gets its own acceptance criteria when it is specified; none below belong to it.

Each phase ends with verify, independent review, refactor, re-verify. Undo is a revert of the phase's commits; nothing is published or migrated.

## Acceptance criteria

Phase 0, preconditions (owner actions, checked before any code change):

- [ ] With a token that has `read:packages` exported as `JOYMIFY_PACKAGES_READ_TOKEN` and the user-level token line in place, each of `npm view @joymify/tokens@0.2.0 version`, `npm view @joymify/icons@0.3.0 version`, `npm view @joymify/brand@0.2.0 version` and `npm view @joymify/react@0.2.0 version`, run with `--@joymify:registry=https://npm.pkg.github.com`, prints that version.
- [ ] `npm view @joymify/react@0.2.0 dependencies --@joymify:registry=https://npm.pkg.github.com` lists `@joymify/*` names with version ranges, none starting with `workspace:`.
- [ ] `gh secret list` in `cli-state-handler` shows `JOYMIFY_PACKAGES_READ_TOKEN`.

Phase 1a, wiring:

- [ ] `test ! -e apps/docs/joy-alias.ts` succeeds, and `grep -rn -E "joy-design/packages|joy-alias|@montionugera/joy-" apps/docs --include='*.ts' --include='*.tsx' --include='*.json' --exclude-dir=node_modules` prints nothing.
- [ ] `grep -n "@joymify/" apps/docs/package.json` shows `@joymify/react` and `@joymify/tokens` with version ranges, not `workspace:` or `link:`, and `grep -c "@joymify/" apps/docs/tsconfig.json` prints 0.
- [ ] `grep -rl -E "from ['\"]@joymify/react['\"]" apps/docs/src | wc -l` prints at least 9 (the importing files keep their imports; nothing was renamed), and `grep -c "@joymify/tokens/theme.css" apps/docs/src/main.tsx` prints 1.
- [ ] `cat .npmrc` shows exactly one registry line, `@joymify:registry=https://npm.pkg.github.com`; `grep -c '_authToken' .npmrc` prints 0 and `grep -c 'montionugera' .npmrc` prints 0.
- [ ] With the user-level token line and `JOYMIFY_PACKAGES_READ_TOKEN` set, `pnpm install --frozen-lockfile` exits 0 on a fresh clone that has no sibling `joy-design` directory, and `node -p "require('./apps/docs/node_modules/@joymify/react/package.json').version"` prints `0.2.0`.
- [ ] `grep -c -E "MarkdownViewer|MermaidViewer|CodeBlock|PolyglotCodeTabs|Segmented|Alert" apps/docs/node_modules/@joymify/react/dist/index.d.ts` is at least 6 (adjust the path to the package's declared `types` entry), confirming the exports table against the published package.
- [ ] `pnpm typecheck` at the repository root exits 0.
- [ ] `bash scripts/precheck.sh` exits 0.
- [ ] `pnpm --filter @ucsa/docs test` exits 0 with a passing count no lower than the baseline recorded after the rebase.
- [ ] `pnpm --filter @ucsa/docs build` exits 0.
- [ ] The pull request's `ci.yml` run is green (the runner has no cache and no sibling checkout, so a green install proves the registry fetch and the token mechanism on pnpm 10), and `grep -c "npm.pkg.github.com" .github/workflows/ci.yml .github/workflows/release.yml` is at least 1 in each file.
- [ ] `grep -n "JOYMIFY_PACKAGES_READ_TOKEN" .github/workflows/ci.yml .github/workflows/release.yml` shows, in each file, the placeholder line written to the user-level config and the secret passed as `env` on the install step (plus the precheck step in `ci.yml` only if that proved necessary); `grep -c "packages: read" .github/workflows/ci.yml .github/workflows/release.yml` prints 0 for both; `grep -n "no secrets" .github/workflows/ci.yml` prints nothing.
- [ ] `git diff <rebased base>..HEAD -- .github/workflows | grep -E '^[+-] *- uses:|^[+-] *uses:'` prints nothing (no action version touched).
- [ ] Release regression check: `git diff --stat <rebased base>..HEAD -- scripts/release packages/core/package.json apps/cli/package.json` prints nothing; from the repository root with the new `.npmrc` present and no token in the environment, `npm config get @montionugera:registry` prints `undefined` and `node scripts/release/next-release.mjs` (no `--apply`) exits 0.
- [ ] `bash scripts/epic-check.sh E-009` still passes its release-workflow assertions.
- [ ] After the merge to main, the Release workflow run is green through install and "Decide release", and `npm view @montionugera/ucsa-core version --registry=https://registry.npmjs.org/` run outside the repository still prints the latest released version.
- [ ] `grep -n -E "JOYMIFY_PACKAGES_READ_TOKEN|read:packages" README.md` shows the install instructions and the token's expiry date.

Phase 1b, themes:

- [ ] `grep -c 'data-theme="dark"' apps/docs/index.html` prints 0.
- [ ] New tests named for the theme toggle pass: choosing Dark sets `data-theme="dark"` and saves it; choosing System removes both; a saved choice is applied on load.
- [ ] In a browser with the system set to dark and a saved choice of Light, a hard reload never shows a dark frame (checked with a throttled reload).
- [ ] `ls apps/docs/dist/assets | grep -c -E "\.woff2$"` prints at least 2, and `grep -rn -E "fonts\.googleapis|fonts\.gstatic" apps/docs/dist` prints nothing.
- [ ] Every route in `apps/docs/src/routes.ts`, at 360px and at 1280px, in light and in dark: `document.documentElement.scrollWidth <= window.innerWidth` and the console shows no errors.

Phase 2, code and diagrams:

- [ ] New tests pass: Joymify `CodeBlock` output contains at least one `joy-syntax-` span; `MermaidViewer` with a flowchart source renders an `svg` element.
- [ ] The Overview route shows a rendered diagram (an `svg`, not raw text) in both themes.
- [ ] `grep -l "joy-mermaid" apps/docs/dist/assets/*.js` lists a file that is not the entry chunk named in `apps/docs/dist/index.html`.
- [ ] The route check above (360px and 1280px, light and dark, no horizontal scroll, no console errors) is repeated and passes.

## Appendix: audit trail

- 2026-10-09 self-grill-audit (independent, read against the source tree): verdict **safe with fixes**. Corrected:
  - CRITICAL: the spec pinned two registry calls; there are three. `scripts/release/next-release.mjs` runs `npm view` on every merge to main and throws on anything but `E404`, so the scope mapping would have turned the release workflow red on every merge. Added to current state, design and acceptance criteria.
  - HIGH: the committed token line `_authToken=${GITHUB_TOKEN}` relies on placeholder expansion that pnpm removed from project-level `.npmrc` in v11.5.3 (pnpm.io/npmrc). Moved the token line to user-level config; the committed file keeps only the scope mapping.
  - HIGH: the manifests already had `publishConfig.registry` and it does not override a scope mapping (npm-registry-fetch `pickRegistry`). Added the `@montionugera:registry` key to `publishConfig` as a second layer, so manual publishes are covered too.
  - HIGH: the release safety check had no `npm view` check, no negative control and no post-merge check. Added.
  - HIGH: acceptance criterion "install log shows packages fetched from npm.pkg.github.com" is not observable (pnpm does not log registry hosts). Replaced with a green uncached run plus the installed version.
  - HIGH: two rollout steps were both "Phase 1" and the criteria were not tied to phases. Split into 1a and 1b, stated what each depends on, grouped the criteria by phase.
  - Recorded, not changed: the write-capable job token reaches the install step of `release.yml`; library publishing now depends on GitHub Packages. Both are owner decisions under option A.
  - LOW: nine files import `@joymify/react`, not eight. The count of 54 inline styles is all inline styles on the base branch, not only those carrying colours.
  - Confirmed without change: every named export exists in `joy-design` `packages/react/src/index.ts` at `02b1dfc8`; `MarkdownViewer` has no lists, links or images; the diagram renderer handles flowchart or graph and sequence diagrams only; both jobs that run `pnpm install` are covered; nothing installs `@montionugera/ucsa-*` from a registry.
  - Not verified: a local `npm publish --dry-run` probe was not permitted in the audit session, so the precedence facts rest on npm and pnpm source and docs; the phase 1a criteria prove them. Whether pnpm keeps `publishConfig` in a packed tarball, and the GitHub "Manage Actions access" grant, are likewise proved only by those criteria.
  - Open: option A versus a stored read-only token (see "Risks and open questions").
- 2026-10-09 (late) revision for a changed owner decision, recorded in `research.md` ("packages move to `@joymify`"). Not a new audit; the earlier findings stand except where listed.
  - Renamed throughout: the dependencies are `@joymify/tokens` 0.2.0, `@joymify/icons` 0.3.0, `@joymify/brand` 0.2.0 and `@joymify/react` 0.2.0, private, organisation `joymify` on GitHub Packages (`joy-design` F-073, release 3.8). Stated as **to be published**; resolving from the registry is now rollout step 0 with its own acceptance checks.
  - Removed: the scope-clash mitigation from the first audit (CRITICAL and two HIGH items above). The registry line is `@joymify:registry=...` and does not touch `@montionugera`, so the three explicit npmjs.com flags (`release.yml` `npm view` and `npm publish`, `scripts/release/next-release.mjs:41`), the `"@montionugera:registry"` key in `publishConfig`, the negative-control publish dry runs and the unit test for the flag are all dropped. Replaced by one regression check (`npm config get @montionugera:registry` is `undefined`, and the release script's dry run exits 0).
  - Changed: CI access is a classic `read:packages` token in the Actions secret `JOYMIFY_PACKAGES_READ_TOKEN`. The "Manage Actions access" grant route, `packages: read`, and the option A / option B question are removed. Side effect: the write-capable job token no longer reaches the install step of `release.yml`.
  - Kept and tightened: the token line stays out of the committed `.npmrc`. Re-read of the pnpm documentation found the placeholder restriction also applies to pnpm 10 from v10.34.2 (not only pnpm 11 from v11.5.3), so a committed line would already fail on the CI runner. The user-level placeholder line is documented to work on both.
  - Simplified: alias removal no longer renames imports; the base branch already imports `@joymify/react` in nine files.
  - Kept without change: phases each shippable alone, the exports table and the limits of `MarkdownViewer` and `MermaidViewer`, fonts, the sidebar decision, the 360px checks, the coupling of library releases to GitHub Packages. Workflow action versions are left to I-046.
  - Not verified in this revision: that F-073 keeps the exports of `02b1dfc8` (checked in phase 1a); pnpm 10 and 11 placeholder behaviour beyond the documentation (pnpm 10 proved by the green `ci.yml` run, pnpm 11 not exercised); how npm and pnpm treat the unresolved placeholder when the variable is not exported; that GitHub Packages still rejects fine-grained tokens; the `types` path used in the exports check.
- 2026-10-10 self-grill-audit of `plan.md` (independent, read against the source tree). Lines of this spec the plan or the audit proved wrong are corrected in place; the rest is recorded here so a reviewer does not flag the plan for departing from the spec.
  - CRITICAL, corrected ("CI package access"): "the line is appended" was unsafe for `release.yml`. `actions/setup-node` writes its config file without a final newline, so a plain append destroys the token line and turns every merge to main red at install. The append must start with a newline. Reproduced locally.
  - Corrected ("CI package access"): a run without the secret now stops with an explicit error in the install step. The variable is still given to that step only.
  - Corrected ("Alias removal"): the root `vitest.config.ts` imports the alias file as well.
  - Corrected ("Theme tokens and toggle", "Fonts", "Testing", "Risks"): no inline style carries a colour literal; the fonts need the two font-family custom properties redefined; the diagram test asserts a rejected definition, not an unsupported type; the baseline is measured before the cherry-pick; `routes.ts` does not conflict.
  - Recorded, spec unchanged: Dart and C# snippets render without highlighting (the upstream highlighter has no grammar for them; request filed upstream, nothing shimmed), so "highlighting" in the component mapping holds for TypeScript only today. The platform guide keeps its own copy button and passes `allowCopy={false}`, because the Joymify button hides a failed copy. Callouts pass `role="note"` over the `Alert` default `role="alert"`.
  - Recorded, not automatable: the criterion "a hard reload never shows a dark frame (checked with a throttled reload)" cannot be run by the browser tooling the agents have. The plan proves the ordering of the inline script in the built page and leaves the throttled reload as a manual check for the owner.
  - Owner go-ahead added: the draft pull request of rollout step 2 pushes a branch and opens a pull request against `main`; the plan stops for explicit approval before it, with a recorded path if it is declined.
