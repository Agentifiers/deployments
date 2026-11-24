import {
  makeUniqueClaimRecord,
  tableForItemType,
  uniqueClaimRequirements,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { makeWebhookEndpointRecord, replaceWebhookEndpointRecord } from "@deployments-ai/webhooks";
import { describe, expect, test } from "bun:test";
import { archiveWebhook, createWebhook } from "./runtime-operations.ts";
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

describe("runtime discovery and lifecycle operations", () => {
  test("counts active legacy webhooks beyond ten pages of archived history", async () => {
    const archived = replaceWebhookEndpointRecord(
      makeWebhookEndpointRecord({
        environmentId,
        eventTypes: ["run.completed"],
        id: ids[7]!,
        name: "Archived history",
        organizationId,
        projectId,
        signingSecretRef: {
          credentialId: ids[12]!,
          generation: 0,
          store: "dynamodb-kms",
        },
        url: "https://archived.example.com/platform",
        now,
      }),
      { status: "archived" },
    );
    const active = Array.from({ length: 100 }, (_, index) =>
      makeWebhookEndpointRecord({
        environmentId,
        eventTypes: ["run.completed"],
        id: `01ARZ3NDEKTSV4RRFFQ69G6${String(index).padStart(3, "0")}` as Ulid,
        name: `Legacy active ${index}`,
        organizationId,
        projectId,
        signingSecretRef: {
          credentialId: ids[12]!,
          generation: 0,
          store: "dynamodb-kms",
        },
        url: `https://legacy-${index}.example.com/platform`,
        now,
      }),
    );
    let endpointPage = 0;
    const database = {
      queryRecords: (
        _table: string,
        input: { readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>> },
      ) => {
        if (input.ExpressionAttributeValues?.[":prefix"] === "VALUE#") {
          return Promise.resolve({ items: [] });
        }
        endpointPage += 1;
        if (endpointPage <= 10) {
          return Promise.resolve({
            items: [archived],
            lastEvaluatedKey: { pk: archived.pk, sk: `${archived.sk}-${endpointPage}` },
          });
        }
        return Promise.resolve({ items: active });
      },
    } as unknown as DynamoDatabaseService;
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
          database,
          generateId: async () => ids[15]!,
          now: () => now,
          sessionTokenSecret,
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
    expect(endpointPage).toBe(11);
    expect(prepared).toBe(false);
  });

  test("reserves distinct quota slots for concurrent webhook creates", async () => {
    const memory = memoryDatabase();
    const dependency = (generated: Ulid[], credentialKey: string): RuntimeApiDependencies => {
      const credentialId = generated[1]!;
      return {
        credentialVault: {
          prepareWrite: async () => ({
            operation: {
              kind: "put",
              record: {
                data: {},
                itemType: "credential-vault-entry",
                pk: credentialKey,
                sk: credentialKey,
              },
            },
            reference: {
              credentialId,
              generation: 0,
              store: "dynamodb-kms",
            },
          }),
        },
        database: memory.database,
        generateId: async () => generated.shift()!,
        now: () => now,
      } as unknown as RuntimeApiDependencies;
    };

    await Promise.all([
      createWebhook(
        dependency(
          [
            "01ARZ3NDEKTSV4RRFFQ69G5100",
            "01ARZ3NDEKTSV4RRFFQ69G5101",
            "01ARZ3NDEKTSV4RRFFQ69G5102",
          ] as Ulid[],
          "credential-a",
        ),
        principal(),
        {
          eventTypes: ["run.completed"],
          name: "Concurrent A",
          url: "https://hooks-a.example.com/platform",
        },
      ),
      createWebhook(
        dependency(
          [
            "01ARZ3NDEKTSV4RRFFQ69G5103",
            "01ARZ3NDEKTSV4RRFFQ69G5104",
            "01ARZ3NDEKTSV4RRFFQ69G5105",
          ] as Ulid[],
          "credential-b",
        ),
        principal(),
        {
          eventTypes: ["run.completed"],
          name: "Concurrent B",
          url: "https://hooks-b.example.com/platform",
        },
      ),
    ]);

    const quotaSlots = [...memory.records.values()]
      .filter((record) => record.itemType === "webhook-endpoint")
      .map((record) => record.data.quotaSlot)
      .toSorted(
        (left, right) => (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY),
      );
    expect(quotaSlots).toEqual([0, 1]);
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "unique-claim"),
    ).toHaveLength(2);
  });

  test("releases the quota slot when archiving a webhook", async () => {
    const endpoint = makeWebhookEndpointRecord({
      environmentId,
      eventTypes: ["run.completed"],
      id: ids[7]!,
      name: "Run lifecycle",
      organizationId,
      projectId,
      quotaSlot: 0,
      signingSecretRef: {
        credentialId: ids[8]!,
        generation: 0,
        store: "dynamodb-kms",
      },
      url: "https://hooks.example.com/platform",
      now,
    });
    const claim = makeUniqueClaimRecord(
      uniqueClaimRequirements(endpoint)[0]!,
      now.toISOString(),
    ) as Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;
    const memory = memoryDatabase([endpoint, claim]);

    const result = await archiveWebhook(
      {
        credentialVault: {
          prepareRevoke: async () => ({
            operation: {
              kind: "delete",
              record: {
                data: {},
                itemType: "credential-vault-entry",
                pk: "credential",
                sk: "credential",
              },
            },
          }),
        },
        database: memory.database,
        generateId: async () => ids[9]!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      endpoint.data.id,
    );

    expect(result).toMatchObject({ status: "archived" });
    expect(result).not.toHaveProperty("quotaSlot");
    expect(memory.records.has(`${claim.pk}\n${claim.sk}`)).toBe(false);
  });
});
