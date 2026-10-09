---
title: "CAS playground on a tested model"
id: I-031
status: idea
---

# CAS playground on a tested model

Slice 5 of epic E-008 (docs portal). Depends on slice 2.

## Problem

`CasPlayground.tsx` imports nothing from `@ucsa/core`; its behaviour is hand-rolled and untested against the real store. The real store (`storage/cas-store.ts`, `cas-lru.ts`) needs `better-sqlite3`, `node:fs` and `node:crypto`.

## Scope

- `apps/docs/src/models/cas-model.ts`: in-memory content-addressable store using WebCrypto SHA-256, with put (dedupe by hash), get, reference counting, a byte budget and LRU eviction that never evicts a referenced entry. Behaviour follows README "Content-Addressable Storage" and the real `cas-store`/`cas-lru` rules. `@ucsa/core` is not modified.
- `apps/docs/tests/cas-model.parity.test.ts`: for shared fixtures, the model's hash and key format equal those produced by the real `cas-store`; eviction order matches the real LRU for a scripted access sequence.
- `CasPlayground.tsx` is rewired onto the model and labelled "browser model, hash-compatible with the real store". Its existing test keeps passing or is updated only where the old mock behaviour was wrong.

## Acceptance criteria

- [ ] `cas-model.parity.test.ts` passes: identical hashes/keys to the real store for every fixture.
- [ ] Putting identical content twice stores one blob and reports a dedupe.
- [ ] Exceeding the byte budget evicts the least recently used unreferenced blob; a referenced blob is never evicted.
- [ ] `apps/docs/tests/cas-playground.test.tsx` passes against the rewired component.
- [ ] The built bundle contains no `node:crypto` or `better-sqlite3`.

## Non-goals

Filesystem layout, the package/manifest layer beyond what the playground already shows.
