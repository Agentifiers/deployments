import {
  ApprovalRecord,
  RunRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { makeWebhookEndpointRecord } from "@deployments-ai/webhooks";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { publishRunMutationThreadEvents, runMutationThreadEvents } from "./runtime-handler.ts";
import { createWebhook, listApprovals } from "./runtime-operations.ts";
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

function approvalRecord(
  status: "approved" | "expired" | "pending" | "rejected",
  approvalId: Ulid,
  toolCallId?: Ulid,
) {
  return Schema.decodeUnknownSync(ApprovalRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        escalationCount: 0,
        id: approvalId,
        organizationId,
        projectId,
        request: { toolName: "deploy" },
        requestedByAgentDeploymentId: deploymentId,
        runId: ids[7]!,
        status,
        threadId: ids[8]!,
        ...(toolCallId ? { toolCallId } : {}),
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "approval" as const,
    }),
  );
}

describe("runtime discovery and lifecycle operations", () => {
  test("keeps committed run mutation publication failures retriable", async () => {
    const run = runRecord("queued");
    expect(
      publishRunMutationThreadEvents(
        "retry",
        runMutationThreadEvents("retry", principal(), run),
        async () => {
          throw new Error("stream unavailable");
        },
      ),
    ).rejects.toThrow("stream unavailable");
    expect(
      publishRunMutationThreadEvents(
        "replay",
        runMutationThreadEvents("replay", principal(), run),
        async () => {
          throw new Error("stream unavailable");
        },
      ),
    ).rejects.toThrow("stream unavailable");
  });

  test("lists every approval status unless an explicit status filter is provided", async () => {
    const pending = approvalRecord("pending", ids[9]!);
    const approved = approvalRecord("approved", ids[10]!);
    const rejected = approvalRecord("rejected", ids[11]!);
    const memory = memoryDatabase([pending, approved, rejected]);
    const dependencies = {
      database: memory.database,
    } as unknown as RuntimeApiDependencies;

    const all = await listApprovals(dependencies, principal(), {});
    const pendingOnly = await listApprovals(dependencies, principal(), {
      status: "pending",
    });

    expect(all.approvals).toHaveLength(3);
    expect(all.approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending.data.id, status: "pending" }),
        expect.objectContaining({ id: approved.data.id, status: "approved" }),
        expect.objectContaining({ id: rejected.data.id, status: "rejected" }),
      ]),
    );
    expect(pendingOnly.approvals).toHaveLength(1);
    expect(pendingOnly.approvals[0]).toMatchObject({
      id: pending.data.id,
      status: "pending",
    });
  });

  test("creates a webhook with a one-time secret and stores only its encrypted reference", async () => {
    const memory = memoryDatabase();
    const generated = [ids[7]!, ids[8]!, ids[9]!];
    const dependencies = {
      credentialVault: {
        prepareWrite: async () => ({
          operation: {
            kind: "put",
            record: {
              data: {},
              itemType: "credential-vault-entry",
              pk: "credential",
              sk: "credential",
            },
          },
          reference: {
            credentialId: ids[8]!,
            generation: 0,
            store: "dynamodb-kms",
          },
        }),
      },
      database: memory.database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const result = await createWebhook(dependencies, principal(), {
      eventTypes: ["run.completed", "run.failed"],
      name: "Run lifecycle",
      url: "https://hooks.example.com/platform",
    });

    expect(result).toMatchObject({
      eventTypes: ["run.completed", "run.failed"],
      id: ids[7],
      object: "webhook-endpoint",
      status: "active",
    });
    expect(result.signingSecret).toBeString();
    expect(result).not.toHaveProperty("signingSecretRef");
    expect(result).not.toHaveProperty("quotaSlot");
    const stored = [...memory.records.values()].find(
      (record) => record.itemType === "webhook-endpoint",
    );
    expect(stored?.data).not.toHaveProperty("signingSecret");
    expect(stored?.data).toHaveProperty("signingSecretRef");
    expect([...memory.records.values()].some((record) => record.itemType === "unique-claim")).toBe(
      true,
    );
  });

  test("returns the one-time webhook secret after an ambiguous committed transaction", async () => {
    const memory = memoryDatabase();
    const credential = withCanonicalRecordKeys({
      data: {
        environmentId,
        generation: 0,
        id: ids[8]!,
        organizationId,
        ownerId: ids[7]!,
        ownerType: "webhook-endpoint" as const,
        projectId,
        purpose: "webhook-signing",
        status: "active" as const,
      },
      itemType: "credential-vault-entry" as const,
    }) as unknown as PlatformRecord;
    const database = {
      ...memory.database,
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        await memory.database.transactWrite(operations);
        throw new Error("transaction result was lost");
      },
    } as unknown as DynamoDatabaseService;
    const generated = [ids[7]!, ids[8]!, ids[9]!];
    const dependencies = {
      credentialVault: {
        prepareWrite: async () => ({
          operation: { kind: "put", record: credential },
          reference: {
            credentialId: ids[8]!,
            generation: 0,
            store: "dynamodb-kms",
          },
        }),
      },
      database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const result = await createWebhook(dependencies, principal(), {
      eventTypes: ["run.completed"],
      name: "Ambiguous commit",
      url: "https://hooks.example.com/ambiguous",
    });

    expect(result).toMatchObject({
      id: ids[7],
      object: "webhook-endpoint",
      signingSecret: expect.any(String),
      status: "active",
    });
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "webhook-endpoint"),
    ).toHaveLength(1);
  });

  test("rejects webhook hosts that the delivery policy cannot send to", async () => {
    const memory = memoryDatabase();
    let prepared = false;
    const generated = [ids[7]!, ids[8]!, ids[9]!];
    const dependencies = {
      credentialVault: {
        prepareWrite: async () => {
          prepared = true;
          throw new Error("must not prepare a secret");
        },
      },
      database: memory.database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    expect(
      createWebhook(dependencies, principal(), {
        eventTypes: ["run.completed"],
        name: "Internal hook",
        url: "https://service.internal/hooks/runtime",
      }),
    ).rejects.toMatchObject({
      code: "invalid_webhook_subscription",
      status: 400,
    });
    expect(prepared).toBe(false);
    expect(memory.records.size).toBe(0);
  });

  test("counts legacy active webhook subscriptions toward the environment cap", async () => {
    const endpoints = Array.from({ length: 100 }, (_, index) =>
      makeWebhookEndpointRecord({
        environmentId,
        eventTypes: ["run.completed"],
        id: `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}` as Ulid,
        name: `Run lifecycle ${index}`,
        organizationId,
        projectId,
        signingSecretRef: {
          credentialId: ids[12]!,
          generation: 0,
          store: "dynamodb-kms",
        },
        url: `https://hooks-${index}.example.com/platform`,
        now,
      }),
    );
    const memory = memoryDatabase(endpoints);
    let prepared = false;

    expect(
      createWebhook(
        {
          credentialVault: {
            prepareWrite: async () => {
              prepared = true;
              throw new Error("must not prepare a secret");
            },
          },
          database: memory.database,
          generateId: async () => ids[15]!,
          now: () => now,
        } as unknown as RuntimeApiDependencies,
        principal(),
        {
          eventTypes: ["run.completed"],
          name: "Over quota",
          url: "https://hooks.example.com/platform",
        },
      ),
    ).rejects.toMatchObject({
      code: "webhook_subscription_limit",
      status: 409,
    });
    expect(prepared).toBe(false);
  });
});
