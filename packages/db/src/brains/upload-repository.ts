import { setTimeout as sleep } from "node:timers/promises";
import type {
  BrainMutationCaller,
  BrainRepository,
  BrainUploadTicket,
} from "@deployments-ai/brains";
import { BrainUploadQuotaExceededError } from "@deployments-ai/brains";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  isDatabaseWriteConflict,
  makeDatabaseTransactionToken,
} from "../transaction-conditions.ts";
import { activeBrainCondition, activeOrganizationCondition } from "./authorization-conditions.ts";
import {
  activeBrainSourceCondition,
  activeBrainWriteGrantCondition,
  brainMutationCallerConditions,
} from "./knowledge-mutation-conditions.ts";
import { createBrainRecordOperations, updateBrainRecordOperations } from "./record-operations.ts";
import { githubConnectionAuthorization } from "./connector-authorization.ts";
import { brainAgentWriteConditions } from "./agent-write-authorization.ts";
import {
  brainGrantPlatformRecord,
  brainSourcePlatformRecord,
  brainUlid,
  brainUploadLeasePlatformRecord,
  brainUploadTicketFromPlatformRecord,
  brainUploadTicketPlatformRecord,
} from "./record-mapping.ts";
import { invariant } from "./repository-invariants.ts";
import { DEFAULT_BRAIN_UPLOAD_QUOTAS, type BrainUploadQuotas } from "./upload-quotas.ts";

type RateCounter = Extract<PlatformRecord, { readonly itemType: "rate-limit-counter" }>;

function rateCounter(
  organizationId: string | undefined,
  scopeId: string,
  limitKey: string,
  window: string,
  expiresAt: string,
): RateCounter {
  return withCanonicalRecordKeys({
    data: {
      count: 0,
      expiresAt,
      limitKey,
      ...(organizationId ? { organizationId } : {}),
      scopeId,
      version: 0,
      window,
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse(expiresAt) / 1_000),
  }) as RateCounter;
}

interface CounterAdjustment {
  readonly delta: number;
  readonly expiresAt: string;
  readonly limit?: number;
  readonly limitKey: string;
  readonly organizationId?: string;
  readonly scopeId: string;
  readonly window: string;
}

async function counterOperations(
  database: DynamoDatabaseService,
  adjustments: readonly CounterAdjustment[],
) {
  const identities = adjustments.map((input) =>
    rateCounter(input.organizationId, input.scopeId, input.limitKey, input.window, input.expiresAt),
  );
  const current = await Promise.all(
    identities.map(
      async (identity) =>
        await database.getRecord("usage", { pk: identity.pk, sk: identity.sk }, true),
    ),
  );
  return adjustments.map((input, index): TransactionOperation => {
    const identity = identities[index]!;
    const persisted = current[index];
    invariant(
      !persisted ||
        (persisted.itemType === "rate-limit-counter" &&
          persisted.data.scopeId === input.scopeId &&
          persisted.data.limitKey === input.limitKey &&
          persisted.data.window === input.window &&
          (persisted.data.organizationId === undefined ||
            persisted.data.organizationId === input.organizationId)),
      "Brain upload quota counter mismatch.",
    );
    const previous = persisted as RateCounter | undefined;
    const count = Math.max(0, (previous?.data.count ?? 0) + input.delta);
    if (input.limit !== undefined && count > input.limit) {
      throw new BrainUploadQuotaExceededError(input.limitKey);
    }
    const next: RateCounter = {
      ...identity,
      data: {
        ...identity.data,
        count,
        version: previous ? previous.data.version + 1 : 0,
      },
    };
    return previous
      ? { kind: "put", previousRecord: previous, record: next }
      : { kind: "put", record: next };
  });
}

const MAX_QUOTA_COUNTER_ATTEMPTS = 8;

