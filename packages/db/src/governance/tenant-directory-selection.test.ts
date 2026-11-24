import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import {
  governanceObjectDigest,
  governanceTenantDirectoryRecord,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type GovernanceStore,
  type PlatformRecord,
  type TenantRecord,
  type TenantRecordLocator,
  type TenantRecordSelection,
} from "../index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;
const BUCKET = "artifacts";

function organization() {
  return withCanonicalRecordKeys({
    data: {
      createdAt: "2026-08-20T00:00:00.000Z",
      id: ORGANIZATION_ID,
      name: "Deployments.ai",
      slug: "deployments-ai",
      status: "active" as const,
      updatedAt: "2026-08-21T00:00:00.000Z",
      version: 1,
    },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord;
}

function counter(extraData: Readonly<Record<string, unknown>> = {}) {
  return withCanonicalRecordKeys({
    data: {
      count: 1,
      expiresAt: "2026-08-22T00:00:00.000Z",
      limitKey: "brain-upload.issuance.organization",
      organizationId: ORGANIZATION_ID,
      scopeId: ORGANIZATION_ID,
      version: 1,
      window: "2026-08-21T00",
      ...extraData,
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse("2026-08-22T00:00:00.000Z") / 1_000),
  }) as unknown as PlatformRecord;
}

function storeOver(
  locators: readonly PlatformRecord[],
  batchGet: (input: BatchGetCommand["input"]) => Record<string, unknown>,
) {
  const commands: unknown[] = [];
  const store = makeDynamoGovernanceStore(
    {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof QueryCommand) {
          const partition = command.input.ExpressionAttributeValues?.[":inventory"];
          return { Items: locators.filter((locator) => locator.pk === partition) };
        }
        if (command instanceof BatchGetCommand) return batchGet(command.input);
        return {};
      },
    } as unknown as DynamoDBDocumentClient,
    TABLE_NAMES,
    { now: () => new Date("2026-08-21T00:00:00.000Z") },
  );
  return { commands, store };
}

async function listAll(store: GovernanceStore, selection: TenantRecordSelection) {
  const items: TenantRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listTenantRecords(ORGANIZATION_ID, cursor, selection);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items.toSorted((left, right) => left.table.localeCompare(right.table));
}

describe("governance tenant directory selection", () => {
  test("records each locator's retention timestamp and object digests", () => {
    const referencing = counter({
      nested: { copies: [{ bucket: BUCKET, key: "b" }] },
      storage: { bucket: BUCKET, key: "a" },
    });

    expect(governanceTenantDirectoryRecord(referencing)?.data).toMatchObject({
      recordObjectDigests: [
        governanceObjectDigest(BUCKET, "a"),
        governanceObjectDigest(BUCKET, "b"),
      ].sort(),
      recordTimestamp: "2026-08-22T00:00:00.000Z",
    });
    expect(governanceTenantDirectoryRecord(organization())?.data).toMatchObject({
      recordObjectDigests: [],
      recordTimestamp: "2026-08-21T00:00:00.000Z",
    });
  });

  test("reads only selected records, each with its requested consistency", async () => {
    const owner = organization();
    const usage = counter();
    const seen: TenantRecordLocator[] = [];
    const { commands, store } = storeOver(
      [governanceTenantDirectoryRecord(owner)!, governanceTenantDirectoryRecord(usage)!],
      (input) => ({
        Responses: Object.fromEntries(
          Object.keys(input.RequestItems ?? {}).map((table) => [
            table,
            table === "control" ? [owner] : [usage],
          ]),
        ),
      }),
    );

    expect(
      await listAll(store, {
        select: (locator) => {
          seen.push(locator);
          return locator.recordItemType === "organization" ? "consistent" : "eventual";
        },
      }),
    ).toEqual([
      { record: owner, table: "control" },
      { record: usage, table: "usage" },
    ]);
    expect(seen.map((locator) => locator.recordItemType).toSorted()).toEqual([
      "organization",
      "rate-limit-counter",
    ]);
    expect(
      commands.every(
        (command) => !(command instanceof QueryCommand) || command.input.ConsistentRead === true,
      ),
    ).toBe(true);
    expect(
      commands
        .filter((command): command is BatchGetCommand => command instanceof BatchGetCommand)
        .map((command) => command.input.RequestItems)
        .toSorted((left, right) => Object.keys(left!)[0]!.localeCompare(Object.keys(right!)[0]!)),
    ).toEqual([
      { control: { ConsistentRead: true, Keys: [{ pk: owner.pk, sk: owner.sk }] } },
      { usage: { ConsistentRead: false, Keys: [{ pk: usage.pk, sk: usage.sk }] } },
    ]);
  });

  test("skips unselected records without reading them", async () => {
    const { commands, store } = storeOver(
      [governanceTenantDirectoryRecord(organization())!],
      () => {
        throw new Error("an unselected record must not be read");
      },
    );

    expect(await listAll(store, { select: () => undefined })).toEqual([]);
    expect(commands).toHaveLength(18);
    expect(
      commands
        .filter((command) => !(command instanceof QueryCommand))
        .map((command) => (command instanceof GetCommand ? command.input : command)),
    ).toEqual([
      {
        ConsistentRead: true,
        Key: {
          pk: "GLOBAL#deploy-migration",
          sk: "DEPLOY-MIGRATION#governance-inventory-shard-writes",
        },
        TableName: "control",
      },
    ]);
  });

  test("strongly re-reads a record its eventual read missed before failing closed", async () => {
    const usage = counter();
    const { commands, store } = storeOver([governanceTenantDirectoryRecord(usage)!], (input) =>
      input.RequestItems?.usage?.ConsistentRead ? { Responses: { usage: [usage] } } : {},
    );

    expect(await listAll(store, { select: () => "eventual" })).toEqual([
      { record: usage, table: "usage" },
    ]);
    expect(
      commands
        .filter((command): command is BatchGetCommand => command instanceof BatchGetCommand)
        .map((command) => command.input.RequestItems?.usage?.ConsistentRead),
    ).toEqual([false, true]);
  });
});
