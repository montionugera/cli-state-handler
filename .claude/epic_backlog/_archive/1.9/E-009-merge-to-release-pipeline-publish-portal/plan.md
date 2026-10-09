# Merge-to-Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merge to `main` of `cli-state-handler` versions and publishes `@montionugera/ucsa-core` and `@montionugera/ucsa-cli`, writes release notes, attaches the docs build to a GitHub Release, and signals the developer portal, with no manual step.

**Architecture:** A pure decision library (`scripts/release/lib.mjs`) turns "commits since the last tag + the release catalog" into "no release / publish only / release version X with these notes". A thin command (`scripts/release/next-release.mjs`) feeds it from git, npm and disk and applies the result. `.github/workflows/release.yml` runs that command on every push to `main`, then commits the bump, publishes, builds the docs and creates the GitHub Release.

**Tech Stack:** Node 22 ES modules (no new dependencies), Vitest (root `vitest run`), GitHub Actions, `gh` CLI, Vite + React 19 docs app (`apps/docs`).

**Spec:** `.claude/epic_backlog/E-009-merge-to-release-pipeline-publish-portal/spec.md` (assertions in `verification.md` beside it).

## Global Constraints

- The workflow file MUST stay named `.github/workflows/release.yml` and its publish job MUST NOT get an `environment:` key. npmjs.com trusts exactly that file name with a blank environment; either change makes every publish fail.
- Both packages always carry the same version (`packages/core/package.json` and `apps/cli/package.json`).
- The docs are built AFTER the publish step. A docs failure must never block a library release.
- No new npm dependencies.
- Run tests with the default Node on the developer machine (the local `better-sqlite3` binary is x86_64); do not switch to an arm64 Node 22.
- This is a ps-release-workflow repo: never edit in the main checkout; each task is done in its claimed feature worktree. Never `git commit --amend`.
- Do not touch the worktree `../cli-state-handler-fix-docs-design` or branch `fix/docs-design-nav`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/release/lib.mjs` (create) | Pure functions: bump a version, read one commit, decide the release, format and splice changelog entries. No I/O. |
| `scripts/release/lib.test.mjs` (create) | Unit tests for every rule in the spec's "Picking the version". |
| `scripts/release/next-release.mjs` (create) | Command: gathers inputs from git, npm and disk, calls `decide`, writes outputs and (with `--apply`) the files. |
| `scripts/release/history-check.mjs` (create) | Proves the catalog rule against the real release 1.8 merge commit. |
| `CHANGELOG.md` (create) | Release notes; newest entry first. Written by the workflow from then on. |
| `.github/workflows/release.yml` (modify) | Release on push to `main`. |
| `.github/workflows/docs.yml` (delete) | Failing GitHub Pages deploy; wrong target. |
| `apps/docs/src/models/changelog.ts` (create) | Parses `CHANGELOG.md` text into entries. |
| `apps/docs/src/components/ReleaseNotes.tsx` (create) | The "Release notes" page. |
| `apps/docs/vite-plugins/version-json.ts` (create) | Emits `version.json` into the docs build. |
| `scripts/epic-check.sh` (modify) | Adds the E-009 pre-merge assertions. |
| `README.md` (modify) | Replaces the tag-based "Publishing" section with the merge-based flow. |

---

### Task 1: Version and release-notes script

**Files:**
- Create: `scripts/release/lib.mjs`, `scripts/release/lib.test.mjs`, `scripts/release/next-release.mjs`, `scripts/release/history-check.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `bump(version: string, level: 'patch'|'minor'|'major'): string`
  - `notesForCommit(commit: {subject: string, body: string}, catalog: Array<{id: string, title: string, release_version: string|null}>): {level: 'none'|'patch'|'minor'|'major', notes: string[]}`
  - `decide(input: {currentVersion: string, commits: Array<{subject, body}>, catalog, currentIsTagged: boolean, currentIsPublished: boolean}): {action: 'none'|'publish-only'|'release', version: string, notes: string[]}`
  - `changelogEntry(version: string, date: string, notes: string[]): string`
  - `prependEntry(existing: string, entry: string): string`
  - `extractEntry(changelog: string, version: string): string`
  - Command `node scripts/release/next-release.mjs [--apply] [--notes <path>]`: prints `action=<...>` and `version=<...>`, appends the same two lines to `$GITHUB_OUTPUT` when set. With `--apply` and action `release` it rewrites both `package.json` versions and `CHANGELOG.md`. With `--notes <path>` it always writes the notes of the printed version to the path. It exits non-zero if npm cannot be reached (only a "not found" answer counts as unpublished).

- [ ] **Step 1: Write the failing tests**

Create `scripts/release/lib.test.mjs`:

