# End-to-End Tests

`@deployments-ai/e2e` exercises the platform through its public HTTP API and
the real `deployments` CLI process, without a UI. Tests are Effect programs run
by Vitest through `@effect/vitest`; scoped resources register their cleanup as
soon as they are created. The Bun unit, integration, and contract tests in the
other packages remain the faster correctness layer.

Vitest runs every `src/**/*.e2e.ts` file serially (no file parallelism, no
concurrent tests), with a 30-second hook timeout and a 120-second default test
timeout. Long proofs set their own timeout.

## Layout

| Path            | Contents                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/contract/` | Hermetic tests: route, OpenAPI, and CLI coverage; the real CLI process; and unit tests for the harness itself. No network access. |
| `src/live/`     | Tests against a deployed installation, plus `*-support.ts` helpers they share.                                                    |
| `src/harness/`  | Configuration loading, the HTTP client, the CLI process runner, platform credential minting and refresh, and polling helpers.     |

## Suites

| Suite                   | Root command                                          | Package script             | Target                                       |
| ----------------------- | ----------------------------------------------------- | -------------------------- | -------------------------------------------- |
| Contract and CLI        | `bun run e2e:contract`                                | `test` or `test:contract`  | None (local only)                            |
| Deployed public surface | `bun run e2e:public`                                  | `test:public`              | Any installation, no credentials             |
| Credentialed lifecycle  | `bun run e2e:live`                                    | `test:live`                | A dedicated test installation (destructive)  |
| Slack sandbox           | `bun run e2e:slack-live`                              | `test:slack-live`          | A test installation and a sandbox Slack team |
| Telegram sandbox        | `bun run --cwd packages/e2e test:telegram-live`       | `test:telegram-live`       | A test installation and a sandbox bot        |
| Provider OAuth          | `bun run --cwd packages/e2e test:provider-oauth-live` | `test:provider-oauth-live` | A test installation and an operator browser  |

The root `bun run check` gate runs the contract suite, and CI runs it on every
push to `main`. The other suites run only when you start them.

### Contract and CLI

```sh
bun run e2e:contract
```

- Every local route is represented exactly once in the generated OpenAPI
  document, with its authentication, scope, idempotency, and error traits.
- Every public operation maps to an executable CLI command, and no non-public
  route is exposed through the CLI.
- The real CLI is spawned with Bun; its machine-readable catalog lists every
  command and `--help` renders for every public command.
- Harness behavior: configuration validation (including the destructive-target
  acknowledgement and channel API approval), JWT metadata redaction, platform
  token refresh, cleanup retry rules, polling under real time, API Gateway
  throttle resends, and the agent model defaults.

Set `DEPLOYMENTS_E2E_BUN_BIN` to choose the Bun executable used for the CLI
process tests; it defaults to `bun` on `PATH`.

### Deployed public surface

```sh
DEPLOYMENTS_E2E_API_URL=https://api.example.com \
DEPLOYMENTS_E2E_STREAM_GATEWAY_URL=https://stream.example.com \
bun run e2e:public
```

`src/live/public-api.e2e.ts` needs no credentials and changes nothing. It
checks that:

- `GET /health` returns `200` and the deployed `/v1/openapi.json` equals the
  locally generated document exactly. An installation without Agent Email may
  serve the variant that omits the Agent Email routes; only the routes in the
  served variant are probed.
- Every protected route answers `401` before authentication, with placeholder
  scope headers and idempotency keys. Stream gateway routes are probed only
  when `DEPLOYMENTS_E2E_STREAM_GATEWAY_URL` is set. `503` responses are retried
  for up to 15 seconds.
- Every unsigned `/v1/system` observer request is rejected with `403` by API
  Gateway's IAM check, not answered by the platform.
- `GET /v1/providers` and `GET /v1/providers/github` decode against their
  response schemas.
- Malformed device-authorization requests return `400` (or `503`).

Run it after each deploy to confirm that new routes were published and that
none bypasses authentication.

The suites' own requests to the platform API and the identity service go
through `src/harness/http-client.ts`, either `E2eHttpClient` or, for a request
it cannot express, `fetchResendingGatewayThrottles`. When API Gateway throttles a
request, it answers `429` with the body `{"message":"Too Many Requests"}`. The
harness resends that request after 0.25, 0.5, 1, 2, and 4 seconds, then
returns the last answer. A throttled request never reaches the route, so a
resend repeats no side effect. A `429` from the platform (problem+json) or from
the identity service (`slow_down`) has a different body and is returned
without a resend.

### Credentialed lifecycle

`bun run e2e:live` sets `DEPLOYMENTS_E2E_LIVE=true` and runs every file in
`src/live/`, including the public surface tests. The Slack, Telegram, and
provider OAuth proofs are skipped unless their own flags are set (their package
scripts set them).

> **Warning:** The credentialed suite creates and deletes real resources,
> spends model tokens, sends email through SES, and erases a disposable
> organization. Run it only against an installation that exists for testing,
> never against one that serves real users.

| File                             | Proof                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform-lifecycle.e2e.ts`      | CLI and API tenancy-to-run lifecycle in a fresh `e2e-<uuid>` project and environment: service account, API key, agent definition, release, deployment, run, and timeline.               |
| `control-plane-lifecycle.e2e.ts` | Workflow draft-to-release and managed-skill source-to-installation lifecycles. Needs the privileged credential.                                                                         |
| `model-policy.e2e.ts`            | Environment model-policy admission of a non-curated catalog model through publish, deploy, and run, and publish-time denial (`422 model_not_allowed_by_environment_policy`) of another. |
| `agent-release-retarget.e2e.ts`  | A deployment retargets while an approval-paused run finishes on its original release.                                                                                                   |
| `agent-release-canary.e2e.ts`    | Canary threads stay sticky through promote, abort, and an explicit release rebase.                                                                                                      |
| `agent-release-promotion.e2e.ts` | A release is promoted into another environment of the project and runs there.                                                                                                           |
| `manifest-agents.e2e.ts`         | A release-pinned response format is enforced and a conflicting run format rejected; a parent run resumes with an awaited sub-agent's answer.                                            |
| `preview-runs.e2e.ts`            | Preview turns execute an unpublished manifest in isolation from releases and deployments.                                                                                               |
| `memory-lifecycle.e2e.ts`        | Memory import, review, indexing, search, lifecycle, namespaces, reranking, active recall, feedback, and flush. Active recall needs the privileged credential.                           |
| `brain-lifecycle.e2e.ts`         | Brain grants, mounts, upload capture, indexing, search, ask, feedback, the hosted `/v1/mcp/brain` server, mounted agent search, and erasure.                                            |
| `tool-approval.e2e.ts`           | A real tool request, approval, execution, result, and resumed model completion.                                                                                                         |
| `client-tools.e2e.ts`            | A deployed run pauses on a client-executed tool and resumes with submitted output.                                                                                                      |
| `hosted-code-tools.e2e.ts`       | Release-pinned JavaScript and Python hosted code tools with vault secrets and network isolation.                                                                                        |
| `mcp-runtime.e2e.ts`             | Remote MCP discovery, credential rotation, workspace authorization, and deployed execution against the `/_e2e/mcp` fixture.                                                             |
| `http-callback-runtime.e2e.ts`   | HTTP callback extension dispatch, workspace grants, policy allow, and secret rotation against the `/_e2e/callback` fixture.                                                             |
| `web-tools-runtime.e2e.ts`       | Hosted web search, public redirects, and rejection of a public-to-reserved-address redirect, confirmed in the web tools service log.                                                    |
| `browser-sandbox-runtime.e2e.ts` | Hosted browser actions and sandboxed code, with every MicroVM the test started terminated afterwards.                                                                                   |
| `agent-email-lifecycle.e2e.ts`   | Agent Email MIME ingress through SES, the email-triggered run, raw and attachment content, the provider reply and delivery event, policy, and usage.                                    |
| `runtime-resources.e2e.ts`       | Artifact bytes and retention, a delivered webhook, and schedule and heartbeat execution, history, and lifecycle.                                                                        |
| `evaluations.e2e.ts`             | Score definitions, dataset import, a release evaluation run, and an advisory release comparison.                                                                                        |
| `observability-traces.e2e.ts`    | A completed hosted run's trace, spans, and metrics through the public observability API.                                                                                                |
| `governance-lifecycle.e2e.ts`    | Usage and spend reads, then, in a new disposable organization: retention, tenant export, signed audit export, and observability-purging erasure.                                        |

