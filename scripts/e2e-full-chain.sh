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
echo ">>> [Phase 1/4] TypeScript Core & Transport Engine (packages/core)"
echo "    Testing: BFF ETag 304 | SWR Engine | SQLite WAL | CAS SHA-256 | WS Push | Outbox"
pnpm test packages/core/tests/e2e/full-chain.test.ts
echo "    ✓ TypeScript Core full-chain passed cleanly."
echo ""

# ------------------------------------------------------------------------------
# Phase 2: Interactive Terminal CLI POC (apps/cli) Live Execution
# ------------------------------------------------------------------------------
echo ">>> [Phase 2/4] Interactive Node/TS CLI Live Full Chain (apps/cli)"
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

echo "    6. Outbox Replay (Conflict Policy Resolution):"
node apps/cli/bin/ucsa.js outbox replay --db "$CLI_DB" --policy client-wins

echo "    7. Status Inspection:"
node apps/cli/bin/ucsa.js status --db "$CLI_DB" --casDir "$CLI_CAS"

echo "    8. Durability Checkpoint (PRAGMA wal_checkpoint TRUNCATE on exit):"
node apps/cli/bin/ucsa.js durability --db "$CLI_DB"
echo "    ✓ Interactive CLI live full-chain passed cleanly."
echo ""

# ------------------------------------------------------------------------------
# Phase 3: Dart 3+ / Flutter Reference Package (packages/ucsa_dart)
# ------------------------------------------------------------------------------
echo ">>> [Phase 3/4] Dart 3+ Reference Engine Full Chain (packages/ucsa_dart)"
echo "    Testing: Sealed FSM | SQLite WAL | CAS SHA-256 | Zero-Rebuild Stream Observer"
(cd packages/ucsa_dart && dart test test/e2e_full_chain_test.dart)
echo "    ✓ Dart full-chain passed cleanly."
echo ""

# ------------------------------------------------------------------------------
# Phase 4: C# Unity Engine Package (packages/com.ucsa.unity)
# ------------------------------------------------------------------------------
echo ">>> [Phase 4/4] C# Unity Engine Reference Engine Full Chain (packages/com.ucsa.unity)"
echo "    Testing: SWR QueryEngine | Zero-Alloc Observer | TextureCache | Mobile Pause Durability"
dotnet test packages/com.ucsa.unity/Tests/Ucsa.Unity.Tests.csproj --filter "FullyQualifiedName~E2EFullChainTests"
echo "    ✓ C# Unity full-chain passed cleanly."
echo ""

END_TOTAL=$(date +%s)
TOTAL_TIME=$((END_TOTAL - START_TOTAL))

echo "================================================================================"
echo "    FULL CHAIN COMPLETE - 100% VERIFIED ACROSS ALL 4 TIERS ($TOTAL_TIME seconds)"
echo "================================================================================"
