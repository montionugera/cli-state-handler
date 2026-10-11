#!/usr/bin/env bash
# Epic verification: implements E-008 (assertions 1-10) and E-009 (pre-merge checks 1-6).
# Usage: scripts/epic-check.sh <epic-id>   (id from $1 or PSRW_EPIC_ID)
# Any other epic id exits 0 immediately (nothing to check).
# Assertion 11 (Chrome at 360px/1280px) is manual and is NOT checked here.
set -uo pipefail
cd "$(dirname "$0")/.."

EPIC="${1:-${PSRW_EPIC_ID:-}}"
if [ "$EPIC" = "E-009" ]; then
  # Checks 1-5 are pre-merge assertions 1-5 of E-009's verification.md; check 6
  # (the portal signal passes cli_docs_tag) is extra and is not that file's
  # assertion 6. Its assertions 6-10 only become true after a real release and
  # are checked by hand.
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
    [ \"\$(grep -n 'publish-packages.sh' $W | head -n 1 | cut -d: -f1)\" -lt \"\$(grep -n '@ucsa/docs build' $W | head -n 1 | cut -d: -f1)\" ]"
  run 4 "no workflow targets GitHub Pages" bash -c "! grep -rlE 'deploy-pages|upload-pages-artifact|configure-pages' .github/workflows"
  run 5 "docs build has a release notes page and version.json" bash -c "
    pnpm --filter @montionugera/ucsa-core build >/dev/null && pnpm --filter @ucsa/docs build >/dev/null &&
    test -f apps/docs/dist/version.json && grep -rqF 'Release notes' apps/docs/dist"
  run 6 "release.yml signal step passes cli_docs_tag from env, no \${{ in its run script" bash -c "
    step=\$(awk '/- name: Signal the developer portal/{f=1;next} f&&/^      - name:/{exit} f' $W) &&
    run=\$(printf '%s\n' \"\$step\" | awk '/^        run:/{r=1;next} r') &&
    printf '%s\n' \"\$step\" | grep -qE '^          CLI_DOCS_TAG: v\\$\{\{ steps.decide.outputs.version \}\}' &&
    printf '%s\n' \"\$run\" | grep -qF -- '-f cli_docs_tag=\"\$CLI_DOCS_TAG\"' &&
    ! printf '%s\n' \"\$run\" | grep -qF '\${{'"
  exit $rc
fi
if [ "$EPIC" != "E-008" ]; then
  echo "epic-check: no checks defined for '${EPIC}', nothing to do"
  exit 0
fi

T=apps/docs/tests
FAILED=()

pass() { echo "PASS  assertion $1: $2"; }
fail() { echo "FAIL  assertion $1: $2"; FAILED+=("$1"); }
# check <n> <description> <command...>: runs the command, output hidden unless it fails.
check() {
  local n=$1 desc=$2; shift 2
  local out
  if out=$("$@" 2>&1); then pass "$n" "$desc"; else fail "$n" "$desc"; echo "$out" | tail -n 8 | sed 's/^/        /'; fi
}

# 1. docs tests pass and every named test file exists
missing=()
for f in app-shell.test.tsx swr-playground.test.tsx timing-playground.test.tsx \
         outbox-playground.test.tsx cas-playground.test.tsx wal-visualiser.test.tsx \
         ucb1-visualiser.test.tsx sandbox.test.tsx multiplatform-docs.test.tsx parity.test.tsx \
         ucb1-codec.parity.test.ts cas-model.parity.test.ts outbox-model.parity.test.ts \
         wal-model.test.ts; do
  [ -f "$T/$f" ] || missing+=("$f")
done
if [ ${#missing[@]} -gt 0 ]; then
  fail 1 "missing test files under $T: ${missing[*]}"
else
  check 1 "pnpm --filter @ucsa/docs test exits 0, all 14 named test files exist" pnpm --filter @ucsa/docs test
fi

# 2. docs build exits 0 and dist/index.html exists
rm -rf apps/docs/dist
check 2 "docs build exits 0 and apps/docs/dist/index.html exists" \
  bash -c 'pnpm --filter @ucsa/docs build && test -f apps/docs/dist/index.html'

# 3. built bundle has no real Node-only imports (Buffer.from is allowed: browser core uses it).
# Only quoted module specifiers count (import/require/dynamic import); guide pages legitimately mention
# `better-sqlite3` and `node:net` in prose, which minified output keeps inside backtick template strings.
if [ -d apps/docs/dist/assets ] && ! grep -rEl "[\"'](better-sqlite3|node:(fs|net|crypto|path))[\"']" apps/docs/dist/assets >/dev/null; then
  pass 3 "no Node-only imports in apps/docs/dist/assets"
else
  fail 3 "apps/docs/dist/assets missing, or contains better-sqlite3|node:(fs|net|crypto|path)"
fi

# 4. app-shell test renders every route and the not-found page
if grep -q 'for (const route of routes)' $T/app-shell.test.tsx 2>/dev/null \
   && grep -q 'not-found' $T/app-shell.test.tsx; then
  pass 4 "app-shell.test.tsx iterates routes and covers not-found"
else
  fail 4 "app-shell.test.tsx does not iterate routes and assert not-found"
fi

# 5. UCB1 parity test compares against real frame-codec, UCB1 magic, round trip
if grep -q 'ipc/frame-codec' $T/ucb1-codec.parity.test.ts 2>/dev/null \
   && grep -q '"UCB1"' $T/ucb1-codec.parity.test.ts && grep -qi 'round trip' $T/ucb1-codec.parity.test.ts; then
  pass 5 "ucb1-codec.parity.test.ts asserts real frame-codec parity, UCB1 magic, round trip"
else
  fail 5 "ucb1-codec.parity.test.ts missing frame-codec parity / UCB1 magic / round trip"
fi

# 6. WAL visualiser test: real test titles for WAL-before-main, reader isolation, checkpoint, simulation label
W=$T/wal-visualiser.test.tsx
if [ -f $W ] && grep -qF 'not yet in the main-file panel' $W && grep -qF 'still shows the old value' $W \
   && grep -qF 'empties the WAL panel' $W && grep -qF 'simulation' $W; then
  pass 6 "wal-visualiser.test.tsx has WAL-vs-main, older-reader, checkpoint and simulation tests"
else
  fail 6 "$W missing, or lacks titles: 'not yet in the main-file panel', 'still shows the old value', 'empties the WAL panel', 'simulation'"
fi

# 7. parity matrix test: six subsystems, every platform, one row per subsystem (arrives with F-035)
P=$T/parity.test.tsx
if [ -f $P ] && grep -qF 'const SUBSYSTEMS = ["swr", "timing", "outbox", "cas", "wal", "ucb1"]' $P \
   && grep -qF 'for (const p of platforms)' $P && grep -qF 'renders one row per subsystem' $P \
   && grep -qF 'expect(rows.length).toBe(6)' $P; then
  pass 7 "parity.test.tsx covers six subsystems, every platform, one matrix row per subsystem"
else
  fail 7 "apps/docs/tests/parity.test.tsx missing or lacks the SUBSYSTEMS list / platform loop / one-row-per-subsystem assertions (arrives with F-035)"
fi

# 8. Docs are built and attached by the release workflow; no GitHub Pages workflow
if [ ! -e .github/workflows/docs.yml ] && grep -q "docs-site.tgz" .github/workflows/release.yml \
   && grep -q "@ucsa/docs build" .github/workflows/release.yml; then
  pass 8 "release.yml builds apps/docs and attaches docs-site.tgz; no Pages workflow"
else
  fail 8 "release.yml does not build and attach the docs, or docs.yml still exists"
fi

# 9. README names every route title and the four commands
missing=()
while IFS= read -r title; do
  grep -qF -- "$title" README.md || missing+=("$title")
done < <(sed -n 's/^.*{ id: "[^"]*", title: "\([^"]*\)".*$/\1/p' apps/docs/src/routes.ts)
for cmd in '@ucsa/docs dev' '@ucsa/docs test' '@ucsa/docs build' 'ucsa docs'; do
  grep -qF -- "$cmd" README.md || missing+=("command: $cmd")
done
if [ ${#missing[@]} -eq 0 ]; then
  pass 9 "README.md contains every route title and the dev/test/build/docs-CLI commands"
else
  fail 9 "README.md is missing: $(IFS='; '; echo "${missing[*]}")"
fi

# 10. Gate 1 and Gate 2 exit 0 and do not print n/a for the UI slots
ok10=1
for g in precheck integration; do
  out=$(bash scripts/$g.sh 2>&1); rc=$?
  [ $rc -eq 0 ] || { ok10=0; echo "        scripts/$g.sh exited $rc"; }
  if echo "$out" | grep -E '^-- (static_ui_checks|browser_smoke): n/a' >/dev/null; then
    ok10=0; echo "        scripts/$g.sh prints n/a for a UI slot"
  fi
done
if [ $ok10 -eq 1 ]; then pass 10 "precheck.sh and integration.sh exit 0, no n/a UI slots"
else fail 10 "precheck.sh / integration.sh failed or print n/a for a UI slot"; fi

echo "----"
echo "Assertion 11 (Chrome 360px/1280px, no scroll/console errors) is manual."
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "epic-check E-008: FAILED assertions: ${FAILED[*]}"
  exit 1
fi
echo "epic-check E-008: all automated assertions passed"
