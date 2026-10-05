---
title: "CAS Package Cache"
id: I-003
status: idea
---

# CAS Package Cache

## Acceptance criteria

- [ ] Implement `CasStore` using SHA-256 content-addressable storage under `<casDir>/objects/<hash_prefix>/<full_hash>`.
- [ ] Atomic file writing: writes to `<casDir>/tmp/<uuid>.tmp`, validates SHA-256 checksum, and atomically renames to the destination path.
- [ ] Integrity check: Rejects corrupted byte streams when actual SHA-256 does not match expected hash.
- [ ] Explicit access time tracking: touching `mtime` and recording `last_accessed_at` in SQLite index `ucsa_cas_objects`.
- [ ] LRU size budget pruning: when storage exceeds `maxSizeBytes` (e.g. 90%), prunes oldest unaccessed files down to 70%.
- [ ] Unit tests pass in Vitest validating atomic writes, checksum verification, LRU pruning, and concurrency.
