# Developing `@agentifiers/deployments-cli`

This file is for contributors working in the Deployments repository. The build
does not copy it into the published npm package.

## Run from source

From the repository root:

```sh
bun run cli --help
bun run cli project list --mock
bun run --cwd packages/cli test
bun run --cwd packages/cli typecheck
```

Set `DEPLOYMENTS_CONFIG_DIR` to an absolute temporary directory to keep test
profiles out of your own config.

## Structure

- [Citty](https://github.com/unjs/citty) handles nested command routing,
  generated help, and argument parsing.
  [Clack](https://github.com/bombshell-dev/clack) drives interactive flows, and
  `cli-table3` renders human-readable tables.
- Commands call only `@agentifiers/deployments-sdk`. They never access databases or
  infrastructure directly. `--mock` swaps the live transport for the SDK's
  deterministic mock transport.
- `scaffoldCommandCatalog` in `src/catalog.ts` holds the typed resource and
  action specifications. `commandCatalog` keeps only the actions whose method
  and path appear in the public API contract (`PUBLIC_API_ROUTES` in
  `@deployments-ai/api-contract`), and only those become executable commands.
- `src/capability-catalog-coverage.test.ts` fails when a public API operation
  has no command or when a command maps to a route outside the public contract.

## Add a command

1. Add the operation to the public API contract.
2. Add or update its resource and action specification in the catalog. The
   command builder supplies context resolution, pagination, idempotency keys,
   output formatting, confirmation, SDK transport, and error mapping.
3. Add a custom top-level command only when the interaction cannot be expressed
   as a resource action, and extend the coverage test for it.

## Build the npm package

```sh
bun run packages:build
bun run packages:verify
```

`scripts/build-cli-package.ts` bundles `src/bin.ts` into
`packages/cli/dist/package/bin.js` and stages `README.md`, this package's
`LICENSE`, and a `NOTICE` that appends the license of every third-party npm
package the bundle includes. `scripts/verify-client-packages.ts` packs the
staged SDK and CLI, installs them into a temporary project, and smoke-tests
them.
