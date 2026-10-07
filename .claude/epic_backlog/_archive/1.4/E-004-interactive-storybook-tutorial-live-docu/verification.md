---
title: "Interactive Storybook Tutorial & Live Documentation System"
id: E-004
---

# How we will know E-004 works

Prose for humans. `scripts/epic-check.sh` implements these assertions; the
toolkit never parses this file.

## Assertions

1. `apps/docs` builds cleanly via `pnpm --filter @ucsa/docs build` producing client bundle artifacts.
2. `apps/docs` component tests pass via `pnpm --filter @ucsa/docs test`, verifying that:
   - SWR Playground correctly updates query status, displays stale cache while revalidating, and reflects structural equality diffs.
   - Timing Controls Playground correctly calculates and visually represents render counts under throttled/debounced conditions.
   - Outbox Simulator handles pending mutations, conflict resolution policies, and network status toggles.
3. `ucsa tutorial` and `ucsa docs` subcommands in `apps/cli` are registered and parse command line options (port, host, open).
4. `README.md` documents the live documentation app, launch instructions (`pnpm dev:docs` / `ucsa tutorial`), and interactive playgrounds.
5. Gate 1 (`./scripts/precheck.sh`), Gate 2 (`./scripts/integration.sh`), and the full chain runner (`./scripts/e2e-full-chain.sh`) pass 100% across all tiers.
