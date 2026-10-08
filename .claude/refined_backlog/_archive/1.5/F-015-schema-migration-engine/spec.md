---
title: "schema-migration-engine"
id: F-015
status: refined
from_idea: I-015
---

# schema-migration-engine

## Acceptance criteria

- [ ] Directory `contracts/migrations/` is created containing `0001_baseline.sql` and `manifest.json`.
- [ ] Migration runner in `packages/core/src/storage/migration-runner.ts` inspects `PRAGMA user_version`.
- [ ] If `user_version == 0`, creates `ucsa_migrations` tracking table, applies pending migrations sequentially inside a transaction, records SHA-256 checksums, and updates `PRAGMA user_version = 1`.
- [ ] If a migration statement throws an error, the transaction rolls back cleanly, leaving `user_version` and schemas unchanged.
- [ ] Opening a database file with `user_version > TARGET_VERSION` throws `DatabaseVersionTooNewError`.
- [ ] An unversioned UCSA v1.4 database with populated queries, tags, outbox items, and CAS objects is upgraded cleanly to version 1 with zero data loss.
- [ ] `SqliteAdapter.initSchema()` delegates to the migration runner.