## Configuration

Every value is read from the environment and trimmed; an empty value counts as
unset. Keep secrets out of command-line arguments: export them from a secret
store in the shell, or use `DEPLOYMENTS_E2E_PLATFORM_API_KEY_FILE`.

### Common

| Variable                             | Used by          | Meaning                                                                   |
| ------------------------------------ | ---------------- | ------------------------------------------------------------------------- |
| `DEPLOYMENTS_E2E_API_URL`            | All live suites  | Platform API origin under test. Required; there is no default target.     |
| `DEPLOYMENTS_E2E_STREAM_GATEWAY_URL` | Public surface   | Stream gateway origin. Optional; gateway routes are probed only when set. |
| `DEPLOYMENTS_E2E_BUN_BIN`            | CLI process runs | Bun executable for the spawned CLI. Defaults to `bun`.                    |
| `DEPLOYMENTS_E2E_JUNIT_OUTPUT`       | All suites       | When set, adds a JUnit reporter that writes to this path.                 |

### Credentialed

| Variable                                           | Required                     | Meaning                                                                                                                       |
| -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE`                | Yes                          | Must equal `DEPLOYMENTS_E2E_API_URL` exactly. The suite refuses to start otherwise.                                           |
| `DEPLOYMENTS_E2E_ORGANIZATION_ID`                  | Yes                          | Long-lived organization the suite works in.                                                                                   |
| `DEPLOYMENTS_E2E_PROJECT_ID`                       | All tests but one            | Fixed project used as the memory and feature scope. Only the platform lifecycle proof runs without it.                        |
| `DEPLOYMENTS_E2E_ENVIRONMENT_ID`                   | All tests but one            | Fixed environment in that project.                                                                                            |
| `DEPLOYMENTS_E2E_IDENTITY_ISSUER`                  | Unless an API key is set     | Platform identity issuer origin, for example `https://auth.example.com`.                                                      |
| `DEPLOYMENTS_E2E_IDENTITY_USERNAME`                | Unless an API key is set     | Email address of the test principal.                                                                                          |
| `DEPLOYMENTS_E2E_IDENTITY_PASSWORD`                | Unless an API key is set     | That principal's password.                                                                                                    |
| `DEPLOYMENTS_E2E_PLATFORM_API_KEY`                 | No                           | Static platform API key used instead of the identity sign-in.                                                                 |
| `DEPLOYMENTS_E2E_PLATFORM_API_KEY_FILE`            | No                           | File containing that key; read only when `DEPLOYMENTS_E2E_PLATFORM_API_KEY` is unset.                                         |
| `DEPLOYMENTS_E2E_IDENTITY_CLIENT_SECRET`           | For the privileged proofs    | Secret of the `deployments-e2e` confidential OAuth client.                                                                    |
| `DEPLOYMENTS_E2E_IDENTITY_REDIRECT_URI`            | For the privileged proofs    | One of `platform_identity_web_redirect_uris`; the `deployments-e2e` client is registered with the web client's redirect URIs. |
| `DEPLOYMENTS_E2E_WEBHOOK_URL`                      | Feature proofs               | HTTPS receiver you control that answers webhook deliveries with `200`.                                                        |
| `DEPLOYMENTS_E2E_AGENT_EMAIL_DOMAIN`               | Agent Email proof            | The installation's agent email domain.                                                                                        |
| `DEPLOYMENTS_E2E_AWS_REGION`                       | Agent Email proof            | Region for the SES client. Falls back to `AWS_REGION`.                                                                        |
| `DEPLOYMENTS_E2E_MCP_INITIAL_TOKEN`                | MCP proof                    | `initial` value of the `/e2e/mcp` SecureString parameter. Must differ from the rotated token.                                 |
| `DEPLOYMENTS_E2E_MCP_ROTATED_TOKEN`                | MCP proof                    | `rotated` value of the same parameter.                                                                                        |
| `DEPLOYMENTS_E2E_CALLBACK_INITIAL_SECRET`          | HTTP callback proof          | `initial` value of the `/e2e/callback` SecureString parameter. Must differ from the rotated secret.                           |
| `DEPLOYMENTS_E2E_CALLBACK_ROTATED_SECRET`          | HTTP callback proof          | `rotated` value of the same parameter.                                                                                        |
| `DEPLOYMENTS_E2E_AGENT_MODEL`                      | No                           | Model for every agent the suite creates. Defaults to the curated `openrouter/qwen/qwen3.7-plus`.                              |
| `DEPLOYMENTS_E2E_AGENT_MODEL_INPUT_TOKEN_BUDGET`   | With an uncatalogued model   | Sets the agents' `modelInputTokenBudget`. Positive integer.                                                                   |
| `DEPLOYMENTS_E2E_AGENT_MODEL_OUTPUT_TOKEN_RESERVE` | With an uncatalogued model   | Sets the agents' `modelOutputTokenReserve`. Positive integer.                                                                 |
| `AWS_REGION`                                       | Web tools and browser proofs | Region for the AWS calls those proofs make. Defaults to `us-east-2`.                                                          |

