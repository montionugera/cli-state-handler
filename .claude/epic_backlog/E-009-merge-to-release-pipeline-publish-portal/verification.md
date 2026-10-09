---
title: "Merge-to-release pipeline: publish, portal docs, release notes"
id: E-009
---

# How we will know E-009 works

Prose for humans. `scripts/epic-check.sh` implements these assertions; the
toolkit never parses this file.

## Assertions

1. After a merge to `main` that contains a feature, the latest version of `@montionugera/ucsa-core` and `@montionugera/ucsa-cli` on npmjs.com is higher than before, both are equal, and nobody pushed a tag or edited a version by hand.
2. `CHANGELOG.md` on `main` has an entry for that version naming the feature, and a GitHub Release with the same version exists and carries `docs-site.tgz`.
3. `https://dev.joymify.com/cli-state-handler/` serves the docs build from that release, and its "Release notes" page shows the same entry.
4. A housekeeping-only merge (for example a `chore:` commit) publishes nothing and creates no tag.
5. Re-running the release workflow for an already published version succeeds without publishing again.
6. No workflow in this repo targets GitHub Pages, and no workflow run on `main` is red after a normal merge.