async function quotaCountersMoved(
  database: DynamoDatabaseService,
  quota: readonly TransactionOperation[],
) {
  const current = await Promise.all(
    quota.map(async (operation) =>
      operation.kind === "put"
        ? await database.getRecord(
            "usage",
            { pk: operation.record.pk, sk: operation.record.sk },
            true,
          )
        : undefined,
    ),
  );
  return quota.some(
    (operation, index) =>
      operation.kind === "put" &&
      (current[index] as RateCounter | undefined)?.data.version !==
        (operation.previousRecord as RateCounter | undefined)?.data.version,
  );
}

/**
 * Quota counters are shared by every upload in a caller, Brain, and organization, so concurrent
 * uploads race on their versions. A transaction cancelled because a counter moved re-reads the
 * counters and retries; any other conflict is the caller's to handle.
 */
async function transactWithQuotaCounters(
  database: DynamoDatabaseService,
  adjustments: readonly CounterAdjustment[],
  transact: (quota: readonly TransactionOperation[], attempt: number) => Promise<void>,
) {
  for (let attempt = 1; ; attempt += 1) {
    const quota = await counterOperations(database, adjustments);
    try {
      await transact(quota, attempt);
      return;
    } catch (cause) {
      if (
        attempt >= MAX_QUOTA_COUNTER_ATTEMPTS ||
        !isDatabaseWriteConflict(cause) ||
        !(await quotaCountersMoved(database, quota))
      ) {
        throw cause;
      }
      await sleep(1 + Math.floor(Math.random() * Math.min(10 * 2 ** attempt, 250)));
    }
  }
}

function quotaScopeId(actor: BrainMutationCaller) {
  return actor.kind === "human" ? actor.principalId : actor.serviceAccountId;
}

type QuotaChange =
  | { readonly kind: "reserve"; readonly quotas: BrainUploadQuotas }
  | { readonly kind: "release" };

