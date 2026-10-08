# Research — payload-versioning-pipeline

## 1. Problem Statement
Schema migrations (`PRAGMA user_version` and `0001_baseline.sql`) evolve SQLite table structures, but cached query data payloads in `ucsa_query_cache.data_payload` are JSON text blobs. When consuming applications evolve their entity models (e.g. renaming `userName` to `username`, nesting `address` inside `profile`, or converting timestamps to ISO-8601 strings), cached JSON entries become stale or crash client parsers unless upgraded.

## 2. Solution: Lazy On-Read Upcasting Pipeline
Rather than performing slow batch JSON transformations across millions of SQLite rows during app startup:
1. Database schema migration adds `payload_version INTEGER NOT NULL DEFAULT 1` to `ucsa_query_cache` via `0002_payload_version.sql`.
2. When a query is read from memory or SQLite, the `QueryEngine` checks `payload_version`.
3. If `payload_version < targetVersion`, it executes a pure upcaster pipeline chaining registered transformers: `v1 -> v2 -> v3`.
4. The upgraded payload is immediately returned to the caller and written back to SQLite asynchronously, amortizing migration cost across natural query reads.
