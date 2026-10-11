---
title: "Tell the developer portal which docs version to fetch"
id: I-048
status: idea
---

# Tell the developer portal which docs version to fetch

## Problem

The "Signal the developer portal" step in `.github/workflows/release.yml` dispatches joy-design's `ci.yml` with no inputs, so the portal fetches "latest release". If two releases land close together, or a release is re-run, the portal can pick up the wrong docs.

## Why now

joy-design's `ci.yml` already accepts a `workflow_dispatch` input `cli_docs_tag` (a tag such as `v0.3.0`; empty means latest). Nothing sends it yet.

## Sketch

Pass `-f cli_docs_tag="$TAG"` to `gh workflow run`. `TAG` comes from `env:` and is built from `steps.decide.outputs.version` (the same source the release steps use for `v$VERSION`). No `${{ }}` inside the `run:` script. Touch only the signal step; the publish step, file name and job environment stay untouched. Missing-token warning stays as is.

## Acceptance criteria

- [ ] The signal step passes `cli_docs_tag` from an env variable holding `v<released version>`.
- [ ] No `${{` appears inside the signal step's `run:` script.
- [ ] The missing-token warning and `exit 0` are unchanged.
- [ ] `scripts/epic-check.sh` asserts the above and passes; README/handoff doc mention the tag.