function quotaAdjustments(
  actor: BrainMutationCaller,
  ticket: BrainUploadTicket,
  change: QuotaChange,
): readonly CounterAdjustment[] {
  const outstandingWindow = ticket.createdAt.slice(0, 10);
  const outstandingExpiry = new Date(
    Date.parse(`${outstandingWindow}T00:00:00.000Z`) + 2 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const hour = ticket.createdAt.slice(0, 13);
  const hourlyExpiry = new Date(
    Date.parse(`${hour}:00:00.000Z`) + 2 * 60 * 60 * 1_000,
  ).toISOString();
  const callerId = quotaScopeId(actor);
  const direction = change.kind === "reserve" ? 1 : -1;
  const reservationLimit = (select: (quotas: BrainUploadQuotas) => number) =>
    change.kind === "reserve" ? { limit: select(change.quotas) } : {};
  return [
    {
      delta: direction,
      expiresAt: outstandingExpiry,
      ...reservationLimit((quotas) => quotas.outstandingTickets.caller),
      limitKey: "brain-upload.outstanding-tickets.caller",
      scopeId: callerId,
      window: outstandingWindow,
    },
    {
      delta: direction * ticket.expectedByteSize,
      expiresAt: outstandingExpiry,
      ...reservationLimit((quotas) => quotas.outstandingBytes.caller),
      limitKey: "brain-upload.outstanding-bytes.caller",
      scopeId: callerId,
      window: outstandingWindow,
    },
    {
      delta: direction,
      expiresAt: outstandingExpiry,
      ...reservationLimit((quotas) => quotas.outstandingTickets.brain),
      limitKey: "brain-upload.outstanding-tickets.brain",
      organizationId: ticket.organizationId,
      scopeId: ticket.brainId,
      window: outstandingWindow,
    },
    {
      delta: direction * ticket.expectedByteSize,
      expiresAt: outstandingExpiry,
      ...reservationLimit((quotas) => quotas.outstandingBytes.brain),
      limitKey: "brain-upload.outstanding-bytes.brain",
      organizationId: ticket.organizationId,
      scopeId: ticket.brainId,
      window: outstandingWindow,
    },
    {
      delta: direction,
      expiresAt: outstandingExpiry,
      ...reservationLimit((quotas) => quotas.outstandingTickets.organization),
      limitKey: "brain-upload.outstanding-tickets.organization",
      organizationId: ticket.organizationId,
      scopeId: ticket.organizationId,
      window: outstandingWindow,
    },
    {
      delta: direction * ticket.expectedByteSize,
      expiresAt: outstandingExpiry,
      ...reservationLimit((quotas) => quotas.outstandingBytes.organization),
      limitKey: "brain-upload.outstanding-bytes.organization",
      organizationId: ticket.organizationId,
      scopeId: ticket.organizationId,
      window: outstandingWindow,
    },
    ...(change.kind === "reserve"
      ? [
          {
            delta: 1,
            expiresAt: hourlyExpiry,
            limit: change.quotas.hourlyIssuance.caller,
            limitKey: "brain-upload.issuance.caller",
            scopeId: callerId,
            window: hour,
          },
          {
            delta: 1,
            expiresAt: hourlyExpiry,
            limit: change.quotas.hourlyIssuance.organization,
            limitKey: "brain-upload.issuance.organization",
            organizationId: ticket.organizationId,
            scopeId: ticket.organizationId,
            window: hour,
          },
        ]
      : []),
  ];
}

export async function brainUploadQuotaReleaseOperations(
  database: DynamoDatabaseService,
  ticket: BrainUploadTicket,
) {
  const actor: BrainMutationCaller = ticket.createdByPrincipalId
    ? { kind: "human", principalId: ticket.createdByPrincipalId }
    : {
        apiCredentialId: ticket.createdByServiceAccountId!,
        environmentId: ticket.environmentId!,
        kind: "service",
        projectId: ticket.projectId!,
        serviceAccountId: ticket.createdByServiceAccountId!,
      };
  return counterOperations(database, quotaAdjustments(actor, ticket, { kind: "release" }));
}

function ticketActorId(actor: BrainMutationCaller) {
  return actor.kind === "human" ? actor.principalId : actor.serviceAccountId;
}

function ticketMatchesActor(ticket: BrainUploadTicket, actor: BrainMutationCaller) {
  return actor.kind === "human"
    ? ticket.createdByPrincipalId === actor.principalId &&
        ticket.createdByServiceAccountId === undefined
    : ticket.createdByServiceAccountId === actor.serviceAccountId &&
        ticket.projectId === actor.projectId &&
        ticket.environmentId === actor.environmentId &&
        ticket.createdByPrincipalId === undefined;
}

function uploadEvent(
  ticket: ReturnType<typeof brainUploadTicketPlatformRecord>,
  eventId: string,
  actor: BrainMutationCaller,
  eventType: string,
) {
  return makeSemanticEventRecord({
    actor: {
      id: brainUlid(ticketActorId(actor)),
      type: actor.kind === "human" ? "principal" : "service-account",
    },
    aggregateId: ticket.data.id,
    aggregateType: "brain-upload-ticket",
    aggregateVersion: ticket.data.version + 1,
    eventId: brainUlid(eventId),
    eventType,
    occurredAt: ticket.data.updatedAt,
    organizationId: ticket.data.organizationId,
    payload: {
      brainId: ticket.data.brainId,
      sourceId: ticket.data.sourceId,
      status: ticket.data.status,
      ticketId: ticket.data.id,
    },
  });
}

function validateAggregate(
  ticket: BrainUploadTicket,
  source: Parameters<BrainRepository["issueUploadTicket"]>[0]["source"],
  actor: BrainMutationCaller,
) {
  invariant(
    ticket.organizationId === source.organizationId &&
      ticket.brainId === source.brainId &&
      ticket.sourceId === source.id,
    "Brain upload ticket aggregate mismatch.",
  );
  invariant(ticketMatchesActor(ticket, actor), "Brain upload ticket caller mismatch.");
}

async function getBrain(database: DynamoDatabaseService, organizationId: string, brainId: string) {
  const record = await database.getRecord(
    "control",
    { pk: key("ORG", organizationId), sk: key("BRAIN", brainId) },
    true,
  );
  return record?.itemType === "brain" && record.data.organizationId === organizationId
    ? record
    : undefined;
}

function liveUploadConditions(
  actor: BrainMutationCaller,
  agentAuthorization: Parameters<BrainRepository["issueUploadTicket"]>[0]["agentAuthorization"],
  authorizingGrant: Parameters<BrainRepository["issueUploadTicket"]>[0]["authorizingGrant"],
  brain: NonNullable<Awaited<ReturnType<typeof getBrain>>>,
  source: Parameters<BrainRepository["issueUploadTicket"]>[0]["source"],
  timestamp: string,
): readonly TransactionOperation[] {
  const callerGrant = agentAuthorization?.callerGrant ?? authorizingGrant;
  invariant(
    !agentAuthorization ||
      (authorizingGrant.id === agentAuthorization.agentDefinitionGrant.id &&
        authorizingGrant.version === agentAuthorization.agentDefinitionGrant.version),
    "Agent Brain authorization must use its agent-definition grant.",
  );
  return [
    activeOrganizationCondition(source.organizationId),
    {
      conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      key: {
        pk: key("ORG", source.organizationId),
        sk: key("ERASURE-FENCE", source.organizationId),
      },
      kind: "condition-check",
      table: "control",
    },
    ...brainMutationCallerConditions(actor, callerGrant, source.organizationId, timestamp),
    activeBrainCondition(brain),
    activeBrainSourceCondition(brainSourcePlatformRecord(source)),
    activeBrainWriteGrantCondition(brainGrantPlatformRecord(callerGrant)),
  ];
}

export function makeBrainUploadRepository(
  database: DynamoDatabaseService,
  quotas: BrainUploadQuotas = DEFAULT_BRAIN_UPLOAD_QUOTAS,
): Pick<
  BrainRepository,
  "beginUpload" | "completeUpload" | "getUploadLease" | "getUploadTicket" | "issueUploadTicket"
> {
  return {
    async issueUploadTicket({
      actor,
      agentAuthorization,
      authorizingGrant,
      eventId,
      source,
      ticket,
    }) {
      invariant(
        ticket.status === "issued" && ticket.version === 0,
        "New Brain upload tickets must be issued version zero.",
      );
      invariant(
        ticket.expiresAt > ticket.createdAt,
        "Brain upload ticket expiry must be in the future.",
      );
      validateAggregate(ticket, source, actor);
      const brain = await getBrain(database, ticket.organizationId, ticket.brainId);
      invariant(brain, "Brain does not exist in the requested organization.");
      const record = brainUploadTicketPlatformRecord(ticket);
      const connector =
        source.kind === "github"
          ? await githubConnectionAuthorization(database, source)
          : undefined;
      await transactWithQuotaCounters(
        database,
        quotaAdjustments(actor, ticket, { kind: "reserve", quotas }),
        async (quota, attempt) =>
          await transactWithSemanticEvents(
            database,
            [
              ...liveUploadConditions(
                actor,
                agentAuthorization,
                authorizingGrant,
                brain,
                source,
                ticket.createdAt,
              ),
              ...brainAgentWriteConditions(ticket.organizationId, agentAuthorization),
              ...(connector ? [connector.condition] : []),
              ...createBrainRecordOperations(record, ticket.createdAt),
              ...quota,
            ],
            [uploadEvent(record, eventId, actor, "brain-upload-ticket.issued")],
            attempt === 1 ? eventId : makeDatabaseTransactionToken([eventId, String(attempt)]),
          ),
      );
      return brainUploadTicketFromPlatformRecord(record);
    },

    async getUploadTicket(organizationId, brainId, ticketId) {
      const record = await database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId, "BRAIN", brainId),
          sk: key("BRAIN-UPLOAD-TICKET", ticketId),
        },
        true,
      );
      return record?.itemType === "brain-upload-ticket" && record.data.brainId === brainId
        ? brainUploadTicketFromPlatformRecord(record)
        : undefined;
    },

    async getUploadLease(organizationId, brainId, leaseId) {
      const record = await database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId, "BRAIN", brainId),
          sk: key("BRAIN-UPLOAD-LEASE", leaseId),
        },
        true,
      );
      return record?.itemType === "brain-upload-lease" && record.data.brainId === brainId
        ? { ...record.data }
        : undefined;
    },

    async beginUpload({
      actor,
      agentAuthorization,
      authorizingGrant,
      lease,
      next,
      previous,
      source,
    }) {
      validateAggregate(previous, source, actor);
      invariant(
        previous.status === "issued" &&
          next.status === "streaming" &&
          next.version === previous.version + 1 &&
          next.id === previous.id &&
          next.updatedAt < previous.expiresAt &&
          lease.status === "active" &&
          lease.ticketId === previous.id &&
          lease.brainId === previous.brainId,
        "Invalid Brain upload start transition.",
      );
      const brain = await getBrain(database, previous.organizationId, previous.brainId);
      invariant(brain, "Brain does not exist in the requested organization.");
      const previousRecord = brainUploadTicketPlatformRecord(previous);
      const nextRecord = brainUploadTicketPlatformRecord(next);
      const leaseRecord = brainUploadLeasePlatformRecord(lease);
      const connector =
        source.kind === "github"
          ? await githubConnectionAuthorization(database, source)
          : undefined;
      await database.transactWrite([
        ...liveUploadConditions(
          actor,
          agentAuthorization,
          authorizingGrant,
          brain,
          source,
          next.updatedAt,
        ),
        ...brainAgentWriteConditions(previous.organizationId, agentAuthorization),
        ...(connector ? [connector.condition] : []),
        ...updateBrainRecordOperations(previousRecord, nextRecord, next.updatedAt),
        ...createBrainRecordOperations(leaseRecord, lease.createdAt),
      ]);
      return brainUploadTicketFromPlatformRecord(nextRecord);
    },

    async completeUpload({
      actor,
      agentAuthorization,
      authorizingGrant,
      lease,
      next,
      previous,
      previousLease,
      source,
    }) {
      validateAggregate(previous, source, actor);
      invariant(
        previous.status === "streaming" &&
          next.status === "completed" &&
          next.version === previous.version + 1 &&
          next.bodyRef?.key === previous.objectKey &&
          next.bodyRef.versionId.length > 0 &&
          next.bodyRef.byteSize === previous.expectedByteSize &&
          next.bodyRef.sha256 === previous.expectedContentHash &&
          previousLease.status === "active" &&
          lease.status === "completed" &&
          lease.version === previousLease.version + 1,
        "Invalid Brain upload completion transition.",
      );
      const brain = await getBrain(database, previous.organizationId, previous.brainId);
      invariant(brain, "Brain does not exist in the requested organization.");
      const previousRecord = brainUploadTicketPlatformRecord(previous);
      const nextRecord = brainUploadTicketPlatformRecord(next);
      const connector =
        source.kind === "github"
          ? await githubConnectionAuthorization(database, source)
          : undefined;
      await transactWithQuotaCounters(
        database,
        quotaAdjustments(actor, previous, { kind: "release" }),
        async (quota) =>
          await database.transactWrite([
            ...liveUploadConditions(
              actor,
              agentAuthorization,
              authorizingGrant,
              brain,
              source,
              next.updatedAt,
            ),
            ...brainAgentWriteConditions(previous.organizationId, agentAuthorization),
            ...(connector ? [connector.condition] : []),
            ...updateBrainRecordOperations(previousRecord, nextRecord, next.updatedAt),
            ...updateBrainRecordOperations(
              brainUploadLeasePlatformRecord(previousLease),
              brainUploadLeasePlatformRecord(lease),
              lease.updatedAt,
            ),
            ...quota,
          ]),
      );
      return brainUploadTicketFromPlatformRecord(nextRecord);
    },
  };
}
