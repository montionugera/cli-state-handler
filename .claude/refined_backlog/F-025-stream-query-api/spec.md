---
title: "stream-query-api"
id: F-025
status: refined
from_idea: I-025
---

# stream-query-api

## Acceptance criteria

- [ ] `QueryEngine.streamQuery()` returns `StreamHandle` implementing `AsyncIterable<StreamSlice>`.
- [ ] `StreamSlice` contains delta text, cumulative text, sequence number, byte offset, and completion flag.
- [ ] Streaming UTF-8 decoder buffers incomplete multi-byte code points so no corrupted characters are emitted.
- [ ] `StreamHandle.done` resolves to full completed string or Buffer payload.
- [ ] Cancellation via `AbortSignal` or `StreamHandle.cancel()` aborts source stream and marks stream as `aborted`.
- [ ] CLI command `ucsa stream <key>` streams real-time chunks to stdout with live stats.
