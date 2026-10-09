---
title: "Docs app shell with hash routing and responsive layout"
id: I-028
status: idea
---

# Docs app shell with hash routing and responsive layout

Slice 2 of epic E-008 (docs portal). Depends on slice 1.

## Problem

`apps/docs/src/App.tsx` switches five "stories" with `useState`: no URLs, no deep links, no place for prose pages, and every future page would have to edit `App.tsx` and `index.css`.

## Scope

- `src/routes.ts`: an exported `routes` array (`id`, `title`, `group`, lazy `component`). The five existing stories (swr, timing, outbox, cas, multiplatform) become entries, plus a home page.
- `src/router.ts`: a small hash router hook (`#/<id>`), no library. Unknown hash renders a not-found page.
- Shell: grouped sidebar, mobile drawer under 768px, skip link, focus-visible styles, active-route marker.
- Design tokens (colour, spacing, type scale) as CSS custom properties in `index.css`; per-page styles live in their own CSS files from now on.
- `src/components/Prose.tsx`: a prose-page primitive (headings, paragraphs, callout, code block) for later tutorial content.
- Rule for later slices, stated in a comment at the top of `routes.ts`: add one registry line and your own files; do not otherwise edit `App.tsx` or `index.css`.

## Acceptance criteria

- [ ] `apps/docs/tests/app-shell.test.tsx` renders every id in `routes` via its hash and finds that page's title.
- [ ] The same test renders the not-found page for `#/does-not-exist`.
- [ ] Changing `location.hash` switches the page without a reload, and the sidebar marks the active route with `aria-current="page"`.
- [ ] The five existing playground tests still pass unchanged.
- [ ] No new entries in `apps/docs/package.json` dependencies.
- [ ] `pnpm --filter @ucsa/docs build` exits 0.

## Non-goals

New visualisers, tutorial content, search, light theme.
