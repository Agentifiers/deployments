# `@deployments-ai/db`

Private DynamoDB data layer for the platform.

The package defines the canonical `pk`, `sk`, `itemType`, and nested `data`
record envelope for all platform items. Optional `gsi1*`, `gsi2*`, and `ttl`
attributes are the only additional top-level fields.

All platform-owned resource identifiers are ULIDs. `Ulid` is an Effect Schema,
and `makeIdGenerator().generate()` returns monotonic ULIDs synchronously.

The persistence API is Promise-based. `DynamoDatabaseService` methods and every
domain repository or facade exported here return Promises that reject with
`DatabaseError` or `RecordDecodeError` (or the facade's own typed error);
`getRecord` resolves `undefined` for a missing item. Effect is an internal
implementation detail of the client, not part of the exported contract.
Effect-native callers lift a call with `fromDatabase(() => database.getRecord(...))`,
which keeps database failures in the typed error channel and turns any other
rejection into a defect; always pass a thunk so retries and interruption re-run
or cancel the call.

## Tables

- `control`: tenant hierarchy, principals, global uniqueness claims, providers,
  agents, deployments, policies, memory governance, inbox configuration,
  schedules, and integration configuration.
- `identity`: expiring signup registrations, public-email deduplication markers,
  and rate limits; password credentials; security state; browser and BFF
  sessions; OAuth clients, authorization codes, device grants, and refresh
  tokens. Access is limited to the identity runtime; verified-registration
  transactions may also create principal and uniqueness-claim records in
  `control`.
- `execution`: threads, messages, runs, tools, approvals, artifacts, jobs,
  leases, sandbox host/provider recovery metadata, delivery attempts, and
  runtime coordination.
- `identity-email-outbox`: `identity-email-delivery` records (verification,
  password, invitation, and security notices) that the identity email worker
  sends from the table's stream.
- `events`: replayable semantic events, identity security events, audit,
  idempotency, delivery state, checkpoints, deduplication, and replay
  coordination.
- `usage`: raw meter events, sharded counters, aggregates, spend, storage,
  inbox usage, rate limits, and budgets.

`RECORD_SCHEMAS`, `RECORD_TYPES_BY_TABLE`, and `ACCESS_PATTERN_REGISTRY` are the
versioned source of truth. Unknown data read from DynamoDB is decoded through
Effect Schema before it reaches application code.

Use `withCanonicalRecordKeys` when constructing records. Reads and writes reject
items whose base or secondary-index keys do not match their tenant, aggregate,
identity, status, and time fields. Mutations use full validated record puts;
partial DynamoDB update expressions are intentionally not exposed. The one
exception is the request-admission store described at the end of this file.

Direct puts and transaction puts without `previousRecord` are create-only.
Updates provide the previously decoded record, advance its integer `version` by
exactly one, and use an optimistic condition against the stored version.
Transaction deletes carry full records rather than arbitrary keys so ownership,
canonical keys, versions, and uniqueness invariants can be checked.

Customer-visible mutations add a `semantic-event` put to the same transaction
as the resource mutation (`src/semantic-event-storage.ts`, wrapped by
`@deployments-ai/events`). The `events` table record is the transactional
outbox and replay log;
consumers do not infer public events from arbitrary control, execution, or usage
table stream records.

Semantic events are append-only and numbered per aggregate. An event at version
N lands only after the aggregate's earlier writes. `semanticAggregatesOf` in
`src/semantic-aggregate-identity.ts` names the aggregates each stored record
holds: by default its item type and `data.id`, with explicit entries for records
that name their aggregate otherwise (an organization member by `principalId`, an
identity provider, an egress allowlist, and a Brain search placement by
`organizationId`, a model provider credential by `credentialId`, memory search
provisioning as
`memory-search-operation`, standing and its suspension, governance operations by
`kind`, and the snake_case evaluation and email aggregate types). When the same
transaction updates that record from its `previousRecord`, or deletes it at its
version, the record's version condition orders the event and the event put is
create-only. Otherwise the database layer adds a condition check that event N - 1
exists, even when another record that shares the aggregate id is written.
Governance retention deletes semantic events older than the organization's
`events` period, so a record that has not changed within that period has no
surviving event, and its record version, not its event history, orders its next
write. Semantic events other than a thread's carry an item TTL for that period
(see Retention TTL below), so DynamoDB removes them on the same schedule. A new
record type whose aggregate is not its item type and `data.id`
needs an entry in `semanticAggregatesOf`.

Feature persistence is grouped by domain beneath `src/`. Governance owns its
retention, export, and erasure orchestration, while `src/governance/` owns the
DynamoDB repository, transaction fencing, record decoding, and authoritative
transactional tenant inventory.
Likewise, `src/credential-vault/` owns the canonical credential records,
conditional DynamoDB writes, and KMS envelope persistence; the
`@deployments-ai/credential-vault` package exposes feature-facing contracts and
provider OAuth value helpers without constructing DynamoDB commands.
`src/webhooks/` owns webhook delivery persistence: endpoint discovery through
quota-slot claims and the environment's active-endpoint index (and, for
organization and project billing alerts, the organization resource index
`control.organization-resources`, re-reading each endpoint consistently),
create-only
`webhook-delivery` records, versioned delivery transitions guarded by the
endpoint still being active, immutable `webhook-delivery-attempt` records
partitioned by delivery, and endpoint health transitions with their semantic
events. Both webhook records carry `retentionExpiresAt` and a matching `ttl`.

`src/apps/domains.ts` owns `app-domain` records, keyed
`ORG#<org>#APP#<appId>` / `APP-DOMAIN#<domainId>` with a random ULID id that is
never reused. A record carries `hostname`, `attachedBy`, a 32-hex `token`, an
`appSlot`, and `state`: `unverified`,
`verified { verifiedAt, slot, problem, certificateSearches? }`, or
`active { verifiedAt, activatedAt, slot, problem, certificateSearches? }`.
`problem` is `null` or `{ code, message, observedAt, rejectedCreates? }`, with
`rejectedCreates` = `{ count, latestAt }`, and `certificateSearches` is a list of
`{ startedAt, endedAt }`. `AppHostname` stops at
236 characters so the proof name `_deployments-app.<hostname>` fits in 253.
`appClaimRequirements` derives its claims from that state. Every record holds
`app:<appId>:domain-slot` = `String(appSlot)`, which caps an app at
`APP_DOMAIN_LIMIT` (10), and `app:<appId>:domain-hostname` = `<hostname>`, so
attaching a hostname the app already holds returns the existing record. A
`verified` or `active` record also holds the global `app-hostname` claim and an
`app-domain` organization capacity slot. An unverified record therefore claims
no hostname, and the first organization to prove ownership wins.
`domainForHostname` reads the `app-hostname` claim and returns the domain that
holds it, in whichever app. Proof is the
TXT record `_deployments-app.<hostname>` = `deployments-app=<token>`, checked
through `dns-ownership-proof.ts`, which login domains share with the
`deployments-login` prefix. Every attach, verify, and detach transaction
condition-checks the app's stored `status`: attach and verify need
`provisioning` or `active`; detach also admits `failed`, `archived`, and
`erasing`. Each write emits an `app.domain.attached`, `app.domain.verified`, or
`app.domain.detached` event on the `app-domain` aggregate. `eraseApp` refuses
while any `app-domain` remains.

The domain reconciler reads and writes through `AppDomainReconciliation`.
`listPublishedDomains` queries the single `UNIQUE#app-hostname` claim partition,
which holds exactly the verified and active hostnames, and reads each owner with
a consistent get, so it never scans. `activateDomain` moves `verified` to
`active`, keeping `certificateSearches`, and condition-checks that the app is
`provisioning` or `active`. `recordDomainProblem` sets or clears `problem`, and
writes again when only `problem.rejectedCreates` or `problem.observedAt`
changes: the reconciler counts consecutive tenant creates the edge rejected
there, with the time of the latest, and backs off from that time, and restates
a certificate budget refusal on a later day, which leaves `rejectedCreates`
as it was. `recordCertificateSearches` replaces `state.certificateSearches`,
the `startedAt` and `endedAt` of each tenant create that did not create the
tenant and whose certificate the reconciler has not tagged yet, and omits the
field when the list is empty. All three are full puts with `version + 1` that
emit `app.domain.activated`, `app.domain.problem_recorded` (with the `problem`
code and the `rejectedCreates` count), `app.domain.problem_cleared`, or
`app.domain.certificate_searches_recorded` (with the number of searches), and
all three resolve `undefined` when a concurrent write won, so the next run
decides again. `takeCertificateRequest` spends one TLS
certificate request of the organization and one of the platform for the current UTC day
in one transaction. Each budget is a `rate-limit-counter` in `usage` with `limitKey`
`app-domain.certificate-request`, the day as `window`, and `expiresAt` at the next 00:00
UTC; the organization's is scoped to its id, the platform's to the zero ULID. A take reads
both counters consistently, answers `organization-spent` or `platform-spent` without writing
when a count has reached its limit, and otherwise puts both with `version + 1` (or creates
them at version 0), conditioned on the versions it read. A take that loses that race reads
again, up to three times.

