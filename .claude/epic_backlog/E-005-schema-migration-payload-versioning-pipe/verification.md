---
title: "Schema Migration & Payload Versioning Pipeline"
id: E-005
---

# How we will know E-005 works

## Assertions

1. An unversioned SQLite database created by UCSA v1.4 is opened by `SqliteAdapter` in TypeScript, Dart, or C#, immediately upgraded to `user_version = 1`, and all pre-existing queries, tags, outbox mutations, and CAS records are preserved with 100% data integrity.
2. Opening a database whose `user_version` is newer than the binary's supported version throws a typed `DatabaseVersionTooNewError` and aborts without executing writes.
3. If any migration step fails mid-execution, the entire transaction rolls back cleanly, leaving `user_version` and table schemas at the previous clean state.
4. When `payload_version` is enabled, an entry stored at version 1 is upgraded to version 2 on read through the registered `upcast` transformer, and rewritten to SQLite with `payload_version = 2`.
5. An un-upgradable query entry is selectively evicted and triggers a `payload-evicted` event, while pending outbox mutations are never dropped and transition to `failed` status with a salvage file created on error.
