---
title: "Core Contracts & SQLite Schema"
id: F-001
status: refined
from_idea: I-001
---

# Core Contracts & SQLite Schema

## Acceptance criteria

- [ ] Core TypeScript types defined for QueryKey, QueryState, CacheEntry, OutboxMutation, and TransportAdapter.
- [ ] SQLite persistence engine creates tables `ucsa_query_cache`, `ucsa_cache_tags`, and `ucsa_mutation_outbox` with explicit `TEXT NOT NULL` column types.
- [ ] SQLite sets `PRAGMA busy_timeout = 5000;` and defaults to `PRAGMA journal_mode = WAL;` (with MEMORY fallback on Web).
- [ ] Secondary index join table `ucsa_cache_tags` supports tag-based invalidations with cascade deletion on query eviction.
- [ ] Unit tests pass in Vitest covering table creation, numeric array keys, and WAL persistence.
