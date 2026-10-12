# Changelog

Release notes for `@montionugera/ucsa-core` and `@montionugera/ucsa-cli`. Both packages always share one version. Entries are written by the release workflow.

## 0.5.0 - 2026-10-12

- Adopt the Joymify design system in the docs portal (F-045)
- fix: give the install step its own npm config for the Joymify token

## 0.4.0 - 2026-10-11

- Make release.yml publish loop tolerate overlapping runs (skip on staged/409, wait for npm to show version) (F-047)
- Tell the developer portal which docs version to fetch (F-048)

## 0.3.0 - 2026-10-11

- Bump pinned GitHub Actions off Node 20 and confirm Ubuntu 26 readiness (F-046)

## 0.2.0 - 2026-10-09

- Version and release-notes script (F-038)
- Release-on-merge workflow (F-039)
- Release notes page and version marker in docs (F-040)
- Portal signal to joy-design (F-041)
- README and epic check for merge-based releases (F-042)
- Fix flaky Copied timer in MultiPlatformDocs (F-043)
- Add pull request CI check workflow (F-044)

## 0.1.1 - 2026-10-09

- First release published by the release workflow through trusted publishing

## 0.1.0 - 2026-10-09

- First public release of both packages