```js
import { describe, expect, it } from 'vitest';
import { bump, changelogEntry, decide, extractEntry, notesForCommit, prependEntry } from './lib.mjs';

const catalog = [
  { id: 'F-036', title: 'Docs sandbox', release_version: '1.8' },
  { id: 'F-037', title: 'Phone-width fixes', release_version: '1.8' },
  { id: 'F-038', title: 'Later thing', release_version: '1.9' },
  { id: 'F-039', title: 'Unreleased', release_version: null },
];
const base = { currentVersion: '0.1.1', catalog, currentIsTagged: true, currentIsPublished: true };

describe('bump', () => {
  it('bumps each level', () => {
    expect(bump('1.2.3', 'patch')).toBe('1.2.4');
    expect(bump('1.2.3', 'minor')).toBe('1.3.0');
    expect(bump('1.2.3', 'major')).toBe('2.0.0');
  });
  it('treats a breaking change below 1.0 as a feature-level bump', () => {
    expect(bump('0.1.1', 'major')).toBe('0.2.0');
  });
});

describe('notesForCommit', () => {
  it('reads a planned release from the catalog, direct-promote title', () => {
    expect(notesForCommit({ subject: 'release 1.8', body: '' }, catalog)).toEqual({
      level: 'minor',
      notes: ['Docs sandbox (F-036)', 'Phone-width fixes (F-037)'],
    });
  });
  it('reads a planned release with a pull-request suffix and ignores its body', () => {
    const r = notesForCommit({ subject: 'release 1.9 (#12)', body: '* fix: something\n* chore: x' }, catalog);
    expect(r).toEqual({ level: 'minor', notes: ['Later thing (F-038)'] });
  });
  it('treats a planned release with no features as a maintenance patch', () => {
    expect(notesForCommit({ subject: 'release 2.0', body: '' }, catalog)).toEqual({
      level: 'patch',
      notes: ['Maintenance release 2.0'],
    });
  });
  it('reads commit types from a squash-merge title and body without duplicates', () => {
    const r = notesForCommit(
      { subject: 'feat(cli): add watch flag (#7)', body: '* feat(cli): add watch flag\n\n* fix(core): close handle\n\n* docs: readme' },
      catalog,
    );
    expect(r).toEqual({ level: 'minor', notes: ['feat: add watch flag', 'fix: close handle'] });
  });
  it('returns none for housekeeping', () => {
    expect(notesForCommit({ subject: 'chore(release): finalize 1.8 cleanup on main', body: '' }, catalog)).toEqual({
      level: 'none',
      notes: [],
    });
  });
  it('marks a bang or a BREAKING CHANGE footer as major', () => {
    expect(notesForCommit({ subject: 'feat(core)!: drop v1 codec', body: '' }, catalog).level).toBe('major');
    expect(notesForCommit({ subject: 'fix: tighten parser', body: 'BREAKING CHANGE: rejects old input' }, catalog).level).toBe('major');
  });
});

describe('decide', () => {
  it('releases a feature-level bump for a planned release followed by its cleanup commit', () => {
    const d = decide({
      ...base,
      commits: [
        { subject: 'chore(release): finalize 1.8 cleanup on main', body: '' },
        { subject: 'release 1.8', body: '' },
      ],
    });
    expect(d).toEqual({ action: 'release', version: '0.2.0', notes: ['Docs sandbox (F-036)', 'Phone-width fixes (F-037)'] });
  });
  it('releases a patch for a fix merge', () => {
    expect(decide({ ...base, commits: [{ subject: 'fix(core): close handle (#9)', body: '' }] })).toEqual({
      action: 'release',
      version: '0.1.2',
      notes: ['fix: close handle'],
    });
  });
  it('releases nothing for a housekeeping-only range', () => {
    expect(decide({ ...base, commits: [{ subject: 'docs: typo', body: '' }] })).toEqual({ action: 'none', version: '0.1.1', notes: [] });
  });
  it('releases nothing when there are no commits', () => {
    expect(decide({ ...base, commits: [] }).action).toBe('none');
  });
  it('publishes only when the current version is tagged but not on the registry', () => {
    expect(decide({ ...base, currentIsPublished: false, commits: [{ subject: 'feat: x', body: '' }] })).toEqual({
      action: 'publish-only',
      version: '0.1.1',
      notes: [],
    });
  });
  it('uses the major rule above 1.0', () => {
    expect(decide({ ...base, currentVersion: '1.4.0', commits: [{ subject: 'feat!: x', body: '' }] }).version).toBe('2.0.0');
  });
});

describe('changelog', () => {
  const entry = changelogEntry('0.2.0', '2026-10-10', ['Docs sandbox (F-036)', 'fix: close handle']);
  it('formats an entry', () => {
    expect(entry).toBe('## 0.2.0 - 2026-10-10\n\n- Docs sandbox (F-036)\n- fix: close handle\n');
  });
  it('puts a new entry above older ones and below the title', () => {
    const existing = '# Changelog\n\nIntro line.\n\n## 0.1.1 - 2026-10-09\n\n- first\n';
    expect(prependEntry(existing, entry)).toBe(
      '# Changelog\n\nIntro line.\n\n## 0.2.0 - 2026-10-10\n\n- Docs sandbox (F-036)\n- fix: close handle\n\n## 0.1.1 - 2026-10-09\n\n- first\n',
    );
  });
  it('appends when the file has no entry yet', () => {
    expect(prependEntry('# Changelog\n', entry)).toBe('# Changelog\n\n' + entry);
  });
  it('extracts the bullet list of one version', () => {
    const text = prependEntry('# Changelog\n\n## 0.1.1 - 2026-10-09\n\n- first\n', entry);
    expect(extractEntry(text, '0.2.0')).toBe('- Docs sandbox (F-036)\n- fix: close handle');
    expect(extractEntry(text, '0.1.1')).toBe('- first');
    expect(extractEntry(text, '9.9.9')).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run scripts/release 2>&1 | tail -n 15`
Expected: FAIL, cannot resolve `./lib.mjs`.

- [ ] **Step 3: Write the library**

Create `scripts/release/lib.mjs`:

```js
// Pure release-decision logic. No I/O: next-release.mjs feeds it.
const PLANNED = /^release (\d+\.\d+)(?: \(#\d+\))?$/;
const CONVENTIONAL = /^(?:\*\s+)?([a-z]+)(?:\([^)]*\))?(!)?:\s+(.+?)(?:\s+\(#\d+\))?$/;
const RELEASING = { feat: 'minor', fix: 'patch', perf: 'patch' };
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

export function bump(version, level) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump level: ${level}`);
}

