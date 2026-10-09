# Feature F-026: Cross-Platform Streaming Parity & Release 1.7 Convergence

> **For agentic workers:** Implement this plan phase-by-phase using strict TDD (write tests first -> watch them fail -> implement minimal code -> verify tests pass).

**Goal:** Complete cross-platform streaming verification across TypeScript, Dart, and C# Unity, synchronize documentation and test tables, pass all gates and full chain, ship F-026, and promote Release 1.7 to `main`.

---

## Tasks

### Task 1: Cross-Platform Streaming Verification & Documentation Audit
- [x] Verify Dart package `ucsa_dart` streaming test suite covers all acceptance criteria.
- [x] Verify Unity package `com.ucsa.unity` streaming test suite covers all acceptance criteria.
- [x] Audit `README.md` Sections 12, 13, and 14 for complete accuracy and synchronize all test metrics table entries.
- [x] Commit: `docs(streaming): synchronize streaming architecture documentation and parity metrics`.

### Task 2: Full-Chain E2E Verification & Shipping F-026
- [x] Run `./scripts/precheck.sh` (Gate 1).
- [x] Run `./scripts/integration.sh` (Gate 2).
- [x] Run `./scripts/e2e-full-chain.sh` (All 5 tiers).
- [x] Update `plan.md` checking off all tasks.
- [x] Ship via `psrw ship`.

### Task 3: Release 1.7 Promotion to main
- [ ] Verify `release/1.7` combined branch has all E-007 commits (F-023, F-024, F-025, F-026).
- [ ] Run `psrw promote --direct` from the release worktree or root repository.
- [ ] Verify `main` has been fast-forwarded or merged with Release 1.7.
- [ ] Run `./scripts/e2e-full-chain.sh` on `main` to provide verified evidence of completion.
