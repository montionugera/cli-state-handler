#!/usr/bin/env bash
# Godot in-engine smoke test for packages/ucsa_godot.
#   scripts/godot-smoke.sh            build, run headless under a timeout, and require
#                                     both exit code 0 and the literal line "SMOKE PASS 4/4"
#   scripts/godot-smoke.sh --locate   print the Godot .NET binary and exit 0; exit non-zero when none is found
# Binary lookup: $GODOT_MONO_BIN, else `godot-mono` or `godot` on PATH whose --version contains "mono".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$ROOT/packages/ucsa_godot"
TIMEOUT_SECS="${GODOT_SMOKE_TIMEOUT_SECS:-180}"
PASS_LINE="SMOKE PASS 4/4"

locate_godot() {
  if [ -n "${GODOT_MONO_BIN:-}" ]; then
    if [ ! -x "$GODOT_MONO_BIN" ]; then
      echo "godot smoke: GODOT_MONO_BIN is set but is not an executable file: $GODOT_MONO_BIN" >&2
      return 2
    fi
    echo "$GODOT_MONO_BIN"
    return 0
  fi
  local candidate
  for candidate in godot-mono godot; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version 2>/dev/null | grep -q mono; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

if [ "${1:-}" = "--locate" ]; then
  locate_godot
  exit $?
fi

if ! GODOT="$(locate_godot)"; then
  echo "godot smoke: FAILED (no Godot .NET binary; set GODOT_MONO_BIN or install godot-mono)" >&2
  exit 1
fi
if ! command -v dotnet >/dev/null 2>&1; then
  echo "godot smoke: FAILED (dotnet is not installed)" >&2
  exit 1
fi

echo "godot smoke: binary $GODOT ($("$GODOT" --version 2>/dev/null | head -n 1))"
dotnet build "$PROJ/UcsaGodot.csproj" --nologo -v quiet

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# perl's alarm survives exec, so a hung engine is killed after TIMEOUT_SECS (exit code 142).
set +e
perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' "$TIMEOUT_SECS" "$GODOT" --headless --path "$PROJ" >"$LOG" 2>&1
rc=$?
set -e
cat "$LOG"

if [ "$rc" -ne 0 ]; then
  echo "godot smoke: FAILED (exit code $rc; 142 means the ${TIMEOUT_SECS}s timeout fired)"
  exit 1
fi
if ! grep -qx "$PASS_LINE" "$LOG"; then
  echo "godot smoke: FAILED (exit code 0 but no '$PASS_LINE' line in the output)"
  exit 1
fi
echo "godot smoke: ok"
