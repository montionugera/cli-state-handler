# Adopt the Joymify design system in the docs portal — research notes

(prior art, related issues, open questions)

## Decisions and state, 2026-10-09

Owner decisions (answered in session, not yet a spec):

- The docs portal stays in this repo (`apps/docs`); it only consumes the Joymify design system from the sibling repo `joy-design`.
- Depth: full React components (`joy-react`), not only the stylesheet.
- Install: from GitHub Packages under `@montionugera` (`joy-tokens`, `joy-icons`, `joy-brand`, `joy-react`). No vendored copy, no link to a sibling checkout.
- Themes: light and dark, following the system setting, with a toggle.
- Release: 1.8 was promoted without the restyle; the restyle lands in 1.9.
- Base: build on the existing branch `fix/docs-design-nav` (worktree `../cli-state-handler-fix-docs-design`, owned by another session) instead of redoing it.

What that branch already has, as reported by its owning session (not verified here): commit `745f5a9` (hash-based navigation, Overview as default, sidebar links, scroll reset, `src/route.ts` plus tests) and commit `d729081` (Menu, Badge, Button, Input, MetricTile from the Joymify React package; `index.css` on `--joy-*` variables; dark only; packages reached through Vite/tsconfig/vitest aliases to `../joy-design`, new `apps/docs/joy-alias.ts`). It is based on `9c30f9d`, before release 1.8. Its `scripts/precheck.sh` fails without the sibling checkout.

Blocked on: `joy-design` idea I-077 (release 3.7 there), which renames `@joymify/*` to `@montionugera/joy-*`, adds a build for `joy-react` and `joy-icons`, and adds a publish workflow. That rename breaks the alias wiring on the branch. The real publish needs the owner's separate go-ahead.

Remaining for the spec once packages are published: replace the aliases with registry dependencies and an `.npmrc`; add the theme toggle and move hard-coded dark colours and inline styles in the playgrounds onto tokens; self-host the fonts (Inter, JetBrains Mono) in the build (assumed, not yet confirmed by the owner); keep the 360px layout fixes; keep the build self-contained, since the Joymify developer portal copies `apps/docs/dist`.

## Added requirement, 2026-10-09 (owner, in session)

- Use the Joymify markdown components for document content in the docs portal: `MarkdownViewer` (the "md preview") and, where editing is wanted, `MarkdownEditor`, both exported by the Joymify React package. This replaces the hand-written `Prose.tsx` rendering where the content is markdown.
- Mermaid diagrams in that content must render. As checked on the `joy-design` branch `feat/F-071` on 2026-10-09, no file in `packages/react/src` or `packages/svelte/src/lib` mentions mermaid, so `MarkdownViewer` does not render mermaid today. Under the platform rule (enhance upstream, do not shim in the consumer) this is a `joy-design` enhancement to `MarkdownViewer` (React and Svelte twins), to be specified there before the docs portal can rely on it.
- Interpretation note: the owner's wording was brief ("doc and not render mermaid", then "we should use joymify component (it should have like md preview)"). Recorded here as a docs-portal requirement; confirm when the I-038 spec is written.

## Base branch state (reported by session cli-state-handler-31, 2026-10-09; not re-verified here)

- `fix/docs-design-nav` (worktree `../cli-state-handler-fix-docs-design`) is rebased onto main `407ca76`; local, unpushed, unmerged. Two commits: `68ad8b7` (Joymify Button/Badge/Input/MetricTile and `joy-*` classes across `apps/docs`, palette mapped to `--joy-*` tokens, dark theme only, sibling-checkout aliases in `apps/docs/joy-alias.ts`) and `69f8c42` (review fixes).
- The separate navigation commit was dropped: main's 1.8 redesign already ships hash routing. The sidebar is still main's anchor sidebar, not the Joymify Menu, despite the message of `68ad8b7`.
- Peer's evidence: `pnpm --filter @ucsa/docs build` exit 0; docs tests 19 files / 320 passed.
- Merge blocker: `.github/workflows/docs.yml` and `release.yml` check out only this repo, so the `../joy-design` aliases fail the Pages build and the release test run. Root `pnpm typecheck` also lacks the alias paths. Replacing the aliases with the published `@montionugera/joy-*` packages (plus `.npmrc` and a `read:packages` token in CI) resolves all three; this is in scope for I-038.

## Owner decision 2026-10-09 (late): packages move to `@joymify`

- The owner chose to rename the Joymify packages to `@joymify/tokens`, `@joymify/icons`, `@joymify/brand`, `@joymify/react` and publish them privately to the `joymify` GitHub organisation on GitHub Packages, with a personal token. Work: joy-design feature F-073 on its release 3.8.
- Consequence for this spec: the registry line becomes `@joymify:registry=https://npm.pkg.github.com`, which does not touch the `@montionugera` scope. The three npmjs.com pins and the `publishConfig` scope key added by the audit (phase 1a) are no longer needed; the library release pipeline stays as it is apart from making a read token available at install.
- CI access changes too: organisation-owned packages are read with a token stored as a repository secret (`read:packages`), not with the "Manage Actions access" grant on the old personal-account packages. That earlier grant request to the owner is void.
- spec.md must be revised for this before planning; wait until `@joymify/*` is actually on the registry.
