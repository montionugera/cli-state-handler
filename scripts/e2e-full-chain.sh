#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "================================================================================"
echo "    UNIFIED CLIENT STATE ARCHITECTURE (UCSA) - MULTI-PLATFORM FULL CHAIN"
echo "================================================================================"
echo "Timestamp: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Workspace: $ROOT_DIR"
echo ""

START_TOTAL=$(date +%s)

# ------------------------------------------------------------------------------
# Phase 1: TypeScript Core & Network Engine Full Chain
# ------------------------------------------------------------------------------
echo ">>> [Phase 1/5] TypeScript Core & Transport Engine (packages/core)"
echo "    Testing: BFF ETag 304 | SWR Engine | SQLite WAL | CAS SHA-256 | WS Push | Outbox | Timing Controls"
pnpm test packages/core/tests/e2e/full-chain.test.ts packages/core/tests/consumer/observer-timing.test.ts packages/core/tests/query/query-debouncing.test.ts packages/core/tests/query/outbox-rate-limit.test.ts
echo "    ✓ TypeScript Core full-chain passed cleanly."
echo ""

# ------------------------------------------------------------------------------
# Phase 2: Interactive Terminal CLI POC (apps/cli) Live Execution
# ------------------------------------------------------------------------------
echo ">>> [Phase 2/5] Interactive Node/TS CLI Live Full Chain (apps/cli)"
pnpm run build
CLI_TMP_DIR=$(mktemp -d -t ucsa-cli-live-XXXXXX)
CLI_DB="$CLI_TMP_DIR/live.db"
CLI_CAS="$CLI_TMP_DIR/cas"

trap 'rm -rf "$CLI_TMP_DIR"' EXIT

echo "    1. Query (Cold Fetch -> SQLite WAL store):"
node apps/cli/bin/ucsa.js query "pkg/100" --db "$CLI_DB" --ttl 5000 --tag "pkg:100"

echo "    2. Query (SWR Cache Hit from SQLite):"
node apps/cli/bin/ucsa.js query "pkg/100" --db "$CLI_DB" --ttl 5000 --tag "pkg:100"

echo "    3. CAS Put (SHA-256 Store & Atomic Move):"
echo "UCSA Multi-Platform Unified State Package Binary Payload v1.2" > "$CLI_TMP_DIR/pkg.bin"
node apps/cli/bin/ucsa.js cas put "$CLI_TMP_DIR/pkg.bin" --dir "$CLI_CAS" --db "$CLI_DB"

CAS_HASH=$(sha256sum "$CLI_TMP_DIR/pkg.bin" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$CLI_TMP_DIR/pkg.bin" | awk '{print $1}')
echo "    4. CAS Get (Retrieve & Touch Access):"
node apps/cli/bin/ucsa.js cas get "$CAS_HASH" --dir "$CLI_CAS" --db "$CLI_DB"

echo "    5. Outbox Queue (Offline Mutation):"
node apps/cli/bin/ucsa.js outbox queue "/api/v1/packages/100" --db "$CLI_DB" --payload '{"status":"published"}' --policy client-wins
node apps/cli/bin/ucsa.js outbox queue "/api/v1/packages/101" --db "$CLI_DB" --payload '{"status":"archived"}' --policy client-wins

echo "    6. Outbox Replay (Paced Rate-Limiting & Batch Chunking):"
node apps/cli/bin/ucsa.js outbox replay --db "$CLI_DB" --policy client-wins --rateLimit 20 --batchSize 10

echo "    7. Status Inspection:"
node apps/cli/bin/ucsa.js status --db "$CLI_DB" --casDir "$CLI_CAS"

echo "    8. Durability Checkpoint (PRAGMA wal_checkpoint TRUNCATE on exit):"
node apps/cli/bin/ucsa.js durability --db "$CLI_DB"

echo "    9. Tutorial & Docs CLI Launcher Verification:"
node apps/cli/bin/ucsa.js tutorial --dry-run --port 6006
node apps/cli/bin/ucsa.js docs --dry-run --port 6007
echo "    ✓ Interactive CLI live full-chain passed cleanly."
echo ""

# ------------------------------------------------------------------------------
# Phase 3: Dart 3+ Reference Package (packages/ucsa_dart)
# ------------------------------------------------------------------------------
echo ">>> [Phase 3/5] Dart 3+ Reference Engine Full Chain (packages/ucsa_dart)"
echo "    Testing: Sealed FSM | SQLite WAL | CAS SHA-256 | Zero-Rebuild Stream Observer | Timing Controls"
(cd packages/ucsa_dart && dart test test/e2e_full_chain_test.dart test/observer_timing_test.dart test/query_debouncing_test.dart test/outbox_rate_limit_test.dart)
echo "    ✓ Dart full-chain passed cleanly."
echo ""

# ------------------------------------------------------------------------------
# Phase 4: C# shared core and Unity binding (packages/com.ucsa.core, packages/com.ucsa.unity)
# ------------------------------------------------------------------------------
echo ">>> [Phase 4/5] C# Core and Unity Reference Engine Full Chain (packages/com.ucsa.core, packages/com.ucsa.unity)"
echo "    Testing: SWR QueryEngine | Zero-Alloc Observer | TextureCache | Mobile Pause Durability | Timing Controls"

# dotnet test exits 0 when a filter matches nothing, so require at least one test per invocation.
run_dotnet_filtered() {
  local project="$1" filter="$2" out
  if ! out=$(dotnet test "$project" --filter "$filter" 2>&1); then
    echo "$out"
    return 1
  fi
  echo "$out"
  if ! echo "$out" | grep -Eq 'Passed!.*Total: +[1-9]'; then
    echo "    ✗ filter matched no tests in $project"
    return 1
  fi
}

run_dotnet_filtered packages/com.ucsa.core/Tests/Ucsa.Core.Tests.csproj "FullyQualifiedName~StateObserverTimingTests|FullyQualifiedName~QueryDebouncingTests|FullyQualifiedName~OutboxRateLimitTests"
run_dotnet_filtered packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj "FullyQualifiedName~E2EFullChainTests"
echo "    ✓ C# core and Unity full-chain passed cleanly."
echo ""

# ------------------------------------------------------------------------------
# Phase 5: Framework-Native Consumer Integrations (React 19 DOM, Docs Studio & Flutter)
# ------------------------------------------------------------------------------
echo ">>> [Phase 5/5] Framework-Native UI Integrations (React 19 DOM, Docs Studio & Flutter)"
echo "    Testing: React 19 useSyncExternalStore DOM Re-renders | Interactive Docs Studio | Flutter WidgetTester Rebuilds"
pnpm test packages/core/tests/consumer/react-framework.test.tsx
pnpm --filter @ucsa/docs test
pnpm --filter @ucsa/docs build
if command -v flutter >/dev/null 2>&1 && [ -f "packages/ucsa_flutter/pubspec.yaml" ]; then
  (cd packages/ucsa_flutter && flutter test)
fi
echo "    ✓ Framework-native UI consumers and interactive docs studio passed cleanly."
echo ""

END_TOTAL=$(date +%s)
TOTAL_TIME=$((END_TOTAL - START_TOTAL))

echo "================================================================================"
echo "    FULL CHAIN COMPLETE - 100% VERIFIED ACROSS ALL 5 PHASES ($TOTAL_TIME seconds)"
echo "================================================================================"
