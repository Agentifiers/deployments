import {
  MemoryProviderMutationClaimRecord,
  organizationGateCheck,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { memoryProviderMutationClaimKey } from "./placement.ts";

export type MemoryProviderMutationClaim = Extract<
  PlatformRecord,
  { readonly itemType: "memory-provider-mutation-claim" }
>;
type MemoryIndexJob = Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;

export const PROVIDER_MUTATION_AMBIGUITY_MS = 16 * 60_000;
const PROVIDER_MUTATION_REQUEST_MS = 5 * 60_000;
const PROVISIONING_EVIDENCE_REQUEST_SAFETY_MS = 60_000;

interface ProvisioningClaimIdentity {
  readonly database: DynamoDatabaseService;
  readonly operationId: Ulid;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
}

function claimIdentity(args: ProvisioningClaimIdentity) {
  return {
    messageGroup: `provisioning-evidence:${args.operationId}`,
    mutationTuple: `${args.operationId}:${args.targetId}:synthetic-evidence`,
  };
}

function indexJobAdmissionIdentity(job: MemoryIndexJob) {
  if (!job.data.targetId)
    throw new Error("Memory index admission requires a target-qualified job.");
  return {
    messageGroup: `index-job:${job.data.id}`,
    mutationTuple: JSON.stringify([job.pk, job.sk, job.data.idempotencyKey]),
    organizationId: job.data.organizationId,
    targetId: job.data.targetId,
  };
}

export async function currentMemoryIndexAdmissionClaim(
  database: DynamoDatabaseService,
  job: MemoryIndexJob,
) {
  const identity = indexJobAdmissionIdentity(job);
  const claimKey = memoryProviderMutationClaimKey(
    identity.organizationId,
    identity.targetId,
    identity.messageGroup,
  );
  const value = await memoryPersistence.read(database, "control", claimKey, true);
  if (value && value.itemType !== "memory-provider-mutation-claim") {
    throw new Error("Memory index admission claim identity is occupied.");
  }
  const claim = value as MemoryProviderMutationClaim | undefined;
  if (
    claim &&
    (claim.data.organizationId !== identity.organizationId ||
      claim.data.targetId !== identity.targetId ||
      claim.data.messageGroup !== identity.messageGroup ||
      claim.data.mutationTuple !== identity.mutationTuple)
  ) {
    throw new Error("Memory index admission claim does not match its job.");
  }
  return claim;
}

export function prepareMemoryIndexAdmissionClaim(
  job: MemoryIndexJob,
  now: Date,
  previous?: MemoryProviderMutationClaim,
) {
  const identity = indexJobAdmissionIdentity(job);
  if (previous && previous.data.status !== "failed") {
    throw new Error("Memory index admission claim is already active or completed.");
  }
  const timestamp = now.toISOString();
  const claim = Schema.decodeUnknownSync(MemoryProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      data: {
        attemptEpoch: previous ? previous.data.attemptEpoch + 1 : 0,
        claimAttemptId: `${job.data.id}:${job.data.version}`,
        createdAt: previous?.data.createdAt ?? timestamp,
        ...identity,
        status: "claimed" as const,
        updatedAt: timestamp,
        version: previous ? previous.data.version + 1 : 0,
      },
      itemType: "memory-provider-mutation-claim" as const,
    }),
  );
  const operations: TransactionOperation[] = [
    {
      kind: "put",
      ...(previous ? { previousRecord: previous } : {}),
      record: claim,
    },
  ];
  return { claim, operations };
}

export function prepareIndexJobOperations(
  job: MemoryIndexJob,
  now: Date,
  admissionRequired: boolean,
): TransactionOperation[] {
  return [
    {
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      kind: "put",
      record: job,
    },
    ...(admissionRequired ? prepareMemoryIndexAdmissionClaim(job, now).operations : []),
  ];
}

export async function prepareIndexAdmissionRequeue(
  database: DynamoDatabaseService,
  job: MemoryIndexJob,
  now: Date,
) {
  const previous = await currentMemoryIndexAdmissionClaim(database, job);
  return prepareMemoryIndexAdmissionClaim(job, now, previous).operations;
}

/**
 * Admission for a worker claim: keep a live admission claim, or re-admit a job that has none (its
 * producer ran without durable routing, or its last attempt failed) while the target gate is open.
 */
