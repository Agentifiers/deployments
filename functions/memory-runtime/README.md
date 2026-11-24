# Memory Runtime

This package deploys the memory API and workers:

- `api.ts`: JWT-protected memory API and active recall.
- `index-worker.ts`: selected-target index consumer.
- `flush-worker.ts`: post-run extraction consumer.
- `shadow-worker.ts`: same-target strategy comparison worker.
- `usage-worker.ts`: durable model-usage persistence retry.
- `reconcile.ts`: canonical DynamoDB versus selected-target repair.
- `operation-reconciler.ts`: due provisioning and index-job recovery.
- `operation-worker.ts`: stale-safe placement provisioning runner.
- `search-placement-worker.ts`: default search provisioning for new
  organizations.
- `index-dispatcher.ts`: semantic event to index queue dispatch.
- `cleanup-worker.ts`: blob and review-content cleanup.
- `erasure-worker.ts`: organization erasure and the index drop and retire
  commands.

Canonical content and lifecycle state live in DynamoDB. Each organization has
one `aws-native` placement that uses one OpenSearch index for dense, lexical,
exact, and entity retrieval. Runtime requests cannot override the
organization's placement, and OpenSearch failures fail closed without a
fallback search path.

Bifrost supplies profile-pinned embeddings, flush completions, and bounded
reranking. Model usage is written through `@deployments-ai/model-usage` with a
durable retry queue.

## Build

```bash
bun run --filter @deployments-ai/memory-runtime build
```

The deploy tool packages and uploads the artifact; see the
[deployment guide](../../apps/docs/content/docs/operate/deployment.mdx).

## Required Runtime Configuration

The OpenTofu module attaches:

- the platform DynamoDB tables;
- the Bifrost secret and private base URL;
- the versioned memory membership keyring;
- the stack-owned OpenSearch domain (AWS managed `aws/es` encryption; shared
  with Brain when `operations.shared_search_domain` is true) for dense,
  lexical, exact, and entity search, with IAM limited to `memory-*` indexes
  plus the cluster task and snapshot paths organization purge needs;
- SSE-SQS index, flush, strategy-shadow, usage, and provisioning queues;
  and
- optional VPC networking for private Bifrost access.

AWS-native target catalogs must match the deployment-owned 336-hour automated
snapshot retention and 60-minute safety margin, and their `openSearchIndex`
must start with `memory-`. OpenSearch credentials come only from the runtime
role, and target endpoints must match the OpenTofu-managed
`DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT`.

## Placement Provisioning

An organization is created with a non-serving `unconfigured` placement and
an `organization.created` event. EventBridge delivers that event to the
`memory-search-placement` queue, and `search-placement-worker.ts` provisions
the installation's default target:

- a per-organization embedding profile, generation, and dense component for
  `DEPLOYMENTS_AI_MEMORY_EMBEDDING_MODEL` at
  `DEPLOYMENTS_AI_MEMORY_EMBEDDING_DIMENSIONS`, whose identifiers are derived
  from the organization, search domain, model, and dimensions, so a retry
  reuses the same immutable catalog;
- the `memory-<organizationId>-v1` index on
  `DEPLOYMENTS_AI_MEMORY_OPENSEARCH_ENDPOINT`.

The worker requests provisioning and queues the action for
`operation-worker.ts`, which creates the index, verifies the dense, exact,
lexical, and cleanup evidence, and activates the placement. The activation
emits `memory.search-placement.activated`, which the Brain runtime uses to
activate the organization's Brain search. A placement in any other phase is
left unchanged, so redelivery is a no-op and an operator's choice is never
replaced.

Organizations created before an installation ran the placement worker keep an
`unconfigured` placement until the next deploy: the deploy tool's
`activateSearchPlacements` stage invokes the worker with
`{"organizations":"all"}` and follows `nextCursor` across every page, then does
the same for the Brain placement function. `{"organizationId":"<organizationId>"}`
activates one organization.

The control surface stays available for overrides, such as moving an active
organization to another target. `provision` on an active placement starts a
migration, the operation worker prepares the candidate once the reconciler
dispatches it, and `complete-migration` moves reads and writes to it:

```bash
DEPLOYMENTS_AI_MEMORY_MEMBERSHIP_KEYRING='{"currentVersion":1,"keys":{"1":"..."}}' \
bun run memory:search:control -- catalog ./catalog.json

bun run memory:search:control -- provision <organizationId> ./provision.json
bun run memory:search:control -- complete-migration <organizationId> <operationId>
```

The provisioning document's target must use provider ID `aws-native`.

Use `abort-provisioning <organizationId>` after classifying a provisioning
failure as permanent. It drains and purges the candidate before restoring the
organization to `unconfigured`, where a new target can be provisioned.
Automatic provisioning does not retry an aborted organization; invoke the
placement worker for it once the cause is fixed.

An active placement has one read target and one identical write target.

## Recovery

Provisioning progresses independently of an operator session. A five-minute
reconciler queries all due-operation shards, dispatches the exact action and
generation, and the worker strongly reloads and leases that generation.

The same reconciler scans queued, expired-running, and failed index jobs. It
strongly reloads each due job before redispatch and advances `nextDueAt` to
avoid a hot shard starving later work. Hosted FIFO queues receive a stable
message group; local standard queues omit FIFO-only fields.

