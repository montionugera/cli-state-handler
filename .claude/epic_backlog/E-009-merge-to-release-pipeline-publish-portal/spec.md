---
title: "Merge-to-release pipeline: publish, portal docs, release notes"
id: E-009
status: epic
---

# Merge-to-release pipeline: publish, portal docs, release notes

<div class="callout info">
<strong>In one sentence.</strong> Merging to <code>main</code> is the whole release: the libraries are versioned and published, the docs and playgrounds appear on the developer portal, and release notes are written, with no manual step.
</div>

## Outcome

Once every slice has shipped, a merge to `main` of `cli-state-handler` that contains a real change does all of the following without anyone touching a terminal:

1. Picks the next version of `@montionugera/ucsa-core` and `@montionugera/ucsa-cli` (they move together).
2. Writes the release notes into `CHANGELOG.md`, commits the bump back to `main`, and tags it.
3. Publishes both packages to npmjs.com through trusted publishing (no token).
4. Creates a GitHub Release carrying the notes and the built docs site as one archive.
5. Makes the developer portal at `https://dev.joymify.com/cli-state-handler/` serve that docs build, including a public "Release notes" page.

<div class="metric-grid">
<div class="metric-tile"><strong>0</strong><br>manual steps per release</div>
<div class="metric-tile"><strong>0</strong><br>extra servers in the cluster</div>
<div class="metric-tile"><strong>3</strong><br>places release notes land</div>
</div>

## Where we start <span class="topic-chip">verified 2026-10-09</span>

| Area | Today |
| --- | --- |
| Publish | Works, token-free, but only when someone pushes a `v*` tag after bumping versions by hand (`.github/workflows/release.yml`; `v0.1.1` is live). |
| Docs and playgrounds | Built by `apps/docs` (Vite + React; playgrounds are components inside it). `.github/workflows/docs.yml` tries GitHub Pages on every merge and fails, because Pages is off. |
| Where docs really live | The `joy-design` repo serves `dev.joymify.com` from one web server in the cluster. It holds a hand-copied build of these docs in `apps/storybook-hub/portal-bundles/cli-state-handler`. Nothing refreshes it. |
| Release notes | None. No changelog, no GitHub Releases. |
| Release catalog | `.claude/refined_backlog/_catalog.json` lists every feature with `id`, `title` and `release_version`. This is the only reliable record of what a planned release contains: its merge commit is titled `release 1.8` with an empty body. |

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| What triggers a release | Every merge to `main` | Chosen by the user: add a feature, merge, done. |
| How docs reach the portal | The portal stays one server and downloads each library's docs archive when it builds | The user asked for a small memory footprint; a server per library was rejected for that reason. |
| Where notes go | `CHANGELOG.md`, a GitHub Release, and a page in the portal docs | The repo is private, so the portal page is the only copy outsiders can read. Default taken without asking. |
| Tooling | One small script in this repo, not an off-the-shelf release tool | Off-the-shelf tools read commit titles; a planned release here arrives as one commit titled `release 1.9`, so they would see nothing. The catalog has to be read. |

## How a release flows

Two separate flows, kept apart on purpose: the first must be fast and safe to re-run; the second is slower and may fail without undoing the first.

**Flow A: library release (this repo)**

```mermaid
flowchart LR
  M[Merge to main] --> D{Real change?}
  D -- no --> X[Stop: nothing released]
  D -- yes --> V[Pick version and write notes]
  V --> C[Commit bump and tag]
  C --> P[Publish both packages]
  P --> R[GitHub Release with docs archive]
  R --> S[Signal the portal]
```

**Flow B: portal refresh (`joy-design` repo)**

```mermaid
flowchart LR
  S[Signal received] --> F[Download latest docs archive per library]
  F -- download fails --> K[Use the committed copy]
  F --> B[Build the one portal image]
  K --> B
  B --> O[Roll out and smoke-test]
```

### Picking the version

The script looks at what the merge brought in:

- **Planned release** (commit titled `release X.Y`): the features in the catalog whose `release_version` is `X.Y` are the notes. One or more features means a feature-level bump.
- **Any other merge** (a hotfix or a direct pull request): the commit types in its title and body are the notes. `feat` is a feature-level bump, `fix` and `perf` are a fix-level bump.
- **Housekeeping only** (`chore`, `docs`, `ci`, `test`, and the workflow's own `finalize ... cleanup` commit): no release.
- **Breaking change** (a `!` after the type, or `BREAKING CHANGE` in the body): the next major version, except while the version is below 1.0, where it is a feature-level bump.

Both packages always get the same version.

### Committing the bump

The workflow commits `CHANGELOG.md` and the two `package.json` files back to `main` with `[skip ci]`, then tags `v<version>`. Because the planned-release flow pushes a second commit seconds after the merge, runs are queued one at a time and the workflow rebases onto the latest `main` before pushing.

<div class="callout warn">
<strong>Side effect to accept.</strong> <code>main</code> gains a commit the local release tooling did not make, so <code>psrw sync-main</code> is needed before starting the next release. The tooling already reports this as "behind origin/main".
</div>

### Handing the docs to the portal

The docs build is attached to the GitHub Release as `docs-site.tgz`, then this repo starts the portal's deploy workflow. The portal downloads the latest archive for each library instead of relying on a hand-committed copy. The committed copy stays as the fallback, so a failed download never leaves an empty docs section.

## Failure handling

| What fails | Result |
| --- | --- |
| Tests or build | Nothing is committed, tagged or published. |
| Publish | The bump commit and tag exist but the registry does not have the version. Re-running the workflow publishes it; a version already on the registry is skipped. |
| GitHub Release or signal | Packages are published. The run is red; re-running repeats only the missing steps. |
| Portal build or rollout | The portal keeps serving the previous docs. The failure shows in `joy-design`, not here. |

## Slices

1. Version and release-notes script: reads the catalog or the commit types, returns the next version and the changelog entry, covered by unit tests for every rule in "Picking the version".
2. Release-on-merge workflow: runs the script, commits the bump, tags, publishes, creates the GitHub Release with `docs-site.tgz`; removes the tag trigger and the failing GitHub Pages workflow.
3. Release notes page in the docs site, rendered from `CHANGELOG.md`.
4. Portal signal: start the `joy-design` deploy workflow after a successful release.
5. README and epic check: document the release flow and implement `scripts/epic-check.sh` for the assertions in `verification.md`.

**Needed from other repos (not slices of this epic):**

- `joy-design`: download docs archives at build time, accept the signal, skip the Flutter build when only library docs changed. Tracked as its own work item there. Slice 4 cannot be proven until it ships.
- An access credential that lets this repo start the portal workflow and lets the portal read this repo's releases. Only the repo owner can create it; it should be distributed through the `gh-secrets` repo.

## Out of scope

- `node-server-decorator` adopting the same pipeline, and `joy-design` publishing its `@joymify` packages to npmjs.com. Both are agreed goals with their own specs to follow. Publishing `@joymify` packages first needs proof that the `@joymify` name on npmjs.com belongs to the owner.
- The docs visual design and navigation, owned by separate work in `fix/docs-design-nav`.
- `zen-ui`.

## Open points to settle inside the slices

- Whether the catalog on the `release X.Y` merge commit already carries `release_version: X.Y` for that release's features (slice 1 verifies against the 1.8 merge commit).
- The narrowest permission the credential needs to start a workflow in another private repo (slice 4).
- No architecture drawing in draw.io format was produced for this spec; the two flowcharts above are its diagrams.
