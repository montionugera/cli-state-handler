# F-041 verification note (E-009 Task 4: portal signal)

Task 4 needed no code change; findings recorded here.

- joy-design `ci.yml` has `workflow_dispatch` with a single optional input
  `image_tag` (default ''). So the `gh workflow run ci.yml -R montionugera/joy-design --ref main`
  line in `.github/workflows/release.yml` (~lines 157-163) needs no `-f` flags.
- Narrowest token: fine-grained PAT scoped to `montionugera/joy-design` with repository
  permission "Actions: Read and write", stored as repo secret `PORTAL_DISPATCH_TOKEN`.
  Inferred from GitHub REST docs; not confirmed for the dispatch endpoint specifically.
- With the secret unset, the step logs
  `::warning::PORTAL_DISPATCH_TOKEN is not set; the developer portal was not signalled`
  and exits 0 (the release is not failed).
- actionlint on release.yml: exit 0. Gate 1 ok at base.

## For Task 5 (README)
Document the `PORTAL_DISPATCH_TOKEN` secret and its scope (fine-grained PAT,
`montionugera/joy-design`, Actions: Read and write).