`src/brains/upload-repository.ts` reserves Brain upload quota when it issues a ticket and
releases it when the upload completes. The reservation adjusts `rate-limit-counter` records in
`usage` scoped to the caller, the Brain, and the organization, so concurrent uploads in one
Brain race on the same counters. Each write reads the counters, puts them with `version + 1`
in the ticket transaction, and when the transaction is cancelled because a counter moved,
reads them again and retries, up to eight attempts with jittered backoff. Each retry of an
issue uses its own `ClientRequestToken`.

`src/apps/sessions.ts` owns the hash-keyed `app-login-transaction`,
`app-login-handoff`, and `app-session` records in the identity table. Each carries
`host`, the slug host or a custom hostname, which decodes as the slug host when absent.
The handoff copies the login's host, `redeemLoginHandoff` refuses a request from any
other host with `other-host`, and the session it creates keeps that host.

Provider OAuth records carry the client binding used for vendor-hosted MCP
servers. `oauth-authorization-attempt` stores `oauthClientId`,
`oauthClientRegistration` (`pre_registered`, `client_id_metadata_document`, or
`dynamic_client_registration`), `oauthIssuer`, and `oauthIssParameterSupported`
as immutable identity; `provider-connection` copies the client id, registration
method, and issuer at callback. A `provider-application` may record its
`registration` (`pre_registered` or issuer-bound `dynamic_client_registration`
with a token endpoint auth method); its secret uses the existing
`provider-application` credential-vault owner type. Besides the permanent
client-id claim, an active dynamic registration holds the
`environment:<env>:provider-application-registration:<providerKey>` claim on its
issuer, released once the application is archived or disabled.
`makeOAuthRefreshClaimPersistence(database)` serializes token refreshers with an
`execution` `oauth-refresh-claim` keyed
`ORG#<org>#ENV#<env>` / `OAUTH-REFRESH-CLAIM#<connectionId>#<credentialGeneration>`:
`acquire` creates the claim (TTL = lease `expiresAt`), reports `held` while a
live claim exists or a conditional race is lost, and takes over a logically
expired claim with a versioned replacement; `release` deletes only the caller's
own claim.

Generic send-only email uses `makeEmailPersistence(database, scope)` with exact
`organizationId`, `projectId`, and `environmentId`. Its canonical `email-tenant`
and `email-domain` records are separate from inbox resources. Creates accept
full `{ itemType, data }` records at version 1; updates accept the current
expected version and atomically advance it alongside a scoped semantic event.
Provider identity fields and domain/tenant ownership are immutable.
Tenant listing uses the scoped base partition; domain listing uses an exact
scope-and-tenant GSI partition. Both return bounded pages and scope-bound
cursors without post-query filtering. Reads used for sending, including the
global domain-claim lookup, are strongly consistent.
Pending email domain registrations do not reserve the global namespace.
Verified ownership acquires the existing global `inbox-domain` claim in the
same transaction as the resource/event update. Revocation blocks sends
immediately but keeps an existing claim until owned provider cleanup succeeds.
`completeDomainRevocation` then writes `revocationCompletedAt` and releases the
claim with its full owner condition in one transaction; retrying completion
cannot delete a successor's claim. A revoked record cannot be reactivated,
but the domain may be registered and verified by a new record after cleanup.
The canonical transactional governance directory inventories both resources
and their ownership claims.

Spend budgets live under `src/budgets/` in the `usage` table. A `budget` governs
exactly one organization, project, environment, or workspace and is keyed
`ORG#<org>` / `BUDGET#<id>`; GSI1
`ORG#<org>#BUDGET-SCOPE#<ORGANIZATION|PROJECT#<id>|ENV#<id>|WORKSPACE#<id>>`
/ `BUDGET#<status>#<id>` finds the active budgets governing a scope.
`scope-spend-shard` counters (`ORG#<org>#SPEND#<scope>` /
`SCOPE-SPEND-SHARD#<period>#<periodStart>#<shard>`) are advanced by the usage
materializer in the same transaction as the hourly counters, for every level of
the meter event's scope chain: its workspace when it names one, then its
environment, project, and organization. One scope's spend for one period is a
strongly consistent query of at most 16 items. A workspace budget, its periods,
and its threshold events carry the workspace's environment and project as well.
`budget-period` (`ORG#<org>#BUDGET#<budgetId>` / `BUDGET-PERIOD#<periodStart>`)
records notified thresholds; each threshold is appended with a version-guarded
write in the same transaction as its `budget.threshold-crossed` event, so
concurrent evaluators emit it once. `makeBudgetPersistence` owns budget CRUD
and period history; `findExhaustedBudget` is the run-admission check.
`src/usage-scope.ts` owns the scope levels: `SCOPE_LEVEL_IDS` lists the
identifier fields each level carries, ancestors included. A `ScopeTarget` names
one level with those fields, and `scopeChain` lists the targets of a run's or
meter event's `UsageScope`, most specific first. Budgets, spend shards, and
their keys all derive from it.

Monitors live under `src/monitors/`. `kinds.ts` is the closed registry of
monitor kinds: each names its scope (environment or organization), its source
(`window-count`, `one-shot`, `current-state`, or `hot-plane`), the semantic
event types that wake it, and its matcher. In `control`, a `monitor` and its
`monitor-state` share the organization partition (`ORG#<org>` /
`MONITOR#<id>` and `MONITOR-STATE#<id>`), so one strongly consistent query
lists every monitor an event can wake. A live monitor is also on GSI1
`MONITOR-SWEEP#<00-15>` / `MONITOR#<org>#<id>` for the scheduled evaluator.
`monitor-state` is the one record evaluators race on: `state-machine.ts`
decides at most one transition (fire, renotify, or resolve) from a fresh read,
and `transition-commit.ts` writes the incident, the state at its version, and
the `alert.*` semantic event in one transaction, so retries and concurrent
evaluations open one incident. In `events`, `monitor-signal`
(`ORG#<org>#MONITOR#<id>` / `MONITOR-SIGNAL#<occurredAt>#<eventId>`, with a
TTL) is one counted event, keyed by the event so a redelivery counts once, and
`monitor-incident` (`ORG#<org>#MONITOR#<id>` / `MONITOR-INCIDENT#<id>`, GSI1
`ORG#<org>#MONITOR-INCIDENTS` and GSI2 `ENV#<env>#MONITOR-INCIDENTS` by
`openedAt`) is the alert history with its timeline. A member's
`alert-notification-preference` (`ORG#<org>` /
`ALERT-NOTIFICATION-PREFERENCE#<principal>`) stops all alert email or mutes
monitors, and `alert-email-delivery` (`ORG#<org>` /
`ALERT-EMAIL-DELIVERY#<eventId>#<principal>`, with a TTL) claims one email
before it is sent, so a retried alert event emails nobody twice.
`makeMonitorPersistence` owns monitor CRUD, signals, transition commits, and
sweep pages, `evaluation.ts` evaluates monitors for an event or a sweep,
`makeAlertHistory` reads incidents, and `makeAlertDeliveryPersistence` resolves recipients
and claims emails.