export async function prepareIndexJobClaimAdmission(
  database: DynamoDatabaseService,
  job: MemoryIndexJob,
  now: Date,
): Promise<TransactionOperation[]> {
  const identity = indexJobAdmissionIdentity(job);
  const current = await currentMemoryIndexAdmissionClaim(database, job);
  if (current?.data.status === "claimed") {
    return [
      {
        conditionExpression: "#data.#status = :claimed AND #itemType = :itemType",
        expressionAttributeNames: { "#data": "data", "#itemType": "itemType", "#status": "status" },
        expressionAttributeValues: {
          ":claimed": "claimed",
          ":itemType": "memory-provider-mutation-claim",
        },
        key: { pk: current.pk, sk: current.sk },
        kind: "condition-check",
        table: "control",
      },
    ];
  }
  return [
    organizationGateCheck(identity.organizationId, {
      kind: "memory-provider-gate-open",
      targetId: identity.targetId,
    }),
    ...prepareMemoryIndexAdmissionClaim(job, now, current).operations,
  ];
}

export async function prepareMemoryIndexAdmissionResolution(
  database: DynamoDatabaseService,
  job: MemoryIndexJob,
): Promise<TransactionOperation> {
  const previous = await currentMemoryIndexAdmissionClaim(database, job);
  if (!previous || previous.data.status !== "claimed") {
    throw new Error("Memory index job has no active admission claim.");
  }
  return { kind: "delete", record: previous };
}

export async function currentProvisioningEvidenceMutationClaim(args: ProvisioningClaimIdentity) {
  const { messageGroup, mutationTuple } = claimIdentity(args);
  const key = memoryProviderMutationClaimKey(args.organizationId, args.targetId, messageGroup);
  const value = await memoryPersistence.read(args.database, "control", key, true);
  if (value && value.itemType !== "memory-provider-mutation-claim") {
    throw new Error("Provisioning evidence mutation claim identity is occupied.");
  }
  const claim = value as MemoryProviderMutationClaim | undefined;
  if (
    claim &&
    (claim.data.organizationId !== args.organizationId ||
      claim.data.targetId !== args.targetId ||
      claim.data.messageGroup !== messageGroup ||
      claim.data.mutationTuple !== mutationTuple)
  ) {
    throw new Error("Provisioning evidence mutation claim does not match its target.");
  }
  return claim;
}

export async function acquireProvisioningEvidenceMutationClaim(
  args: ProvisioningClaimIdentity & {
    readonly now: Date;
  },
) {
  const { messageGroup, mutationTuple } = claimIdentity(args);
  const previous = await currentProvisioningEvidenceMutationClaim(args);
  if (previous && previous.data.status !== "failed") {
    throw new Error("Provisioning evidence already has an active or completed mutation claim.");
  }
  const timestamp = args.now.toISOString();
  const claim = Schema.decodeUnknownSync(MemoryProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      data: {
        attemptEpoch: previous ? previous.data.attemptEpoch + 1 : 0,
        ambiguityUntil: new Date(args.now.getTime() + PROVIDER_MUTATION_AMBIGUITY_MS).toISOString(),
        claimAttemptId: randomUUID(),
        createdAt: previous?.data.createdAt ?? timestamp,
        messageGroup,
        mutationTuple,
        organizationId: args.organizationId,
        status: "claimed" as const,
        targetId: args.targetId,
        updatedAt: timestamp,
        version: previous ? previous.data.version + 1 : 0,
      },
      itemType: "memory-provider-mutation-claim" as const,
    }),
  );
  await memoryPersistence.commit(args.database, [
    organizationGateCheck(args.organizationId, {
      kind: "memory-provider-gate-open",
      targetId: args.targetId,
    }),
    {
      kind: "put",
      ...(previous ? { previousRecord: previous } : {}),
      record: claim,
    },
  ]);
  return claim;
}

