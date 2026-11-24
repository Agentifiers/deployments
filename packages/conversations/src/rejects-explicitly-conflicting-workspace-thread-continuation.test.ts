import { agentManifestContentHash, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  tableForItemType,
  ThreadRecord,
  withCanonicalRecordKeys,
  WorkspaceRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createConversationService, createConversationStreamSession } from "./index.ts";

const ids = Array.from(
  { length: 40 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];
const organizationId = ids[0]!;
const projectId = ids[1]!;
const environmentId = ids[2]!;
const workspaceId = ids[3]!;
const definitionId = ids[4]!;
const releaseId = ids[5]!;
const deploymentId = ids[6]!;
const now = new Date("2026-07-23T12:00:00.000Z");

function controlFixtures() {
  const manifest = Schema.decodeUnknownSync(AgentManifestV1)({
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: "conversation.test-agent",
      name: "Conversation Test Agent",
      version: "1.0.0",
    },
    spec: {
      instructions: "Respond to the conversation.",
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
    },
  });
  const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: definitionId,
        contentHash: agentManifestContentHash(manifest),
        createdAt: now.toISOString(),
        createdByPrincipalId: ids[7]!,
        environmentId,
        id: releaseId,
        manifest,
        organizationId,
        projectId,
        releaseNumber: 1,
        status: "active" as const,
        version: 0,
      },
      itemType: "agent-release" as const,
    }),
  );
  const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: definitionId,
        agentReleaseId: releaseId,
        createdAt: now.toISOString(),
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId,
        id: deploymentId,
        organizationId,
        projectId,
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  return { deployment, release };
}

function memoryDatabase(seed: readonly PlatformRecord[] = []) {
  const records = new Map<string, PlatformRecord>();
  const transactions: TransactionOperation[][] = [];
  const recordKey = (table: TableName, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  const workspace = Schema.decodeUnknownSync(WorkspaceRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        id: workspaceId,
        name: "Runtime workspace",
        organizationId,
        projectId,
        slug: "runtime-workspace",
        status: "active" as const,
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "workspace" as const,
    }),
  );
  records.set(
    recordKey(tableForItemType(workspace.itemType), workspace.pk, workspace.sk),
    workspace,
  );
  for (const item of seed) {
    records.set(recordKey(tableForItemType(item.itemType), item.pk, item.sk), item);
  }
  const database = {
    deleteRecord: async () => {},
    getRecord: async (table: TableName, key: { readonly pk: string; readonly sk: string }) =>
      records.get(recordKey(table, key.pk, key.sk)),
    putRecord: async (item: PlatformRecord) => {
      records.set(recordKey(tableForItemType(item.itemType), item.pk, item.sk), item);
    },
    queryRecords: async (table: TableName, input: Record<string, unknown>) => {
      const values = [...records.values()]
        .filter((item) => tableForItemType(item.itemType) === table)
        .filter(
          (item) => item.pk === (input.ExpressionAttributeValues as Record<string, unknown>)[":pk"],
        )
        .filter((item) => item.sk.startsWith("MESSAGE#"))
        .toSorted((left, right) => left.sk.localeCompare(right.sk));
      return { items: values };
    },
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "put") {
          const item = operation.record;
          records.set(recordKey(tableForItemType(item.itemType), item.pk, item.sk), item);
        } else if (operation.kind === "delete") {
          const item = operation.record;
          records.delete(recordKey(tableForItemType(item.itemType), item.pk, item.sk));
        }
      }
    },
  } as unknown as DynamoDatabaseService;
  return { database, records, transactions };
}

function idGenerator(start = 8) {
  let index = start;
  return async () => ids[index++]!;
}