A `meter-event` records who paid in its `funding` dimension: `operator`, or
`organization` with the organization's `modelCredentialId`. The record schema
refuses any other combination, and an event without the dimension is
operator-funded. `meterEventFundingDimensions` writes the dimension and
`meterEventFunding` reads it. Each spend shard counts every priced event in
`spendUsdMicros` and organization-funded events again in
`organizationFundedUsdMicros`, in the same transaction, so customer budgets keep
reading total spend. A shard written before that field existed has none, and its
spend is operator-funded. `readMonthSpend(database, organizationId, target,
asOf, month?)` returns the spend of one scope target (`{ scope: "organization" }`
for the whole organization) for `month` (a `SpendMonth`, `YYYY-MM`), or for the
UTC month containing `asOf` when omitted, as
`{ totalUsdMicros, operatorFundedUsdMicros, organizationFundedUsdMicros,
periodStart, asOf }` from one strongly consistent read of its monthly shards.
`requestedSpendMonth(requested, now)` parses a caller's `YYYY-MM` and refuses
one after the month containing `now`. The organization and workspace spend
routes both read through it, with `{ scope: "organization" }` or the
workspace's `ScopeTarget`.

A `meter-event` names the workspace of the run, sandbox lease, or request that
produced it in `workspaceId`, and the record schema refuses a run's meter event
whose `observability.workspaceId` names a workspace that `workspaceId` does
not. Meter events stored before events named their workspace have only the run
context, so they do not decode. The deploy pipeline's
`migrateMeterEventWorkspaces` stage, after `migrateGovernanceInventoryShards`,
waits until every invocation of replaced Lambda code (the last writer of such
events) has ended, then runs `migrateMeterEventWorkspaces` from
`scripts/platform-deploy/meter-event-workspaces-migration.ts`. Meter events
live in their environment's partition (`ORG#<org>#ENV#<env>` /
`METER-EVENT#<idempotencyKey>`), so it lists the governed organizations and
each one's environments (control GSI1 `ORG#<org>` / `ENVIRONMENT#`, archived
ones included) and queries each environment's meter events, never scanning the
table. It puts each event it finds back with `workspaceId` copied from
`observability.workspaceId`, after the result decodes, on condition that the
stored `data` is unchanged and the item has no `ttl`. A rerun finds only the
events not yet rewritten. A sweep that left no changed event writes the
`deploy-migration` marker `meter-event-workspaces`, and a later deploy reads
only the marker. Counters are not touched: the materializer counts `INSERT`s
only, and those events were counted, without a workspace, when they were
written. The observability normalizer skips the rewrites' `MODIFY` records,
whose old images do not decode.

An `artifact` carries two index entries, which
`makeArtifactIndexPersistence` reads. The run index (`gsi1`,
`ORG#<org>#RUN#<run>#ARTIFACTS` / `ARTIFACT#<status>#<updatedAt>#<id>`) groups
a run's artifacts. The environment index (`gsi2`, `ENV#<env>` /
`ARTIFACT#<createdAt>#<id>`) orders every artifact of an environment by
creation time, so download links and retention changes, which bump
`updatedAt`, do not move an artifact in a newest-first list, and a creation
window is a key range. Artifacts stored before the environment index sorted by
creation keep `ARTIFACT#<status>#<updatedAt>#<id>`, which `decodePlatformRecord`
accepts and which sorts after every timestamp, so an open-ended environment
list still shows them and a `createdBefore` bound leaves them out. The deploy
pipeline's `migrateArtifactCreationIndex` stage, after
`migrateMeterEventWorkspaces`, waits until every invocation of replaced Lambda
code (the last writer of the old key) has ended, then runs
`migrateArtifactCreationIndex` from
`scripts/platform-deploy/artifact-creation-index-migration.ts`. It reads each
governed organization's environments' artifact partitions
(`ORG#<org>#ENV#<env>` / `ARTIFACT#`) and puts each artifact with the old key
back with the canonical `gsi2sk`, on condition that `data` and `gsi2sk` are
unchanged. An artifact that changed during the sweep already carries the new
key, or is read again by the next deploy. A sweep that left no changed artifact
writes the `deploy-migration` marker `artifact-creation-index`.

An `attributed-usage-counter-shard` holds one attribution's share of an hourly
usage counter, with the token splits of its events in `parts`. `ATTRIBUTIONS`
lists the attributions: `agent`, whose `attributionId` is the agent definition
the event's run executed, and `workspace`, the workspace the event names. The
usage materializer advances the counters of each attribution an event has in the
same transaction as the environment counters, in the environment counters' shard. It is keyed
`ORG#<org>#ENV#<env>` /
`ATTRIBUTED-USAGE-COUNTER-SHARD#<AGENT|WORKSPACE>#<attributionId>#<metric>#<bucket>#<shard>`,
where `attributedCounterKeyParts` maps each attribution to its label, so one
attributed id's metric is one key range. The usage and cost summaries read one
attribution's counters for `agentDefinitionId` or `workspaceId`. It has no metric index keys, because
it would share its metric's index partition with the environment counters.

Channel ingress burst state lives under `src/channel-ingress/`. A route is the
exact binding, provider/account/workspace, channel/thread, and executor identity.
Versioned burst heads sequence accepted source messages; adjacent messages from
one sender share a quiet window, while a sender change seals the prior burst.
Expiring source and prepared-burst records preserve each provider message ID and
normalized payload. A permanent, minimal per-source claim is created in the same
transaction, so a provider replay cannot create a second turn after transient
burst retention or under a different grouping. Consumers submit prepared bursts
in conversation order and mark each one complete only after the idempotent
conversation turn succeeds.
Retries load that immutable prepared burst instead of depending on an SQS batch
being reconstructed the same way.
Each accepted source owns a delayed command on the dedicated ingress-flush
queue. When an earlier command observes that a later source extended the quiet
window, it schedules another command for the stored due time before completing.
Receipt timestamps detect conversational gaps, while flush deadlines run from
durable staging so an ingress backlog cannot prematurely split a rapid burst.
That independent trigger closes the gap where the later source committed its
new due time but its queue send did not succeed. Staging transactionally seals
the current bounded burst before accepting a source beyond its quiet window or
size limits, so accepted sources cannot grow one head without bound.

Sandbox integrations use `@deployments-ai/sandbox-hosts`. Its managed service
stores versioned `sandbox-lease` records and writes terminal sandbox capacity
usage as idempotent `meter-event` records in the same transaction as the final
lease mutation and semantic event. Provider, pool, and external sandbox IDs are
also protected by a transactional global identity claim before a lease becomes
allocated. Requested memory/vCPU minima are stored separately from provider
reserved capacity so allocation reconciliation replays the original request.
`preferredRegion` is persisted before the provider create so allocation
reconciliation replays it. `recoveryExternalSandboxId` preserves an
allocation that could not yet be claimed, while `usagePendingThrough` freezes
the original accounting cutoff across segmented usage commits.
Renewable `runtime-lease` records serialize sandbox provider operations across
workers. Optimistic owner/version checks protect renewal and release. They are
not TTL-deleted or automatically taken over after logical expiration because
the current sandbox hosts cannot reject a stale provider request; stale records
and records retained after lease-loss or interruption require provider-side
confirmation and explicit operator recovery. Normal release deletion is retried
and reconciled so a clean operation cannot silently leave a permanent lock.
Thread-persistent sandboxes keep one versioned `sandbox-workspace` record per
(thread, agent deployment) at `ORG#<organizationId>#THREAD#<threadId>` /
`SANDBOX-WORKSPACE#<agentDeploymentId>` through
`makeSandboxWorkspacePersistence`. It references the current `sandbox-lease`
and the latest private `/workspace` archive (bucket, key, S3 version, lowercase
hex SHA-256, 1 B–5 GiB) stored under `organizations/<organizationId>/`.
Governance retains the record with its thread and deletes the pinned snapshot
object version with it. Tenant export includes the record and its snapshot
reference but not the archive bytes.

