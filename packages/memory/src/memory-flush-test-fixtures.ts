import {
  type DynamoDatabaseService,
  type PlatformRecord,
  type QueryRecordsResult,
  type TransactionOperation,
  type Ulid,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import type { MemoryPlatformScope } from "./platform.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids, optionalExpressionString } from "./test-fixtures.ts";

export const fixedNow = new Date("2026-07-21T18:00:00.000Z");
const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function indexedUlid(index: number) {
  let value = index;
  let suffix = "";
  for (let position = 0; position < 6; position += 1) {
    suffix = ulidAlphabet[value % ulidAlphabet.length] + suffix;
    value = Math.floor(value / ulidAlphabet.length);
  }
  return `01ARZ3NDEKTSV4RRFFQ6${suffix}` as Ulid;
}

function tableName(record: PlatformRecord) {
  if (record.itemType === "semantic-event" || record.itemType === "idempotency") return "events";
  if (
    record.itemType === "memory-index-job" ||
    record.itemType === "memory-flush" ||
    record.itemType === "memory-recall-attempt" ||
    record.itemType === "memory-retrieval" ||
    record.itemType === "memory-review-item"
  ) {
    return "execution";
  }
  return "control";
}

export function memoryDatabase(gsi1Filter: (record: PlatformRecord) => boolean = () => true) {
  const tables = new Map<string, Map<string, PlatformRecord>>();
  const clientRequestTokens: (string | undefined)[] = [];
  const queries: { readonly input: Record<string, unknown>; readonly table: string }[] = [];
  const transactions: (readonly TransactionOperation[])[] = [];
  const transactionSizes: number[] = [];
  const table = (name: string) => {
    let records = tables.get(name);
    if (!records) {
      records = new Map();
      tables.set(name, records);
    }
    return records;
  };
  const put = (name: string, value: PlatformRecord) => {
    table(name).set(`${value.pk}\u0000${value.sk}`, value);
  };
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      for (const values of tables.values()) values.delete(`${record.pk}\u0000${record.sk}`);
    },
    getRecord: async (name, key) => {
      const value = table(name).get(`${key.pk}\u0000${key.sk}`);
      return value;
    },
    putRecord: async (record) =>
      put(record.itemType === "semantic-event" ? "events" : tableName(record), record),
    queryRecords: async (name, input) => {
      queries.push({ input: input as Record<string, unknown>, table: name });
      const values = [...table(name).values()];
      const expressions = input.ExpressionAttributeValues as Record<string, unknown> | undefined;
      const pkName =
        input.IndexName === "gsi2" ? "gsi2pk" : input.IndexName === "gsi1" ? "gsi1pk" : "pk";
      const skName =
        input.IndexName === "gsi2" ? "gsi2sk" : input.IndexName === "gsi1" ? "gsi1sk" : "sk";
      const partition = optionalExpressionString(expressions, ":pk");
      const prefix = optionalExpressionString(expressions, ":prefix");
      const exact = expressions?.[":run"];
      const lowerBound = optionalExpressionString(expressions, ":since");
      const matching = values
        .filter((value) => partition === undefined || value[pkName] === partition)
        .filter((value) => input.IndexName !== "gsi1" || gsi1Filter(value))
        .filter((value) => exact === undefined || value[skName] === exact)
        .filter(
          (value) =>
            lowerBound === undefined ||
            (typeof value[skName] === "string" && value[skName] >= lowerBound),
        )
        .filter(
          (value) =>
            prefix === undefined ||
            (typeof value[skName] === "string" && value[skName].startsWith(prefix)),
        );
      const start = Number(
        (input.ExclusiveStartKey as Record<string, unknown> | undefined)?.cursor ?? 0,
      );
      const end = Math.min(start + (input.Limit ?? 100), matching.length);
      return {
        items: matching.slice(start, end),
        ...(end < matching.length
          ? {
              lastEvaluatedKey: {
                cursor: end,
                gsi2pk: partition ?? "ENV#test",
                gsi2sk: `${prefix ?? "ITEM#"}${end}`,
                pk: `PK#${end}`,
                sk: `SK#${end}`,
              },
            }
          : {}),
      } satisfies QueryRecordsResult;
    },
    transactWrite: async (operations: readonly TransactionOperation[], clientRequestToken) => {
      clientRequestTokens.push(clientRequestToken);
      transactions.push(operations);
      transactionSizes.push(operations.length);
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          table(tableName(operation.record)).delete(
            `${operation.record.pk}\u0000${operation.record.sk}`,
          );
        } else {
          put(tableName(operation.record), operation.record);
        }
      }
    },
  };
  return { clientRequestTokens, database, put, queries, tables, transactions, transactionSizes };
}

