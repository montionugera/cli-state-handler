---
title: "multiplatform-tutorial-docs"
id: F-014
status: refined
from_idea: I-014
---

# multiplatform-tutorial-docs

## Summary

Complete the multi-platform documentation and tutorial experience with:
1. **Interactive Multi-Platform Tutorial Switcher** (`<MultiPlatformDocs />`):
   - Side-by-side or tabbed walkthrough comparing TypeScript Core, Dart 3+, and C# Unity code snippets for every UCSA concept:
     - QueryEngine & SWR
     - Selector Observer & Re-render suppression
     - CAS Storage & LRU quota
     - Mutation Outbox & Conflict Resolution
     - Timing Controls (Throttle, Debounce, Rate-limit)
   - "Copy Code" button and runnable interactive sandbox where applicable.
2. **CLI Launcher Integration**:
   - `ucsa tutorial` and `ucsa docs` command in `apps/cli`.
   - Supports `--port <number>` (default 6006, silently falling back to 6007 on collision per Rule 6).
   - Supports `--host <string>` and `--open` flag.
   - Launches the local documentation Vite server directly or opens the browser.
3. **Full-Chain & Gate Integration**:
   - Update `scripts/e2e-full-chain.sh` with docs build and smoke test verification.
   - Update `README.md` with comprehensive tutorial guide, screenshots, and live documentation commands.
   - Verify Gate 1 (`precheck.sh`) and Gate 2 (`integration.sh`).

## Acceptance criteria

- [ ] `<MultiPlatformDocs />` provides interactive syntax-highlighted code comparisons across TypeScript, Dart, and C# Unity.
- [ ] Storybook-like navigation drawer allows switching between all playgrounds (SWR, Timing, Outbox, CAS, Multi-Platform Tutorial).
- [ ] `ucsa tutorial` and `ucsa docs` subcommands in `apps/cli` start or display the documentation app with port collision fallback.
- [ ] Unit tests in `apps/cli/tests/router.test.ts` and `apps/cli/tests/tutorial-command.test.ts` pass.
- [ ] `README.md` updated with tutorial walkthrough and `apps/docs` details.
- [ ] `./scripts/e2e-full-chain.sh` completes cleanly across all tiers.
- [ ] Gate 1 and Gate 2 pass cleanly.