A `generation-reasoning` record in `execution` stores the signed reasoning of
one tool-calling generation of an agent run. Its key is
`ORG#<organizationId>#RUN#<runId>` / `GENERATION-REASONING#<modelCallIndex>`
with the index zero-padded to 16 digits. The record stores the run and thread,
the `producerModelId` and `producerAttemptId` of the model invocation that
returned the reasoning, and `reasoningDetails`, the provider's reasoning blocks
in the form the runtime replays them. `GenerationReasoningDetails` accepts a
non-empty list of maps whose string `type` starts with `reasoning.` and whose
JSON is at most `MAX_GENERATION_REASONING_BYTES` (64 KiB). The package exports
that schema and limit so callers validate reasoning before they write it. The
record has no version and never changes. `generationReasoningCreateOperation`
builds its only write, a create-only transaction put. The agent worker adds that
put to the pause or requeue transaction whose run update first counts the
generation in its model continuation. The run therefore counts every generation
that has a record, and a repeated boundary fails on the run version.
`listRunGenerationReasoning` reads one run's records in model-call order with a
strongly consistent, paged query and fails if a record in the partition names
another scope. Governance erases the record with its thread and expires it
under the `runs` retention class. The record has no API projection, no semantic
event, and no entry in the environment activity index.

A `runtime-log-batch` record in `execution` stores up to 50 lines the runtime
logged during one claimed execution of a run. Its key is
`ORG#<organizationId>#RUN#<runId>` /
`RUNTIME-LOG-BATCH#<attempt>#<batch>`, both zero-padded to 8 digits, so a
partition query returns batches in execution order. Each line has a `time`, a
`level`, a `source` from `RUNTIME_LOG_SOURCES`, a message of at most 2,000
characters, a `sequence` within the batch, and optional `spanId`, `toolCallId`,
and up to 16 scalar `attributes`. The batch records the run's `captureMode`;
the worker has already shaped its lines to that mode. `expiresAt` and `ttl` are
`createdAt` plus `RUNTIME_LOG_RETENTION_DAYS`, the hot-plane span retention.
Batches never change. `makeRuntimeLogPersistence(database).appendBatch` writes
one with a create-only put and treats an existing batch as a retried flush.
`listRunBatches` reads one run's unexpired batches in order, optionally from a
given attempt and batch, and fails if a record in the partition names another
scope. Governance erases batches with their thread and classes them under the
`runs` retention class. Batches have no semantic event and no entry in the
environment activity index; `GET /v1/runs/{runId}/logs` projects their lines.

A `tool-call` record that a model generation requested names that generation:
`modelCallIndex` is the run's model-call index and `modelAttemptId` is the
`attemptId` of the `model-invocation` attempt whose result requested the call.
`ToolCallRecord` requires both fields or neither; tool-plan calls carry neither.
The fields survive checkpoints because the runtime keeps them on the model
continuation's tool requests. Every new `model-invocation` record stores its
`modelCallIndex` and `invocationKind` (`assistant` or `response-depth`); both
are optional only because records written before them lack them.

A `brain-duplicate-pass` record in `execution` remembers the last completed
duplicate-document pass of one Brain. Its key is `ORG#<organizationId>#BRAIN#<brainId>`
/ `BRAIN-DUPLICATE-PASS`. It stores `contentFingerprint`, a SHA-256 over the
document id and current content version id of every active document in listing
order, and `duplicateGroups`, the number of groups that pass found. Document
versions are immutable, so an unchanged fingerprint means the pass would find
the same groups. Content maintenance lists the Brain's documents, compares the
fingerprint, and reads document versions only when it differs.
`recordBrainDuplicatePass` creates the record or advances it by version from the
record the pass read, in a transaction that checks the Brain is still active at
the version the pass read. It resolves `false` without writing when that check
fails or a concurrent pass wrote first. The record has no semantic event, no
secondary index, and no retention class. Brain erasure deletes it through the
Brain inventory.

A `memory-index-verification-pass` record in `control` remembers where one
scheduled memory scope's index verification walk over one search target stands.
Its key is `ORG#<organizationId>#ENV#<environmentId>` /
`MEMORY-INDEX-VERIFICATION-PASS#<targetId>#<workspaceId|ENVIRONMENT>`. It
stores `cutoff`, the instant before which the pass's index states were last
updated, `indexStatus`, the status range of the target's
`control.memory-search-target-operations` partition the walk is in (`deleted`,
then `ready`, then `suppressed`), and `resumeAfter`, the `pk`, `sk`, `gsi2pk`,
and `gsi2sk` of the last state the walk read, which a query passes as its
`ExclusiveStartKey`. The walk reads states of every environment in the target
and resumes past them on the next run instead of re-reading them, so it needs
no index keyed by environment. `memoryIndexStatePosition` reads that position
from a state. `recordMemoryIndexVerificationPass` creates the record or
advances it by version from the record the walk read, and resolves `false`
without writing when a concurrent walk wrote first. The walk writes it before
queuing the slice it read, so the write is the walk's claim on that slice. The
record has no semantic event and no retention class; tenant erasure deletes it
through the organization inventory.

A `memory-search-index-drop-receipt` record in `control` proves that an
operator dropped a suspended organization's own memory search indexes while the
organization kept its rows. Its key is `ORG#<organizationId>` /
`MEMORY-SEARCH-INDEX-DROP-RECEIPT`, one per organization. It stores `indexes`,
the non-empty list of dropped index names, `droppedAt`, and `operatorHold`, the
hold that authorized the drop: its `id` (`operator/<key>`), `reason`, and
`placedAt`. `recordMemorySearchIndexDrop` creates it with a create-only put and,
when a receipt already exists, returns the stored one unchanged.
`readMemorySearchIndexDropReceipt` reads it strongly consistent. The record is
not a gate source and has no semantic event, because the drop is an operator
action on infrastructure, not a change to a customer resource. Its tenant
locator makes organization erasure delete it with the organization. Nothing
else removes or rewrites it, so a later drop for the same organization answers
from it and deletes nothing.

TTL is asynchronous cleanup only. A record with logical expiration also stores
an `expiresAt` field inside `data`, and callers must enforce that field before
claiming or using the record.

Unique slugs, addresses, credential hashes, and external identities use a
`unique-claim` item in the `control` base table. The claim and owning resource
must be written in one transaction using `UNIQUE_CLAIM_CONDITION`. Updates with
an unchanged unique value condition-check the existing claim owner; changes and
deletes conditionally release the previous claim in the same transaction. GSIs
are lookup projections and never enforce uniqueness.

## Retention TTL

`RETENTION_TTL_CLASS_BY_ITEM_TYPE` (`src/governance/contracts.ts`) names the
item types DynamoDB TTL expires instead of governance retention deletes:
`memory-recall-attempt`, `memory-retrieval`, `brain-query-attempt`, and
`brain-retrieval` under the `runs` class, and `semantic-event` under `events`.
`makeDynamoDatabase` sets `ttl` on every put of one of these types to its
retention deadline plus `RETENTION_TTL_GRACE_SECONDS` (48 hours), in whole
seconds. The deadline is the retention timestamp (`governanceRecordTimestamp`:
`createdAt`, or `occurredAt` for an event) plus its organization's class period.
It reads the organization's `retention-policy` record once per transaction,
strongly consistent, after the transaction has validated, and uses the default
period when the organization has none. A rewrite is stamped again from the
policy in force at that write. Callers do not set this `ttl`; no `data` field
mirrors it, because a semantic event's `data` is its published EventBridge
detail.

Records retention keeps for active work get no TTL and stay with retention:
a thread's semantic events (the thread's next event-only append also
condition-checks the previous event), telemetry that names a `runId` or
`threadId`, and a recall or query attempt still `running`.

The record's inventory locator carries the same `ttl`. A listing treats a
locator whose `ttl` has passed as absent and reads neither it nor its record,
because DynamoDB TTL can take days to remove both. Readers of the telemetry
types (retrieval feedback, Brain query feedback, memory quality) treat a record
whose `ttl` has passed as absent. So a TTL'd record stays visible for up to the
grace past its deadline; retention's daily sweep already kept records up to a
day past theirs. Semantic event version lookups read the physical item,
because a version that still exists cannot be reused.

Retention skips a TTL'd record whose `ttl` is at or before its deadline plus
the grace, and reads and deletes one only when the organization has since
shortened the period. Records written before their type carried a TTL have
none, and retention deletes them as before.