Set both token budget variables or neither; the suite refuses to load with only
one. Only a model without a catalog entry needs them, because the platform
cannot derive its context window.

#### Platform credentials

With identity credentials, the suite starts a CLI device grant against the
platform authorization server, approves it as the test principal, and uses the
resulting short-lived access token, re-minting it before expiry. That token
drives control-plane operations, tenant-scoped memory operations, and the
creation of environment-scoped runtime API keys. The Brain proof needs this JWT
identity rather than an API key, because Brain routes record a human creator.

Managed-skill catalog mutations and `memory:execute` need scopes that the public
CLI client cannot request. When `DEPLOYMENTS_E2E_IDENTITY_CLIENT_SECRET` and
`DEPLOYMENTS_E2E_IDENTITY_REDIRECT_URI` are set, the suite also signs in to the
identity service and runs an authorization code flow with PKCE for the
`deployments-e2e` client, requesting `openid managed-skills:admin
managed-skills:read memory:execute`. Without them, the managed-skill and
active-recall proofs fail.

`DEPLOYMENTS_E2E_PLATFORM_API_KEY` is enough for the proofs that need neither
the JWT identity nor the privileged scopes.

#### AWS credentials on the test machine

Some proofs call AWS directly with the default credential chain:

- The Agent Email proof sends a multipart MIME message with SES v2.
- The web tools proof runs `aws logs filter-log-events` on the `/ecs/web-tools`
  log group to find the egress denial, so the AWS CLI must be installed.
