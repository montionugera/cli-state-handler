# F-003: CAS Package Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Content-Addressable Storage (CAS) for package binaries and heavy assets with SHA-256 integrity verification, atomic file writes, explicit access time tracking, and LRU disk quota eviction.

**Architecture:** `CasStore` writes byte buffers or streams to a temporary file (`<casDir>/tmp/<uuid>.tmp`), verifies SHA-256 checksums, and atomically renames to `<casDir>/objects/<prefix>/<hash>`. Access times are recorded in SQLite table `ucsa_cas_objects` and file `mtime` is touched. When total size exceeds `maxSizeBytes` (90% high watermark), an LRU worker prunes the oldest unaccessed objects down to 70%.

**Tech Stack:** TypeScript (ESM), Node.js `node:crypto`, `node:fs/promises`, SQLite (`SqliteAdapter`), Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md`](file:///Users/pasitnusso/workspace/repos/cli-state-handler/docs/superpowers/specs/2026-10-05-unified-state-architecture-design.md)

## Global Constraints

- **Atomic Writes:** Files must never be written directly to their target content-addressed path; writes must land in `<casDir>/tmp/` and atomically rename.
- **Checksum Integrity:** If the computed SHA-256 hash does not match the expected hash, the file must be removed and an `IntegrityError` thrown.
- **Access Tracking:** Because filesystem `atime` is disabled/throttled on modern OS mounts, access tracking must update SQLite `ucsa_cas_objects.last_accessed_at` and touch `mtime`.

---

## Tasks

### Task 1: CAS Store, Atomic Writes & Checksum Verification
**Files:**
- Create: `packages/core/src/storage/cas-store.ts`
- Test: `packages/core/tests/storage/cas.test.ts`

- [ ] Write unit tests in `packages/core/tests/storage/cas.test.ts`:
  - Store buffer -> returns computed SHA-256 hash.
  - Object stored under `<casDir>/objects/<hash[0..2]>/<hash>`.
  - Content integrity: store with expected hash succeeds if matching; throws `IntegrityError` and cleans up temp file if mismatch.
  - Retrieve buffer: `read(hash)` returns exact stored Buffer/Uint8Array.
  - Exists check: `has(hash)` returns boolean.
- [ ] Implement `CasStore` in `packages/core/src/storage/cas-store.ts`:
  - Constructor takes `{ baseDir: string, sqliteAdapter?: SqliteAdapter, maxSizeBytes?: number }`.
  - Methods: `put(data: Buffer | Uint8Array, expectedHash?: string): Promise<{ hash: string, size: number, path: string }>`, `get(hash: string): Promise<Buffer | null>`, `has(hash: string): Promise<boolean>`, `delete(hash: string): Promise<boolean>`.
- [ ] Export `CasStore` from `packages/core/src/index.ts`.
- [ ] Run `pnpm test` and verify all tests pass.
- [ ] Commit: `feat(storage): implement CAS store with atomic writes and integrity checks`.

### Task 2: Explicit Access Tracking & LRU Disk Quota Pruning
**Files:**
- Create: `packages/core/src/storage/cas-lru.ts`
- Test: `packages/core/tests/storage/cas-lru.test.ts`

- [ ] Write tests in `packages/core/tests/storage/cas-lru.test.ts`:
  - Reading an object updates `last_accessed_at` in SQLite and touches `mtime`.
  - When total disk usage exceeds high watermark (e.g. 90%), `prune()` purges the least recently accessed objects until total size drops to target (70%).
  - Ensure unpruned items remain intact and readable.
- [ ] Implement LRU index table `ucsa_cas_objects (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, last_accessed_at INTEGER NOT NULL)` in `sqlite-adapter.ts` or `cas-lru.ts`.
- [ ] Implement `prune()` method in `CasStore`.
- [ ] Run `pnpm test` and verify 100% pass rate.
- [ ] Commit: `feat(storage): implement explicit access tracking and LRU size pruning`.

### Task 3: Verification Gate & Precheck
**Files:**
- Test: `packages/core/tests/storage/cas.test.ts`
- Modify: `README.md`

- [ ] Run full test suite: `pnpm test`.
- [ ] Update `README.md` with CAS Package Cache usage, atomic writes, and LRU pruning documentation.
- [ ] Run `./scripts/precheck.sh` and ensure Gate 1 passes cleanly (`Gate 1: ok`).
- [ ] Commit: `chore(release): verify Gate 1 precheck for F-003`.
