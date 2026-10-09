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
