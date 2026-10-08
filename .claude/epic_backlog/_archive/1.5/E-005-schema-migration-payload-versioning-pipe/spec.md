---
title: "Schema Migration & Payload Versioning Pipeline"
id: E-005
status: epic
---

# Schema Migration & Payload Versioning Pipeline

## Outcome

The SQLite database file format is governed by a version number (`PRAGMA user_version`), an immutable migration log table (`ucsa_migrations`), and language-neutral SQL files in `contracts/migrations/`. 

Opening any database file upgrades it deterministically to the target version or fails with an explicit error before any query runs. Opening an unversioned v1.4 database preserves every row without corruption. Cached query payloads carry a `payload_version` and are upgraded on-read through a pure function pipeline, while un-migratable cache queries are selectively evicted without ever dropping pending outbox mutations.

## Slices

1. `I-015` -> `F-015`: `schema-migration-engine` — Migration runner, `PRAGMA user_version = 1`, `ucsa_migrations` tracking table, `contracts/migrations/0001_baseline.sql`, atomic transactions and checksum verification in TypeScript.
2. `I-016` -> `F-016`: `cross-language-migration-parity` — Dart `package:sqlite3` and C# `Microsoft.Data.Sqlite` migration runners conforming to `contracts/` and verified with cross-language database fixtures.
3. `I-017` -> `F-017`: `payload-versioning-pipeline` — Multi-version payload transformer pipeline (`upcast()` on read), `payload_version` column (`0002_payload_version.sql`), and write-back on read.
4. `I-018` -> `F-018`: `incompatibility-selective-eviction` — Selective cache eviction for un-upcastable queries, outbox salvage protection, and CLI `ucsa migrate` command.
