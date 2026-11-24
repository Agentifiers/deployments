import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import {
  governanceLegacyDirectoryRecord,
  governanceTenantDirectoryRecord,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type GovernanceStore,
  type PlatformRecord,
  type TenantRecord,
} from "../index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;

function organization(id = ORGANIZATION_ID) {
  return withCanonicalRecordKeys({
    data: {
      createdAt: "2026-08-21T00:00:00.000Z",
      id,
      name: "Deployments.ai",
      slug: `organization-${id}`,
      status: "active" as const,
      updatedAt: "2026-08-21T00:00:00.000Z",
      version: 1,
    },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord;
}

const INVENTORY_PARTITIONS = [
  `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY`,
  ...Array.from(
    { length: 16 },
    (_, shard) =>
      `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY#SHARD#${String(shard).padStart(2, "0")}`,
  ),
];

function inventoryPage(command: QueryCommand, locators: readonly { readonly pk: string }[]) {
  const partition = command.input.ExpressionAttributeValues?.[":inventory"];
  return { Items: locators.filter((locator) => locator.pk === partition) };
}

async function listAll(store: GovernanceStore) {
  const items: TenantRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listTenantRecords(ORGANIZATION_ID, cursor);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

describe("governance tenant directory inventory", () => {
  test("strongly resolves an authoritative directory page", async () => {
    const source = organization();
    const directory = governanceTenantDirectoryRecord(source);
    if (!directory) throw new Error("Expected tenant directory record.");
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof QueryCommand) return inventoryPage(command, [directory]);
          if (command instanceof BatchGetCommand) {
            return { Responses: { control: [source] } };
          }
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
    );

    expect(await listAll(store)).toEqual([{ record: source, table: "control" }]);
    const queries = commands.filter((command) => command instanceof QueryCommand);
    expect(queries.map(({ input }) => input.ExpressionAttributeValues?.[":inventory"])).toEqual(
      INVENTORY_PARTITIONS,
    );
    expect(
      queries.every(({ input }) => input.ConsistentRead && input.TableName === "control"),
    ).toBe(true);
    expect(
      commands.find((command) => command instanceof BatchGetCommand)?.input.RequestItems,
    ).toEqual({
      control: {
        ConsistentRead: true,
        Keys: [{ pk: source.pk, sk: source.sk }],
      },
    });
  });

  test("fails closed for missing or cross-tenant directory targets", async () => {
    const source = organization();
    const directory = governanceTenantDirectoryRecord(source);
    if (!directory) throw new Error("Expected tenant directory record.");
    for (const resolved of [undefined, organization(OTHER_ORGANIZATION_ID)]) {
      const store = makeDynamoGovernanceStore(
        {
          send: async (command: unknown) => {
            if (command instanceof QueryCommand) return inventoryPage(command, [directory]);
            if (command instanceof BatchGetCommand) {
              // The unresolved locator is re-read and is still present and unchanged.
              const keys = command.input.RequestItems?.control?.Keys ?? [];
              if (keys.some((locatorKey) => locatorKey.pk === directory.pk)) {
                return { Responses: { control: [directory] } };
              }
              return { Responses: { control: resolved ? [resolved] : [] } };
            }
            return {};
          },
        } as unknown as DynamoDBDocumentClient,
        TABLE_NAMES,
      );

      expect(listAll(store)).rejects.toThrow(
        "Governance inventory does not resolve to its canonical tenant record.",
      );
    }
  });

  test("ignores only missing source rows whose recorded DynamoDB TTL has elapsed", async () => {
    const expiresAt = "2026-08-20T00:00:00.000Z";
    const source = withCanonicalRecordKeys({
      data: {
        count: 1,
        expiresAt,
        limitKey: "brain-upload.issuance.organization",
        organizationId: ORGANIZATION_ID,
        scopeId: ORGANIZATION_ID,
        version: 1,
        window: "2026-08-19T00",
      },
      itemType: "rate-limit-counter" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }) as unknown as PlatformRecord;
    const directory = governanceTenantDirectoryRecord(source);
    if (!directory) throw new Error("Expected tenant directory record.");
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof QueryCommand) return inventoryPage(command, [directory]);
          if (command instanceof BatchGetCommand) {
            return command.input.RequestItems?.control
              ? { Responses: { control: [directory] } }
              : { Responses: { usage: [] } };
          }
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
      { now: () => new Date("2026-08-21T00:00:00.000Z") },
    );

    expect(await listAll(store)).toEqual([]);
    const cleanup = commands.find(
      (command): command is TransactWriteCommand => command instanceof TransactWriteCommand,
    );
    expect(cleanup?.input.TransactItems).toEqual([
      {
        ConditionCheck: {
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          Key: { pk: source.pk, sk: source.sk },
          TableName: "usage",
        },
      },
      expect.objectContaining({
        Delete: expect.objectContaining({
          Key: { pk: directory.pk, sk: directory.sk },
          TableName: "control",
        }),
      }),
    ]);
  });

  test("skips a retention TTL locator whose ttl passed without reading or pruning", async () => {
    const attempt = (id: string, ttl: string) =>
      withCanonicalRecordKeys({
        data: {
          authorizedBrainCount: 1,
          candidateCount: 1,
          canonicalDropCount: 0,
          createdAt: "2026-08-01T00:00:00.000Z",
          emittedCount: 1,
          id,
          organizationId: ORGANIZATION_ID,
          placementGeneration: 1,
          provider: "aws-native",
          purpose: "search",
          queryHash: "query-hash",
          schemaGeneration: 1,
          status: "completed",
          targetId: OTHER_ORGANIZATION_ID,
          version: 0,
        },
        itemType: "brain-query-attempt",
        ttl: Date.parse(ttl) / 1_000,
      }) as unknown as PlatformRecord;
    const expired = attempt("01ARZ3NDEKTSV4RRFFQ69G5FB1", "2026-08-20T00:00:00.000Z");
    const live = attempt("01ARZ3NDEKTSV4RRFFQ69G5FB2", "2026-08-22T00:00:00.000Z");
    const expiresAt = "2026-08-20T00:00:00.000Z";
    const expiredCounter = withCanonicalRecordKeys({
      data: {
        count: 1,
        expiresAt,
        limitKey: "brain-upload.issuance.organization",
        organizationId: ORGANIZATION_ID,
        scopeId: ORGANIZATION_ID,
        version: 1,
        window: "2026-08-19T00",
      },
      itemType: "rate-limit-counter" as const,
      ttl: Date.parse(expiresAt) / 1_000,
    }) as unknown as PlatformRecord;
    const directory = [expired, live, expiredCounter].map(
      (record) => governanceTenantDirectoryRecord(record)!,
    );
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof QueryCommand) return inventoryPage(command, directory);
          if (command instanceof BatchGetCommand) {
            return { Responses: { execution: [expired, live], usage: [expiredCounter] } };
          }
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
      { now: () => new Date("2026-08-21T00:00:00.000Z") },
    );

    expect(directory.map((locator) => locator.ttl)).toEqual([
      Date.parse("2026-08-20T00:00:00.000Z") / 1_000,
      Date.parse("2026-08-22T00:00:00.000Z") / 1_000,
      undefined,
    ]);
    expect((await listAll(store)).map(({ record }) => record.sk).toSorted()).toEqual(
      [live.sk, expiredCounter.sk].toSorted(),
    );
    expect(
      commands
        .flatMap((command) =>
          command instanceof BatchGetCommand
            ? Object.values(command.input.RequestItems ?? {}).flatMap(({ Keys }) => Keys ?? [])
            : [],
        )
        .map(({ sk }) => String(sk))
        .toSorted(),
    ).toEqual([live.sk, expiredCounter.sk].toSorted());
    expect(commands.some((command) => command instanceof TransactWriteCommand)).toBe(false);
  });

  test("fails closed when legacy locators resolve to the wrong record type", async () => {
    const expiresAt = "2026-08-22T00:00:00.000Z";
    const legacy = withCanonicalRecordKeys({
      data: {
        commandHash: "legacy-command-hash",
        createdAt: "2026-08-21T00:00:00.000Z",
        expiresAt,
        idempotencyKey: "agent-api:legacy",
        principalId: OTHER_ORGANIZATION_ID,
        resourceIds: [],
        status: "completed" as const,
        version: 1,
      },
      itemType: "idempotency" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }) as unknown as PlatformRecord;
    const directory = governanceLegacyDirectoryRecord(legacy);
    if (!directory) throw new Error("Expected legacy directory record.");
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) return { Items: [directory] };
          if (command instanceof BatchGetCommand) {
            return { Responses: { events: [organization()] } };
          }
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
    );

    expect(store.listLegacyPrincipalIdempotency(ORGANIZATION_ID)).rejects.toThrow(
      "does not resolve to its canonical idempotency record",
    );
  });

  test("prunes a missing expired locator from the global legacy directory", async () => {
    const expiresAt = "2026-08-20T00:00:00.000Z";
    const legacy = withCanonicalRecordKeys({
      data: {
        commandHash: "legacy-command-hash",
        createdAt: "2026-08-19T00:00:00.000Z",
        expiresAt,
        idempotencyKey: "agent-api:expired",
        principalId: OTHER_ORGANIZATION_ID,
        resourceIds: [],
        status: "completed" as const,
        version: 1,
      },
      itemType: "idempotency" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }) as unknown as PlatformRecord;
    const directory = governanceLegacyDirectoryRecord(legacy);
    if (!directory) throw new Error("Expected legacy directory record.");
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof QueryCommand) return { Items: [directory] };
          if (command instanceof BatchGetCommand) return { Responses: { events: [] } };
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
      { now: () => new Date("2026-08-21T00:00:00.000Z") },
    );

    expect(store.listLegacyPrincipalIdempotency(ORGANIZATION_ID)).resolves.toEqual([]);
    const cleanup = commands.find(
      (command): command is TransactWriteCommand => command instanceof TransactWriteCommand,
    );
    expect(cleanup?.input.TransactItems).toEqual([
      {
        ConditionCheck: {
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          Key: { pk: legacy.pk, sk: legacy.sk },
          TableName: "events",
        },
      },
      expect.objectContaining({
        Delete: expect.objectContaining({
          Key: { pk: directory.pk, sk: directory.sk },
          TableName: "control",
        }),
      }),
    ]);
  });

  test("requires the completed backfill marker in production mode", async () => {
    const commands: unknown[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          commands.push(command);
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
      { requireTenantInventoryReady: true },
    );

    expect(store.listTenantRecords(ORGANIZATION_ID)).rejects.toThrow(
      "authoritative directory backfill completes",
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetCommand);
  });

  test("bounds deterministic legacy lease reads to DynamoDB batch limits", async () => {
    const commands: BatchGetCommand[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: BatchGetCommand) => {
          commands.push(command);
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
    );
    const ids = Array.from({ length: 101 }, (_, index) => String(index).padStart(26, "0"));

    expect(store.listLegacyRuntimeLeases(ids)).resolves.toEqual([]);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.input.RequestItems?.execution?.Keys?.length)).toEqual([
      100, 1,
    ]);
    expect(
      commands.every((command) => command.input.RequestItems?.execution?.ConsistentRead === true),
    ).toBe(true);
  });

  test("backs off and bounds throttled inventory batch reads", async () => {
    const source = organization();
    const directory = governanceTenantDirectoryRecord(source);
    if (!directory) throw new Error("Expected tenant directory record.");
    const batchCommands: BatchGetCommand[] = [];
    const retryDelays: number[] = [];
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) return inventoryPage(command, [directory]);
          if (command instanceof BatchGetCommand) {
            batchCommands.push(command);
            return {
              UnprocessedKeys: {
                control: {
                  ConsistentRead: true,
                  Keys: [{ pk: source.pk, sk: source.sk }],
                },
              },
            };
          }
          return {};
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
      {
        batchWriteRandom: () => 0.5,
        batchWriteSleep: async (milliseconds) => {
          retryDelays.push(milliseconds);
        },
      },
    );

    expect(listAll(store)).rejects.toThrow("remained throttled past their retry budget");
    expect(batchCommands).toHaveLength(8);
    expect(retryDelays).toEqual([25, 50, 100, 200, 400, 500, 500]);
  });

  test("tolerates a record deleted with its locator after the page read", async () => {
    const fake = fakeDynamoDocumentClient();
    fake.put("control", organization());
    const counter = withCanonicalRecordKeys({
      data: {
        count: 1,
        expiresAt: "2026-08-22T00:00:00.000Z",
        limitKey: "brain-upload.issuance.organization",
        organizationId: ORGANIZATION_ID,
        scopeId: ORGANIZATION_ID,
        version: 1,
        window: "2026-08-21T00",
      },
      itemType: "rate-limit-counter" as const,
      ttl: Math.floor(Date.parse("2026-08-22T00:00:00.000Z") / 1_000),
    }) as unknown as PlatformRecord;
    await makeDynamoDatabase(fake.client, TABLE_NAMES).transactWrite([
      { kind: "put", record: counter },
    ]);
    // Without the shard-writes marker the writer placed the locator on the legacy partition.
    const locator = {
      pk: `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY`,
      sk: governanceTenantDirectoryRecord(counter)!.sk,
    };
    let deleted = false;
    const store = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) => {
          const result = await fake.client.send(command as never);
          const listed =
            command instanceof QueryCommand && "Items" in result && result.Items?.length;
          if (listed && !deleted) {
            // A concurrent writer deletes the record and its locator after the page read.
            deleted = true;
            await fake.client.send(
              new TransactWriteCommand({
                TransactItems: [
                  { Delete: { Key: { pk: counter.pk, sk: counter.sk }, TableName: "usage" } },
                  { Delete: { Key: { pk: locator.pk, sk: locator.sk }, TableName: "control" } },
                ],
              }),
            );
          }
          return result;
        },
      } as unknown as DynamoDBDocumentClient,
      TABLE_NAMES,
      { now: () => new Date("2026-08-21T00:00:00.000Z") },
    );

    expect(await listAll(store)).toEqual([]);
    expect(deleted).toBe(true);
  });
});
