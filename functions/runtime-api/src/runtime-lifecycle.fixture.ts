import {
  AgentDeploymentRecord,
  RunRecord,
  TraceRecord,
  runLocatorRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { RuntimeApiCredentialPrincipal } from "./runtime-support.ts";

export const ids = Array.from(
  { length: 32 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}`,
) as Ulid[];
export const [organizationId, projectId, environmentId, serviceAccountId, deploymentId] = ids as [
  Ulid,
  Ulid,
  Ulid,
  Ulid,
  Ulid,
];
export const now = new Date("2026-07-25T12:00:00.000Z");

export function memoryDatabase(seed: readonly PlatformRecord[] = []) {
  const records = new Map<string, PlatformRecord>();
  const queries: Parameters<DynamoDatabaseService["queryRecords"]>[1][] = [];
  const transactions: Array<readonly TransactionOperation[]> = [];
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\n${record.sk}`;
  for (const record of seed) records.set(recordKey(record), record);
  const runs = seed.filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
      record.itemType === "run",
  );
  for (const run of runs) {
    const trace = traceRecord(
      run,
      runs.filter((candidate) => candidate.data.traceId === run.data.traceId),
    );
    if (!records.has(recordKey(trace))) records.set(recordKey(trace), trace);
  }
  const database = {
    getRecord: (
      _table: Parameters<DynamoDatabaseService["getRecord"]>[0],
      requested: Parameters<DynamoDatabaseService["getRecord"]>[1],
    ) => {
      const record = records.get(`${requested.pk}\n${requested.sk}`);
      return Promise.resolve(record);
    },
    queryRecords: (
      _table: Parameters<DynamoDatabaseService["queryRecords"]>[0],
      input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
    ) => {
      queries.push(input);
      const values = input.ExpressionAttributeValues ?? {};
      const names = input.ExpressionAttributeNames?.["#partition"]
        ? input.ExpressionAttributeNames
        : undefined;
      const partition = names ? values[":partition"] : values[":pk"];
      const prefix = values[":prefix"];
      const items = [...records.values()].filter((record) => {
        const attributes = record as unknown as Readonly<Record<string, unknown>>;
        const recordPartition = names
          ? attributes[names["#partition"]!]
          : input.IndexName === "gsi2"
            ? record.gsi2pk
            : record.pk;
        const recordSort = names
          ? attributes[names["#sort"]!]
          : input.IndexName === "gsi2"
            ? record.gsi2sk
            : record.sk;
        return (
          recordPartition === partition &&
          (typeof prefix !== "string" ||
            (typeof recordSort === "string" && recordSort.startsWith(prefix)))
        );
      });
      return Promise.resolve({ items });
    },
    transactWrite: (operations: Parameters<DynamoDatabaseService["transactWrite"]>[0]) => {
      transactions.push(operations);
      for (const operation of operations) {
        if (
          operation.kind === "put" &&
          operation.conditionExpression?.includes("attribute_not_exists") &&
          records.has(recordKey(operation.record))
        ) {
          const conflict = new Error("conditional write failed");
          conflict.name = "ConditionalCheckFailedException";
          return Promise.reject(conflict as never);
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const table = tableForItemType(operation.record.itemType);
        if (!["control", "events", "execution"].includes(table)) continue;
        if (operation.kind === "delete") records.delete(recordKey(operation.record));
        else records.set(recordKey(operation.record), operation.record);
      }
      return Promise.resolve(undefined);
    },
  } as unknown as DynamoDatabaseService;
  return { database, queries, records, transactions };
}

export function principal(): RuntimeApiCredentialPrincipal {
  return {
    credential: { data: { id: ids[31]!, scopes: ["platform:*"] } },
    scope: { environmentId, organizationId, projectId },
    serviceAccount: {
      data: { id: serviceAccountId, scopes: ["platform:*"] },
    },
  } as unknown as RuntimeApiCredentialPrincipal;
}

export function deployment() {
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[5]!,
        agentReleaseId: ids[6]!,
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
}

export function release() {
  return withCanonicalRecordKeys({
    data: {
      agentDefinitionId: ids[5]!,
      contentHash: "test-content-hash",
      createdAt: now.toISOString(),
      createdByPrincipalId: serviceAccountId,
      environmentId,
      id: ids[6]!,
      manifest: { spec: {} },
      organizationId,
      projectId,
      releaseNumber: 1,
      status: "active" as const,
      version: 0,
    },
    itemType: "agent-release" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "agent-release" }>;
}

export function runRecord(
  status: "completed" | "failed" | "queued" | "running" | "waiting-for-tool",
  runId = ids[7]!,
  idempotencyKey = `run-${status}`,
) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        agentReleaseId: ids[6]!,
        attempt: status === "failed" ? 3 : 0,
        captureMode: "metadata-only" as const,
        createdAt: now.toISOString(),
        ...(status === "completed" || status === "failed"
          ? { completedAt: now.toISOString() }
          : {}),
        environmentId,
        executor: "hosted",
        id: runId,
        idempotencyKey,
        organizationId,
        priority: 50,
        projectId,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status,
        threadId: ids[8]!,
        trigger: "api",
        traceId: "0123456789abcdef0123456789abcdef",
        updatedAt: now.toISOString(),
        userMessageId: ids[14]!,
        userMessageSequence: 0,
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
}

function traceRecord(
  run: ReturnType<typeof runRecord>,
  runs: readonly ReturnType<typeof runRecord>[],
) {
  const finalized = runs.every((candidate) =>
    ["canceled", "completed", "failed"].includes(candidate.data.status),
  );
  return Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: run.data.captureMode,
        ...(finalized ? { completedAt: now.toISOString(), finalizedAt: now.toISOString() } : {}),
        createdAt: run.data.createdAt,
        environmentId,
        ...(finalized ? { graphWatermark: "fixture-watermark" } : {}),
        id: run.data.traceId,
        organizationId,
        projectId,
        redactionPolicyVersion: 1 as const,
        rootRunId: run.data.id,
        rootSpanId: run.data.spanId,
        runIds: runs.map((candidate) => candidate.data.id),
        schemaVersion: 1 as const,
        sessionId: run.data.threadId,
        status: finalized ? ("finalized" as const) : ("open" as const),
        ...(finalized ? { totalCostUsdMicros: 0, totalTokens: 0 } : {}),
        traceId: run.data.traceId,
        updatedAt: now.toISOString(),
        version: 1,
      },
      itemType: "trace" as const,
    }),
  );
}

/** The locator production writes alongside the run, including the run feed mirrors. */
export function runLocator(run: RunRecord) {
  return runLocatorRecord(run)!;
}