export async function acquireMemoryIndexMutationClaim(args: {
  readonly database: DynamoDatabaseService;
  readonly job: Extract<PlatformRecord, { readonly itemType: "memory-index-job" }>;
  readonly memoryId: Ulid;
  readonly mutationTuple: string;
  readonly now: Date;
  readonly organizationId: Ulid;
  readonly targetId: Ulid;
}) {
  if (
    args.job.data.status !== "running" ||
    !args.job.data.leaseOwner ||
    !args.job.data.leaseExpiresAt
  ) {
    throw new Error("Memory index mutation claim requires a leased running job.");
  }
  const messageGroup = `memory:${args.memoryId}`;
  const key = memoryProviderMutationClaimKey(args.organizationId, args.targetId, messageGroup);
  const value = await memoryPersistence.read(args.database, "control", key, true);
  if (value && value.itemType !== "memory-provider-mutation-claim") {
    throw new Error("Memory index mutation claim identity is occupied.");
  }
  const previous = value as MemoryProviderMutationClaim | undefined;
  if (
    previous &&
    (previous.data.organizationId !== args.organizationId ||
      previous.data.targetId !== args.targetId ||
      previous.data.messageGroup !== messageGroup)
  ) {
    throw new Error("Memory index mutation claim does not match its target.");
  }
  if (previous && (previous.data.status === "claimed" || previous.data.status === "ambiguous")) {
    const ambiguityUntil = previous.data.ambiguityUntil
      ? Date.parse(previous.data.ambiguityUntil)
      : Number.NaN;
    if (!Number.isFinite(ambiguityUntil) || ambiguityUntil > args.now.getTime()) {
      throw new Error("An earlier memory index mutation is still inside its ambiguity horizon.");
    }
  }
  const timestamp = args.now.toISOString();
  const claim = Schema.decodeUnknownSync(MemoryProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      data: {
        ambiguityUntil: new Date(args.now.getTime() + PROVIDER_MUTATION_AMBIGUITY_MS).toISOString(),
        attemptEpoch: previous ? previous.data.attemptEpoch + 1 : 0,
        claimAttemptId: `${args.job.data.id}:${args.job.data.attempt}:${args.job.data.leaseOwner}`,
        createdAt: previous?.data.createdAt ?? timestamp,
        messageGroup,
        mutationTuple: args.mutationTuple,
        organizationId: args.organizationId,
        status: "claimed" as const,
        targetId: args.targetId,
        updatedAt: timestamp,
        version: previous ? previous.data.version + 1 : 0,
      },
      itemType: "memory-provider-mutation-claim" as const,
    }),
  );
  await memoryPersistence.commit(args.database, [
    {
      conditionExpression:
        "#data.#version = :version AND #data.#status = :running AND #data.#leaseOwner = :leaseOwner AND #data.#leaseExpiresAt > :now AND #itemType = :jobType",
      expressionAttributeNames: {
        "#data": "data",
        "#itemType": "itemType",
        "#leaseExpiresAt": "leaseExpiresAt",
        "#leaseOwner": "leaseOwner",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":jobType": "memory-index-job",
        ":leaseOwner": args.job.data.leaseOwner,
        ":now": args.now.toISOString(),
        ":running": "running",
        ":version": args.job.data.version,
      },
      key: { pk: args.job.pk, sk: args.job.sk },
      kind: "condition-check",
      table: "execution",
    },
    {
      conditionExpression: "#data.#status = :claimed AND #itemType = :itemType",
      expressionAttributeNames: {
        "#data": "data",
        "#itemType": "itemType",
        "#status": "status",
      },
      expressionAttributeValues: {
        ":claimed": "claimed",
        ":itemType": "memory-provider-mutation-claim",
      },
      key: memoryProviderMutationClaimKey(
        args.organizationId,
        args.targetId,
        `index-job:${args.job.data.id}`,
      ),
      kind: "condition-check",
      table: "control",
    },
    {
      kind: "put",
      ...(previous ? { previousRecord: previous } : {}),
      record: claim,
    },
  ]);
  return claim;
}

export function providerMutationSignal(claim: MemoryProviderMutationClaim, now: Date) {
  const ambiguityUntil = claim.data.ambiguityUntil
    ? Date.parse(claim.data.ambiguityUntil)
    : Number.NaN;
  const requestDeadline = ambiguityUntil - PROVISIONING_EVIDENCE_REQUEST_SAFETY_MS;
  const remaining = requestDeadline - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error("Provisioning evidence mutation claim has no safe request horizon.");
  }
  return AbortSignal.timeout(Math.min(remaining, PROVIDER_MUTATION_REQUEST_MS));
}

export function resolveMemoryProviderMutationClaim(
  previous: MemoryProviderMutationClaim,
  status: "ambiguous" | "applied" | "failed",
  now: Date,
) {
  return Schema.decodeUnknownSync(MemoryProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        status,
        updatedAt: now.toISOString(),
        version: previous.data.version + 1,
      },
      itemType: "memory-provider-mutation-claim" as const,
    }),
  );
}