- The browser sandbox proof lists Lambda MicroVMs before and after the run and
  requires no additional active MicroVM afterwards. It lists every MicroVM in
  the account and region, so other sandbox activity during the run can make it
  fail.

Run these from a principal in the installation's account that can perform
those calls.

## Preparing an installation

### Test fixtures

Set `operations.test_fixtures = true` in the installation's OpenTofu inputs.
This provisions the `deployments-e2e` confidential OAuth client. The deploy
tool's identity client bootstrap writes its client secret to the SecureString
parameter `/identity/e2e-oauth-client` and validates the client.
Leave the flag `false` on installations that serve users.

The MCP and HTTP callback proofs call fixtures on the public API domain:
`ANY /_e2e/mcp/{credential}` and `ANY /_e2e/callback/{credential}`, each backed
by a separate least-privilege Lambda. They are deployed by the `platform` module
inputs `platform_api_e2e_mcp_fixture_enabled` and
`platform_api_e2e_callback_fixture_enabled` (both default `false`, and both
require `operations.test_fixtures`). The installation roots in
`infrastructure/environments/` do not set these inputs, so enabling the fixtures
means passing them in your own root. Each fixture keeps its `initial` and
`rotated` bearer values as JSON in a SecureString parameter (`/e2e/mcp` and
`/e2e/callback`). Load them without printing them:

