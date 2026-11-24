import { createHash } from "node:crypto";
import { Schema } from "effect";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { EndUserKey } from "../records/conversation-erasure.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
} from "../unique-claims.ts";
import { makeConversationErasureStore } from "./store.ts";

const ulid = Schema.decodeUnknownSync(Ulid);

export const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;
export const CREATED_AT = "2026-10-01T00:00:00.000Z";
export const ORGANIZATION_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAV");
export const PROJECT_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAW");
export const ENVIRONMENT_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAX");
export const DEPLOYMENT_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAY");
export const RELEASE_ID = ulid("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
export const REQUESTER = { id: ulid("01ARZ3NDEKTSV4RRFFQ69G5FB0"), type: "principal" as const };
export const SCOPE = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
};

export function testId(suffix: string) {
  return ulid(`01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`);
}

export function testEndUserKeys(organizationId: string, endUserId: string): EndUserKey {
  return Schema.decodeUnknownSync(EndUserKey)(
    `v1.${createHash("sha256").update(`${organizationId}\u0000${endUserId}`).digest("base64url")}`,
  );
}

export function threadRecord(id: Ulid, options: { readonly endUserKey?: EndUserKey } = {}) {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      agentDeploymentId: DEPLOYMENT_ID,
      archived: false,
      channel: "api",
      createdAt: CREATED_AT,
      createdBy: REQUESTER,
      ...(options.endUserKey ? { endUserKey: options.endUserKey } : {}),
      id,
      pinned: false,
      streamId: id,
      title: "Conversation",
      updatedAt: CREATED_AT,
      version: 1,
    },
    itemType: "thread" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "thread" }>;
}

export function messageRecord(threadId: Ulid, id: Ulid, sequence: number) {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      body: "hello",
      contentHash: "sha256:hello",
      createdAt: CREATED_AT,
      id,
      role: "user" as const,
      sequence,
      threadId,
    },
    itemType: "message" as const,
  }) as PlatformRecord;
}

export function runRecord(threadId: Ulid, id: Ulid, status: "completed" | "running" = "completed") {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      agentDeploymentId: DEPLOYMENT_ID,
      agentReleaseId: RELEASE_ID,
      attempt: 0,
      captureMode: "metadata-only" as const,
      createdAt: CREATED_AT,
      executor: "test",
      ...(status === "running" ? { executionSlot: 0 } : {}),
      id,
      idempotencyKey: `run:${id}`,
      priority: 0,
      redactionPolicyVersion: 1 as const,
      schemaVersion: 1 as const,
      spanId: "0123456789abcdef",
      status,
      threadId,
      traceId: "0123456789abcdef0123456789abcdef",
      trigger: "test",
      updatedAt: CREATED_AT,
      version: 0,
    },
    itemType: "run" as const,
  }) as PlatformRecord;
}

export function toolCallRecord(threadId: Ulid, runId: Ulid, id: Ulid) {
  return withCanonicalRecordKeys({
    data: {
      ...SCOPE,
      createdAt: CREATED_AT,
      effect: "read" as const,
      id,
      inputSummary: "lookup",
      requiredScopes: [],
      runId,
      status: "succeeded" as const,
      threadId,
      toolName: "lookup",
      updatedAt: CREATED_AT,
      version: 0,
    },
    itemType: "tool-call" as const,
  }) as PlatformRecord;
}

export async function seedRecords(
  database: DynamoDatabaseService,
  records: readonly PlatformRecord[],
) {
  for (const record of records) {
    const claims = uniqueClaimRequirements(record).map(
      (requirement): TransactionOperation =>
        acquireUniqueClaim(
          Schema.decodeUnknownSync(UniqueClaimRecord)(
            makeUniqueClaimRecord(requirement, CREATED_AT),
          ),
        ),
    );
    await database.transactWrite([{ kind: "put", record }, ...claims]);
  }
}

export async function markRunCanceled(
  database: DynamoDatabaseService,
  run: Extract<PlatformRecord, { readonly itemType: "run" }>,
  at: string,
) {
  await database.transactWrite([
    {
      kind: "put",
      previousRecord: run,
      record: withCanonicalRecordKeys({
        ...run,
        data: {
          ...run.data,
          completedAt: at,
          status: "canceled" as const,
          updatedAt: at,
          version: run.data.version + 1,
        },
      }),
    },
  ]);
}

export function erasureTestDatabase(now = () => new Date("2026-10-07T12:00:00.000Z")) {
  const fake = fakeDynamoDocumentClient();
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: CREATED_AT,
        id: ORGANIZATION_ID,
        name: "Erasure",
        slug: "erasure",
        status: "active" as const,
        updatedAt: CREATED_AT,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  let sequence = 0;
  const generateId = () => {
    sequence += 1;
    return `01ARZ3NDEKTSV4RRFFQ69H${String(sequence).padStart(4, "0")}`;
  };
  const database = makeDynamoDatabase(fake.client, TABLE_NAMES);
  const store = makeConversationErasureStore(fake.client, TABLE_NAMES, { generateId, now });
  return { database, fake, store };
}