When a retention policy update lengthens `runs` or `events`, the same
transaction writes a `retention-restamp` record (`ORG#<org>` /
`RETENTION-RESTAMP#<org>`), replacing any pending one. Its `dueAt` is
`RETENTION_RESTAMP_START_DELAY_MILLISECONDS` (15 minutes) after the commit, by
which every write that read the earlier policy has committed, so the restamp
sees every record stamped with the shorter period. The record sits on the
`control.governance-dispatch-due` index, and the one-minute dispatch sweep
queues it once due. The governance worker claims it by moving `dueAt` 15
minutes ahead, then pages the inventory: first the TTLs that fall within the
grace, then the rest. For each record whose `ttl` is below the current policy's
deadline plus grace it puts the record with the raised `ttl` (conditioned on the
`ttl` and version it read) and its locator in one transaction, then checkpoints
the cursor and renews `dueAt`. A crashed run resumes from its last checkpoint
once `dueAt` passes. A checkpoint conditioned on the record's `version` and
`policyVersion` stops a run that a newer lengthening replaced. The last page
deletes the record. A restamp costs about 8 to 10 write units per raised record
(a transactional put of the record with its two GSIs and of its locator).

## Identity providers and directory sync

`src/identity-federation/` owns one `organization-identity-provider` record per
organization in `control`, keyed `ORG#<org>` /
`ORGANIZATION-IDENTITY-PROVIDER#oidc`. The `oidc` in the key is
`IDENTITY_PROVIDER_SLOT`, named before SAML existed, so changing it is a data
migration. The single key keeps an organization to one provider of either
protocol. `data` is a union. The OIDC arm holds `clientId`, the sealed
`clientSecret`, `clientSecretSetAt`, `endpoints`, an `https:` `issuer`,
`signingAlgorithms`, and `tokenEndpointAuthMethod`, and leaves `protocol` out
(rows written before SAML have none, and OIDC writes still omit it). The SAML
arm has `protocol: "saml"`, the entity ID as `issuer` (at most 512 characters),
`singleSignOnUrl`, one to four `signingCertificates` with `certificate`,
`notAfter`, and `sha256Fingerprint`, `unsolicitedSignIn` (`disabled` or
`enabled`), and optional `metadataUrl` and `emailAttribute`.
`identityProviderProtocol` reads the protocol of either arm. Grants, links,
and link requests store the issuer as `FederationIssuer`, a non-empty string
that holds an OIDC issuer URL or a SAML entity ID.

An IdP-initiated SAML sign-in waits for the browser's confirmation in an
`identity-federation-unsolicited-sign-in` record in `identity`, keyed
`IDENTITY-FEDERATION-UNSOLICITED-SIGN-IN#<tokenHash>` for both `pk` and `sk`,
where `tokenHash` is the SHA-256 of the browser's token. The record is a union
on `status`. A `pending` record holds the asserted `claims` (`email`,
`emailDomain`, `issuer`, `subject`, and an optional `displayName`) and
`returnTo`. A `consumed` record drops them. `recordUnsolicitedSignIn` refuses
an assertion whose `IssueInstant` is more than
`UNSOLICITED_RESPONSE_MAX_AGE_MS` (300 seconds plus 60 seconds of clock skew)
older than the time it observes, and returns `stale`. A pending record can be
confirmed for 300 seconds after its `createdAt`. `expiresAt` is the later of
that deadline and the `IssueInstant` plus 480 seconds, the acceptance window
plus another 60 seconds of skew and a 60-second margin. The record owns an
expiring `saml-assertion` claim whose value is `assertionKey`, the SHA-256 of
the issuer, a NUL, and the assertion ID. The claim copies the record's
`expiresAt` and `ttl`, so the claim outlives every instant at which the
assertion is still fresh, and consuming the record keeps the claim until it
expires. `recordUnsolicitedSignIn` checks freshness, then writes the record
and the claim in one transaction, observed at the same instant, and a second
write for the same assertion loses the claim and returns `replayed`.

`src/directory/` owns SCIM provisioning. `organization-directory` is keyed
`ORG#<org>` / `ORGANIZATION-DIRECTORY#<org>`, and its `id` is the organization
ID because token-hash claims need a ULID owner. It holds `defaultRole`
(`member` or `viewer`) and `tokens`, at most `MAX_DIRECTORY_TOKENS` (2) as a
schema check. Each token has `id`, `createdAt`, `createdBy`, `tokenPrefix`, and
`tokenHash`, the hex SHA-256 of the bearer secret, and holds the global
`directory-token-hash` claim on that hash. SCIM authentication resolves a
token through that claim, and concurrent token writes serialize on the
record's `version`. `organization-directory-user` is keyed `ORG#<org>` /
`ORGANIZATION-DIRECTORY-USER#<principalId>`, with the principal ID as its `id`.
It holds the SCIM `userName`, an optional `externalId` (each at most 256
characters), and `origin`: `provisioned` when SCIM created the principal, or
`adopted` when SCIM mapped an existing one. `origin` never changes. Provenance
lives on this record rather than on the global principal, so organization
erasure forgets it. The record claims
`organization:<org>:directory-user-name` with the SHA-256 of the lowercased
`userName`, and `organization:<org>:directory-external-id` with the SHA-256 of
the `externalId`, so long values fit in a claim key. Updates and deletes
condition on `organizationId`, `id`, `userName`, and `externalId`. SCIM
`DELETE` deletes the record with its claims and removes the membership.
Directory records have no retention class and live until organization erasure.

## Account email change and deletion

`principal-email-change` is a person's own change of their primary email, in
`identity`, keyed `PRINCIPAL#<principal>` / `PRINCIPAL-EMAIL-CHANGE#<principal>`
with the principal ID as its `id`. One record per principal means a new request
replaces the old one with an exact-version put. `data` is a union on `state`.
`pending` holds `newEmail`, `expiresAt`, the `credentialVersion` it was proven
under, and `tokenHash`, the SHA-256 of the link sent to the new address. It is
void once `expiresAt` passes or the credential version moves. `applied` holds
`previousEmail`, `newEmail`, `appliedAt`, `reportTokenHash` for the notice sent
to the old address, and `reportExpiresAt`. `reported` records that the old
address reported the change, with `emailRestored` false when someone else had
claimed the old address meanwhile. `cancelled` and `reported` are terminal. The record has no TTL, so its version history survives every
transition.

Applying a change replaces the `principal` with `principalEmailReplacement`,
which acquires the new `principal-email` claim create-only and releases the old
one in the same transaction, so two people racing for one address cannot both
win. The same transaction advances `sessionEpoch` and the BFF fence with an
`identity.email-changed` security event, so every session, refresh token,
device grant, and app session issued under the old address ends.

Deleting an account writes `anonymizedPrincipal` in one transaction: the
`principal` becomes `archived` with no `primaryEmail`, `displayName`, or
`metadata`, its email claim is released, the security state's `sessionEpoch`
advances, and the fence becomes `archived` at the new epoch, with an
`identity.account-deleted` security event. Organization memberships are removed
first through `makeAccountStandingRepository().leave`, one organization at a
time with that organization's semantic events and audit entry, and it refuses
the last active owner with `last_owner_required`. The principal record stays as
a tombstone, so audit events and other records that name the principal ID keep
resolving to an archived principal with no personal data. Organization erasure
likewise keeps global principal records and drops only organization-owned
records.

## Organization capacity claims

`src/capacity/` counts each organization's running runs, active sandboxes,
and verified app domains with ordinary `unique-claim` items in `control`. A
slot is a claim in the namespace `organization:<org>:<claimName>` whose value
is `String(slot)`. `CAPACITY_RESOURCES` names the holders:

- A `run` holds a `run-execution-slot` while `status` is `running`. Its slot
  is `data.executionSlot`.
- A `sandbox-lease` holds an `active-sandbox-slot` while `computeUsageActive`
  is true or `status` is `resuming`. Its slot is `data.capacitySlot`.
- An `app-domain` holds an `app-domain-slot` while its state is `verified` or
  `active`. Its slot is `data.state.slot`, and the limit is the constant
  `ORGANIZATION_APP_DOMAIN_LIMIT` (50).

Feature code never writes capacity claims. The persistence companion
`withCapacityClaims` runs on every `transactWrite`. When a holder enters its
holding state, the companion adds the claim put. When a holder leaves that
state or is deleted, it adds the owner-conditioned claim delete. A claim
operation the caller already supplied is left alone. A transaction that puts a
holding record without its slot fails with
`<itemType>:<id> holds <resource> capacity without a slot.` `putRecord`
rejects a holding run or lease and any non-create run or lease update, because
a direct put has no `previousRecord` and could not release the claim.