```sh
MCP_FIXTURE_JSON="$(aws ssm get-parameter --name /e2e/mcp --with-decryption \
  --query Parameter.Value --output text)"
export DEPLOYMENTS_E2E_MCP_INITIAL_TOKEN="$(jq -er '.initial' <<< "${MCP_FIXTURE_JSON}")"
export DEPLOYMENTS_E2E_MCP_ROTATED_TOKEN="$(jq -er '.rotated' <<< "${MCP_FIXTURE_JSON}")"
unset MCP_FIXTURE_JSON
```

Load `/e2e/callback` into the two `DEPLOYMENTS_E2E_CALLBACK_*` variables the
same way. The callback fixture answers only a `POST` whose bearer matches the
secret for its path slot and rejects other secrets with `401`.

### Test principal and scope

Create a platform-administrator principal for the suite and an organization,
project, and environment it works in. Platform access tokens carry no
authoritative organization, project, environment, or role claims; the API
resolves the scope headers through strongly consistent reads, so the principal
must be an active member.

The fixed project and environment are the memory scope for the suite. That
environment needs a memory policy with active recall enabled and
`hybrid-rerank-v1` retrieval at a 100% rollout. The memory proof creates such a
policy only when the environment has none; it never overwrites an existing
policy, and it fails if the existing policy differs.

### Search placements and retention

Before the first credentialed run against an organization, activate its memory
and Brain search placements and bound its retention. Run these from the
repository root with AWS credentials for the installation; all three are
idempotent:

```sh
export DEPLOYMENTS_E2E_ORGANIZATION_ID=<organization-id>
export DEPLOYMENTS_E2E_PRINCIPAL_ID=<test-principal-id>
export AWS_REGION=<region>

DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT=<memory search domain endpoint> \
DEPLOYMENTS_AI_MEMORY_OPERATION_QUEUE_URL=<memory operation queue URL> \
DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_SECRET_ARN=<membership keyring secret ARN> \
bun scripts/bootstrap-e2e-memory-search.ts

DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT=<Brain search domain endpoint> \
bun scripts/bootstrap-e2e-brain-search.ts

bun scripts/bootstrap-e2e-retention.ts
```

- `bootstrap-e2e-memory-search.ts` activates the organization's memory search
  placement on the given OpenSearch domain. When the active placement names a
  different domain (for example after the domain was replaced), it migrates the
  placement through a provisioning operation.
- `bootstrap-e2e-brain-search.ts` activates or migrates the Brain search
  placement. Run it after the memory bootstrap: the Brain target reuses the
  embedding profile of the organization's active memory target. The Brain index
  worker creates the physical index on its first job.
- `bootstrap-e2e-retention.ts` sets the organization's retention policy to 7
  days for threads, messages, runs, artifacts, and events and 365 days for
  audit, so the daily retention sweep removes earlier runs' records.

The scripts use the default DynamoDB table names; set
`DEPLOYMENTS_AI_<TABLE>_TABLE` (for example `DEPLOYMENTS_AI_CONTROL_TABLE`) when
your tables are named differently.

### Models

`DEPLOYMENTS_E2E_AGENT_MODEL` applies to every agent the suite creates,
including those in the disposable governance organization, so pick a model
every organization admits (a curated model, or one covered by an
installation-wide grant).

The model-policy proof chooses its own model. It needs at least one paid,
non-curated `openai` catalog model with tool calling and a context window of at
least 32,000 tokens; it picks the cheapest by output price. It admits that model
in the fixed environment, creating a policy that keeps the curated models when
none is active or extending the active one, and its finalizer reverts only its
own change. It also needs a non-curated `openrouter` model that the policy does
not allow, which it publishes (expecting the `422`) but never runs.

### Organization limits

The suite runs serially and stays under typical request and run limits.
Sandbox leases left in `error` keep their slots, so if hosted tool calls start
failing on the sandbox limit, raise the organization's `activeSandboxes` in
its operator grant:

```sh
deployments system set-entitlements <organization-id> --tenant-limits '{"activeSandboxes":16}'
```

Defaults come from `operations.tenant_limit_defaults`.

### Running

