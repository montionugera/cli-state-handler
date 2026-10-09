---
title: "Generative AI & LLM Token Streaming Engine"
id: E-007
---

# How we will know E-007 works

## Assertions

1. **Schema Migration v4 Integrity:** Database migrates cleanly to `user_version = 4`, creating `ucsa_streams`, `ucsa_stream_chunks`, and `ucsa_stream_tags` with foreign keys and cascade deletions.
2. **Chunk Store Sequence & Offset Invariants:** Sequential appended chunks preserve monotonic `seq` (0, 1, 2, ...) and exact byte offsets (`byte_offset[n] == sum(len(chunks[0..n-1]))`).
3. **Atomic Compaction:** Upon stream completion, all chunks are concatenated and stored into `ucsa_query_cache` (or CAS if >1MB) in a single atomic transaction while cleaning up `ucsa_streams` rows without orphan data.
4. **Resumable Streaming Recovery:** Dropped streams reconnect and resume seamlessly using HTTP Range requests (`bytes=<offset>-`) or SSE `Last-Event-ID` without duplicated text.
5. **Streaming Query Ergonomics:** `streamQuery()` streams incremental text chunks without splitting multi-byte UTF-8 glyphs, and aborting via `AbortSignal` transitions the stream to `aborted` with all committed chunks intact.
6. **Cross-Platform Parity:** All streaming tests and benchmarks pass with 100% parity across TypeScript, Dart/Flutter, and C# Unity.
