# Deployments

Deployments is a multi-tenant control plane and runtime for building,
versioning, deploying, and operating AI agents on AWS. You describe an agent in
a manifest, publish it as an immutable release, deploy that release into an
environment with its own credentials and tool policies, and send it work
through the API, the CLI, the SDK, schedules, webhooks, email, or chat
channels. Every run pins the exact release it executed.

The platform covers tenancy and identity, agent releases and deployments,
durable threads and runs, approvals, workflows, memory, credentials, tools and
MCP servers, sandboxed execution, streaming, semantic events, usage metering,
and data governance. The product documentation lives in [`apps/docs`](apps/docs).

## Repository layout

| Path                                            | Contents                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/`                                     | Domain libraries, the public API contract, the TypeScript SDK (`@agentifiers/deployments-sdk`), and the CLI (`@agentifiers/deployments-cli`). |
| `functions/`                                    | Lambda and ECS entry points: the public API, runtime API, agent worker, workflow, memory, and channel runtimes.                               |
| `apps/`                                         | Services and web apps: the management console, stream gateway, Durable Streams, sandbox hosts, and the docs site.                             |
| `infrastructure/modules/`                       | Reusable OpenTofu modules. `modules/platform` is the full stack every installation calls as `module "platform"`.                              |
| `infrastructure/bootstrap/customer`             | One-time account bootstrap: state bucket, deploy role, optional observer role, and workload permissions boundary.                             |
| `infrastructure/environments/customer`          | The OpenTofu root for an installation in your own AWS account.                                                                                |
| `infrastructure/environments/local`             | The OpenTofu root for the local AWS emulator.                                                                                                 |
| `infrastructure/terraform-provider-deployments` | A Go OpenTofu provider that issues environment API keys into AWS Secrets Manager.                                                             |
| `scripts/`                                      | Build, deploy, local AWS, and release tooling.                                                                                                |
| `tests/`, `contracts/`                          | Repository-wide boundary and infrastructure tests, and the exported release bundle contract.                                                  |

## Prerequisites

- [Bun](https://bun.sh/) 1.4.4
- Node.js at the version in [`.node-version`](.node-version)
- [OpenTofu](https://opentofu.org/) 1.13.2 (`tofu`)
- Go, at the version in `infrastructure/terraform-provider-deployments/go.mod`, to build the provider
- Docker, for the local AWS emulator and image builds

## Development

This repository accepts issues, not pull requests; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

```sh
bun install
bun run check          # format, lint, typecheck, contract, tests, OpenTofu validation
bun run test           # the test suite only
bun run signoff:verify # check plus build; run before every commit
```

`bun run hooks:install` installs the repository's pre-commit hook. Commit
messages follow Conventional Commits; see [`AGENTS.md`](AGENTS.md) for the
repository conventions and [`packages/e2e/README.md`](packages/e2e/README.md)
for the end-to-end suites that run against a live installation.

The CLI runs from source with `bun run cli --help`. Pass `--mock` or set
`DEPLOYMENTS_MOCK=1` to explore it without an API.

### Local AWS

A pinned Floci emulator (`infrastructure/local/compose.yml`) runs the DynamoDB
tables, event bus, buckets, queues, and secret containers the tests need:

```sh
export LOCAL_MEMORY_JWT_ISSUER=https://issuer.example.com
bun run local-aws:up
bun run local-aws:run -- bun test packages/db
eval "$(bun run --silent local-aws:env)"
bun run local-aws:down   # stop and keep local state
bun run local-aws:reset  # destroy emulated resources and stop
```

`LOCAL_MEMORY_JWT_ISSUER` must be an HTTPS OpenID Connect issuer with a
reachable discovery document and JWKS. `LOCAL_AWS_PORT` moves the listener;
`LOCAL_AWS_ENDPOINT` targets another one.

## Deploy into your own AWS account

An installation runs in one dedicated AWS account and region. The operate guides in
[`apps/docs/content/docs/operate/`](apps/docs/content/docs/operate) cover the account bootstrap
and install ([`install.mdx`](apps/docs/content/docs/operate/install.mdx)), the deploy tool, target
format, and GitHub Action ([`deployment.mdx`](apps/docs/content/docs/operate/deployment.mdx)),
what each feature needs and costs, upgrades, troubleshooting, and teardown. Common questions,
including licensing, are answered in the [FAQ](<apps/docs/content/docs/(guides)/faq.mdx>).

## License

| Path                                  | License                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Everything not listed below           | [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (`FSL-1.1-ALv2`)     |
| [`packages/sdk`](packages/sdk)        | [MIT](packages/sdk/LICENSE), including the published `@agentifiers/deployments-sdk` package |
| [`packages/cli`](packages/cli)        | [MIT](packages/cli/LICENSE), including the published `@agentifiers/deployments-cli` package |
| Vendored and bundled third-party code | Its own license, as listed in [`NOTICE`](NOTICE)                                            |

`FSL-1.1-ALv2` is a Fair Source license, not an OSI-approved open source
license. It permits any purpose other than a competing use: making the software
available in a commercial product or service that substitutes for it or offers
substantially similar functionality. Each version converts to the Apache
License 2.0 two years after it is released.

The published SDK and CLI packages bundle code from other workspace packages,
such as `@deployments-ai/api-contract`. That bundled code is licensed under MIT
as part of each package. Each package's `NOTICE` reproduces the licenses of
the third-party code it bundles.

Firecrawl, Lightpanda, and SearXNG run as separate services from their own
AGPL-licensed sources and are not part of this repository's code. See
[`NOTICE`](NOTICE).
