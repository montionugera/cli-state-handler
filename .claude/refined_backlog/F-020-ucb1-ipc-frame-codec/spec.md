---
title: "ucb1-ipc-frame-codec"
id: F-020
status: refined
from_idea: I-020
---

# ucb1-ipc-frame-codec

## Acceptance criteria

- [ ] Fixed 12-byte header encoding and decoding: ASCII `UCB1`, 1-byte type, 1-byte flags, 2-byte reserved, 4-byte big-endian length.
- [ ] Round-trip encoding and decoding for all frame types: `HELLO`, `WELCOME`, `SUBSCRIBE`, `UNSUBSCRIBE`, `PUBLISH`, `EVENT`, `PING`, `PONG`, `RESYNC`, `BYE`, and `ERROR`.
- [ ] Streaming split-frame buffer reassembly handles chunks split across arbitrary byte boundaries and batches containing multiple contiguous frames.
- [ ] Throws typed errors on invalid magic bytes, non-zero reserved flags, payloads exceeding 1MB (1,048,576 bytes), or invalid JSON.
- [ ] Conformance vectors verify binary wire compatibility with identical outputs for test fixtures.
