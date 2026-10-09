# Docs app shell with hash routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development (flat execution allowed when nested agents unavailable). Steps use checkbox syntax.

**Goal:** Replace the `useState` story switcher in `apps/docs` with a hash-routed, responsive shell driven by a one-line-per-page registry.

**Architecture:** `routes.ts` (registry) -> `router.ts` (`useHashRoute` hook) -> `App.tsx` (shell: sidebar groups, drawer, skip link, main). Pages are plain components; new `Prose` primitive for later prose pages. Tokens in `index.css`; shell and prose styles in their own CSS files.

**Tech Stack:** React 19, Vite, vitest + @testing-library/react (jsdom), plain CSS. No new deps.

**Spec:** `.claude/refined_backlog/F-028-docs-app-shell-with-hash-routing-and-res/spec.md`

## Global Constraints
- Hash routes `#/<id>`; unknown hash -> not-found page.
- `routes.ts` top comment: later slices add one registry line plus own files; do not otherwise edit `App.tsx` or `index.css`.
- No new dependencies; `apps/docs/package.json` and `packages/core` untouched.
- The five existing playground tests pass unchanged. They are synchronous and use `getByText` on exact sidebar labels (`"⚡ SWR & Lifecycle"`, `"📖 Architecture Overview"`, `"🌐 TS / Dart / Unity C#"`, `"UCSA Studio"` once) and click-then-assert synchronously. Consequences (deviation from spec "lazy component"): `component` is eager (React.lazy would break sync assertions); nav label is one text node `${icon} ${title}`; link click calls `navigate()` which sets state synchronously (not relying on async `hashchange`); the brand string appears once.
- Plain CSS, custom-property tokens; works from 360px; `aria-current="page"`, visible focus, skip link, `prefers-reduced-motion`.

## Interfaces
- `routes.ts`: `type RouteGroup = "Start"|"Visualisers"|"Guides"`; `interface RouteDef {id:string; title:string; icon?:string; group:RouteGroup; component:ComponentType}`; `routes: RouteDef[]`; `groups: RouteGroup[]`.
- `router.ts`: `parseHash(hash:string): string` ("" / "#" / "#/" -> "home"; "#/x" -> "x"); `useHashRoute(): {id:string; route:RouteDef|undefined; navigate(id:string):void}`.
- `components/Prose.tsx`: `Prose({children})`, `Callout({tone?:"info"|"warn", title?, children})`, `CodeBlock({children, language?})`.

## Task 1: Failing shell test
**Files:** Create `apps/docs/tests/app-shell.test.tsx`
- [ ] Test: for every `routes` entry set `location.hash="#/"+id` (home: `#/`), render `<App/>`; assert `main[data-route-id]===id`, `document.title` starts with route title, sidebar link with that title has `aria-current="page"` and is the only one.
- [ ] Test: `#/does-not-exist` -> `main[data-route-id]="not-found"`, heading "Page not found", no `aria-current` link.
- [ ] Test: render at `#/swr`, set `location.hash="#/cas"` + dispatch `hashchange` inside `act` -> route becomes cas, no reload.
- [ ] Test: clicking a sidebar link navigates; drawer toggle button toggles `aria-expanded` and Escape closes it; skip link exists and moves focus to main.
- [ ] Test: `parseHash` cases. Group headings Start/Visualisers/Guides present.
- [ ] Run `pnpm --filter @ucsa/docs test` -> app-shell fails (modules missing).

## Task 2: Router, registry, pages, Prose, shell
**Files:** Create `src/routes.ts`, `src/router.ts`, `src/components/Prose.tsx`, `src/pages/Home.tsx` (existing overview markup moved verbatim), `src/pages/NotFound.tsx`, `src/shell.css`, `src/prose.css`; Modify `src/App.tsx`, `src/index.css`.
- [ ] Implement per Interfaces; App renders `<a href="#/id" aria-current onClick={e=>{e.preventDefault();navigate(id)}}>`; skip link is an anchor whose click focuses `main#main` (a `#main` href would clobber the hash router); effect on route change sets `document.title`, closes drawer, focuses main; Escape closes drawer; backdrop click closes.
- [ ] CSS: tokens (colour, space, type scale, radius, motion) in `:root`; shell grid; sidebar fixed drawer under 768px with transform transition disabled under `prefers-reduced-motion`; `:focus-visible` ring; keep legacy classes (`.card`, `.btn`, `.badge`, `.stat-*`, `.input`) because playgrounds use them.
- [ ] Run tests -> all pass (new + 5 existing). `pnpm --filter @ucsa/docs build` -> exit 0.
- [ ] README: add a short "Adding a docs page" section to `apps/docs/README.md` if present, else root README docs section.
- [ ] Commit.

## Task 3: Phase gate
- [ ] `scripts/precheck.sh` exit 0; `git diff --stat 207c9f7 HEAD -- apps/docs/package.json packages/core` empty; independent review of the diff; fix findings in a new commit; re-run all acceptance commands; `git status --short` empty.

## Appendix - audit trail
- 2026-10-09 self-grill-audit: verdict safe-with-fixes. Corrected: contract names pinned (nav `aria-label="Documentation"`, skip link "Skip to content" with href + preventDefault focusing `main#main` `tabIndex=-1`, toggle "Open navigation"/"Close navigation" with `aria-expanded`, heading "Page not found", all groups rendered); no focus steal on mount (main is not focused on route change; only the skip link focuses it); only 2 of 5 playground tests render `<App/>`, so no chrome text may duplicate a nav label or "UCSA Studio"; default landing becomes `home` (spec asks for a home page) and groups renamed per spec; README test table + page-adding section updated (root README, no apps/docs/README); the "do not edit App.tsx/index.css" rule is a courtesy comment, not enforced. Open: none.
