import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { GovernanceOperation } from "../governance/contracts.ts";
import { operationFromRecord, operationRecord } from "../governance/dynamo-store.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import type { ConversationErasureState } from "../records/governance.ts";
import { makeSemanticEventRecord } from "../semantic-event-storage.ts";
import { Ulid } from "../ids.ts";
import type { ConversationErasureRequester } from "./contracts.ts";

export type OperationRecord = Extract<
  PlatformRecord,
  { readonly itemType: "governance-operation" }
>;

export const parseUlid = Schema.decodeUnknownSync(Ulid);

export const EMPTY_COUNTS: ConversationErasureState["counts"] = {
  automationsArchived: 0,
  emailMessagesErased: 0,
  emailThreadsErased: 0,
  ingressRecordsDeleted: 0,
  memoriesErased: 0,
  objectsStaged: 0,
  recordsDeleted: 0,
  runsCanceled: 0,
  streamsDeleted: 0,
  threadsErased: 0,
  threadsPlanned: 0,
};

export async function readOperationRecord(
  database: DynamoDatabaseService,
  organizationId: string,
  operationId: string,
): Promise<OperationRecord | undefined> {
  const record = await database.getRecord("control", {
    pk: key("ORG", organizationId),
    sk: key("GOVERNANCE-OPERATION", operationId),
  });
  return record?.itemType === "governance-operation" ? record : undefined;
}

export function conversationOperation(input: {
  readonly createdAt: string;
  readonly id: Ulid;
  readonly idempotencyKey: string;
  readonly kind: "end-user-erasure" | "thread-erasure";
  readonly organizationId: string;
  readonly requester: ConversationErasureRequester;
  readonly state: ConversationErasureState;
}): GovernanceOperation {
  return {
    conversationErasure: input.state,
    createdAt: input.createdAt,
    dispatchReadyAt: input.createdAt,
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    organizationId: input.organizationId,
    requestedByPrincipalId: input.requester.id,
    status: "pending",
    updatedAt: input.createdAt,
    version: 1,
  };
}

export function lifecycleEvent(input: {
  readonly eventId: Ulid;
  readonly occurredAt: string;
  readonly operation: GovernanceOperation;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requester?: ConversationErasureRequester;
  readonly stage: "erased" | "erasure-requested";
}) {
  const { operation } = input;
  const subject = operation.kind === "thread-erasure" ? "thread" : "end-user";
  return makeSemanticEventRecord({
    ...(input.requester ? { actor: input.requester } : {}),
    aggregateId: parseUlid(operation.id),
    aggregateType: operation.kind,
    aggregateVersion: input.stage === "erasure-requested" ? 1 : 2,
    ...(operation.conversationErasure
      ? { environmentId: operation.conversationErasure.environmentId }
      : {}),
    eventId: input.eventId,
    eventType: `${subject}.${input.stage}`,
    occurredAt: input.occurredAt,
    organizationId: parseUlid(operation.organizationId),
    payload: { erasureId: operation.id, ...input.payload },
  });
}

export async function resumeOnReplay(
  database: DynamoDatabaseService,
  record: OperationRecord,
  now: string,
): Promise<GovernanceOperation> {
  const operation = operationFromRecord(record);
  if (operation.status !== "failed") return operation;
  const { error: _error, leaseExpiresAt: _leaseExpiresAt, ...rest } = operation;
  const resumed: GovernanceOperation = {
    ...rest,
    dispatchReadyAt: now,
    status: "pending",
    updatedAt: now,
    version: operation.version + 1,
  };
  await database.transactWrite([
    { kind: "put", previousRecord: record, record: operationRecord(resumed) },
  ]);
  return resumed;
}
