#!/usr/bin/env bash
# Gate 1 (precheck) - fast checks, no external services.
# Stamped by `psrw init`. `psrw ship` runs it before merging a feature into the release.
#
# Each slot_* function below is a labelled slot. To FILL a slot, replace its
# `unfilled` line with the real commands. If a slot truly does not apply to this
# repo, keep `unfilled` and add one comment line above it inside the function:
#     # n/a: the reason, in plain words
# An unfilled slot is reported loudly here and FAILS Gate 2 (integration.sh).
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/.."

UNFILLED_IS_FAILURE=0

# ---- slot runner (leave as is) ----------------------------------------------
FAILED=0
UNFILLED=0

unfilled() { return 1; }   # placeholder body; run_slot detects it from the source

slot_body() { sed -n "/^slot_$1() {/,/^}/p" "$SELF"; }

is_unfilled() { slot_body "$1" | grep -Eq '^[[:space:]]*unfilled[[:space:]]*$'; }

na_reason() {  # prints the reason when slot $1 carries a real "# n/a: ..." marker
  slot_body "$1" \
    | sed -n 's/^[[:space:]]*# n\/a: \([^<[:space:]].*\)$/\1/p' | head -n 1
}

run_slot() {
  SLOT=$1
  reason=$(na_reason "$SLOT")
  if [ -n "$reason" ]; then
    echo "-- $SLOT: n/a ($reason)"
    return 0
  fi
  # Unfilled is decided from the slot's SOURCE (it still holds the `unfilled`
  # line), never from an exit code a real tool could also return.
  if is_unfilled "$SLOT"; then
    echo "UNFILLED GATE SLOT: $SLOT"
    UNFILLED=$((UNFILLED + 1))
    if [ "$UNFILLED_IS_FAILURE" -ne 0 ]; then
      echo "FAILED: $SLOT"
      FAILED=$((FAILED + 1))
    fi
    return 0
  fi
  echo "== $SLOT"
  # Subshell with its own `set -e`, called outside any `if`, so the slot stops at
  # its FIRST failing command instead of reporting only the last one.
  set +e
  ( set -e; "slot_$SLOT" )
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "FAILED: $SLOT"
    FAILED=$((FAILED + 1))
  fi
}

# ---- slots -------------------------------------------------------------------

# SLOT 1 - build / typecheck (e.g. `pnpm build && pnpm check`, `go vet ./...`, `mypy app`)
slot_build_typecheck() {
  if [ -f "package.json" ]; then
    pnpm install --prefer-offline 2>/dev/null || pnpm install
  fi
  pnpm run build && pnpm run typecheck
}

# SLOT 2 - unit tests (e.g. `pnpm test:unit`, `pytest -q`, `go test ./...`)
slot_unit_tests() {
  pnpm test
  if command -v dart >/dev/null 2>&1 && [ -f "packages/ucsa_dart/pubspec.yaml" ]; then
    (cd packages/ucsa_dart && dart test)
  fi
  if command -v flutter >/dev/null 2>&1 && [ -f "packages/ucsa_flutter/pubspec.yaml" ]; then
    (cd packages/ucsa_flutter && flutter test)
  fi
  if command -v dotnet >/dev/null 2>&1 && [ -f "packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj" ]; then
    dotnet test packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj
    dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj
  fi
}

# SLOT 3 - fast static UI checks: lint for controls that cannot be clicked
# (handlers missing, unclosed containers, overlays covering buttons), e.g.
# `pnpm lint`, svelte-check, an antislop script. No browser here - that is Gate 2.
slot_static_ui_checks() {
  echo "apps/docs: typecheck (tsc -b) + tests"
  (cd apps/docs && pnpm exec tsc -b)
  pnpm --filter @ucsa/docs test
}

for slot in build_typecheck unit_tests static_ui_checks; do
  run_slot "$slot"
done

if [ "$FAILED" -gt 0 ]; then
  echo "Gate 1: $FAILED slot(s) failed"
  exit 1
fi
if [ "$UNFILLED" -gt 0 ]; then
  echo "Gate 1: passed, but $UNFILLED slot(s) are UNFILLED and checked nothing"
else
  echo "Gate 1: ok"
fi
