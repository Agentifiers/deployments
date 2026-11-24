import {
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type GovernanceOperation,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  CREATED_AT,
  DEPLOYMENT_ID,
  SCOPE,
  TABLE_NAMES,
  erasureTestDatabase,
  markRunCanceled,
  messageRecord,
  runRecord,
  testId,
  threadRecord,
  toolCallRecord,
} from "@deployments-ai/db/erasure-testing";
import { createGovernanceService } from "./governance-service-composition.ts";
import type { ObservabilityErasureRequest } from "./governance-observability-erasure.ts";
import type { ConversationErasurePorts, ConversationErasureThread } from "./types.ts";

export const BUCKET = "tenant-objects";

function blob(name: string) {
  return {
    bucket: BUCKET,
    byteSize: 5,
    contentType: "text/plain",
    key: `organizations/${SCOPE.organizationId}/threads/${name}`,
    sha256: `sha256:${name}`,
  };
}

function record<Type extends PlatformRecord["itemType"]>(
  itemType: Type,
  data: Readonly<Record<string, unknown>>,
) {
  const ttl =
    typeof data.expiresAt === "string" ? Math.floor(Date.parse(data.expiresAt) / 1_000) : undefined;
  return withCanonicalRecordKeys({ data, itemType, ...(ttl ? { ttl } : {}) }) as Extract<
    PlatformRecord,
    { readonly itemType: Type }
  >;
}

export function conversation(threadId: Ulid, suffix: string): readonly PlatformRecord[] {
  const runId = testId(`R${suffix}`);
  const routeId = `route-${suffix}`;
  const body = messageRecord(threadId, testId(`B${suffix}`), 2);
  return [
    threadRecord(threadId),
    messageRecord(threadId, testId(`M${suffix}`), 1),
    { ...body, data: { ...body.data, bodyRef: blob(`body-${suffix}`) } } as PlatformRecord,
    runRecord(threadId, runId),
    toolCallRecord(threadId, runId, testId(`C${suffix}`)),
    record("generation-reasoning", {
      ...SCOPE,
      createdAt: CREATED_AT,
      modelCallIndex: 0,
      producerAttemptId: `${runId}:execution:1:assistant:0:run-attempt:0:fallback:0`,
      producerModelId: "openrouter/anthropic/claude-opus-5.5",
      reasoningDetails: [{ signature: `signature-${suffix}`, type: "reasoning.text" }],
      runId,
      threadId,
    }),
    record("conversation-checkpoint", {
      ...SCOPE,
      agentDeploymentId: DEPLOYMENT_ID,
      contentHash: "sha256:summary",
      createdAt: CREATED_AT,
      fromSequence: 1,
      id: testId(`K${suffix}`),
      runId,
      sourceMessageCount: 2,
      summary: "The user asked about the rollout.",
      threadId,
      throughSequence: 2,
    }),
    record("memory", {
      ...SCOPE,
      body: "Prefers morning rollouts.",
      contentHash: "sha256:memory",
      createdAt: CREATED_AT,
      id: testId(`Y${suffix}`),
      memorySpaceId: testId(`S${suffix}`),
      reviewStatus: "approved",
      scope: "thread",
      searchKey: `thread:${threadId}`,
      sensitivity: "internal",
      source: "agent",
      status: "active",
      threadId,
      updatedAt: CREATED_AT,
      version: 0,
    }),
    record("schedule", {
      ...SCOPE,
      agentDeploymentId: DEPLOYMENT_ID,
      createdAt: CREATED_AT,
      id: testId(`D${suffix}`),
      name: "Daily follow-up",
      schedule: { cron: "0 9 * * *" },
      status: "active",
      threadId,
      updatedAt: CREATED_AT,
      version: 1,
    }),
    record("stream-session", {
      ...SCOPE,
      createdAt: CREATED_AT,
      credentialRef: { credentialId: testId(`V${suffix}`), generation: 1, store: "dynamodb-kms" },
      expiresAt: "2026-10-01T00:05:00.000Z",
      id: testId(`E${suffix}`),
      scopes: ["read"],
      threadId,
      version: 1,
    }),
    record("inbound-thread-route", {
      ...SCOPE,
      agentDeploymentId: DEPLOYMENT_ID,
      createdAt: CREATED_AT,
      externalThreadKey: `dm-${suffix}`,
      id: `inbound-${suffix}`,
      ingressRouteId: routeId,
      sourceId: testId(`N${suffix}`),
      sourceKind: "channel-binding",
      threadId,
    }),
    ingressSource(routeId, `before-${suffix}`, CREATED_AT),
  ];
}

