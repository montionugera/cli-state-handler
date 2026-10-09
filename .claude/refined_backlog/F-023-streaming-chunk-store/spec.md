---
title: "streaming-chunk-store"
id: F-023
status: refined
from_idea: I-023
---

# streaming-chunk-store

## Acceptance criteria

- [ ] Schema migration v4 creates `ucsa_streams`, `ucsa_stream_chunks`, and `ucsa_stream_tags` with SQLite foreign key cascade deletions.
- [ ] `SqliteAdapter.createStream()` initializes stream row with `status = 'open'`, `next_seq = 0`, and `byte_length = 0`.
- [ ] `SqliteAdapter.appendStreamChunk()` inserts binary chunk with contiguous `seq` and validated `byte_offset`.
- [ ] Coalesced chunk flushing batches incoming pieces up to 4KB or 50ms before writing to SQLite.
- [ ] `SqliteAdapter.compactStream()` concatenates all chunks, moves tags, deletes stream row, and inserts completed payload into `ucsa_query_cache` (or `CasStore` if > 1MB) atomically.
- [ ] Foreign key cascade deletes remove all chunks when stream is deleted or aborted.