Failed index jobs back off through `retryAt`: 5 seconds growing fourfold to a
6-hour cap. A delivery that arrives earlier does not claim the job. The worker
holds it until `retryAt` when that is at most five minutes away, and otherwise
acknowledges it and leaves the job to the reconciler. A hidden message blocks
its memory's FIFO group, so a failing job never delays a newer job for the same
memory by more than five minutes; the newer job then supersedes it. After 8
claims, or 2 claims when routing or placement
resolution rejects the target configuration (for example an unapproved
OpenSearch endpoint), the job stays `failed` with `skipReason`
`retries-exhausted` or `configuration-failure`, keeps its last `error`, and drops
out of the due-job projection, so no sweep redispatches it. A new memory version
creates a new job and indexes normally.

Canonical reconciliation traverses all memory pages and repairs only the
organization's selected target. It queues a job when a target has no index
state or a stale version or status, unless the newest job for the memory's
current version is still pending or terminally failed; that job owns the
version until it succeeds or the memory changes. It also applies retention,
deletes expired memories, and repairs tombstones. It never re-indexes a memory
only because its index state is old.

A policy write emits `memory.reconcile.requested` only when it changes the
effective retention or sensitivity mode, the two policy fields reconciliation
applies. An update that changes only retrieval settings, such as
`processingConfig` or active recall, starts no sweep. A new policy replaces
every field it inherits, so creating one can change effective retention and
start a sweep. Archiving a memory space also starts a sweep.

The schedule runs every five minutes for each scope in the optional
`reconciliation_scopes` module input. Each run sweeps the scope and then calls
`verifyIndexStates`, which re-indexes at most 50 memories whose settled index
state is older than 24 hours. The schedule therefore re-verifies at most 600
index jobs an hour per scope. Verification walks the search target's index
states oldest first and stores where it stopped in a
`memory-index-verification-pass` record, so each run resumes the walk. A run
claims its slice by advancing that record with a conditional write before it
queues any job, and queues nothing if another run of the scope advanced it
first, so a schedule event delivered twice queues each memory once. A pass
covers the states older than 24 hours when it starts. A run that reaches the
end of a pass leaves the record there, and the first run 15 minutes later,
Lambda's longest possible run, starts the next pass, so no run is still
queuing the end of the old pass. A run that dies after its claim leaves its
slice's index states old, and the next pass covers them again. The target's
partition holds every environment of the organization, so the walk also reads
other environments' states and moves past them. A run reads at most 5 pages of
100 states per target, so a large unscheduled sibling slows the walk but cannot
stall it. A memory whose current job can still run counts toward the 50. A
memory whose last job failed for good holds no slot and gets a fresh job once
the backoff that job's next retry would have waited has passed, 6 hours after
retries run out, and its turn comes again.

A scope that is not in `reconciliation_scopes` is never re-verified for age.
Its memories are re-indexed only when they change, when a policy change moves
their retention or sensitivity, or when a sweep finds their index state missing
or behind. Search does not depend on the schedule. Expired memories outside the
listed scopes stay hidden from search, but their content is deleted only when a
sweep reaches them.

## Membership And Erasure

OpenTofu creates a versioned membership HMAC keyring for internal provisioning
and erasure functions. Configure it through
`memory_runtime_membership_keyring`; never edit the deployed secret directly.
Retain historical keys until all records using that version are retired.

Organization erasure drains the selected target, verifies OpenSearch absence
and backup boundaries, and remains pending if any cleanup evidence is
incomplete.

When the organization alone owns the target's index, by the same check that
`drop-disabled-index` uses below, and nothing outside the target still uses the
index's catalog, erasure deletes the index before the purge. The purge then
finds the index absent and starts the backup wait after the deletion. The
purge receipt records `indexDrop` (`dropped` or `already-absent`), so the
erasure receipt digest covers it. Erasure then deletes the catalog records
that existed only for that index: its `memory-search-component` and
`memory-search-generation` records, every record in those generations'
membership and live partitions, the physical owner, the target identity, and
the organization's own `memory-embedding-profile`. Records that a retried
erasure no longer reads, such as stale generations an aborted provisioning
left at the same index, go first in transactions of 25 deletes. The
transaction that writes the erasure receipts deletes the rest, which are
bounded by the target's own components. A run that stops between transactions
finds the remaining records on its next attempt.

Erasure finds the organization's profiles by reading the
`GLOBAL#memory-embedding-profile` partition and keeping those whose
`gatewayRoute.routeScopeRef` is `organization:<organizationId>`, not through
the index's components. It retires such a profile only when no remaining
component names it and the organization's Brain search placement does not name
it. Governance purges memory before Brain, and default Brain search reuses the
memory target's profile, so tenant erasure keeps the profile of an
organization with Brain search. Once the erasure finishes, no placement is
left, and `retire-erased-index` retires that profile even though erasure
already removed the components. A run of the command that stops between
transactions finds the profile the same way on its next run. A shared index is
purged with delete-by-query and a force merge as before, and its catalog stays.

## Drop Or Retire An Organization's Index

`memory:search:control -- drop-disabled-index` and `retire-erased-index` invoke
`memory-erasure` to drop a held organization's index or retire one that an
older erasure left behind. The
[organization standing guide](../../apps/docs/content/docs/operate/organization-standing.mdx)
documents both commands, their refusals, and how to bring a held organization
back.

## Embedding Profiles

`gatewayRoute` contains the exact canonical JSON returned by
`modelGatewayRouteIdentity(resolveModelRoute(...))`. The runtime revalidates the
route, actual served model, dimensions, normalization, and processing boundary
before a vector can enter OpenSearch.
