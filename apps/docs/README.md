# Docs site

`apps/docs` is the product documentation site. It is a Fumadocs site on
Next.js, exported as static files.

## How the content is made

The site has two kinds of pages:

- **Hand-written pages** live in `content/docs/`. The guides (the overview,
  `getting-started/`, and `capabilities/`) sit in the `(guides)` route group,
  which does not appear in URLs. `meta.json` files set the sidebar order.
- **Reference pages** are generated on every build by
  `scripts/generate-reference.ts` and are not committed. The generator joins
  `PUBLIC_API_ROUTES` from `@deployments-ai/api-contract` with the real
  `deployments` command tree from `@agentifiers/deployments-cli` and writes one API page
  per operation, one CLI page per top-level command, the SDK function index,
  the OpenAPI document the API pages render, and `generated/manifest.json`.
  Generation fails when a public operation has no CLI command.

Each API page shows a curl, TypeScript SDK, and CLI sample. The SDK function
name is the operation name, which `scripts/build-sdk-package.ts` enforces for
the published client.

## Commands

Run these from the repository root.

| Command                                                           | What it does                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bun run --cwd apps/docs dev`                                     | Generates the reference and starts the dev server.                                                                |
| `bun run --cwd apps/docs generate`                                | Regenerates the reference pages and `generated/manifest.json`.                                                    |
| `bun run --cwd apps/docs check:content [files...]`                | Checks hand-written pages without building the site.                                                              |
| `bun run --cwd apps/docs check:samples`                           | Type-checks every TypeScript sample against the published SDK.                                                    |
| `bun run --cwd apps/docs build`                                   | Runs `check:samples`, generates, exports the site to `apps/docs/out`, then runs `check:content` and `check:site`. |
| `bun scripts/deploy-docs.ts --root <dir> --backend-config <file>` | Builds the site, applies the given OpenTofu docs-site root with the given backend config, uploads, and verifies.  |

`check:content` compiles each page, resolves every internal link, rejects
unregistered components, and validates every `deployments` command, flag, and
`@agentifiers/deployments-sdk` import in code blocks against the manifest.

`check:samples` builds the SDK package that the registry publishes
(`packages/sdk/dist/package`) and type-checks two kinds of samples against it
in strict mode. The first kind is the SDK sample on each API operation page.
The second kind is every ` ```ts ` or ` ```tsx ` block in the hand-written
pages. Each block compiles as its own module. A block that opens with
` ```ts continues ` compiles appended to the TypeScript block before it on the
same page, the way a reader would paste both into one file. The check prints
each error at its page line, or at the operation ID for a generated sample.

`check:site` runs on the exported files. It fails when the number of API pages
differs from `PUBLIC_API_ROUTES.length`, when a CLI command or an SDK sample is
missing, when an internal link is broken, or when the leak guard finds an AWS
account ID, an ARN, a real ULID, or a private name. It resolves each link
to a file with the CloudFront viewer-request function from
`infrastructure/modules/docs-site/main.tf`, the same function the live site runs.

`check:site` also loads `out/api/search.json` into the static search client
the site uses. It fails when searching an operation's SDK name or summary does
not return that operation's page, or when a phrase from a guide body does not
return the guide. CloudFront compresses only files up to 10,000,000 bytes, and
`check:site` fails on any larger published file, so the index leaves out what a
search does not need. Generated reference pages are indexed by title,
description, and headings only. Neighboring paragraphs and table cells under
one heading share an entry of up to 200 characters, because each entry costs
more index bytes than a short text. The index keeps no sort tables, because the
search dialog ranks by relevance alone.

The repository holds no list of private names. A hosting installation that
wants `check:content` and `check:site` to reject its own private names (for
example unannounced products) sets `DOCS_LEAK_GUARD_DIGESTS_FILE` to the
absolute path of a JSON file `{ "names": [...], "leadWords": [...] }` that it
keeps outside this repository. The file holds SHA-256 digest prefixes, not the
names. `bun apps/docs/scripts/leak-guard.ts --digest "<name>"` prints the
entries to merge into it. Without the variable, the guard checks everything
except private names.

## Deployment

The site is served from S3 behind CloudFront by the
`infrastructure/modules/docs-site` module. Each hosting installation keeps its
own OpenTofu root that calls that module, plus a backend config for its state.
`scripts/deploy-docs.ts` takes both as `--root` and `--backend-config`, reads
AWS credentials from the environment, builds the site, applies the root,
uploads `apps/docs/out`, and verifies the published pages.
