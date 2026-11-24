import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import {
  governanceTenantDirectoryRecord,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  makeSemanticEventRecord,
  withCanonicalRecordKeys,
  type BrainTenantInventory,
  type PlatformRecord,
  type TenantRecord,
} from "../index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BRAIN_A = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const BRAIN_B = "01ARZ3NDEKTSV4RRFFQ69G5FA2";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;
const NOW = new Date("2026-08-21T00:00:00.000Z");
const LEGACY_INVENTORY_PARTITION = `ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY`;

/** Where writers put a record's locator while the shard-writes marker is absent. */
function legacyLocatorKey(record: PlatformRecord) {
  return { pk: LEGACY_INVENTORY_PARTITION, sk: governanceTenantDirectoryRecord(record)!.sk };
}

function organization() {
  return withCanonicalRecordKeys({
    data: {
      createdAt: "2026-08-21T00:00:00.000Z",
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

function rateLimitCounter(scopeId: string, limitKey: string) {
  return withCanonicalRecordKeys({
    data: {
      count: 1,
      expiresAt: "2026-08-22T00:00:00.000Z",
      limitKey,
      organizationId: ORGANIZATION_ID,
      scopeId,
      version: 1,
      window: "2026-08-21T00",
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse("2026-08-22T00:00:00.000Z") / 1_000),
  }) as unknown as PlatformRecord;
}

function brainEvent(aggregateId: string, version: number, payload: Record<string, unknown>) {
  return makeSemanticEventRecord({
    aggregateId: aggregateId as never,
    aggregateType: "brain",
    aggregateVersion: version,
    eventId: `01ARZ3NDEKTSV4RRFFQ69G5FB${version}` as never,
    eventType: "brain.updated",
    occurredAt: NOW.toISOString(),
    organizationId: ORGANIZATION_ID as never,
    payload: payload as never,
  }) as unknown as PlatformRecord;
}

function seededStore() {
  const fake = fakeDynamoDocumentClient();
  fake.put("control", organization());
  const queries: QueryCommand["input"][] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) queries.push(command.input);
      return fake.client.send(command as never);
    },
  } as unknown as typeof fake.client;
  const database = makeDynamoDatabase(client, TABLE_NAMES);
  const store = makeDynamoGovernanceStore(client, TABLE_NAMES, { now: () => NOW });
  return { database, fake, queries, store };
}

async function listAll(
  store: BrainTenantInventory,
  brainId: string,
): Promise<readonly TenantRecord[]> {
  const items: TenantRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listBrainRecords(ORGANIZATION_ID, brainId, cursor);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

describe("governance Brain inventory", () => {
  test("projects locators by the Brains their record names", () => {
    const single = governanceTenantDirectoryRecord(
      rateLimitCounter(BRAIN_A, "brain-upload.issuance.brain"),
    );
    const multi = governanceTenantDirectoryRecord(
      brainEvent(BRAIN_A, 1, { brainId: BRAIN_B, nested: [{ brainId: BRAIN_A }] }),
    );
    const unrelated = governanceTenantDirectoryRecord(
      rateLimitCounter(ORGANIZATION_ID, "brain-upload.issuance.organization"),
    );

    expect(single?.data.brainIds).toEqual([BRAIN_A]);
    expect(single?.gsi2pk).toBe(`ORG#${ORGANIZATION_ID}#BRAIN#${BRAIN_A}#GOVERNANCE-INVENTORY`);
    expect(single?.gsi2sk).toBe(single?.sk);
    expect(multi?.data.brainIds).toEqual([BRAIN_A, BRAIN_B]);
    expect(multi?.gsi2pk).toBe(`ORG#${ORGANIZATION_ID}#GOVERNANCE-INVENTORY#MULTI-BRAIN`);
    expect(unrelated?.data.brainIds).toBeUndefined();
    expect(unrelated?.gsi2pk).toBeUndefined();
  });

  test("lists and erases one Brain without touching another Brain or the organization inventory", async () => {
    const { database, fake, queries, store } = seededStore();
    const brainACounter = rateLimitCounter(BRAIN_A, "brain-upload.issuance.brain");
    const brainBCounter = rateLimitCounter(BRAIN_B, "brain-upload.issuance.brain");
    const organizationCounter = rateLimitCounter(
      ORGANIZATION_ID,
      "brain-upload.issuance.organization",
    );
    const brainAEvent = brainEvent(BRAIN_A, 1, { brainId: BRAIN_A });
    const brainBEvent = brainEvent(BRAIN_B, 1, { brainId: BRAIN_B });
    const sharedEvent = brainEvent(BRAIN_A, 2, {
      brainId: BRAIN_A,
      citations: [{ brainId: BRAIN_B }],
    });
    for (const record of [
      brainACounter,
      brainBCounter,
      organizationCounter,
      brainAEvent,
      brainBEvent,
      sharedEvent,
    ]) {
      await database.transactWrite([{ kind: "put", record }]);
    }

    const owned = await listAll(store, BRAIN_A);
    expect(owned.map(({ record }) => record.sk).toSorted()).toEqual(
      [brainACounter.sk, brainAEvent.sk, sharedEvent.sk].toSorted(),
    );
    expect(
      queries.every(
        (query) =>
          query.IndexName === "gsi2" &&
          query.ExpressionAttributeValues?.[":partition"] !== LEGACY_INVENTORY_PARTITION,
      ),
    ).toBe(true);

    await store.deleteTenantRecords(owned, "2026-08-21T00:15:00.000Z");

    expect(await listAll(store, BRAIN_A)).toEqual([]);
    const survivors = await listAll(store, BRAIN_B);
    expect(survivors.map(({ record }) => record.sk).toSorted()).toEqual(
      [brainBCounter.sk, brainBEvent.sk].toSorted(),
    );
    expect(fake.get("usage", organizationCounter)).toBeDefined();
    expect(fake.get("control", legacyLocatorKey(organizationCounter))).toBeDefined();
    for (const record of [brainACounter, brainAEvent, sharedEvent]) {
      expect(fake.get("control", legacyLocatorKey(record))).toBeUndefined();
    }
  });

  test("skips index entries whose locator was deleted with its record", async () => {
    const { database, fake, store } = seededStore();
    const counter = rateLimitCounter(BRAIN_A, "brain-upload.issuance.brain");
    await database.transactWrite([{ kind: "put", record: counter }]);
    const staleLocator = fake.get("control", legacyLocatorKey(counter))!;
    await store.deleteTenantRecords(
      [{ record: counter, table: "usage" }],
      "2026-08-21T00:15:00.000Z",
    );
    // The eventually consistent index still nominates the deleted locator.
    const staleStore = makeDynamoGovernanceStore(
      {
        send: async (command: unknown) =>
          command instanceof QueryCommand && command.input.IndexName === "gsi2"
            ? { Items: [staleLocator] }
            : fake.client.send(command as never),
      } as typeof fake.client,
      TABLE_NAMES,
      { now: () => NOW },
    );

    expect(staleStore.listBrainRecords(ORGANIZATION_ID, BRAIN_A)).resolves.toEqual({
      cursor: expect.any(String),
      items: [],
    });
  });

  test("a dangling locator outside the Brain fails only the organization inventory", async () => {
    const { database, fake, store } = seededStore();
    const brainCounter = rateLimitCounter(BRAIN_A, "brain-upload.issuance.brain");
    await database.transactWrite([{ kind: "put", record: brainCounter }]);
    // An out-of-band purge removed a non-Brain record but left its TTL-less locator behind.
    const { ttl: _ttl, ...purged } = rateLimitCounter(
      ORGANIZATION_ID,
      "brain-upload.issuance.organization",
    );
    fake.put("control", governanceTenantDirectoryRecord(purged as PlatformRecord)!);

    expect(listAll(store, BRAIN_A)).resolves.toEqual([
      { record: expect.objectContaining({ sk: brainCounter.sk }), table: "usage" },
    ]);
    let cursor: string | undefined;
    expect(
      (async () => {
        do {
          cursor = (await store.listTenantRecords(ORGANIZATION_ID, cursor)).cursor;
        } while (cursor);
      })(),
    ).rejects.toThrow("Governance inventory does not resolve to its canonical tenant record.");
  });
});