```sh
export DEPLOYMENTS_E2E_API_URL=https://api.example.com
export DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE=https://api.example.com
export DEPLOYMENTS_E2E_ORGANIZATION_ID=<organization-id>
export DEPLOYMENTS_E2E_PROJECT_ID=<project-id>
export DEPLOYMENTS_E2E_ENVIRONMENT_ID=<environment-id>
export DEPLOYMENTS_E2E_IDENTITY_ISSUER=https://auth.example.com
export DEPLOYMENTS_E2E_IDENTITY_USERNAME=e2e@example.com
export DEPLOYMENTS_E2E_IDENTITY_REDIRECT_URI=<one of platform_identity_web_redirect_uris>
export DEPLOYMENTS_E2E_AGENT_EMAIL_DOMAIN=agents.example.com
export DEPLOYMENTS_E2E_WEBHOOK_URL=https://e2e-receiver.example.com/webhooks
# Load DEPLOYMENTS_E2E_IDENTITY_PASSWORD, DEPLOYMENTS_E2E_IDENTITY_CLIENT_SECRET,
# and the fixture secrets from your secret store.
bun run e2e:live
```

Read the `deployments-e2e` client secret with
`aws ssm get-parameter --name /identity/e2e-oauth-client --with-decryption --query Parameter.Value --output text`.

## Isolation, cleanup, and leftovers

- Each test registers a finalizer immediately after creating a resource, and
  finalizers run in reverse dependency order. A resource that is already gone
  counts as cleaned up; any other cleanup failure fails the test.
- The platform lifecycle proof creates a unique `e2e-<uuid>` project and
  environment and archives them at the end. Feature proofs create unique agents,
  grants, spaces, memories, webhooks, schedules, and heartbeats in the fixed
  project and environment and archive or revoke them.
- Shared state the suite changes, such as the organization's Agent Email policy
  or the environment model policy, is restored by a finalizer.
- Runs, threads, messages, events, model invocations, artifacts, usage records,
  and audit events stay in the configured organization. With the bootstrapped
  retention policy the daily sweep removes them after 7 days; records without a
  retention class (usage meter events, spend ledgers, counters, idempotency
  records, and configuration) remain.
- The governance proof runs in a disposable organization. It completes one run
  there, waits for its trace, downloads and hashes the tenant export, verifies
  the audit archive's hash chain and embedded ECDSA signature, then erases the
  organization. It requires the erasure summary to report deleted ClickHouse
  and Iceberg rows with `physicalRemovalBy` and `backupsExpireBy` boundaries,
  a memory search `backupsExpireBy` about 14 days and 1 hour after completion,
  and stale credentials to receive `organization_erased`. Audit objects stay
  under their 365-day Compliance Object Lock after the erasure. The erasure
  waits for the memory search purge tasks and the observability drain, which
  can take 55 minutes, so the test allows 75 minutes. If the test fails, its
  finalizer requests the erasure again without waiting, and the dispatch sweep
  finishes it.
- The Brain proof erases its Brain. Brain erasure waits through a quiescence
  window before it completes; the test allows 60 minutes.

## Slack sandbox

```sh
DEPLOYMENTS_E2E_API_URL=https://api.example.com \
DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE=https://api.example.com \
DEPLOYMENTS_E2E_CHANNEL_API_URL=<channel_provider_api_endpoint output> \
DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL=<the same value> \
DEPLOYMENTS_E2E_ORGANIZATION_ID=<organization-id> \
DEPLOYMENTS_E2E_PROJECT_ID=<project-id> \
DEPLOYMENTS_E2E_ENVIRONMENT_ID=<environment-id> \
DEPLOYMENTS_E2E_IDENTITY_ISSUER=https://auth.example.com \
DEPLOYMENTS_E2E_IDENTITY_USERNAME=e2e@example.com \
DEPLOYMENTS_E2E_SLACK_AGENT_USERNAME='E2E Agent' \
DEPLOYMENTS_E2E_SLACK_CHANNEL_ID=C0123456789 \
DEPLOYMENTS_E2E_SLACK_TEAM_ID=T0123456789 \
DEPLOYMENTS_E2E_SLACK_USER_GROUP_ID=S0123456789 \
DEPLOYMENTS_E2E_SLACK_USER_ID=U0123456789 \
bun run e2e:slack-live
```