describe("conversation control plane", () => {
  test("rejects child trace context that does not match the canonical parent run", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });
    const parent = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Create a canonical parent",
      environmentId,
      idempotencyKey: "canonical-parent",
      organizationId,
      projectId,
    });

    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "Forge the parent span",
        environmentId,
        idempotencyKey: "forged-child",
        organizationId,
        projectId,
        threadId: parent.thread.data.id,
        traceContext: {
          parentAgentDeploymentId: deploymentId,
          parentRunId: parent.run.data.id,
          parentSpanId: "fedcba9876543210",
          parentThreadId: parent.thread.data.id,
          traceId: parent.run.data.traceId,
        },
      }),
    ).rejects.toMatchObject({ code: "trace_mismatch" });
    expect(memory.transactions).toHaveLength(1);
  });

  test("rejects an explicit child thread owned by another deployment", async () => {
    const fixtures = controlFixtures();
    const foreignThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: ids[35]!,
          archived: false,
          channel: "api",
          createdAt: now.toISOString(),
          createdBy: { type: "system" as const },
          environmentId,
          id: ids[30]!,
          organizationId,
          pinned: false,
          projectId,
          streamId: ids[31]!,
          title: "Foreign deployment thread",
          updatedAt: now.toISOString(),
          version: 0,
        },
        itemType: "thread" as const,
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, fixtures.release, foreignThread]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });
    const parent = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Create a canonical parent",
      environmentId,
      idempotencyKey: "deployment-parent",
      organizationId,
      projectId,
    });

    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "Try a foreign child thread",
        environmentId,
        idempotencyKey: "foreign-child-thread",
        organizationId,
        projectId,
        threadId: foreignThread.data.id,
        traceContext: {
          parentAgentDeploymentId: deploymentId,
          parentRunId: parent.run.data.id,
          parentSpanId: parent.run.data.spanId,
          parentThreadId: parent.thread.data.id,
          traceId: parent.run.data.traceId,
        },
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(memory.transactions).toHaveLength(1);
  });

  test("rejects an explicitly conflicting workspace on thread continuation", async () => {
    const fixtures = controlFixtures();
    const threadId = ids[30]!;
    const thread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: deploymentId,
          archived: false,
          channel: "api",
          createdAt: now.toISOString(),
          createdBy: { type: "system" as const },
          environmentId,
          id: threadId,
          organizationId,
          pinned: false,
          projectId,
          streamId: ids[31]!,
          title: "Existing",
          updatedAt: now.toISOString(),
          version: 1,
          workspaceId,
        },
        itemType: "thread" as const,
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, fixtures.release, thread]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });

    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "Conflicting workspace",
        environmentId,
        idempotencyKey: "request-workspace-conflict",
        organizationId,
        projectId,
        threadId,
        workspaceId: ids[34]!,
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });

    for (const [key, value] of memory.records) {
      if (value.itemType !== "workspace" || value.data.id !== workspaceId) continue;
      memory.records.set(
        key,
        Schema.decodeUnknownSync(WorkspaceRecord)(
          withCanonicalRecordKeys({
            data: { ...value.data, status: "archived", version: value.data.version + 1 },
            itemType: "workspace" as const,
          }),
        ),
      );
    }
    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "New work in archived workspace",
        environmentId,
        idempotencyKey: "archived-workspace-continuation",
        organizationId,
        projectId,
        threadId,
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
  });

  test("reloads and retries once when another submission advances the thread", async () => {
    const fixtures = controlFixtures();
    const threadId = ids[30]!;
    const thread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: deploymentId,
          archived: false,
          channel: "api",
          createdAt: now.toISOString(),
          createdBy: { type: "system" as const },
          environmentId,
          id: threadId,
          organizationId,
          pinned: false,
          projectId,
          streamId: ids[31]!,
          title: "Existing",
          updatedAt: now.toISOString(),
          version: 1,
          workspaceId,
        },
        itemType: "thread" as const,
      }),
    );
    const concurrentThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: { ...thread.data, version: 2 },
        itemType: "thread" as const,
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, fixtures.release, thread]);
    const baseTransactWrite = memory.database.transactWrite;
    let conflict = true;
    const database = {
      ...memory.database,
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        if (!conflict) return baseTransactWrite(operations);
        conflict = false;
        const entry = [...memory.records.entries()].find(
          ([, record]) => record.itemType === "thread" && record.data.id === threadId,
        );
        if (!entry) throw new Error("thread fixture missing");
        memory.records.set(entry[0], concurrentThread);
        throw new Error("ConditionalCheckFailedException");
      },
    } as unknown as DynamoDatabaseService;
    const service = createConversationService({
      database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });

    const result = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Third user turn",
      environmentId,
      idempotencyKey: "request-conflict-retry",
      organizationId,
      projectId,
      threadId,
      workspaceId,
    });

    expect(result.thread.data.version).toBe(3);
    expect(result.message.data.sequence).toBe(3);
    expect(memory.transactions).toHaveLength(1);
  });

  test("captures the stream offset before reading history", async () => {
    const calls: string[] = [];
    const streamThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: deploymentId,
          archived: false,
          channel: "api",
          createdAt: now.toISOString(),
          createdBy: { type: "system" as const },
          environmentId,
          id: ids[33]!,
          organizationId,
          pinned: false,
          projectId,
          streamId: ids[34]!,
          title: "Empty stream",
          updatedAt: now.toISOString(),
          version: 0,
          workspaceId,
        },
        itemType: "thread" as const,
      }),
    );
    const memory = memoryDatabase([streamThread]);
    const result = await createConversationStreamSession({
      claims: {
        environmentId,
        expiresAt: "9999-12-31T23:59:59.999Z",
        organizationId,
        permissions: ["read"],
        projectId,
        sessionId: ids[32]!,
        threadId: ids[33]!,
      },
      createReadUrl: (offset) => `https://streams.internal/read?offset=${offset}`,
      database: memory.database,
      scope: { environmentId, organizationId, projectId, threadId: ids[33]! },
      transport: {
        append: async () => ({}),
        currentOffset: async () => {
          calls.push("offset");
          return "42";
        },
      },
    });

    expect(calls).toEqual(["offset"]);
    expect(result.session.offset).toBe("42");
    expect(result.session.readUrl).toContain("offset=42");
    expect(result.history.items).toEqual([]);
  });
});
