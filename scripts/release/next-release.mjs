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