Export `DEPLOYMENTS_E2E_IDENTITY_PASSWORD`, `DEPLOYMENTS_E2E_SLACK_BOT_TOKEN`
(`xoxb-`), `DEPLOYMENTS_E2E_SLACK_USER_TOKEN` (`xoxp-`, different from the bot
token), and `DEPLOYMENTS_E2E_SLACK_SIGNING_SECRET` from your secret store first.

Use a dedicated Slack app installation, channel, user, and empty user group. The
proof asks Slack for the user group's members and aborts unless there are none.
It then enables the group if needed (restoring its previous state afterwards),
creates a disposable agent and Slack binding, stores the channel credential
through the encrypted credential API, and posts a seed message. It sends a
correctly signed Events API envelope to the deployed ingress, after checking
that an invalid signature is rejected, requires the user-group ID in the
canonical message metadata, and verifies that the streamed reply uses the
configured agent username while keeping the parent app's `bot_id`.

The user token needs `channels:history`, `usergroups:read`, and
`usergroups:write`: Slack does not let bot tokens change user groups or read
those thread replies. The binding itself uses the bot token.

The signed envelope is synthesized by the test, so the proof covers signature
verification and downstream ingestion, not delivery from Slack. Slack does not
allow `chat.delete` for messages posted with `chat:write.customize`, so each
successful run leaves one customized reply in the sandbox channel. All other
platform resources, the seed message, the credential, and the user-group state
are cleaned up.

### Channel API target check

The Slack and Telegram proofs send platform and provider credentials to the
channel provider API, so they accept `DEPLOYMENTS_E2E_CHANNEL_API_URL` only
when it is a credential-free HTTPS API Gateway origin
(`https://<id>.execute-api.us-east-2.amazonaws.com`, no path, port, query, or
fragment) and `DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL` equals it exactly. Take
the value from the installation root's `channel_provider_api_endpoint` output.
The check accepts only `us-east-2` origins.

## Telegram sandbox

```sh
DEPLOYMENTS_E2E_API_URL=https://api.example.com \
DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE=https://api.example.com \
DEPLOYMENTS_E2E_CHANNEL_API_URL=<channel_provider_api_endpoint output> \
DEPLOYMENTS_E2E_ALLOW_CHANNEL_API_URL=<the same value> \
DEPLOYMENTS_E2E_ORGANIZATION_ID=<organization-id> \
DEPLOYMENTS_E2E_PROJECT_ID=<project-id> \
DEPLOYMENTS_E2E_ENVIRONMENT_ID=<environment-id> \
DEPLOYMENTS_E2E_IDENTITY_ISSUER=https://auth.example.com \
DEPLOYMENTS_E2E_IDENTITY_USERNAME=e2e@example.com \
DEPLOYMENTS_E2E_TELEGRAM_CHAT_ID=123456789 \
bun run --cwd packages/e2e test:telegram-live
```

Export `DEPLOYMENTS_E2E_IDENTITY_PASSWORD` and
`DEPLOYMENTS_E2E_TELEGRAM_BOT_TOKEN` (the BotFather token, `<bot id>:<secret>`)
first. `DEPLOYMENTS_E2E_TELEGRAM_CHAT_ID` is the positive private-chat ID of a
sandbox user who has sent `/start` to the bot; it is also used as the
synthesized sender ID.

The proof confirms the bot with `getMe`, creates a disposable chat agent and a
`telegram` binding pinned to the bot ID, stores `botToken`, `botId`, and a fresh
random `webhookSecret` through the encrypted credential API, and registers the
binding's ingress URL with `setWebhook`. A bot cannot send itself an update, so
the test posts a synthesized private-chat update to the deployed ingress: a
wrong `X-Telegram-Bot-Api-Secret-Token` must get `401` and the correct one
`202`. It then requires the chat-triggered run and its ingress metadata, the
run's channel delivery to reach `sent`, and Telegram to accept `deleteMessage`
for the recorded message ID, which proves the reply exists and removes it.
Cleanup deletes the webhook (dropping pending updates), revokes the credential,
and archives the binding and agent.