`makeOrganizationCapacity(database).acquire` reads the claim partition with a
strongly consistent query and picks a random free slot in `[0, limit)`. It
then runs `commit(slot)`, the holder's own transaction that writes the holder
in its holding state, so the companion adds the claim to that transaction. A
commit that lost its slot to another holder retries with a fresh read. Any
other commit error propagates unchanged. While the claims in use reach
`limit`, `acquire` returns `at-capacity`. A lowered limit therefore admits
nothing until usage drops below it. `claims` returns each held slot with its
holder's id and key, which the sandbox manager uses to find stale holders at
the limit.

## Organization standing

`src/organization-standing/` records which sources hold an organization
suspended and which entitlement grants each source has set.

One `organization-standing` record per organization lives in `control` at
`ORG#<organizationId>` / `ORGANIZATION-STANDING`. A missing record means an
active organization on the installation defaults, so organization creation
writes nothing. `OrganizationRecord.status` is separate and unchanged. The
record's `data` holds:

- `suspension`, present exactly while a hold exists:
  `{ id, since, haltMode, holds }`, where `holds` is keyed `<source>/<key>`. A
  hold has a `reason` (`payment`, `abuse`, `policy`, or `manual`), a
  `customerMessage`, an optional operator-only `operatorNote`, `placedBy`,
  and `placedAt`. `haltMode` is `stop` while any hold's reason is `abuse`,
  `policy`, or `manual`, and `drain` otherwise. Every write that changes the
  holds writes it, and the record schema rejects a `haltMode` that the holds do
  not derive.
- `grants`: an optional `operator` grant and an optional `service` grant, each
  `{ entitlements, grantedBy, grantedAt }`. `entitlements` has optional
  `tenantLimits` and an optional `operatorFundedModelSpendCeiling`
  (`{ monthlyUsdMicros }` or `"unlimited"`).
- `dataBoundary`, present only while an operator has narrowed where the
  organization's data may go: `{ profile, operatorNote, setAt, setBy }`. The
  only profile is `phi`. `setBy` is an operator, so the schema rejects a
  boundary a service set. `operatorNote` holds the agreement reference and is
  never shown to members.

A source is `operator` or `service:<name>`, derived from the `StandingActor`
that the caller authenticated as. A source changes only its own holds and its
own grant. Releasing a key that another source holds, or changing the service
grant that another service owns, returns `refused` with the owning source and
writes nothing.

`makeOrganizationStandingRepository({ database, installDefaults })` exposes
`read` (pass `{ consistent: true }` for a strongly consistent read),
`readWithGrants`, `placeHold`, `releaseHold`, `setGrant`, `clearGrant`,
`setDataBoundary`, `clearDataBoundary`, and `listHistory`. `readWithGrants`
also returns the stored `dataBoundary` for system views. Only an operator sets
or clears the boundary; a service is `refused` with owner `operator`. Setting
the profile already set is `unchanged` and keeps the first note, and clearing
an absent boundary is `unchanged`. Holds and grants carry the boundary forward.
A command that would change nothing returns `unchanged` and writes nothing. A
change writes, in one transaction, the next standing version, an append-only
`organization-standing-change` record at
`ORG#<organizationId>` / `ORGANIZATION-STANDING-CHANGE#<version>`, and semantic
events. Every version appends `organization.hold-placed`,
`organization.hold-released`, `organization.entitlements-updated`,
`organization.data-boundary-set`, or `organization.data-boundary-cleared` to
the `organization-standing` aggregate at that version. The two boundary events
carry `{ profile, source }`. When the hold set crosses
empty, the transaction also appends `organization.suspended` (version 1) or
`organization.reinstated` (version 2) to the `organization-suspension`
aggregate named by the suspension id. A writer that loses the version
condition reloads and applies its command again, up to five attempts.
`listHistory` returns changes newest first and pages with `before`.

`effectiveStanding(stored, installDefaults)` is pure. It returns `active`, or
`suspended` with `suspendedAt` and the holds, and the effective entitlements.
`holdState(stored)` returns the same `active` or `suspended` state without
entitlements. `makeOrganizationHoldReader(database).read` reads it, for
callers that decide on holds alone, such as run admission and the worker's
claim.
Each entitlement field comes from the operator grant, then the service grant,
then the installation defaults. `effectiveModelSpendCeiling(stored,
installDefault)` applies that order to the ceiling alone. Plan `features`
(`sso`, `scim`) merge key by key the same way; the installation default is
`ALL_FEATURES_ENABLED`, so `InstallDefaults` carries no features and an
organization with no feature grant has every feature.

`readOperatorFundedModelSpend(database, organizationId, { asOf,
defaultCeiling })` returns `unlimited`, or the effective ceiling and the
operator-funded spend in the UTC month of `asOf`. It reads the standing record
strongly consistent and, only for a finite ceiling, queries the organization's
16 monthly spend shards strongly consistent. The token issuers and the model
gateway decide on it, so both apply the same ceiling. It rejects an
`organizationId` that is not a ULID.

`recordOperatorFundedSpendExhaustion(database, { ceiling, month,
organizationId })` emits `organization.operator-funded-spend-exhausted` the
first time the organization's operator-funded spend in `month` reaches a finite
ceiling. It writes a create-only `operator-funded-spend-exhaustion` claim at
`ORG#<organizationId>` / `OPERATOR-FUNDED-SPEND-EXHAUSTION#<YYYY-MM>` in the
same transaction as the event, which is version 1 of the
`operator-funded-spend-exhaustion` aggregate named by the claim's `id`. A writer
that loses the claim re-reads it and stops, so the event fires at most once per
organization and month. An `unlimited` ceiling writes nothing.

`data-boundary.ts` owns the one policy table. `dataBoundaryOf(stored)` maps no
boundary to the `open` profile, which admits every tool egress class
(`platform`, `configured`, `public`) and every model gateway provider, and maps
`phi` to `platform` and `configured` egress and `bedrock` models.
`EffectiveStanding.dataBoundary` is that derived boundary.
`boundaryAdmitsModel` normalizes the id first and refuses one that does not
normalize, including an empty or provider-only id.
`makeOrganizationDataBoundaryReader(database).read` reads the standing record
strongly consistent with no cache, and a read error propagates so callers fail
closed.

`egress-allowlist.ts` owns one `organization-egress-allowlist` record per
organization in `control` at `ORG#<organizationId>` /
`ORGANIZATION-EGRESS-ALLOWLIST`: `{ organizationId, entries, updatedAt,
updatedByPrincipalId, version }`, where each entry is `{ origin, note? }`. The
schema enforces `egressAllowlistIssues` from `egress-allowlist-rules.ts`: at
most 200 unique origins, each equal to its `normalizeEgressOrigin` form with no
path, query, credentials, or wildcard, and notes of 1 to 200 characters. A
missing record is an empty list at version 0.
`makeOrganizationEgressAllowlistRepository(database).replace` writes the whole
list sorted by origin: create-only at version 1, then a full put with
`previousRecord` at the next version. The same transaction appends
`organization.egress-allowlist-updated` `{ added, removed }` to the
`organization-egress-allowlist` aggregate named by the organization, at the
record's version. A replace whose origins and notes already match writes
nothing and returns `changed: false`. A writer that loses the version
condition reloads and applies its list again, up to five attempts.
`makeOrganizationEgressAllowlistReader(database).read` reads the entries
strongly consistent with no cache, and a read error propagates so callers fail
closed.

`organizationNotSuspendedCondition(organizationId)` returns a condition check
on the standing record that fails while `data.suspension` exists.
`organizationNotStoppedCondition(organizationId)` fails only while
`data.suspension.haltMode` is `stop`, so a payment-only suspension passes. The
worker adds the first to a queued run's claim and the second to every claim
renewal and reclaim. Any transaction may add either. Both pass when the record
is missing.

## Operator access

