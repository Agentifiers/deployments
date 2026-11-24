import {
  RunRecord,
  WebhookDeliveryRecord,
  key,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { listRuns, listWebhookDeliveries } from "./runtime-operations.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

const ids = Array.from(
  { length: 32 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}`,
) as Ulid[];
const [organizationId, projectId, environmentId, serviceAccountId, deploymentId] = ids as [
  Ulid,
  Ulid,
  Ulid,
  Ulid,
  Ulid,
];
const now = new Date("2026-07-25T12:00:00.000Z");
const sessionTokenSecret = "runtime-api-test-secret".repeat(2);

function memoryDatabase(seed: readonly PlatformRecord[] = []) {
  const records = new Map<string, PlatformRecord>();
  const queries: Parameters<DynamoDatabaseService["queryRecords"]>[1][] = [];
  const transactions: Array<readonly TransactionOperation[]> = [];
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\n${record.sk}`;
  for (const record of seed) records.set(recordKey(record), record);
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
      const partition = values[":pk"];
      const prefix = values[":prefix"];
      const items = [...records.values()].filter((record) => {
        const recordPartition = input.IndexName === "gsi2" ? record.gsi2pk : record.pk;
        const recordSort = input.IndexName === "gsi2" ? record.gsi2sk : record.sk;
        return (
          recordPartition === partition &&
          (typeof prefix !== "string" || recordSort?.startsWith(prefix))
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

function principal(): RuntimeApiPrincipal {
  return {
    credential: { data: { scopes: ["platform:*"] } },
    scope: { environmentId, organizationId, projectId },
    serviceAccount: {
      data: { id: serviceAccountId, scopes: ["platform:*"] },
    },
  } as unknown as RuntimeApiPrincipal;
}

function runRecord(
  status: "completed" | "failed" | "queued" | "running",
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

function webhookDelivery(deliveryId: Ulid, webhookEndpointId: Ulid, createdAt: Date) {
  return Schema.decodeUnknownSync(WebhookDeliveryRecord)(
    withCanonicalRecordKeys({
      data: {
        aggregateId: ids[22]!,
        aggregateType: "schedule-fire",
        aggregateVersion: 1,
        attempt: 1,
        createdAt: createdAt.toISOString(),
        environmentId,
        eventId: ids[23]!,
        eventType: "schedule-fire.completed",
        id: deliveryId,
        maxAttempts: 8,
        organizationId,
        projectId,
        responseCode: 200,
        retentionExpiresAt: new Date(createdAt.getTime() + 3_650 * 86_400_000).toISOString(),
        status: "delivered" as const,
        updatedAt: createdAt.toISOString(),
        version: 2,
        webhookEndpointId,
      },
      itemType: "webhook-delivery" as const,
      ttl: Math.floor((createdAt.getTime() + 3_650 * 86_400_000) / 1_000),
    }),
  );
}

describe("runtime discovery and lifecycle operations", () => {
  test("lists deployment runs with tenant filtering and public redaction", async () => {
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: deploymentId,
          agentReleaseId: ids[6]!,
          attempt: 0,
          captureMode: "metadata-only" as const,
          claimedBy: "internal-worker",
          createdAt: now.toISOString(),
          environmentId,
          executor: "hosted",
          id: ids[7]!,
          idempotencyKey: "private-key",
          organizationId,
          priority: 50,
          projectId,
          redactionPolicyVersion: 1 as const,
          schemaVersion: 1 as const,
          spanId: "0123456789abcdef",
          status: "running" as const,
          threadId: ids[8]!,
          trigger: "api",
          traceId: "0123456789abcdef0123456789abcdef",
          updatedAt: now.toISOString(),
          version: 1,
        },
        itemType: "run" as const,
      }),
    );
    const otherProject = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...run,
        data: {
          ...run.data,
          id: ids[9]!,
          idempotencyKey: "other-private-key",
          projectId: ids[10]!,
        },
      }),
    );
    const memory = memoryDatabase([run, otherProject]);
    expect(run.gsi2pk).toBe(key("ENV", environmentId, "AGENT-DEPLOYMENT", deploymentId));
    expect(run.gsi2sk).toStartWith("RUN#running#");

    const result = await listRuns(
      {
        database: memory.database,
        sessionTokenSecret,
      } as unknown as RuntimeApiDependencies,
      principal(),
      {},
      {
        agentDeploymentId: deploymentId,
        status: "running",
      },
    );

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      id: ids[7],
      object: "run",
      status: "running",
    });
    expect(result.runs[0]).not.toHaveProperty("claimedBy");
    expect(result.runs[0]).not.toHaveProperty("idempotencyKey");

    const malformedCursor = Buffer.from(JSON.stringify({}), "utf8").toString("base64url");
    expect(
      listRuns(
        {
          database: memory.database,
          sessionTokenSecret,
        } as unknown as RuntimeApiDependencies,
        principal(),
        { cursor: malformedCursor },
        { agentDeploymentId: deploymentId },
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("protects run cursors from disclosure, tampering, and scope reuse", async () => {
    const run = runRecord("running", ids[9]!, "private-pagination-key");
    const lastEvaluatedKey = {
      gsi2pk: run.gsi2pk!,
      gsi2sk: run.gsi2sk!,
      pk: run.pk,
      sk: run.sk,
    };
    const queries: Parameters<DynamoDatabaseService["queryRecords"]>[1][] = [];
    const database = {
      queryRecords: (
        _table: Parameters<DynamoDatabaseService["queryRecords"]>[0],
        input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
      ) => {
        queries.push(input);
        return Promise.resolve(
          input.ExclusiveStartKey ? { items: [] } : { items: [run], lastEvaluatedKey },
        );
      },
    } as unknown as DynamoDatabaseService;
    const dependencies = {
      database,
      sessionTokenSecret,
    } as unknown as RuntimeApiDependencies;

    const first = await listRuns(
      dependencies,
      principal(),
      { limit: "1" },
      {
        agentDeploymentId: deploymentId,
      },
    );
    expect(first.nextCursor).toStartWith("rac2.");
    for (const component of first.nextCursor!.split(".")) {
      expect(Buffer.from(component, "base64url").toString("utf8")).not.toContain(
        run.data.idempotencyKey,
      );
    }

    await listRuns(
      dependencies,
      principal(),
      { cursor: first.nextCursor, limit: "1" },
      { agentDeploymentId: deploymentId },
    );
    expect(queries[1]?.ExclusiveStartKey).toEqual(lastEvaluatedKey);

    const parts = first.nextCursor!.split(".");
    const ciphertext = parts[2]!;
    parts[2] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    expect(
      listRuns(
        dependencies,
        principal(),
        { cursor: parts.join(".") },
        { agentDeploymentId: deploymentId },
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });

    const otherScopePrincipal = {
      ...principal(),
      scope: {
        ...principal().scope,
        environmentId: ids[19]!,
      },
    };
    expect(
      listRuns(
        dependencies,
        otherScopePrincipal,
        { cursor: first.nextCursor },
        { agentDeploymentId: deploymentId },
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });

    expect(
      listRuns(
        dependencies,
        principal(),
        { cursor: first.nextCursor },
        { agentDeploymentId: deploymentId, threadId: ids[18]! },
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("fills a filtered run page from subsequent DynamoDB pages", async () => {
    const matching = runRecord("running", ids[9]!);
    const unrelatedBase = runRecord("running", ids[10]!);
    const unrelated = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...unrelatedBase,
        data: { ...unrelatedBase.data, threadId: ids[11]! },
      }),
    );
    let queryCount = 0;
    const database = {
      queryRecords: () => {
        queryCount += 1;
        return Promise.resolve(
          queryCount === 1
            ? {
                items: [unrelated],
                lastEvaluatedKey: {
                  gsi2pk: unrelated.gsi2pk,
                  gsi2sk: unrelated.gsi2sk,
                  pk: unrelated.pk,
                  sk: unrelated.sk,
                },
              }
            : { items: [matching] },
        );
      },
    } as unknown as DynamoDatabaseService;

    const result = await listRuns(
      { database, sessionTokenSecret } as unknown as RuntimeApiDependencies,
      principal(),
      { limit: "1" },
      {
        agentDeploymentId: deploymentId,
        threadId: matching.data.threadId,
      },
    );

    expect(queryCount).toBe(2);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ id: matching.data.id });
  });

  test("bounds filtered run scans and returns a continuation cursor", async () => {
    const unrelated = runRecord("running", ids[10]!);
    const lastEvaluatedKey = {
      gsi2pk: unrelated.gsi2pk!,
      gsi2sk: unrelated.gsi2sk!,
      pk: unrelated.pk,
      sk: unrelated.sk,
    };
    let queryCount = 0;
    const database = {
      queryRecords: () => {
        queryCount += 1;
        return Promise.resolve({
          items: [unrelated],
          lastEvaluatedKey,
        });
      },
    } as unknown as DynamoDatabaseService;

    const result = await listRuns(
      {
        database,
        sessionTokenSecret,
      } as unknown as RuntimeApiDependencies,
      principal(),
      { limit: "1" },
      {
        agentDeploymentId: deploymentId,
        threadId: ids[11]!,
      },
    );

    expect(queryCount).toBe(10);
    expect(result.runs).toEqual([]);
    expect(result.nextCursor).toStartWith("rac2.");
  });

  test("binds webhook delivery cursors to the webhook filter", async () => {
    const delivery = webhookDelivery(ids[9]!, ids[7]!, now);
    const lastEvaluatedKey = {
      gsi1pk: delivery.gsi1pk!,
      gsi1sk: delivery.gsi1sk!,
      pk: delivery.pk,
      sk: delivery.sk,
    };
    const database = {
      queryRecords: () => Promise.resolve({ items: [delivery], lastEvaluatedKey }),
    } as unknown as DynamoDatabaseService;
    const dependencies = {
      database,
      sessionTokenSecret,
    } as unknown as RuntimeApiDependencies;

    const first = await listWebhookDeliveries(dependencies, principal(), {
      limit: "1",
      webhookId: ids[7],
    });
    expect(first.nextCursor).toStartWith("rac2.");
    expect(
      listWebhookDeliveries(dependencies, principal(), {
        cursor: first.nextCursor,
        webhookId: ids[8],
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("lists one webhook's deliveries behind more sibling deliveries than the scan budget", async () => {
    // Deterministic automation event ids sort a schedule-fire delivery behind every run
    // delivery in the environment partition, as observed on dev with 1,346 newer siblings.
    const busyEndpointId = ids[20]!;
    const quietEndpointId = ids[21]!;
    const siblings = Array.from({ length: 1_050 }, (_, index) =>
      webhookDelivery(
        `01M3SSDC3RGAFYVEATZX${String(index).padStart(6, "0")}` as Ulid,
        busyEndpointId,
        new Date(now.getTime() + index * 1_000),
      ),
    );
    const quiet = webhookDelivery("01ARZ3NDEKTSV4RRFFQ69G6008" as Ulid, quietEndpointId, now);
    const records = [...siblings, quiet];
    const database = {
      queryRecords: (
        _table: Parameters<DynamoDatabaseService["queryRecords"]>[0],
        input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
      ) => {
        const index = input.IndexName === "gsi1" ? "gsi1" : "base";
        const partitionOf = (record: PlatformRecord) =>
          index === "gsi1" ? record.gsi1pk : record.pk;
        const sortOf = (record: PlatformRecord) => (index === "gsi1" ? record.gsi1sk : record.sk);
        const values = input.ExpressionAttributeValues ?? {};
        const matching = records
          .filter(
            (record) =>
              partitionOf(record) === values[":pk"] &&
              sortOf(record)?.startsWith(values[":prefix"] as string),
          )
          .toSorted((left, right) => sortOf(right)!.localeCompare(sortOf(left)!));
        const start = input.ExclusiveStartKey
          ? matching.findIndex(
              (record) =>
                record.pk === input.ExclusiveStartKey?.pk &&
                record.sk === input.ExclusiveStartKey?.sk,
            ) + 1
          : 0;
        const items = matching.slice(start, start + (input.Limit ?? matching.length));
        const last = items.at(-1);
        return Promise.resolve({
          items,
          ...(last && start + items.length < matching.length
            ? {
                lastEvaluatedKey:
                  index === "gsi1"
                    ? { gsi1pk: last.gsi1pk, gsi1sk: last.gsi1sk, pk: last.pk, sk: last.sk }
                    : { pk: last.pk, sk: last.sk },
              }
            : {}),
        });
      },
    } as unknown as DynamoDatabaseService;

    const page = await listWebhookDeliveries(
      { database, sessionTokenSecret } as unknown as RuntimeApiDependencies,
      principal(),
      { webhookId: quietEndpointId },
    );

    expect(page.deliveries).toEqual([
      expect.objectContaining({ id: quiet.data.id, webhookEndpointId: quietEndpointId }),
    ]);
    expect(page.nextCursor).toBeUndefined();
  });
});