export function notesForCommit({ subject, body }, catalog) {
  const planned = PLANNED.exec(subject.trim());
  if (planned) {
    const features = catalog.filter((f) => f.release_version === planned[1]);
    if (features.length === 0) return { level: 'patch', notes: [`Maintenance release ${planned[1]}`] };
    return { level: 'minor', notes: features.map((f) => `${f.title} (${f.id})`) };
  }
  let level = 'none';
  const notes = [];
  for (const line of [subject, ...body.split('\n')]) {
    const m = CONVENTIONAL.exec(line.trim());
    if (!m) continue;
    const [, type, bang, text] = m;
    const lineLevel = bang ? 'major' : (RELEASING[type] ?? 'none');
    if (lineLevel === 'none') continue;
    const note = `${type}: ${text}`;
    if (!notes.includes(note)) notes.push(note);
    if (RANK[lineLevel] > RANK[level]) level = lineLevel;
  }
  if (notes.length > 0 && /^BREAKING CHANGE:/m.test(body)) level = 'major';
  return { level, notes };
}

export function decide({ currentVersion, commits, catalog, currentIsTagged, currentIsPublished }) {
  if (currentIsTagged && !currentIsPublished) return { action: 'publish-only', version: currentVersion, notes: [] };
  let level = 'none';
  const notes = [];
  // git log lists newest first; notes read better oldest first.
  for (const commit of [...commits].reverse()) {
    const r = notesForCommit(commit, catalog);
    if (RANK[r.level] > RANK[level]) level = r.level;
    for (const note of r.notes) if (!notes.includes(note)) notes.push(note);
  }
  if (level === 'none') return { action: 'none', version: currentVersion, notes: [] };
  return { action: 'release', version: bump(currentVersion, level), notes };
}

export function changelogEntry(version, date, notes) {
  return `## ${version} - ${date}\n\n${notes.map((n) => `- ${n}`).join('\n')}\n`;
}

export function prependEntry(existing, entry) {
  const i = existing.indexOf('\n## ');
  if (i === -1) return `${existing.trimEnd()}\n\n${entry}`;
  return `${existing.slice(0, i + 1)}${entry}\n${existing.slice(i + 1)}`;
}

