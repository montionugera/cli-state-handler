# Feature F-018: Incompatibility Selective Eviction & Migration CLI

> **For agentic workers:** Implement this plan phase-by-phase using strict TDD (write tests first -> watch them fail -> implement minimal code -> verify tests pass).

**Goal:** Implement selective cache eviction for un-upcastable or corrupted queries with zero outbox mutation loss, build the CLI `ucsa migrate` command suite, ensure cross-platform parity, verify full chain, and promote Release 1.5.

---

## Tasks

### Task 1: Core Selective Eviction & Outbox Salvage Protection
- [x] Define `IncompatiblePayloadError` in `packages/core/src/query/payload-upcaster.ts`.
- [x] Update `QueryEngine` in `packages/core/src/query/query-engine.ts`:
  - Add optional `onIncompatiblePayload?: (err: Error, entry: CacheEntry) => void` to `QueryEngineOptions`.
  - Handle payload decoding / upcasting errors during cache read (`getQueryData`, `fetchQuery`, `useQuery`).
  - Selectively evict only the failed entry from SQLite and in-memory cache without purging valid entries.
  - Fall back to network fetch on `fetchQuery` and `useQuery`, or `undefined` on `getQueryData`.
  - Guarantee that `ucsa_mutation_outbox` is completely untouched and preserved during eviction.
- [x] Write unit and integration tests in `packages/core/tests/query/selective-eviction.test.ts`.
- [x] Verify `pnpm test` passes in `packages/core`.
- [x] Commit: `feat(query): implement selective cache eviction and outbox salvage protection`.

### Task 2: CLI `ucsa migrate` Command Suite
- [x] Implement `apps/cli/src/commands/migrate.ts`:
  - `status`: reports current `user_version`, target version, applied list, and pending migrations.
  - `up`: applies all pending migrations using `MigrationRunner`.
  - `check`: exits 0 if schema is up to date, 1 if migrations are pending.
  - `clean-incompatible`: scans `ucsa_query_cache`, selectively evicts entries that cannot be upcasted, validates outbox count is untouched, and prints summary report.
- [x] Register `migrate` in `apps/cli/src/router.ts` and `apps/cli/bin/ucsa.ts`.
- [x] Write unit tests in `apps/cli/tests/migrate-command.test.ts`.
- [x] Verify `pnpm test` in `apps/cli`.
- [x] Commit: `feat(cli): implement ucsa migrate command suite`.

### Task 3: Cross-Platform Parity & Documentation
- [x] Update `packages/ucsa_dart`:
  - Add graceful selective eviction in `QueryEngine` on corrupted or non-upcastable cache records.
  - Add test in `packages/ucsa_dart/test/query_engine_test.dart`.
- [x] Update `packages/com.ucsa.unity`:
  - Add graceful selective eviction in `QueryEngine` on corrupted cache records.
  - Add test in `packages/com.ucsa.unity/Tests/Runtime/QueryEngineTests.cs`.
- [x] Update `README.md`:
  - Add Section 7 documenting Selective Cache Eviction & Outbox Salvage Protection.
  - Document `ucsa migrate` subcommands with CLI examples.
  - Synchronize cross-platform test and feature matrix tables.
- [x] Commit: `feat(parity): implement cross-platform selective eviction and update docs`.

### Task 4: Full-Chain E2E Verification & Promotion
- [x] Run `./scripts/precheck.sh` (Gate 1).
- [x] Run `./scripts/integration.sh` (Gate 2).
- [x] Run `./scripts/e2e-full-chain.sh` (All 5 phases).
- [x] Update `plan.md` checking off all tasks.
- [ ] Ship via `psrw ship`.
- [ ] Promote release 1.5 via `psrw promote --direct`.
