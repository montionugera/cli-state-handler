// Runs scripts/release/publish-packages.sh with a stub `npm` and `pnpm` first on
// PATH. Nothing here reaches the real registry.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const script = join(here, 'publish-packages.sh');
const pkg = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
const core = pkg('packages/core');
const cli = pkg('apps/cli');
const key = (name) => name.replace(/[@/]/g, '_');

// Stub npm. `view` answers from $STUB_DIR/view.<key>, one line per call
// (visible | 404 | error), repeating the last line. `publish` checks the
// tarball is real, prints $STUB_DIR/publish.<key>.out to stderr and exits
// with $STUB_DIR/publish.<key>.rc (default 0).
const NPM_STUB = `#!/usr/bin/env bash
set -euo pipefail
d="$STUB_DIR"
echo "npm $*" >>"$d/calls.log"
cmd="$1"; shift
key() { printf '%s' "$1" | tr '@/' '__'; }
case "$cmd" in
  view)
    spec=""
    for a in "$@"; do case "$a" in --*) ;; *) spec="$a"; break ;; esac; done
    name="\${spec%@*}"; version="\${spec##*@}"; k="$(key "$name")"
    n=$(cat "$d/view.$k.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$d/view.$k.n"
    total=$(wc -l <"$d/view.$k" | tr -d ' ')
    line=$(sed -n "$(( n < total ? n : total ))p" "$d/view.$k")
    case "$line" in
      visible) echo "$version" ;;
      404) echo "npm error code E404" >&2; echo "npm error 404 No match found for version $version" >&2; exit 1 ;;
      error) echo "npm error code ETIMEDOUT" >&2; echo "npm error network request failed" >&2; exit 1 ;;
      empty) exit 0 ;;
      *) echo "stub npm: bad view line '$line'" >&2; exit 3 ;;
    esac ;;
  publish)
    tgz="$1"; k="$(basename "$tgz" .tgz)"
    tar -tzf "$tgz" >/dev/null || { echo "stub npm: not a real tarball: $tgz" >&2; exit 2; }
    if [ -f "$d/publish.$k.out" ]; then cat "$d/publish.$k.out" >&2; fi
    exit "$(cat "$d/publish.$k.rc" 2>/dev/null || echo 0)" ;;
  *) echo "stub npm: unexpected command $cmd" >&2; exit 3 ;;
esac
`;

// Stub pnpm: \`pnpm pack --pack-destination DIR\` writes a real .tgz named <key>.tgz.
const PNPM_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "pnpm $* (in $PWD)" >>"$STUB_DIR/calls.log"
[ "$1" = pack ] || { echo "stub pnpm: unexpected command $1" >&2; exit 3; }
dest=""
while [ $# -gt 0 ]; do [ "$1" = --pack-destination ] && dest="$2"; shift; done
name=$(node -p "require('./package.json').name")
k=$(printf '%s' "$name" | tr '@/' '__')
tmp=$(mktemp -d); mkdir "$tmp/package"; cp package.json "$tmp/package/"
tar -czf "$dest/$k.tgz" -C "$tmp" package
rm -rf "$tmp"
echo "$dest/$k.tgz"
`;

const E409_RUN_38113899301 = [
  'npm error code E409',
  'npm error 409 Conflict - PUT https://registry.npmjs.org/@montionugera%2fucsa-core - Cannot publish over previously staged version "0.3.0".',
  'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-10-11T05_11_25_675Z-debug-0.log',
].join('\n');

let tmp;
let stubDir;
let runnerTemp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'publish-packages-'));
  stubDir = join(tmp, 'stub');
  runnerTemp = join(tmp, 'runner');
  execFileSync('mkdir', ['-p', join(stubDir, 'bin'), runnerTemp]);
  writeFileSync(join(stubDir, 'bin', 'npm'), NPM_STUB);
  writeFileSync(join(stubDir, 'bin', 'pnpm'), PNPM_STUB);
  chmodSync(join(stubDir, 'bin', 'npm'), 0o755);
  chmodSync(join(stubDir, 'bin', 'pnpm'), 0o755);
  writeFileSync(join(stubDir, 'calls.log'), '');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const views = (name, lines) => writeFileSync(join(stubDir, `view.${key(name)}`), lines.join('\n') + '\n');
const publishFails = (name, rc, out) => {
  writeFileSync(join(stubDir, `publish.${key(name)}.rc`), String(rc));
  writeFileSync(join(stubDir, `publish.${key(name)}.out`), out + '\n');
};

const run = (env = {}) => {
  const r = spawnSync('bash', [script], {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(stubDir, 'bin')}:${process.env.PATH}`,
      STUB_DIR: stubDir,
      RUNNER_TEMP: runnerTemp,
      PUBLISH_POLL_INTERVAL: '0',
      PUBLISH_POLL_LIMIT: '3',
      ...env,
    },
  });
  const calls = readFileSync(join(stubDir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean);
  return { ...r, out: r.stdout + r.stderr, calls };
};
const count = (calls, re) => calls.filter((c) => re.test(c)).length;
const viewsOf = (calls, name) => count(calls, new RegExp(`^npm view --prefer-online ${name}@`));