export function extractEntry(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run scripts/release 2>&1 | tail -n 8`
Expected: 1 file passed, 18 tests passed, 0 failed.

- [ ] **Step 5: Write the command**

Create `scripts/release/next-release.mjs`:

```js
#!/usr/bin/env node
// Decides the next release from git, npm and the release catalog.
// Usage: node scripts/release/next-release.mjs [--apply] [--notes <path>]
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { changelogEntry, decide, extractEntry, prependEntry } from './lib.mjs';

const PACKAGES = ['packages/core/package.json', 'apps/cli/package.json'];
const CATALOG = '.claude/refined_backlog/_catalog.json';
const CHANGELOG = 'CHANGELOG.md';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const notesPath = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : null;

const capture = (cmd, cmdArgs) => {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const manifests = PACKAGES.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const parsed = manifests.map((m) => JSON.parse(m.text));
const currentVersion = parsed[0].version;
if (parsed.some((p) => p.version !== currentVersion)) {
  throw new Error(`package versions differ: ${parsed.map((p) => `${p.name}@${p.version}`).join(', ')}`);
}

const currentIsTagged = capture('git', ['rev-parse', '-q', '--verify', `refs/tags/v${currentVersion}`]) !== null;
// Only "not found" means unpublished. Any other npm failure (network, registry
// outage) must stop the run rather than be mistaken for a missing version.
const isPublished = (name) => {
  try {
    const out = execFileSync('npm', ['view', `${name}@${currentVersion}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() === currentVersion;
  } catch (error) {
    if (/E404/.test(String(error.stderr))) return false;
    throw new Error(`npm view ${name}@${currentVersion} failed: ${String(error.stderr).trim()}`);
  }
};
const currentIsPublished = parsed.every((p) => isPublished(p.name));
const lastTag = capture('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
const log = capture('git', ['log', lastTag ? `${lastTag}..HEAD` : 'HEAD', '--format=%s%x1f%b%x1e']) ?? '';
const commits = log
  .split('\x1e')
  .map((record) => record.trim())
  .filter(Boolean)
  .map((record) => {
    const [subject, body = ''] = record.split('\x1f');
    return { subject, body };
  });
const catalog = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : [];

const decision = decide({ currentVersion, commits, catalog, currentIsTagged, currentIsPublished });

let changelog = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : '# Changelog\n';
if (apply && decision.action === 'release') {
  for (const m of manifests) {
    writeFileSync(m.path, m.text.replace(`"version": "${currentVersion}"`, `"version": "${decision.version}"`));
  }
  const date = new Date().toISOString().slice(0, 10);
  changelog = prependEntry(changelog, changelogEntry(decision.version, date, decision.notes));
  writeFileSync(CHANGELOG, changelog);
}
// Written for every action: a later run may still need the notes to create a
// GitHub Release that an earlier, failed run never made.
if (notesPath) {
  const notes = decision.action === 'release' ? decision.notes.map((n) => `- ${n}`).join('\n') : extractEntry(changelog, decision.version);
  writeFileSync(notesPath, `${notes || `Release ${decision.version}`}\n`);
}

const output = `action=${decision.action}\nversion=${decision.version}\n`;
process.stdout.write(output);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
```

- [ ] **Step 6: Run the command against the real repo (no changes made)**

Run: `node scripts/release/next-release.mjs`
Expected: two lines, `action=<none|release|publish-only>` and `version=<x.y.z>`, exit code 0, and `git status --short` shows no modified tracked files. State in the task report which action was printed and why it is correct for the commits since tag `v0.1.1`.

- [ ] **Step 7: Write and run the history check**

Create `scripts/release/history-check.mjs`:

```js
#!/usr/bin/env node
// Proves the catalog rule on real history: at the release 1.8 merge commit the
// catalog must already name that release's features.
import { execFileSync } from 'node:child_process';
import { notesForCommit } from './lib.mjs';

const MERGE = 'a4c49c9';
const subject = execFileSync('git', ['log', '-1', '--format=%s', MERGE], { encoding: 'utf8' }).trim();
const catalog = JSON.parse(
  execFileSync('git', ['show', `${MERGE}:.claude/refined_backlog/_catalog.json`], { encoding: 'utf8' }),
);
const { level, notes } = notesForCommit({ subject, body: '' }, catalog);
const ok = level === 'minor' && notes.length === 10 && notes.some((n) => n.endsWith('(F-028)')) && notes.some((n) => n.endsWith('(F-037)'));
console.log(`${ok ? 'PASS' : 'FAIL'}  ${subject}: level=${level}, ${notes.length} notes`);
process.exit(ok ? 0 : 1);
```

Run: `node scripts/release/history-check.mjs`
Expected: `PASS  release 1.8: level=minor, 10 notes`, exit code 0. If the count differs, stop and report the actual feature ids; do not change the expected numbers to make it pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/release
git commit -m "feat(release): decide version and release notes from commits and the release catalog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Phase gate** (rule 7): verify (`pnpm exec vitest run scripts/release`, `node scripts/release/history-check.mjs`) → independent review (`code-reviewer` + `typescript-reviewer`, `model: sonnet`) → `/simplify` → re-verify.

---

### Task 2: Release-on-merge workflow

**Files:**
- Modify: `.github/workflows/release.yml` (whole file)
- Delete: `.github/workflows/docs.yml`
- Create: `CHANGELOG.md`

**Interfaces:**
- Consumes: `node scripts/release/next-release.mjs --apply --notes <path>` from Task 1 (outputs `action`, `version`).
- Produces: a GitHub Release `v<version>` carrying `docs-site.tgz`; secret name `PORTAL_DISPATCH_TOKEN` (used by Task 4's step, already wired here as a no-op when unset).

- [ ] **Step 1: Create the changelog with the two existing versions**

Create `CHANGELOG.md`:

```markdown
# Changelog

Release notes for `@montionugera/ucsa-core` and `@montionugera/ucsa-cli`. Both packages always share one version. Entries are written by the release workflow.

## 0.1.1 - 2026-10-09

- First release published by the release workflow through trusted publishing

## 0.1.0 - 2026-10-09

- First public release of both packages
```

- [ ] **Step 2: Replace the workflow**

Replace the whole of `.github/workflows/release.yml` with:

```yaml
name: Release

# Runs on every merge to main. Decides whether the merge is a release
# (scripts/release/next-release.mjs), and if so: bumps both package versions,
# writes CHANGELOG.md, commits and tags, publishes to npmjs.com, attaches the
# docs build to a GitHub Release, and signals the developer portal.
#
# No npm token is stored anywhere: npmjs.com trusts this workflow (owner
# montionugera, repo cli-state-handler, workflow release.yml, environment
# blank). DO NOT rename this file, move the publish step into another workflow,
# or add `environment:` to the job: any of those breaks publishing.
#
# Re-runnable: start it by hand on main after a failed publish; a version that
# is tagged but missing from the registry is published without a new bump, and
# a version already on the registry is skipped.
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: release
  cancel-in-progress: false

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      # ref: main, not the commit that started the run: a queued or re-run job
      # must see bumps and tags that earlier runs already pushed.
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'

      - run: pnpm install --frozen-lockfile

      - name: Decide release
        id: decide
        run: |
          npm install -g npm@^11.5.1
          node scripts/release/next-release.mjs --apply --notes "$RUNNER_TEMP/release-notes.md"

      # True for a new release, and also when an earlier run published the
      # version but failed before attaching the docs, so a re-run repairs it.
      - name: Check for a missing docs archive
        id: docs
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ steps.decide.outputs.version }}
        run: |
          if gh release view "v$VERSION" --json assets --jq '.assets[].name' 2>/dev/null | grep -qx docs-site.tgz; then
            echo "needed=false" >> "$GITHUB_OUTPUT"
          else
            echo "needed=true" >> "$GITHUB_OUTPUT"
          fi

      # Only the published packages (and the workspace deps they need); a
      # docs-site break must not block a release.
      - name: Build
        if: steps.decide.outputs.action != 'none' || steps.docs.outputs.needed == 'true'
        run: pnpm --filter "@montionugera/ucsa-cli..." build

      - name: Unit tests
        if: steps.decide.outputs.action != 'none'
        run: pnpm test

      - name: Commit version bump and tag
        if: steps.decide.outputs.action == 'release'
        env:
          VERSION: ${{ steps.decide.outputs.version }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add CHANGELOG.md packages/core/package.json apps/cli/package.json
          git commit -m "chore(release): v$VERSION [skip ci]"
          # The planned-release flow pushes a cleanup commit seconds after the merge.
          git pull --rebase origin main
          git tag "v$VERSION"
          # Atomic: a bump commit on main without its tag would make the next
          # run bump again and skip this version.
          git push --atomic origin HEAD:main "v$VERSION"

      - name: Publish to npmjs.com (trusted publishing)
        if: steps.decide.outputs.action != 'none'
        run: |
          mkdir -p "$RUNNER_TEMP/npmjs"
          # pnpm pack rewrites workspace:* to the real version; npm uploads
          # (the OIDC exchange lives in the npm CLI). Core before cli.
          for dir in packages/core apps/cli; do
            name="$(node -p "require('./$dir/package.json').name")"
            version="$(node -p "require('./$dir/package.json').version")"
            if npm view "$name@$version" version >/dev/null 2>&1; then
              echo "skip: $name@$version is already on the registry"
              continue
            fi
            rm -f "$RUNNER_TEMP"/npmjs/*.tgz
            (cd "$dir" && pnpm pack --pack-destination "$RUNNER_TEMP/npmjs")
            npm publish "$RUNNER_TEMP"/npmjs/*.tgz --access public
          done

      # After publish on purpose: a docs failure leaves the libraries released.
      - name: Build docs archive
        if: steps.docs.outputs.needed == 'true'
        run: |
          pnpm --filter @ucsa/docs build
          tar -czf "$RUNNER_TEMP/docs-site.tgz" -C apps/docs/dist .

      - name: GitHub Release
        if: steps.docs.outputs.needed == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ steps.decide.outputs.version }}
        run: |
          if gh release view "v$VERSION" >/dev/null 2>&1; then
            gh release upload "v$VERSION" "$RUNNER_TEMP/docs-site.tgz" --clobber
          else
            gh release create "v$VERSION" --title "v$VERSION" --notes-file "$RUNNER_TEMP/release-notes.md" "$RUNNER_TEMP/docs-site.tgz"
          fi

      - name: Signal the developer portal
        if: steps.docs.outputs.needed == 'true'
        env:
          GH_TOKEN: ${{ secrets.PORTAL_DISPATCH_TOKEN }}
        run: |
          if [ -z "$GH_TOKEN" ]; then
            echo "::warning::PORTAL_DISPATCH_TOKEN is not set; the developer portal was not signalled"
            exit 0
          fi
          gh workflow run ci.yml -R montionugera/joy-design --ref main
```

- [ ] **Step 3: Delete the GitHub Pages workflow and everything that still points at it**

Run: `git rm .github/workflows/docs.yml`

Three places still describe or test that workflow; fix each in this same commit:

1. `scripts/epic-check.sh`, the block under the comment `# 8. Pages workflow exists, parses as YAML, references apps/docs` (the `if python3 -c '...'` through its closing `fi`). Replace the comment and the whole block with:

```bash
# 8. Docs are built and attached by the release workflow; no GitHub Pages workflow
if [ ! -e .github/workflows/docs.yml ] && grep -q "docs-site.tgz" .github/workflows/release.yml \
   && grep -q "@ucsa/docs build" .github/workflows/release.yml; then
  pass 8 "release.yml builds apps/docs and attaches docs-site.tgz; no Pages workflow"
else
  fail 8 "release.yml does not build and attach the docs, or docs.yml still exists"
fi
```

2. `README.md`, the subsection headed `### Deploying (GitHub Pages)`: change the heading to `### Deploying` and replace its paragraph with:

```markdown
The docs are not deployed from this repo directly. On every release, `.github/workflows/release.yml` builds `apps/docs`, attaches the build to the GitHub Release as `docs-site.tgz`, and signals the developer portal (`dev.joymify.com/cli-state-handler/`, served from the `joy-design` repo). The base path stays `/cli-state-handler/`. See "Publishing".
```

3. `docs/handoff/ucsa-docs-portal.md`, the `## Deploy` section: replace its first paragraph (the one starting with `` `.github/workflows/docs.yml` ``) with the same paragraph as in item 2.

Then run: `grep -rn "docs\.yml" --include='*.md' --include='*.sh' --include='*.yml' . 2>/dev/null | grep -v node_modules | grep -v "^./.claude/" | grep -v "^./graft/"`
Expected: no output except the `[ ! -e .github/workflows/docs.yml ]` line in `scripts/epic-check.sh`.

Add `scripts/epic-check.sh README.md docs/handoff/ucsa-docs-portal.md` to the `git add` in Step 6.

- [ ] **Step 4: Verify the workflow file**

Run:

```bash
W=.github/workflows/release.yml
python3 -I -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1])); print("yaml ok")' "$W" 2>/dev/null || ruby -ryaml -e 'YAML.load_file(ARGV[0]); puts "yaml ok"' "$W"
grep -c "branches: \[main\]" "$W"; grep -cE "^\s*environment:" "$W"; grep -c "tags:" "$W"
echo "publish line $(grep -n 'npm publish' "$W" | head -n 1 | cut -d: -f1), docs line $(grep -n '@ucsa/docs build' "$W" | head -n 1 | cut -d: -f1)"
ls .github/workflows
```

Expected: `yaml ok`; counts `1`, `0`, `0`; the publish line number is lower than the docs line number; the only workflow file is `release.yml`. Also confirm `grep -c "ref: main" "$W"` prints `1` and `grep -c "push --atomic" "$W"` prints `1`.

Known consequence, state it in the task report: the first run after this merges finds no GitHub Release for the current version, so even a housekeeping merge creates the Release and attaches the docs once. If `actionlint` is installed (`command -v actionlint`), also run `actionlint "$W"` and expect no output.

- [ ] **Step 5: Dry-run the decision exactly as the workflow will**

Run:

```bash
GITHUB_OUTPUT=/dev/null node scripts/release/next-release.mjs --notes "$(mktemp)"; git status --short
```

Expected: `action=` and `version=` lines; no tracked file modified (no `--apply`).

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md .github/workflows/release.yml scripts/epic-check.sh README.md docs/handoff/ucsa-docs-portal.md
git commit -m "feat(release): release on every merge to main with changelog, GitHub Release and docs archive

Removes the tag trigger and the GitHub Pages workflow, which failed on every
merge and targeted the wrong host.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Phase gate** (rule 7), full gate, this is CI and publishing surface: verify (Step 4 and Step 5 again) → independent review (`code-reviewer` + `security-reviewer`, `model: opus`, asked specifically to check the trust constraint, the write permission scope, the rebase-then-push race, and shell quoting of `VERSION`) → `/simplify` → re-verify. The workflow on a real runner cannot be verified before the release branch is merged; say so in the task report.

---

### Task 3: Release notes page and version marker in the docs

**Files:**
- Create: `apps/docs/src/models/changelog.ts`, `apps/docs/tests/changelog.test.ts`, `apps/docs/src/components/ReleaseNotes.tsx`, `apps/docs/vite-plugins/version-json.ts`
- Modify: `apps/docs/src/routes.ts` (one import, one route line), `apps/docs/src/virtual.d.ts` (one declaration), `apps/docs/vite.config.ts` (register the plugin)

**Interfaces:**
- Consumes: `CHANGELOG.md` at the repo root in the format written by Task 1's `changelogEntry` (`## <version> - <date>` heading, then `- ` bullets). Task 2 creates the file; if this task runs first, create it with the content from Task 2 Step 1.
- Produces: route id `release-notes`; file `version.json` (`{"version": "<core version>"}`) at the root of `apps/docs/dist`.

- [ ] **Step 1: Write the failing parser test**

Create `apps/docs/tests/changelog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/models/changelog.js";

describe("parseChangelog", () => {
  it("returns entries newest first with their notes", () => {
    const text = "# Changelog\n\nIntro.\n\n## 0.2.0 - 2026-10-10\n\n- Docs sandbox (F-036)\n- fix: close handle\n\n## 0.1.1 - 2026-10-09\n\n- first\n";
    expect(parseChangelog(text)).toEqual([
      { version: "0.2.0", date: "2026-10-10", notes: ["Docs sandbox (F-036)", "fix: close handle"] },
      { version: "0.1.1", date: "2026-10-09", notes: ["first"] },
    ]);
  });
  it("returns an empty list when there are no entries", () => {
    expect(parseChangelog("# Changelog\n")).toEqual([]);
  });
  it("tolerates a heading without a date", () => {
    expect(parseChangelog("## 0.3.0\n\n- x\n")).toEqual([{ version: "0.3.0", date: "", notes: ["x"] }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/changelog.test.ts 2>&1 | tail -n 8`
Expected: FAIL, cannot resolve `../src/models/changelog.js`.

- [ ] **Step 3: Write the parser**

Create `apps/docs/src/models/changelog.ts`:

```ts
export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
}

/** Parses the repo-root CHANGELOG.md (written by scripts/release) into entries, newest first. */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const line of text.split("\n")) {
    const heading = /^## (\S+)(?: - (\S+))?$/.exec(line.trim());
    if (heading) {
      entries.push({ version: heading[1], date: heading[2] ?? "", notes: [] });
      continue;
    }
    const bullet = /^- (.+)$/.exec(line.trim());
    if (bullet && entries.length > 0) entries[entries.length - 1].notes.push(bullet[1]);
  }
  return entries;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @ucsa/docs exec vitest run tests/changelog.test.ts 2>&1 | tail -n 6`
Expected: 3 tests passed.

- [ ] **Step 5: Add the page and register it**

Append to `apps/docs/src/virtual.d.ts`:

```ts
declare module "*.md?raw" {
  const text: string;
  export default text;
}
```

Create `apps/docs/src/components/ReleaseNotes.tsx`:

```tsx
import changelog from "../../../../CHANGELOG.md?raw";
import { parseChangelog } from "../models/changelog.js";
import { Prose } from "./Prose.js";

const entries = parseChangelog(changelog);

export function ReleaseNotes() {
  return (
    <Prose>
      <h1>Release notes</h1>
      <p>
        Every version of <code>@montionugera/ucsa-core</code> and <code>@montionugera/ucsa-cli</code>. Both packages
        always share one version.
      </p>
      {entries.map((entry) => (
        <section key={entry.version}>
          <h2>
            {entry.version}
            {entry.date ? ` (${entry.date})` : ""}
          </h2>
          <ul>
            {entry.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ))}
    </Prose>
  );
}
```

In `apps/docs/src/routes.ts`: add `import { ReleaseNotes } from "./components/ReleaseNotes.js";` after the `Sandbox` import, and add this line to the `routes` array directly after the `parity` entry (so it sits in the existing "Guides" group, before the Sandbox entry):

```ts
  { id: "release-notes", title: "Release notes", icon: "📝", group: "Guides", component: ReleaseNotes },
```

- [ ] **Step 6: Add the version marker plugin**

Create `apps/docs/vite-plugins/version-json.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Emits version.json so a deployed docs build can be matched to a library release. */
export function versionJson(): Plugin {
  return {
    name: "ucsa-version-json",
    apply: "build",
    generateBundle() {
      const manifest = fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url));
      const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ version })}\n` });
    },
  };
}
```

In `apps/docs/vite.config.ts`: import it (`import { versionJson } from "./vite-plugins/version-json.js";`, matching the import style of the existing `ucsaCoreIife` import in that file) and add `versionJson()` to the `plugins` array.

- [ ] **Step 7: Build and verify**

Run:

```bash
pnpm --filter @montionugera/ucsa-core build 2>&1 | tail -n 2
pnpm --filter @ucsa/docs build 2>&1 | tail -n 4
cat apps/docs/dist/version.json
node -p "require('./packages/core/package.json').version"
grep -l "Release notes" apps/docs/dist/assets/*.js | head -n 1
pnpm --filter @ucsa/docs test 2>&1 | tail -n 5
```

Expected: both builds exit 0; `version.json` prints `{"version":"<x>"}` where `<x>` equals the core version on the next line; one built script contains "Release notes"; all docs tests pass. Then load the page: `pnpm --filter @ucsa/docs preview` and open `http://localhost:6006/cli-state-handler/#/release-notes` in a browser; confirm the two changelog entries render and the sidebar shows "Release notes". Report what you saw. Stop the preview server afterwards.

- [ ] **Step 8: Commit**

```bash
git add apps/docs
git add CHANGELOG.md 2>/dev/null || true   # only present here if this task had to create it
git commit -m "feat(docs): release notes page from CHANGELOG.md and version.json build marker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Phase gate** (rule 7): verify (Step 7) → independent review (`code-reviewer` + `typescript-reviewer`, `model: sonnet`) → `/simplify` → re-verify.

---

### Task 4: Portal signal

**Files:**
- Modify: `.github/workflows/release.yml` only if the checks below show the step from Task 2 needs a change.

**Interfaces:**
- Consumes: the "Signal the developer portal" step and secret name `PORTAL_DISPATCH_TOKEN` from Task 2.
- Produces: a verified statement of the narrowest token permission, for the README in Task 5.

This task is mostly verification: the step already exists (Task 2) and is inert until the owner creates the credential.

- [ ] **Step 1: Confirm the target workflow can be started by hand**

Run: `gh api repos/montionugera/joy-design/contents/.github/workflows/ci.yml --jq .content | base64 -d | sed -n '1,20p'`
Expected: the `on:` block lists `workflow_dispatch`. If it declares required inputs, add matching `-f name=value` flags to the `gh workflow run` line in `release.yml` and re-run Task 2 Step 4.

- [ ] **Step 2: Determine the narrowest permission**

Read GitHub's REST documentation for "Create a workflow dispatch event" (`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`) and record the fine-grained token permission it lists. Expected finding: repository permission "Actions: write" on `montionugera/joy-design`. Record the exact wording you found; do not guess.

- [ ] **Step 3: Confirm the unset-secret path is harmless**

Run: `GH_TOKEN= bash -c 'if [ -z "$GH_TOKEN" ]; then echo "::warning::PORTAL_DISPATCH_TOKEN is not set; the developer portal was not signalled"; exit 0; fi; echo SHOULD_NOT_PRINT'; echo "exit $?"`
Expected: the warning line, then `exit 0`.

- [ ] **Step 4: Commit only if `release.yml` changed**

```bash
git add .github/workflows/release.yml
git commit -m "fix(release): pass required inputs when signalling the developer portal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Phase gate**: shares Task 5's gate (same subsystem, small diff).

---

### Task 5: README and epic check

**Files:**
- Modify: `README.md` ("Publishing" section), `scripts/epic-check.sh`

**Interfaces:**
- Consumes: everything above; the permission wording from Task 4 Step 2.
- Produces: `scripts/epic-check.sh E-009` exits 0 when assertions 1 to 5 of `verification.md` hold.

- [ ] **Step 1: Add the E-009 checks**

The release tool's epic gate calls this script with no arguments and passes the epic id in the environment variable `PSRW_EPIC_ID`; today the script only reads its first argument, so in the gate it always reports "nothing to do". Fix that first: change the line `EPIC="${1:-}"` to

```bash
EPIC="${1:-${PSRW_EPIC_ID:-}}"
```

Then change the header comment's second and fourth lines to say the script implements E-008 and E-009 and takes the id from the first argument or `PSRW_EPIC_ID`, and insert this block immediately after the `EPIC=` line:

```bash
if [ "$EPIC" = "E-009" ]; then
  # Pre-merge assertions 1-5 of E-009's verification.md. Assertions 6-10 only
  # become true after a real release and are checked by hand.
  rc=0
  # The gate runs in a fresh snapshot worktree with no node_modules.
  [ -d node_modules ] || pnpm install --frozen-lockfile >/dev/null 2>&1 || { echo "FAIL  pnpm install"; exit 1; }
  run() {
    local n=$1 desc=$2 out; shift 2
    if out=$("$@" 2>&1); then echo "PASS  assertion $n: $desc"
    else echo "FAIL  assertion $n: $desc"; echo "$out" | tail -n 8 | sed 's/^/        /'; rc=1; fi
  }
  W=.github/workflows/release.yml
  run 1 "version script unit tests pass" pnpm exec vitest run scripts/release
  run 2 "script names the features of release 1.8 at its merge commit" node scripts/release/history-check.mjs
  run 3 "release.yml: runs on push to main, no environment, docs built after publish" bash -c "
    grep -q 'branches: \[main\]' $W && ! grep -qE '^\s*environment:' $W && ! grep -q 'tags:' $W &&
    [ \"\$(grep -n 'npm publish' $W | head -n 1 | cut -d: -f1)\" -lt \"\$(grep -n '@ucsa/docs build' $W | head -n 1 | cut -d: -f1)\" ]"
  run 4 "no workflow targets GitHub Pages" bash -c "! grep -rlE 'deploy-pages|upload-pages-artifact|configure-pages' .github/workflows"
  run 5 "docs build has a release notes page and version.json" bash -c "
    pnpm --filter @montionugera/ucsa-core build >/dev/null && pnpm --filter @ucsa/docs build >/dev/null &&
    test -f apps/docs/dist/version.json && grep -q 'release-notes' apps/docs/src/routes.ts"
  exit $rc
fi
```

- [ ] **Step 2: Run the epic check both ways**

Run: `scripts/epic-check.sh E-009; echo "exit $?"`
Expected: five `PASS` lines, `exit 0`.

Run: `PSRW_EPIC_ID=E-009 scripts/epic-check.sh; echo "exit $?"`
Expected: the same five `PASS` lines, `exit 0` (this is how the release tool calls it).

Run: `scripts/epic-check.sh E-000; echo "exit $?"`
Expected: `epic-check: no checks defined for 'E-000', nothing to do`, `exit 0` (unchanged behaviour).

Run: `scripts/epic-check.sh E-008 2>&1 | grep -E "^(PASS|FAIL)" | sort | uniq -c | head -n 12; scripts/epic-check.sh E-008 >/dev/null 2>&1; echo "exit $?"`
Expected: no `FAIL` line and `exit 0`. Because the id is now also read from the environment, the E-008 checks will run for real in the gate for the first time. If any E-008 assertion fails for a reason unrelated to this epic, stop and report it with its output; do not weaken the assertion.

- [ ] **Step 3: Rewrite the README "Publishing" section**

The "Publishing" section of `README.md` has four parts: an opening paragraph, `**First publish (one-time, manual)**`, `**Cutting a release**`, and `**Requirements and notes**`. Keep the opening paragraph, "First publish" and "Requirements and notes" exactly as they are. Replace only the `**Cutting a release**` part (from that bold line up to, not including, `**Requirements and notes**`) with the text below, leaving out its first line (`## Publishing`) and its last paragraph (`**New package:** ...`). Then add that `**New package:**` paragraph as the last line of the "First publish" part, as the command-line alternative to the settings table.

```markdown
## Publishing

**How a release happens**

Merging to `main` is the release. `.github/workflows/release.yml` runs on every merge and:

1. Decides whether the merge is a release (`scripts/release/next-release.mjs`):
   - a planned release (`release X.Y`) takes its notes from the release catalog and bumps the minor version;
   - any other merge is read by commit type: `feat` bumps the minor version, `fix` and `perf` the patch version;
   - housekeeping-only merges (`chore`, `docs`, `ci`, `test`) release nothing;
   - a breaking change (`!` or a `BREAKING CHANGE:` footer) bumps the major version, or the minor version while below 1.0.
2. Bumps `@montionugera/ucsa-core` and `@montionugera/ucsa-cli` to the same version, adds the entry to `CHANGELOG.md`, commits that to `main` and tags `v<version>`.
3. Publishes both packages to npmjs.com through trusted publishing. No token is stored.
4. Builds the docs, attaches them to a GitHub Release as `docs-site.tgz`, and starts the developer portal's deploy.

Check what the next merge would do, without changing anything: `node scripts/release/next-release.mjs`.

**If a publish fails:** start the "Release" workflow by hand on `main`. A version that is tagged but missing from the registry is published without a new bump.

**Do not** rename `release.yml`, move its publish step into another workflow, or add `environment:` to its job. npmjs.com trusts that exact file with a blank environment.

**Portal signal:** needs a repository secret `PORTAL_DISPATCH_TOKEN`, a fine-grained GitHub token for `montionugera/joy-design` with the permission recorded below. Without it the release still succeeds and the workflow logs a warning.

After a release, `main` has a bump commit made by the workflow; run `psrw sync-main` before starting the next release.

**New package:** npmjs.com needs a package to exist before trust can be attached, so its first version is published once by hand, then `npm trust github <name> --file release.yml --repository montionugera/cli-state-handler --allow-publish`.
```

Under "Portal signal", replace "the permission recorded below" with the exact permission wording found in Task 4 Step 2.

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/epic-check.sh
git commit -m "docs(release): document merge-based releases; add E-009 epic checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Phase gate** (rule 7, covers Tasks 4 and 5): verify (`scripts/epic-check.sh E-009`, `pnpm test 2>&1 | tail -n 5`) → independent review (`code-reviewer`, `model: sonnet`) → `/simplify` → re-verify.

---

## After the plan (not tasks; owner or follow-up work)

- First real release: when the release branch is promoted to `main`, watch the "Release" run and check assertions 6, 7, 9 and 10 of `verification.md`. Assertion 8 waits for the portal work.
- Open the `joy-design` work item: download `docs-site.tgz` for each library in its pipeline before the image build (unpack over `apps/storybook-hub/portal-bundles/<library>`), skip the Flutter build for runs started by a library release, compare `version.json` in `scripts/smoke-prod.sh`.
- Owner creates the `PORTAL_DISPATCH_TOKEN` credential and a read credential for `joy-design`, and adds both to the `gh-secrets` repo.
- No architecture diagram in draw.io format accompanies this plan; the spec's two flowcharts are the diagrams.
- Known limit: a docs-only merge (commit type `docs`) is housekeeping, so the portal docs are refreshed at the next real release, not immediately.
- The release workflow cannot run before `release/1.9` is merged to `main`. That first merge publishes the next version to npmjs.com (permanent) and pushes a commit and tag to `main`; it is the first real test of the workflow.

## Audit trail

- 2026-10-09 self-grill-audit: verdict safe-with-fixes. The auditor ran the plan's code in a scratch directory: 18 of 18 tests pass, `next-release.mjs` prints `action=none version=0.1.1` on `release/1.9`, `history-check.mjs` passes with 10 notes, the workflow parses and `actionlint` is clean. Corrected: checkout now uses `ref: main` (a queued or re-run job re-decided the same release and died on "tag already exists"); docs build, GitHub Release and portal signal are gated on "no `docs-site.tgz` on the release" so a re-run can repair them; `scripts/epic-check.sh` reads `PSRW_EPIC_ID` (the release tool's gate passes the id there, so the checks never ran) and installs dependencies; commit and tag are pushed atomically (a lost tag caused a double bump); only an npm "not found" counts as unpublished; stale references to `docs.yml` in `README.md`, `docs/handoff/ucsa-docs-portal.md` and E-008 assertion 8 are fixed in Task 2; the release notes route names its group and icon; the page uses the existing `Prose` component; the README rewrite keeps the first-publish and requirements parts.
  Open: the two workflow fixes were reasoned and simulated by the auditor in a scratch repo, not run on GitHub.