`src/operator-access/` records when a platform administrator may read and
change one organization's data. One `organization-operator-access` record per
(organization, principal) lives in `control` at `ORG#<organizationId>` /
`ORGANIZATION-OPERATOR-ACCESS#<principalId>`, so the authorizer reads it with
one strongly consistent `GetItem`. Its `data` holds `grantId`, `reason`, an
optional `ticket`, `openedAt`, `expiresAt`, and `state`, which is
`{ kind: "open" }` or `{ kind: "closed", closedAt }`. Expiry is derived from
`expiresAt` and never stored, so an expired grant needs no write to end.
`gsi2` (`GLOBAL#ORGANIZATION-OPERATOR-ACCESS` / `<state>#<expiresAt>#...`)
lists open grants across the install.

`lifecycle.ts` is pure: `operatorAccessStatus` returns `open`, `expired`, or
`closed`; `openOperatorAccess` renews an open grant in place (same `grantId`,
new `expiresAt`) and otherwise starts a new one; `closeOperatorAccess` closes
an open grant and returns nothing for the rest. Access lasts 60 minutes by
default and at most 480.

`makeOperatorAccessRepository({ database })` exposes `get`, `open`, `close`,
and `listOpen`. Opening refuses a missing organization (`organization_not_found`)
and an archived one (`organization_archived`). Each change writes, in one
transaction, the record, a semantic event on the
`organization-operator-access` aggregate, and an organization audit event:
`organization.operator-access-opened`, `-renewed`, or `-closed`. The record
keeps only the latest grant per pair; the audit log is the history of who had
access when.

`organizationAccess` in `src/identity-federation/access.ts` decides tenant
access. An active member is decided as a member first. A non-member platform
administrator is admitted only under an open, unexpired grant for the
organization, and is otherwise `operator-access-required`. The grant read runs
in parallel with the membership read and only for administrators. Audit actors
for administrators carry `operatorAccessGrantId`.

## Request admission: the partial-update exception

`src/request-admission/` stores each organization's API request rate state.
It is the only code in the repository that sends a partial `UpdateItem`, and
`tests/dynamodb-update-boundary.test.ts` fails when `UpdateCommand`,
`UpdateItemCommand`, or `updateItem(` appears anywhere else outside
`scripts/`.

Every admitted API request is one write, so the write has to be a single
atomic compare-and-advance. A canonical versioned put needs a read before
every write and loses races under concurrent requests from one organization.
The generic cell rate algorithm (GCRA) keeps one number per organization, its
theoretical arrival time `tat`, and a conditional `UpdateItem` advances it in
one round trip.

The state lives in a dedicated table, not in `TABLE_NAMES`. The table has
hash key `pk` (string) only, TTL attribute `ttl`, on-demand capacity, no
stream, and no GSI. Each item is
`{ pk: "ORG#<organizationId>", tat: <epoch microseconds>, ttl: <epoch seconds> }`.
The canonical envelope, record schemas, semantic events, and uniqueness
claims do not apply to it.

`makeRequestAdmissionStore({ client, tableName, requestTimeoutMs })` sends one
of two conditional writes, both with
`ReturnValuesOnConditionCheckFailure: ALL_OLD`:

- The idle write sets `tat = now + interval` if the item is absent or
  `tat < now`.
- The busy write sets `tat = tat + interval` if
  `now <= tat <= now + tolerance`.

A failed condition returns the stored `tat` without a read. That value either
rejects the request with `retryAtUs = tat - tolerance` or selects the other
write. The store makes at most three attempts within a 150 ms budget. A
timeout, a throttle, or a 5xx response raises `RequestRateStoreUnavailable`.
The limiter then admits the request and emits the `LimiterUnavailable`
metric. Each write sets `ttl` to `ceil(tat seconds) + 3600`.

Every API Lambda builds its limiter with
`makeOrganizationRequestLimiterFromEnvironment`, which reads
`DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE` and
`DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS`. The runtime IAM grant is
`dynamodb:UpdateItem` on that table's ARN and nothing else.

Tenant erasure does not delete these items. An item holds only the
organization ID and two timestamps. After erasure no credential for the
organization authenticates, so nothing advances `tat`, and DynamoDB TTL
removes the item asynchronously once `ttl` has passed, about an hour after
the organization's last admitted request.

## Organization creation fences

`src/tenancy/organization-creation-policy.ts` admits every organization create. A platform
administrator is exempt. Anyone else is refused with `email_verification_required` when the
policy requires a verified email and the invocation identity lacks `emailVerified` (the API sets it
from the access token's signed `email_verified` claim, so the fence reads nothing from `identity`),
with `organization_creation_held` while any organization where they are an active `owner` or
`admin` has an `organization-standing.suspension`, and with `organization_quota_reached` once their
count reaches `quotaPerPrincipal`. The count is one `principal-organization-creations` record per
principal in `control` at `PRINCIPAL#<principalId>` / `PRINCIPAL-ORGANIZATION-CREATIONS`, put in
the create transaction with its previous version, so concurrent creates serialize on it. A create
that loses that condition is admitted again, so the loser of a race for the last allowed
organization gets the quota refusal. Erasure never lowers the count.

`makePrincipalStatusRepository(database).setStatus` disables or re-enables a human principal. One
transaction puts the principal status, the BFF revocation fence, and, when disabling, the next
session epoch, with `identity.principal-disabled` or `identity.principal-enabled` and
`identity.sessions-invalidated` security events that name the acting administrator. A status that
is already set writes nothing. A lost version condition reloads and retries up to five attempts.
Only platform identity's principal status function runs it. The API sends that function a
`PrincipalStatusCommand` and reads its reply with `principalStatusOutcomeFromReply`, which turns a
reported refusal back into a `PersistenceError`; `makePrincipalStatusCommandHandler` is the
function's side.

`makePlatformPrincipalDirectory(database)` gives platform administrators person reads from the
`control` and `events` tables. `findByEmail` matches the email claim hash exactly. `get` adds the
person's memberships from `control` gsi2 `PRINCIPAL#<id>` / `ORGANIZATION-MEMBER#`, at most
`PRINCIPAL_MEMBERSHIP_READ_LIMIT` (100) with `membershipsCapped`, each joined to its organization.
`securityEvents` pages `events` gsi1 `PRINCIPAL#<id>#IDENTITY-SECURITY-EVENTS` newest first.
Reads of the `identity` table stay in platform identity: `makePrincipalSecurityRepository` describes
sign-in state (verified email, multi-factor state without secrets, and session and refresh family
counts of at most 100 each), finds a pending sign-up by email, and ends every session by advancing
the session epoch on the security state and the BFF fence with an `identity.sessions-invalidated`
event naming the administrator and reason. `makePrincipalCommandHandler` is the principal
function's side for both status changes and these commands, and `principalCommandReply` reads its
replies.

## Organization gate lanes

Six record types hold organization-wide state that tenant writes depend on: the
`organization`, its `erasure-fence`, its `memory-search-placement` and
`memory-search-mutation-fence`, its `memory-provider-mutation-gate` records, and
its `brain-search-placement`. They stay the source of truth. Each organization
also has `ORGANIZATION_GATE_LANE_COUNT` (32) `organization-gate-lane` records at
`ORG#<org>` / `ORGANIZATION-GATE-LANE#<00-31>` in `control`. Every lane holds the
same projection of those sources (`src/organization-gate/lanes.ts`).

A tenant transaction that changes no gate source checks one lane instead of the
sources. The lane condition requires that the lane exists and that no unexpired
erasure fence is held. `transactWriteForErasure` requires the owner's fence
instead. The lane index is a digest of the transaction's item keys, so two
unrelated writes in one organization share a lane with probability 1/32, and a
retried transaction sends the same lane. To depend on more organization-wide
state, add `organizationGateCheck(organizationId, requirement)` to the
operations. The database layer folds every such check for the organization into
the one lane check. `activeOrganizationCondition`, the Brain index enqueue, and
memory search routing use it.

A transaction that changes a gate source checks the sources and rewrites all 32
lanes in the same transaction. `transactWrite` reads the lanes and adds the lane
writes, each conditioned on the lane version it read. A change that leaves the
projection unchanged, such as an organization rename, writes no lanes.
Governance's raw-client writers (`beginErasure`, the claim policy of
`claimOperation`, `releaseErasureFence`, `deleteTenantRecords`, and
`finalizeErasure`) add the same writes through
`organizationGateLaneTransactItems` and `organizationGateLaneRepairItems`.
`finalizeErasure` deletes every lane and checks that the missing ones stay
absent. `putRecord` and `deleteRecord` refuse gate sources and lanes. Lanes have
no tenant locator, no secondary index keys, and no semantic event.