export function ingressSource(routeId: string, id: string, createdAt: string) {
  return record("channel-ingress-source", {
    ...SCOPE,
    contentBytes: 5,
    createdAt,
    expiresAt: "2026-12-01T00:00:00.000Z",
    id,
    payload: { text: "hello" },
    receivedAt: createdAt,
    routeId,
    senderId: "U123",
    sourceFingerprint: `fingerprint-${id}`,
    sourceMessageId: `message-${id}`,
    status: "staged",
    updatedAt: createdAt,
    version: 1,
  });
}

export function conversationErasureFixture() {
  let clock = new Date("2026-10-07T12:00:00.000Z");
  const now = () => clock;
  const context = erasureTestDatabase(now);
  const calls = {
    canceledRuns: [] as string[],
    deletedAllVersions: [] as string[],
    deletedObjects: [] as string[],
    deletedStreams: [] as ConversationErasureThread[],
    deletedTimers: [] as string[],
    observability: [] as ObservabilityErasureRequest[],
    purgedMemories: [] as { readonly memories: readonly string[]; readonly threadId: string }[],
  };
  const failures: Partial<Record<keyof typeof calls, number>> = {};
  const failOnce = (port: keyof typeof calls) => {
    const remaining = failures[port] ?? 0;
    if (remaining === 0) return;
    failures[port] = remaining - 1;
    throw new Error(`${port} is unavailable.`);
  };
  const ports: ConversationErasurePorts = {
    async cancelRun({ run }) {
      failOnce("canceledRuns");
      await markRunCanceled(context.database, run, clock.toISOString());
      calls.canceledRuns.push(run.data.id);
    },
    async deleteAutomationTimer(automationId) {
      failOnce("deletedTimers");
      calls.deletedTimers.push(automationId);
    },
    async deleteThreadStream(thread) {
      failOnce("deletedStreams");
      calls.deletedStreams.push(thread);
    },
    async purgeThreadMemories({ memories, threadId }) {
      failOnce("purgedMemories");
      calls.purgedMemories.push({ memories: memories.map((memory) => memory.sk), threadId });
    },
    store: context.store,
  };
  let ids = 0;
  const governanceStore = makeDynamoGovernanceStore(context.fake.client, TABLE_NAMES, { now });
  const service = createGovernanceService({
    allowedObjectBuckets: [BUCKET],
    conversationErasure: ports,
    generateId: async () => `01ARZ3NDEKTSV4RRFFQ69J${String((ids += 1)).padStart(4, "0")}`,
    now,
    objectStore: {
      blockWrites: async () => {},
      delete: async (reference) => {
        calls.deletedObjects.push(reference.key);
      },
      deleteAllVersions: async (reference) => {
        failOnce("deletedObjects");
        calls.deletedObjects.push(reference.key);
        calls.deletedAllVersions.push(reference.key);
      },
      find: async () => undefined,
      put: async () => {
        throw new Error("Conversation erasure writes no governance objects.");
      },
      read: async () => new Uint8Array(),
      size: async () => 0,
    },
    async purgeObservability(request) {
      failOnce("observability");
      calls.observability.push(request);
      return {
        receipt: {
          clickhouse: { absenceVerifiedAt: clock.toISOString(), rowsDeleted: 3 },
          clickhouseBackupsExpireBy: "2026-11-07T00:00:00.000Z",
          iceberg: {
            absenceVerifiedAt: clock.toISOString(),
            physicalRemovalBy: "2026-10-14T00:00:00.000Z",
            rowsDeleted: 2,
            tables: [{ rowsDeleted: 2, table: "spans" }],
          },
          operationId: request.operationId,
        },
        status: "complete",
      };
    },
    signer: {
      keyId: "test",
      publicKey: async () => "test",
      sign: async () => "signature",
    },
    store: governanceStore,
  });

  async function runToCompletion(operation: GovernanceOperation, maxRuns = 20) {
    let result: GovernanceOperation | undefined;
    for (let run = 1; run <= maxRuns; run += 1) {
      try {
        result = await service.runOperation(operation.organizationId, operation.id);
      } catch {
        result = await service.getOperation(operation.organizationId, operation.id);
      }
      if (result?.status === "completed" || result?.status === "failed") return result;
      clock = new Date(clock.getTime() + 6 * 60_000);
    }
    throw new Error(`The erasure did not settle: ${JSON.stringify(result?.error)}.`);
  }

  async function threadRecordTypes(threadId: Ulid) {
    const types: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await context.store.listThreadRecords(SCOPE.organizationId, threadId, cursor);
      types.push(...page.items.map((item) => item.record.itemType));
      cursor = page.cursor;
    } while (cursor);
    return types.sort();
  }

  return {
    ...context,
    advance: (milliseconds: number) => {
      clock = new Date(clock.getTime() + milliseconds);
    },
    calls,
    failures,
    governanceStore,
    runToCompletion,
    service,
    threadRecordTypes,
  };
}
