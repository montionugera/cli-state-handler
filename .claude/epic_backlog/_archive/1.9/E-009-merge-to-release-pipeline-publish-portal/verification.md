---
title: "Merge-to-release pipeline: publish, portal docs, release notes"
id: E-009
---

# How we will know E-009 works

Prose for humans. `scripts/epic-check.sh` implements the pre-merge assertions; the
toolkit never parses this file.

The epic check runs on the release branch before it is merged, so it can only
assert things that are true before a merge. What only becomes true after a merge
to `main` is listed separately and checked once, by hand or by a smoke script,
after the first real release.

## Assertions (pre-merge, run by the epic check)

1. The version script's unit tests pass, covering: a planned release with features, a planned release with none, a `feat` merge, a `fix` merge, a housekeeping-only range, a breaking change below and above 1.0, and "already bumped, not yet published".
2. Run against the real history, the script names the features of release 1.8 for the range ending at its merge commit.
3. `.github/workflows/release.yml` exists under that exact name, runs on a push to `main`, has no `environment:` on the publish job, and builds the docs only after the publish step.
4. No workflow in this repo targets GitHub Pages.
5. The docs build contains a "Release notes" page and a `version.json`.

## Checks after the first real release (post-merge, not part of the epic check)

6. The latest version of `@montionugera/ucsa-core` and `@montionugera/ucsa-cli` on npmjs.com is higher than before, both are equal, and nobody pushed a tag or edited a version by hand.
7. `CHANGELOG.md` on `main` has an entry for that version naming the features, and a GitHub Release with the same version carries `docs-site.tgz`.
8. `https://dev.joymify.com/cli-state-handler/version.json` reports that version, and the "Release notes" page shows the same entry. Depends on the `joy-design` work item.
9. A housekeeping-only merge publishes nothing and creates no tag.
10. Starting the release workflow again for an already published version succeeds without publishing again.
