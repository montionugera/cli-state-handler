#!/usr/bin/env bash
# Publishes the npm packages, core before cli. Called by the release.yml step
# "Publish to npmjs.com (trusted publishing)". pnpm pack rewrites workspace:*
# to the real version; npm uploads (the OIDC exchange lives in the npm CLI).
#
# Overlapping runs: two pushes to main seconds apart start two release runs.
# The second can upload a version the first already uploaded but npm does not
# show yet, and fail with E409 "previously staged" or E403 "cannot publish over
# the previously published versions". Such a failure becomes a skip only after
# `npm view` shows the version; any other failure stops the run at once.
#
# Env: RUNNER_TEMP (required), PUBLISH_POLL_INTERVAL seconds between checks
# (default 15), PUBLISH_POLL_LIMIT checks (default 20, so 5 minutes; npm took
# up to about 158 s to show core 0.3.0 on 2026-10-11).
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
cd "$(dirname "$0")/../.."

interval="${PUBLISH_POLL_INTERVAL:-15}"
limit="${PUBLISH_POLL_LIMIT:-20}"
dest="$RUNNER_TEMP/npmjs"
mkdir -p "$dest"

# visible <name> <version> [wait]: succeeds when the registry shows the version,
# fails when it does not yet (E404, or no output). Any other npm error exits the
# script: a network or registry failure must not be mistaken for "not yet".
# With a third argument (the polling wait) a transient error is only a warning
# and counts as "not yet", so one network blip does not end a 5-minute wait.
visible() {
  local out rc=0
  out="$(npm view --prefer-online "$1@$2" version 2>"$dest/view.err")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    [ "$out" = "$2" ]
    return
  fi
  if grep -q E404 "$dest/view.err"; then
    return 1
  fi
  if [ -n "${3:-}" ]; then
    echo "warning: npm view $1@$2 failed, will check again:" >&2
    cat "$dest/view.err" >&2
    return 1
  fi
  echo "error: npm view $1@$2 failed:" >&2
  cat "$dest/view.err" >&2
  exit 1
}

for dir in packages/core apps/cli; do
  name="$(node -p "require('./$dir/package.json').name")"
  version="$(node -p "require('./$dir/package.json').version")"
  if visible "$name" "$version"; then
    echo "skip: $name@$version is already on the registry"
    continue
  fi
  rm -f "$dest"/*.tgz
  (cd "$dir" && pnpm pack --pack-destination "$dest")
  if npm publish "$dest"/*.tgz --access public >"$dest/publish.log" 2>&1; then
    cat "$dest/publish.log"
    continue
  fi
  cat "$dest/publish.log"
  if ! grep -qiE 'E409|previously staged|cannot publish over the previously published versions' "$dest/publish.log"; then
    echo "error: npm publish $name@$version failed" >&2
    exit 1
  fi
  echo "$name@$version was uploaded by another run; waiting for npm to show it (every ${interval}s, up to $limit checks)"
  shown=0
  for ((i = 1; i <= limit; i++)); do
    sleep "$interval"
    if visible "$name" "$version" wait; then
      shown=1
      break
    fi
  done
  if [ "$shown" -ne 1 ]; then
    echo "error: $name@$version is still not visible on npm after $limit checks. It may be staged and awaiting approval on npmjs.com: check the package page there, then re-run this workflow." >&2
    exit 1
  fi
  echo "skip: $name@$version is now on the registry (uploaded by an overlapping run; assumed the same content, as both runs check out main)"
done
