# Feature F-014: Multi-Platform Tutorial Docs & CLI Tutorial Launcher

> **For agentic workers:** Implement this plan phase-by-phase using strict TDD (write tests first -> watch them fail -> implement minimal code -> verify tests pass).

**Goal:** Implement `<MultiPlatformDocs />` in `apps/docs` comparing TypeScript, Dart, and C# Unity side-by-side, integrate `ucsa tutorial` and `ucsa docs` CLI launcher in `apps/cli` with port collision fallback, update `README.md` and `scripts/e2e-full-chain.sh`, and verify full chain.

---

## Tasks

### Task 1: Multi-Platform Interactive Code Tutorial Component
- [x] Implement `apps/docs/src/components/MultiPlatformDocs.tsx`:
  - Interactive platform switcher (TypeScript Core, Dart 3+, C# Unity).
  - 5 core UCSA architecture concept walkthroughs:
    1. SWR Query Engine & Caching
    2. Zero-Rebuild State Observer
    3. Observer Throttling & Query Debouncing
    4. Offline Mutation Outbox & Rate-Limiting
    5. Content-Addressable Storage (CAS) with LRU Pruning
  - Copy to clipboard button, syntax styling, and platform-specific feature notes.
- [x] Wire `<MultiPlatformDocs />` into `apps/docs/src/App.tsx`.
- [x] Write unit tests in `apps/docs/tests/multiplatform-docs.test.tsx`.

### Task 2: CLI Tutorial & Docs Launcher
- [x] Implement `apps/cli/src/commands/tutorial.ts`:
  - `runTutorial(options: { port?: number, host?: string, open?: boolean, dryRun?: boolean })`:
    - Checks port availability or uses port collision fallback (6006 -> 6007 per Rule 6).
    - Supports dry-run testing mode returning resolved configuration.
- [x] Update `apps/cli/src/router.ts` and `apps/cli/bin/ucsa.ts` to route `tutorial` and `docs` subcommands.
- [x] Write unit tests in `apps/cli/tests/tutorial-command.test.ts`.

### Task 3: Full-Chain E2E Runner & Documentation
- [x] Update `scripts/e2e-full-chain.sh` to include `apps/docs` build and test verification in the full chain runner.
- [x] Update `README.md` documenting:
  - `apps/docs` interactive Storybook-like tutorial app.
  - CLI launcher `ucsa tutorial` / `ucsa docs`.
  - Comprehensive feature matrix and updated test counts across all 4 platforms/apps.

### Task 4: Verification Gate & Commit
- [x] Run `./scripts/precheck.sh` (Gate 1).
- [x] Run `./scripts/integration.sh` (Gate 2).
- [x] Run `./scripts/e2e-full-chain.sh` (5-phase E2E runner).
- [x] Update `plan.md` checking off all tasks.
- [x] Commit: `feat(docs): implement multiplatform tutorial and CLI launcher` on branch `feat/F-014`.
