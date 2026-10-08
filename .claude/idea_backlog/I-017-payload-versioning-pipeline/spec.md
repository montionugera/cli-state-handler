---
title: "payload-versioning-pipeline"
id: I-017
status: idea
---

# payload-versioning-pipeline

## Outcome

`ucsa_query_cache` records carry a `payload_version` tracking their entity format version. Queries read from local storage with older payload versions are upgraded on-the-fly through a registered pure upcaster transformation pipeline (`v1 -> v2 -> ... -> targetVersion`) and written back to SQLite, preventing application decoding errors across client software upgrades.

## Acceptance criteria

- [ ] `contracts/migrations/0002_payload_version.sql` adds column `payload_version INTEGER NOT NULL DEFAULT 1` and index `idx_ucsa_cache_payload_version` to `ucsa_query_cache`, and `manifest.json` tracks version 2 with its SHA-256 checksum.
- [ ] Running migrations against an existing v1 database advances `PRAGMA user_version` to 2, records version 2 in `ucsa_migrations`, and preserves all existing rows with default `payload_version = 1`.
- [ ] `PayloadRegistry` supports registering version transformers for query key patterns: `register(prefix, fromVersion, toVersion, upcasterFn)`.
- [ ] Chained upcasting: a payload stored at version 1 with registered transformers `v1 -> v2` and `v2 -> v3` is elevated to version 3 in sequential order.
- [ ] On-read write-back: when `QueryEngine.fetchQuery` or `QueryEngine.getQueryData` reads a cached entry with an older `payload_version`, it returns the upgraded payload and updates the database with the upgraded JSON and new `payload_version`.
- [ ] Round-robin cross-language migration parity: Dart and C# migration runners support migrating to schema version 2 cleanly without data loss.
