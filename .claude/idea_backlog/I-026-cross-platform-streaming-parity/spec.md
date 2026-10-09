---
title: "cross-platform-streaming-parity"
id: I-026
status: idea
---

# cross-platform-streaming-parity

## Acceptance criteria

- [ ] Dart package `ucsa_dart` implements migration v4, chunk append, `streamQuery`, and Stream yields.
- [ ] Unity package `com.ucsa.unity` implements migration v4, chunk append, `StreamQueryAsync`, and `IAsyncEnumerable<StreamSlice>`.
- [ ] Section 12 in `README.md` documents Generative AI & LLM Streaming Architecture.
- [ ] Gate 1 (`./scripts/precheck.sh`), Gate 2 (`./scripts/integration.sh`), and all 5 tiers of `./scripts/e2e-full-chain.sh` pass cleanly across all runtimes.
- [ ] Release 1.7 promoted to main.
