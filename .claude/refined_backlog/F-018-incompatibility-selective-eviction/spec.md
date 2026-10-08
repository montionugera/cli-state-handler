---
title: "incompatibility-selective-eviction"
id: F-018
status: refined
from_idea: I-018
---

# incompatibility-selective-eviction

## Outcome

When cached queries cannot be upcasted to the application's target payload version or suffer unrecoverable payload deserialization errors, UCSA selectively evicts only the incompatible cache entries rather than crashing or purging valid cache data. Crucially, the offline mutation outbox (`ucsa_mutation_outbox`) and content-addressable storage are isolated and fully salvaged, guaranteeing zero loss of pending mutations. The CLI provides a dedicated `ucsa migrate` command suite for inspecting schema versions, running pending migrations, and purging incompatible payloads.

## Acceptance criteria

- [ ] `IncompatiblePayloadError` is defined and thrown when a payload cannot be upcasted (missing upcaster, invalid intermediate state, or malformed JSON).
- [ ] Selective Eviction in `QueryEngine`: on encountering an un-upcastable or corrupt cached entry during read (`getQueryData`, `fetchQuery`, `useQuery`), `QueryEngine` catches the error, deletes only that specific query entry from SQLite and in-memory cache, notifies optional `onIncompatiblePayload` telemetry callback, and transparently falls back to network refetch (or returns undefined for synchronous read) without crashing the process.
- [ ] Outbox Salvage Protection: selective eviction and schema migrations strictly guarantee that zero rows in `ucsa_mutation_outbox` are ever modified, cleared, or dropped during eviction operations. Outbox salvage tests verify pending mutations survive corrupted query cache states.
- [ ] CLI `ucsa migrate status`: reports current `user_version`, latest migration target, list of applied migrations with checksums and timestamps, and list of pending migrations.
- [ ] CLI `ucsa migrate up`: executes any pending migrations in `contracts/migrations/` sequentially and reports the upgraded `user_version`.
- [ ] CLI `ucsa migrate check`: verifies schema integrity, returning exit code 0 if up-to-date and 1 if migrations are pending.
- [ ] CLI `ucsa migrate clean-incompatible`: scans `ucsa_query_cache`, validates payload parsing and upcasting against registered schemas, deletes incompatible entries, prints summary of purged entries, and verifies zero outbox mutations touched.
- [ ] Full chain & cross-platform verification: all test suites across TypeScript, Dart, Flutter, and C# Unity pass cleanly with 100% success.