describe('publish-packages.sh', () => {
  it('skips both packages when the registry already shows them, without packing or publishing', () => {
    views(core.name, ['visible']);
    views(cli.name, ['visible']);
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain(`skip: ${core.name}@${core.version} is already on the registry`);
    expect(r.stdout).toContain(`skip: ${cli.name}@${cli.version} is already on the registry`);
    expect(count(r.calls, /^pnpm pack/)).toBe(0);
    expect(count(r.calls, /^npm publish/)).toBe(0);
  });

  it('packs a real tarball and publishes core before cli when neither is on the registry', () => {
    views(core.name, ['404']);
    views(cli.name, ['404']);
    const r = run();
    expect(r.status, r.out).toBe(0);
    const publishes = r.calls.filter((c) => c.startsWith('npm publish'));
    expect(publishes).toHaveLength(2);
    expect(publishes[0]).toContain(`${key(core.name)}.tgz --access public`);
    expect(publishes[1]).toContain(`${key(cli.name)}.tgz --access public`);
    const tgz = join(runnerTemp, 'npmjs', `${key(cli.name)}.tgz`);
    expect(existsSync(tgz)).toBe(true);
    expect(execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })).toContain('package/package.json');
  });

  it('treats E409 as a skip once the version appears on the second poll', () => {
    views(core.name, ['404', '404', 'visible']);
    views(cli.name, ['visible']);
    publishFails(core.name, 1, 'npm error code E409\nnpm error 409 Conflict - Cannot publish over previously staged version');
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain(`skip: ${core.name}@${core.version} is now on the registry`);
    expect(r.stdout).toContain('assumed the same content');
    expect(viewsOf(r.calls, core.name)).toBe(3);
  });

  it('fails with the "staged" message when the version never appears after E409', () => {
    views(core.name, ['404']);
    views(cli.name, ['404']);
    publishFails(core.name, 1, 'npm error code E409');
    const r = run({ PUBLISH_POLL_LIMIT: '3' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/staged and awaiting approval on npmjs\.com/);
    expect(viewsOf(r.calls, core.name)).toBe(1 + 3);
    expect(viewsOf(r.calls, cli.name)).toBe(0);
  });

  it('fails at once, with no polling, on a publish error that is not the race', () => {
    views(core.name, ['404', 'visible']);
    views(cli.name, ['404']);
    publishFails(
      core.name,
      1,
      'npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/@montionugera%2fucsa-core - You do not have permission to publish',
    );
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('You do not have permission to publish');
    expect(viewsOf(r.calls, core.name)).toBe(1);
    expect(viewsOf(r.calls, cli.name)).toBe(0);
  });

  it('skips core after a 409 and still publishes cli', () => {
    views(core.name, ['404', 'visible']);
    views(cli.name, ['404']);
    publishFails(core.name, 1, 'npm error code E409');
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain(`skip: ${core.name}@${core.version} is now on the registry`);
    const publishes = r.calls.filter((c) => c.startsWith('npm publish'));
    expect(publishes).toHaveLength(2);
    expect(publishes[1]).toContain(`${key(cli.name)}.tgz`);
  });

  it('treats the E403 "previously published versions" race as a skip once the version appears', () => {
    views(core.name, ['404', 'visible']);
    views(cli.name, ['visible']);
    publishFails(
      core.name,
      1,
      `npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/@montionugera%2fucsa-core - You cannot publish over the previously published versions: ${core.version}.`,
    );
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain(`skip: ${core.name}@${core.version} is now on the registry`);
  });

  it('treats the exact E409 output of run 38113899301 as a skip once the version appears', () => {
    views(core.name, ['404', '404', '404', 'visible']);
    views(cli.name, ['visible']);
    publishFails(core.name, 1, E409_RUN_38113899301);
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('Cannot publish over previously staged version "0.3.0".');
    expect(r.stdout).toContain(`skip: ${core.name}@${core.version} is now on the registry`);
  });

  it('fails at once when npm view fails with anything other than E404', () => {
    views(core.name, ['error']);
    views(cli.name, ['404']);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ETIMEDOUT');
    expect(count(r.calls, /^pnpm pack/)).toBe(0);
    expect(count(r.calls, /^npm publish/)).toBe(0);
  });

  it('treats an npm view that exits 0 with no output as not on the registry yet', () => {
    views(core.name, ['empty', 'visible']);
    views(cli.name, ['visible']);
    publishFails(core.name, 1, 'npm error code E409\nnpm error 409 Conflict - Cannot publish over previously staged version');
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(viewsOf(r.calls, core.name)).toBe(2);
  });

  it('survives one transient npm view error during the wait', () => {
    views(core.name, ['404', 'error', 'visible']);
    views(cli.name, ['visible']);
    publishFails(core.name, 1, 'npm error code E409\nnpm error 409 Conflict - Cannot publish over previously staged version');
    const r = run();
    expect(r.status, r.out).toBe(0);
    expect(r.stderr).toContain('will check again');
    expect(viewsOf(r.calls, core.name)).toBe(3);
  });

  it('refuses to run without RUNNER_TEMP', () => {
    views(core.name, ['404']);
    views(cli.name, ['404']);
    const r = run({ RUNNER_TEMP: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('RUNNER_TEMP');
    expect(r.calls).toHaveLength(0);
  });
});
