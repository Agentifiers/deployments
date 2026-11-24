# Repository conventions

These instructions apply to the entire repository. More-specific `AGENTS.md`
files may add constraints for their subtree.

## Product isolation

- The platform stays product and vertical agnostic. Do not store product or
  vertical names, persona names, product-owned stable identifiers, product
  configuration values, or product runbooks in this repository.
- Put product-specific wrappers, reconciliation inputs, prompts, persona
  definitions, and operator documentation in the repository that owns the
  product. The platform exposes generic contracts and operational primitives
  that those wrappers call.
- Provider and model support belongs here when it is a reusable platform
  capability, including routing, credentials, metering, and billing behavior.
  Do not couple it to a particular product or persona.
- Do not add a source or workspace dependency on a product repository.

## Management console UI

- The management console (`apps/console`) owns its components: shadcn/ui on
  Base UI in `src/components/ui/` and ReUI primitives in
  `src/components/reui/`, configured by its own `components.json`.
- Add a component from `apps/console` with
  `bunx --bun shadcn@latest add <name>`, or
  `bunx --bun shadcn@latest add @reui/<name>` for ReUI (the registry needs no
  auth).
- Use only stock shadcn items and free ReUI items, never ReUI Pro items or a
  license key. The console has adapted these files, so check `--dry-run` and
  `--diff` before overwriting one.

## Git commits

- Use Conventional Commits: `type(optional-scope): imperative summary`.
- Supported types are `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`,
  `chore`, `perf`, and `revert`.
- Use a short, lowercase, imperative subject without a trailing period. Add a
  descriptive scope when it makes the affected area clearer, for example
  `fix(db): reject expired uniqueness claims`.
- Reserve `feat` and `fix` for user- or operator-visible behavior. Use
  `refactor` for behavior-preserving restructuring and `docs` for
  documentation-only changes.
- Mark breaking changes with `!` and explain them in a `BREAKING CHANGE:`
  footer.
- Keep each commit focused. Do not combine unrelated cleanup with a feature or
  fix merely because the files are nearby.
- Author and commit as a GitHub noreply address
  (`<id>+<login>@users.noreply.github.com`), and leave out
  `Co-authored-by: Amp` trailers. `Amp-Thread-ID` trailers may stay. The CI
  `Commit authorship` job rejects other identities.

## Database and persistence

`packages/db/README.md` is the source of truth for the platform data model and
transaction invariants.

- All DynamoDB reads and writes must be implemented inside `packages/db`.
  This is an absolute repository boundary: feature packages, runtimes, apps,
  and workers must not construct or send DynamoDB commands; call the
  generic Promise-based `DynamoDatabaseService` read/write/query methods; or
  own a DynamoDB-specific storage adapter.
- Code outside `packages/db` must depend on a domain-specific repository or
  facade interface exported by `@deployments-ai/db`. Composition roots may
  construct a DynamoDB client and inject it into a DB-package repository, but
  only `packages/db` may execute persistence operations. Canonical records and
  domain query inputs may be assembled by feature code, but the resulting
  read, query, write, delete, or transaction must cross a domain-named DB
  facade. Add substantial new domain persistence under a descriptive
  `packages/db/src/<domain>/` directory; do not create exceptions in a feature
  or runtime package.
- Operational scripts under `scripts/` may access DynamoDB directly when their
  purpose requires it. Do not import script-local persistence into production
  code or treat scripts as examples for feature persistence.
- Define canonical record schemas in `packages/db/src/records/`, grouped into
  descriptively named domain files. Re-export them through the thin records
  index; do not restore `record-` filename prefixes.
- Keep substantial feature persistence in a descriptive subdirectory such as
  `packages/db/src/agent-email/`. Within such a directory, name files for their
  responsibility rather than repeating the directory name.
- Construct records with `withCanonicalRecordKeys`. Preserve the canonical
  `pk`, `sk`, `itemType`, nested `data`, optional GSI, and TTL envelope, and
  decode unknown DynamoDB results through the canonical Effect schemas before
  returning them to application code.
- Use full, validated record puts. Partial update expressions are deliberately
  not part of the data-layer contract.
- Treat a put without `previousRecord` as create-only. For an update, pass the
  previously decoded record and increment its integer `version` by exactly one.
  Transaction deletes carry the complete decoded record, not an arbitrary key.
- Write uniqueness claims and customer-visible semantic events in the same
  transaction as the resource mutation. GSIs provide lookup projections; they
  do not enforce uniqueness.
- Treat DynamoDB TTL as asynchronous cleanup only. Check logical expiration
  fields before reading, using, replacing, or claiming an expiring record.
- Keep transactions within DynamoDB's 100-operation limit after invariant,
  uniqueness, and event operations have been added.
- Do not add backfills, compatibility reads, dual writes, or migration
  machinery unless a change explicitly migrates persisted data.
- Add focused tests for new record schemas, canonical keys, access patterns,
  transaction invariants, conditional-write races, and logical expiration.

## Modules and dependencies

- Keep source files below 700 lines. Split oversized files by behavior or
  responsibility and use descriptive names; never use names such as `part-1`,
  `part-2`, or `misc`.
- Keep barrel files to exports and small composition only.
- Preserve dependency direction: domain logic depends on contracts; database,
  AWS, and other infrastructure adapters implement those contracts.
- Do not move infrastructure concerns into a domain package for convenience.
  Put ownership at the narrowest reusable boundary and expose an interface.

## Infrastructure

- Infrastructure is OpenTofu 1.13.2; run it as `tofu`. Reusable modules live
  in `infrastructure/modules/`, and every installation root calls
  `infrastructure/modules/platform` as `module "platform"`.
- Keep account-specific values out of the repository. They belong in a
  deployment target file and its var files.

## Verification

- Run focused tests while iterating.
- `bun run test` spreads test files over parallel workers, and the files a
  worker runs share one module registry and global object. A test file must
  restore what it changes before it ends: spies (`mock.restore()`), fake
  timers, `process.env`, and globals such as `fetch`. Lint forbids
  `mock.module` in test files because nothing undoes it; spy on the export or
  inject the dependency instead.
- Before committing, run `bun run signoff:verify`.
- Never commit credentials or decrypted secrets.