const agentReleaseModelId = "openrouter/example/agent-model";

/** Stores the run agent's release so flushes can resolve its configured memory settings. */
export function putAgentRelease(
  put: ReturnType<typeof memoryDatabase>["put"],
  scope: MemoryPlatformScope,
  spec: {
    readonly memory?: {
      readonly mode: "off" | "organization" | "workspace";
      readonly reviewMode?: "auto-approve" | "manual";
    };
    readonly modelId?: string;
    readonly runtime?: { readonly contextCheckpointMode: "auto" | "off" };
  } = {},
) {
  put(
    "control",
    withCanonicalRecordKeys({
      itemType: "agent-release" as const,
      data: {
        agentDefinitionId: ids.agent,
        contentHash: "test-release-hash",
        createdAt: fixedNow.toISOString(),
        createdByPrincipalId: indexedUlid(12_001),
        environmentId: scope.environmentId,
        id: ids.memory2,
        manifest: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "Agent",
          metadata: { key: "example.memory", name: "Memory", version: "1.0.0" },
          spec: {
            capabilities: { tools: [] },
            instructions: "Remember durable facts.",
            memory: spec.memory ?? { mode: "organization" },
            model: { id: spec.modelId ?? agentReleaseModelId },
            ...(spec.runtime ? { runtime: spec.runtime } : {}),
            sandbox: { mode: "none" },
            skills: [],
            triggers: ["api"],
          },
        },
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        releaseNumber: 1,
        status: "active",
        updatedAt: fixedNow.toISOString(),
        version: 0,
      },
    }) as PlatformRecord,
  );
}

export async function grantedFlushRun(
  platform: ReturnType<typeof makeMemoryPlatform>,
  put: ReturnType<typeof memoryDatabase>["put"],
  scope: MemoryPlatformScope,
  memorySpaceId: Ulid,
  runId: Ulid = ids.run,
) {
  const run = completedFlushRun(put, scope, runId);
  await platform.grantMemorySpace(scope, {
    agentDefinitionId: ids.agent,
    memorySpaceId,
    permission: "read-write",
  });
  return run;
}

/** A completed run of a deployed agent, with no memory grants. */
export function completedFlushRun(
  put: ReturnType<typeof memoryDatabase>["put"],
  scope: MemoryPlatformScope,
  runId: Ulid = ids.run,
  memory?: NonNullable<Parameters<typeof putAgentRelease>[2]>["memory"],
) {
  const deploymentId = indexedUlid(12_000);
  put(
    "control",
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids.agent,
        agentReleaseId: ids.memory2,
        createdAt: fixedNow.toISOString(),
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId: scope.environmentId,
        id: deploymentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        updatedAt: fixedNow.toISOString(),
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }) as PlatformRecord,
  );
  putAgentRelease(put, scope, memory ? { memory } : {});
  const run = withCanonicalRecordKeys({
    data: {
      agentDeploymentId: deploymentId,
      agentReleaseId: ids.memory2,
      attempt: 0,
      captureMode: "metadata-only" as const,
      createdAt: fixedNow.toISOString(),
      environmentId: scope.environmentId,
      executor: "test",
      id: runId,
      idempotencyKey: `run:${runId}`,
      organizationId: scope.organizationId,
      priority: 0,
      projectId: scope.projectId,
      redactionPolicyVersion: 1 as const,
      schemaVersion: 1 as const,
      spanId: "0123456789abcdef" as const,
      status: "completed" as const,
      threadId: ids.thread,
      traceId: "0123456789abcdef0123456789abcdef" as const,
      trigger: "test",
      updatedAt: fixedNow.toISOString(),
      version: 0,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    },
    itemType: "run" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "run" }>;
  put("execution", run);
  return run;
}
