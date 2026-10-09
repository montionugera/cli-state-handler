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
