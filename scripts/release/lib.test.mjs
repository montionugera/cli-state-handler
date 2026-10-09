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