An organization without lanes refuses every tenant write. A gate change on such
an organization checks the sources and checks all 32 lanes absent, so a
reconcile that creates the lanes first cancels it instead of leaving the lanes
stale. The deploy pipeline runs
`scripts/platform-deploy/organization-gate-lanes-migration.ts` three times:
before any released code runs, after the Lambda release, and at the end of the
deploy once every invocation of replaced Lambda code has ended. That is the
latest, across every released function, of its last code update's completion
plus its timeout. A rerun counts the updates an earlier run made: it reads
`LastModified` from `list-functions` and allows 360 s for that update to have
finished. The last run copies gate
changes that replaced code made after the second run and creates lanes for
organizations it created. Each run creates missing lanes and rewrites stale
ones from the gate sources, in one transaction per organization that checks
every source it read is unchanged.

## Governance inventory shards

Every tenant record has a `governance-tenant-record` locator in `control` that
tenant export, erasure, and retention list. A locator lives at
`ORG#<org>#GOVERNANCE-INVENTORY#SHARD#<00-15>` /
`RECORD#<sha256(recordTable, recordPk, recordSk)>`. The shard is
`stableShard([recordTable, recordPk, recordSk], GOVERNANCE_INVENTORY_SHARD_COUNT)`,
so a record's locator always lands on the same one of 16 partitions and the
transaction that writes the record computes its locator key without a read.
A memory search writes one locator per record it stores (the recall attempt and
each retrieval). On a single partition, about 50 searches a second in one
organization passed DynamoDB's 1,000 write units per partition per second.
Sixteen partitions keep 100 searches a second near 150 write units per shard.

Code released before the shards lists only the legacy partition
`ORG#<org>#GOVERNANCE-INVENTORY`. A deploy turns shard writes on, and an
operator moves the legacy locators later, when they choose. Writers place
locators by a layout that `governanceInventoryLayout`
reads from the `deploy-migration` marker `governance-inventory-shard-writes`
(`GLOBAL#deploy-migration` / `DEPLOY-MIGRATION#governance-inventory-shard-writes`).
Without the marker the layout is `legacy`: every locator put and delete goes to
the legacy partition, exactly where replaced code reads it. With the marker it
is `sharded`. A process caches a `legacy` read for
`GOVERNANCE_INVENTORY_LEGACY_LAYOUT_CACHE_MILLISECONDS` (30 s) and a `sharded`
read for good, so every process stops writing the legacy partition within
`GOVERNANCE_INVENTORY_LEGACY_WRITES_END_MILLISECONDS` (60 s) of the switch.
`makeDynamoDatabase` reads the marker only for transactions that write a locator.
Every role that writes locators may `GetItem` the `GLOBAL#deploy-migration`
partition.

`listTenantRecords` pages the legacy partition first, then the 16 shards in
order, whatever the layout. The cursor's `tableIndex` names the partition: 0 is
legacy, 1 to 16 are the shards. A listing resolves legacy locators in place, in
either layout, and readers list both partitions until no legacy locator is
left. Once the layout is `sharded`, writers keep only shard locators, so a
legacy locator goes stale when its record is deleted or rewritten.
`resolveTenantInventory` moves only a legacy locator that no longer resolves to
its record. `reconcileTenantLocators` reads both locators, then the
canonical record, writes the shard locator the record defines now, and deletes
the legacy item. It does all of that in one transaction that checks both
locators are unchanged and the record still exists with the item type and TTL
it was read with. Every writer rewrites a record's locator in the transaction
that rewrites the record, so the locator conditions catch a rewrite that
changes the locator, and a record that is rewritten often still moves. A legacy
locator whose record is gone, or now belongs to another organization, is
deleted without a replacement. While the layout
is `legacy`, nothing moves, because replaced code may be paging the same
partition, and a stale legacy locator fails the listing closed.

Listings do not move every legacy locator they meet, because every
organization's daily retention run lists its whole inventory. A large
installation would move millions of locators within a day of the switch, from
`governance-worker` invocations that time out after 900 s. Each move costs two strongly consistent
reads and a three-item transaction, about 6 write units. Each move also holds
the record in a transaction, so a concurrent write to that record can be
cancelled.

A record can be listed twice: through its legacy locator and through the shard
locator a `sharded` writer added when it rewrote the record.
`allTenantRecords` and the Brain and thread erasure walks in
`@deployments-ai/governance` keep the first copy of each table and key across
all pages of one listing (`distinctTenantRecords`). Governance deletes (thread
and Brain erasure, retention staging and cleanup, fence release, erasure
finalization, and tenant erasure's unique-claim owners, runs, and gate sources)
delete a record's locator, and its run-locator and unique-claim locators, from
both partitions, whatever the layout. A delete placed by layout alone would
strand the other locator, and the next listing would fail closed on it. Tenant
erasure's ordinary deletes are the exception described next.

The deploy pipeline's `migrateGovernanceInventoryShards` stage runs after
`reconcileOrganizationGateLanes:final`. It waits until every invocation of
replaced Lambda code has ended (replaced ECS tasks stopped before the Lambdas
were published), writes the shard-writes marker, waits 60 s more for cached
`legacy` reads and their transactions to end, then runs
`recheckGovernanceInventoryShards` from
`scripts/platform-deploy/governance-inventory-shards-migration.ts`. A process
that still wrote the legacy layout just after the switch can delete or rewrite
a record whose locator another process already put on a shard. That shard
locator is then stale, and every listing of that organization fails closed on
it until it is re-checked. The stage runs `reconcileTenantShardLocators` for
every organization, then writes the `deploy-migration` marker
`governance-inventory-shard-recheck`. It never reads the legacy partition. The
shards hold only locators written since the switch, so the stage's work is one
query per shard per organization plus one record read per shard locator. A
later deploy reads only the marker. An installation whose earlier in-deploy
migration wrote `governance-inventory-shards` skips the re-check too, because
that migration re-checked every shard locator before writing it. A run that
fails part way writes no marker, and the next deploy re-checks every
organization again. Rerun a failed deploy soon, because the shards keep
growing after the switch.

`scripts/governance-inventory-migration.ts` moves the legacy locators. It
refuses to move anything until one of those two markers exists, and
`--dry-run` counts each organization's legacy locators and prices the move
first. It calls `moveTenantLegacyLocators`, which moves one organization's
legacy locators 100 per page with `reconcileTenantLocators` and yields each
page's estimated cost. A moved locator leaves the legacy partition, so a rerun
reads only the locators not moved yet and needs no cursor of its own. A run
over every organization that leaves no legacy locator writes the marker
`governance-inventory-shards`. Once every installation has that marker, the
layout read, the legacy listing phase, the stale legacy move on read, the
legacy IAM patterns, the script, and the re-check can be removed. Rolling back
to code from before the shards after the switch needs a reverse migration first,
because that code lists only the legacy partition.

## Tenant erasure deletes

Tenant erasure lists the inventory with `listTenantErasurePage` and deletes
each page with `eraseTenantRecords`, both only while the erasure holds the
organization's erasure fence, so no other writer can put a record or locator
back. A page reads up to `tenantErasurePageSize` locators (500 by default) and
strongly reads their records. It skips a locator whose own item TTL has passed,
because DynamoDB removes it and its record for free. It reports a locator whose
record is gone as stale, and fails closed on a locator that names another
organization's record. For each unique-claim owner or run it also reads the
claims and run locator its transaction will delete, keeping only the ones that
still exist and that it still owns.

`eraseTenantRecords` first checks that the caller's operation holds the fence.
A unique-claim owner, a run, or an organization-gate source keeps one
transaction with its claims (only those still present), run locator, or gate
lanes, because those pairs must change together. Every other record is an
ordinary delete. `BatchWriteItem` deletes the records, 25 per request with
`UnprocessedItems` retried with backoff, and only after every record of the call
is gone does it delete the locators the listing found for them and the stale
locators. A crash can therefore leave a locator without its record, which the
next listing reports as stale and the next call prunes, but never a record
without a locator. An ordinary record costs its own delete plus one delete per
locator found, about 4 write units for a 1 KB record with two GSIs, instead of
the 3 transactional deletes and about 8 write units of `deleteTenantRecords`.
