---
title: "resumable-streaming-strategies"
id: F-024
status: refined
from_idea: I-024
---

# resumable-streaming-strategies

## Acceptance criteria

- [ ] HTTP Range resume strategy builds `Range: bytes=<byte_length>-` and `If-Range: <etag>` headers.
- [ ] SSE `last-event-id` resume strategy tracks latest event ID and passes `Last-Event-ID` on reconnection.
- [ ] Application `continuation` strategy passes committed stream text to application callback to construct continuation prompt.
- [ ] Full `restart` strategy resets stream to sequence 0, purges existing chunks, and emits slice with `reset: true`.
- [ ] Resume state machine transitions between `open`, `error`, `aborted`, and resumes without duplicating text chunks.