Because the webhook is replaced and then deleted, never point this proof at a
bot that serves anything else.

There is no Microsoft Teams sandbox proof: Teams ingress authenticates with Bot
Framework JWTs that only Microsoft can sign, so the test cannot synthesize a
valid request. The package tests cover Teams token verification, activity
normalization, streaming, and delivery with test-signed tokens.

## Provider OAuth

This proof needs an operator at a browser: the provider's authorization code is
bound to the one-time state the platform issues, so a pre-captured code or token
cannot be used. Before the first run:

1. Register a GitHub OAuth App whose callback is
   `<channel_provider_api_endpoint>/public/provider-connections/oauth/callback/github`.
   GitHub's hosted MCP server (`https://api.githubcopilot.com/mcp/`) accepts only
   pre-registered clients.
2. Register the client once in the test environment and keep the returned ID:

   ```sh
   deployments oauth-app register --name "GitHub E2E" --provider github --client-id <client-id> --client-secret-env GITHUB_OAUTH_CLIENT_SECRET --scopes read:user,repo --redirect-uri <callback-url> --registration '{"method":"pre_registered","tokenEndpointAuthMethod":"client_secret_basic"}'
   ```

   The claim on that client ID is permanent in the environment, so the proof
   reads this application and never creates or archives one.

```sh
DEPLOYMENTS_E2E_API_URL=https://api.example.com \
DEPLOYMENTS_E2E_ALLOW_DESTRUCTIVE=https://api.example.com \
DEPLOYMENTS_E2E_ORGANIZATION_ID=<organization-id> \
DEPLOYMENTS_E2E_PROJECT_ID=<project-id> \
DEPLOYMENTS_E2E_ENVIRONMENT_ID=<environment-id> \
DEPLOYMENTS_E2E_IDENTITY_ISSUER=https://auth.example.com \
DEPLOYMENTS_E2E_IDENTITY_USERNAME=e2e@example.com \
DEPLOYMENTS_E2E_GITHUB_OAUTH_APPLICATION_ID=<oauth-application-id> \
bun run --cwd packages/e2e test:provider-oauth-live
```

The proof checks that the application is active with a client secret, creates a
disposable workspace, calls `POST /v1/connections` for `github`, and asserts
that the authorization URL carries the registered client ID and redirect URI,
an S256 PKCE challenge, `resource=https://api.githubcopilot.com/mcp/`, and
tenant-bound state. It prints the URL and waits for a new active connection from
this application. Open the URL as the sandbox GitHub user and approve it; the
deployed callback exchanges the code.

The proof then requires `mcp_discovery` verification, syncs the connection's
tools, and requires GitHub's `get_me` tool to sync as the read adapter
`github.get_me`. It grants `tools:read` to the workspace, deploys an agent that
pins the grant, requires a successful, policy-allowed `github.get_me` call, and
finally revokes the connection and requires the grant to be revoked with it.
Synced tool adapters are environment-scoped, so `github.get_me` stays in place
and later runs reconcile it.

`DEPLOYMENTS_E2E_PROVIDER_OAUTH_AUTHORIZATION_TIMEOUT_MS` sets the consent wait
in milliseconds: an integer from 60000 to 540000, default 300000. The ceiling
stays below the ten-minute authorization-attempt expiry.

## Adding a public operation

A new public operation needs, in the same change:

1. The route in the canonical public route contract and its OpenAPI schemas.
2. An executable CLI command or an explicit built-in CLI mapping.
3. Its authentication, scope, idempotency, error, request, and response
   classification.
4. Focused domain tests for its state transition or failure invariant.

The contract suite fails when OpenAPI or CLI route coverage diverges. The public
surface suite then fails if the deployed gateway did not publish the route or if
the route answers without authentication.

## Effect and Vitest versions

The repository uses `effect@4.0.0-beta.92`, and this package pins
`@effect/vitest@4.0.0-beta.92` to match. The stable `@effect/vitest` release
targets Effect 3; do not substitute it without a repository-wide Effect
upgrade.
