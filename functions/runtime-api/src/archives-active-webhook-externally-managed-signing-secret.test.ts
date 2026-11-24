import {
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { makeWebhookEndpointRecord } from "@deployments-ai/webhooks";
import { describe, expect, test } from "bun:test";
import { archiveWebhook } from "./runtime-operations.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

const ids = Array.from(
  { length: 32 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}`,
) as Ulid[];
const [organizationId, projectId, environmentId, serviceAccountId] = ids as [
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

describe("runtime discovery and lifecycle operations", () => {
  test("archives an active webhook with an externally managed signing secret", async () => {
    const endpoint = makeWebhookEndpointRecord({
      environmentId,
      eventTypes: ["run.completed"],
      id: ids[7]!,
      name: "Legacy lifecycle",
      organizationId,
      projectId,
      signingSecretRef: {
        arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:webhook-signing",
        versionStage: "AWSCURRENT",
      },
      url: "https://hooks.example.com/platform",
      now,
    });
    const memory = memoryDatabase([endpoint]);
    let revokeAttempted = false;

    const result = await archiveWebhook(
      {
        credentialVault: {
          prepareRevoke: async () => {
            revokeAttempted = true;
            throw new Error("external secret must not be revoked");
          },
        },
        database: memory.database,
        generateId: async () => ids[9]!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      endpoint.data.id,
    );

    expect(result).toMatchObject({ status: "archived" });
    expect(revokeAttempted).toBe(false);
    expect(memory.records.get(`${endpoint.pk}\n${endpoint.sk}`)).toMatchObject({
      data: { status: "archived" },
    });
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.aggregateId === endpoint.data.id &&
          record.data.eventType === "webhook.endpoint.archived",
      ),
    ).toMatchObject({ data: { aggregateVersion: 1 } });
  });
});
