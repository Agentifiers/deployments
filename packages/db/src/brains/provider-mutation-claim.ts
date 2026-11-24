import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { BrainProviderMutationClaimRecord } from "../records/brain-search.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import type { BrainIndexJob } from "./index-job-lifecycle.ts";

export type BrainProviderMutationClaim = Extract<
  PlatformRecord,
  { readonly itemType: "brain-provider-mutation-claim" }
>;

export function committedBrainProviderMutation(claim: BrainProviderMutationClaim, now: string) {
  if (claim.data.status !== "active") {
    throw new TypeError("Only an active Brain provider mutation can complete.");
  }
  const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...data } = claim.data;
  return Schema.decodeUnknownSync(BrainProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      ...claim,
      data: {
        ...data,
        status: "committed" as const,
        updatedAt: now,
        version: claim.data.version + 1,
      },
    }),
  );
}

async function currentClaim(database: DynamoDatabaseService, job: BrainIndexJob) {
  const value = await database.getRecord(
    "control",
    {
      pk: key("ORG", job.data.organizationId, "DOCUMENT", job.data.documentId),
      sk: key("BRAIN-PROVIDER-MUTATION-CLAIM", job.data.targetId),
    },
    true,
  );
  return value?.itemType === "brain-provider-mutation-claim" ? value : undefined;
}

function priority(job: BrainIndexJob) {
  return job.data.operation === "suppress" ? 2 : 1;
}

function admissionConditions(job: BrainIndexJob): TransactionOperation[] {
  return [
    {
      conditionExpression: "#itemType = :itemType AND #data.#status = :active",
      expressionAttributeNames: {
        "#data": "data",
        "#itemType": "itemType",
        "#status": "status",
      },
      expressionAttributeValues: { ":active": "active", ":itemType": "brain" },
      key: {
        pk: key("ORG", job.data.organizationId),
        sk: key("BRAIN", job.data.brainId),
      },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression:
        "#itemType = :itemType AND #data.#version = :version AND #data.#status = :status",
      expressionAttributeNames: {
        "#data": "data",
        "#itemType": "itemType",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":itemType": "brain-index-job",
        ":status": "running",
        ":version": job.data.version,
      },
      key: { pk: job.pk, sk: job.sk },
      kind: "condition-check",
      table: "execution",
    },
    {
      conditionExpression: "#itemType = :itemType AND #data.#projectionGeneration = :generation",
      expressionAttributeNames: {
        "#data": "data",
        "#itemType": "itemType",
        "#projectionGeneration": "projectionGeneration",
      },
      expressionAttributeValues: {
        ":generation": job.data.expectedProjectionGeneration,
        ":itemType": "brain-document",
      },
      key: {
        pk: key("ORG", job.data.organizationId, "BRAIN", job.data.brainId),
        sk: key("BRAIN-DOCUMENT", job.data.documentId),
      },
      kind: "condition-check",
      table: "control",
    },
  ];
}

export async function claimBrainProviderMutation(input: {
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
  readonly now: string;
}) {
  const previous = await currentClaim(input.database, input.job);
  const nextPriority = priority(input.job);
  if (previous?.data.status === "active") {
    return {
      outcome: previous.data.leaseExpiresAt! > input.now ? ("busy" as const) : ("unknown" as const),
      claim: previous,
    };
  }
  if (previous?.data.status === "unknown") {
    return { claim: previous, outcome: "unknown" as const };
  }
  if (
    previous &&
    (previous.data.projectionGeneration > input.job.data.expectedProjectionGeneration ||
      (previous.data.projectionGeneration === input.job.data.expectedProjectionGeneration &&
        previous.data.mutationPriority >= nextPriority))
  ) {
    return { claim: previous, outcome: "stale" as const };
  }
  const claim = Schema.decodeUnknownSync(BrainProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      data: {
        brainId: input.job.data.brainId,
        createdAt: previous?.data.createdAt ?? input.now,
        documentId: input.job.data.documentId,
        jobId: input.job.data.id,
        leaseExpiresAt: input.leaseExpiresAt,
        leaseOwner: input.leaseOwner,
        mutationPriority: nextPriority,
        organizationId: input.job.data.organizationId,
        projectionGeneration: input.job.data.expectedProjectionGeneration,
        provider: input.job.data.provider,
        schemaGeneration: input.job.data.schemaGeneration,
        status: "active" as const,
        targetId: input.job.data.targetId,
        updatedAt: input.now,
        version: previous ? previous.data.version + 1 : 0,
      },
      itemType: "brain-provider-mutation-claim" as const,
    }),
  );
  await input.database.transactWrite([
    ...admissionConditions(input.job),
    {
      kind: "put",
      ...(previous ? { previousRecord: previous } : {}),
      record: claim,
    },
  ]);
  return { claim, outcome: "claimed" as const };
}

export async function completeBrainProviderMutation(input: {
  readonly claim: BrainProviderMutationClaim;
  readonly database: DynamoDatabaseService;
  readonly now: string;
}) {
  const committed = committedBrainProviderMutation(input.claim, input.now);
  await input.database.transactWrite([
    { kind: "put", previousRecord: input.claim, record: committed },
  ]);
  return committed;
}

export async function markBrainProviderMutationUnknown(input: {
  readonly claim: BrainProviderMutationClaim;
  readonly database: DynamoDatabaseService;
  readonly now: string;
}) {
  if (input.claim.data.status !== "active" || input.claim.data.leaseExpiresAt! > input.now) {
    throw new TypeError("Only an expired active Brain provider mutation can become unknown.");
  }
  const { leaseExpiresAt: _leaseExpiresAt, leaseOwner: _leaseOwner, ...data } = input.claim.data;
  const unknown = Schema.decodeUnknownSync(BrainProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      ...input.claim,
      data: {
        ...data,
        status: "unknown" as const,
        updatedAt: input.now,
        version: input.claim.data.version + 1,
      },
    }),
  );
  await input.database.transactWrite([
    { kind: "put", previousRecord: input.claim, record: unknown },
  ]);
  return unknown;
}

export async function resumeBrainProviderMutation(input: {
  readonly claim: BrainProviderMutationClaim;
  readonly database: DynamoDatabaseService;
  readonly job: BrainIndexJob;
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
  readonly now: string;
}) {
  if (
    input.claim.data.status !== "unknown" ||
    input.claim.data.jobId !== input.job.data.id ||
    input.claim.data.targetId !== input.job.data.targetId ||
    input.claim.data.projectionGeneration !== input.job.data.expectedProjectionGeneration ||
    input.job.data.status !== "running"
  ) {
    throw new TypeError("Only the same running Brain job may resume its unknown mutation tuple.");
  }
  const resumed = Schema.decodeUnknownSync(BrainProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      ...input.claim,
      data: {
        ...input.claim.data,
        leaseExpiresAt: input.leaseExpiresAt,
        leaseOwner: input.leaseOwner,
        status: "active" as const,
        updatedAt: input.now,
        version: input.claim.data.version + 1,
      },
    }),
  );
  await input.database.transactWrite([
    ...admissionConditions(input.job),
    { kind: "put", previousRecord: input.claim, record: resumed },
  ]);
  return resumed;
}
