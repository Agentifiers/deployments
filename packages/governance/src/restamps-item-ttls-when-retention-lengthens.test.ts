import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import {
  governanceTenantDirectoryRecord,
  listDispatchableGovernanceOperations,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type RetentionRestampStore,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { makeRetentionRestampRunner } from "./governance-retention-restamp.ts";
import { createGovernanceService } from "./service.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const T0 = Date.parse("2026-08-21T00:00:00.000Z");
const DAY = 86_400_000;
const GRACE_SECONDS = 172_800;
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
};
const POLICY_KEY = {
  pk: `ORG#${ORGANIZATION_ID}`,
  sk: `RETENTION-POLICY#${ORGANIZATION_ID}`,
};

function attempt(index: number, createdAt: string) {
  return withCanonicalRecordKeys({
    data: {
      authorizedBrainCount: 1,
      candidateCount: 1,
      canonicalDropCount: 0,
      createdAt,
      emittedCount: 1,
      id: `01ARZ3NDEKTSV4RRFFQ69G${String(index).padStart(4, "0")}`,
      organizationId: ORGANIZATION_ID,
      placementGeneration: 1,
      provider: "aws-native",
      purpose: "search",
      queryHash: "query-hash",
      schemaGeneration: 1,
      status: "completed",
      targetId: PRINCIPAL_ID,
      version: 0,
    },
    itemType: "brain-query-attempt",
  }) as unknown as Extract<PlatformRecord, { readonly itemType: "brain-query-attempt" }>;
}

const ttlAfter = (createdAt: string, days: number) =>
  (Date.parse(createdAt) + days * DAY) / 1_000 + GRACE_SECONDS;

function installation() {
  const clock = { now: T0 };
  const fake = fakeDynamoDocumentClient();
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-01-01T00:00:00.000Z",
        id: ORGANIZATION_ID,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active" as const,
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: { completedAt: "2026-01-01T00:00:00.000Z", id: "governance-inventory-shard-writes" },
      itemType: "deploy-migration" as const,
    }),
  );
  const now = () => new Date(clock.now);
  const store = makeDynamoGovernanceStore(fake.client, TABLE_NAMES, { now });
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const service = createGovernanceService({
    allowedObjectBuckets: [],
    generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    now,
    objectStore: {
      blockWrites: unused,
      delete: unused,
      deleteAllVersions: unused,
      find: async () => undefined,
      put: unused,
      read: unused,
      size: unused,
    },
    signer: { keyId: "key", publicKey: async () => "public", sign: async () => "signature" },
    store,
  });
  const stored = (record: PlatformRecord) => {
    const locator = fake.get("control", governanceTenantDirectoryRecord(record)!) as
      | Extract<PlatformRecord, { readonly itemType: "governance-tenant-record" }>
      | undefined;
    return [fake.get("execution", record)?.ttl, locator?.ttl, locator?.data.recordTtl];
  };
  return { clock, fake, now, service, store, stored };
}

describe("retention TTL restamp", () => {
  test("a lengthening raises every record and locator TTL, resuming after a crash", async () => {
    const { clock, fake, now, service, store, stored } = installation();
    await service.updateRetentionPolicy({
      organizationId: ORGANIZATION_ID,
      patch: { events: 30, runs: 30 },
      principalId: PRINCIPAL_ID,
    });
    expect(
      fake.get("control", { pk: POLICY_KEY.pk, sk: `RETENTION-RESTAMP#${ORGANIZATION_ID}` }),
    ).toBeUndefined();
    const database = makeDynamoDatabase(fake.client, TABLE_NAMES);
    const records = Array.from({ length: 40 }, (_, index) =>
      attempt(index, new Date(T0 - (index % 2 === 0 ? 29 : 5) * DAY).toISOString()),
    );
    for (const record of records) await database.transactWrite([{ kind: "put", record }]);
    const oldPolicy = fake.get("control", POLICY_KEY);

    await service.updateRetentionPolicy({
      organizationId: ORGANIZATION_ID,
      patch: { runs: 90 },
      principalId: PRINCIPAL_ID,
    });

    // A write that read the 30-day policy before the lengthening committed after it.
    const inFlight = attempt(99, new Date(T0 - 29 * DAY).toISOString());
    const staleClient = {
      send: (command: GetCommand) =>
        command instanceof GetCommand && command.input.Key?.sk === POLICY_KEY.sk
          ? Promise.resolve({ Item: oldPolicy })
          : fake.client.send(command),
    } as unknown as DynamoDBDocumentClient;
    await makeDynamoDatabase(staleClient, TABLE_NAMES).transactWrite([
      { kind: "put", record: inFlight },
    ]);
    const written = [...records, inFlight];
    expect(stored(inFlight)).toEqual(Array(3).fill(ttlAfter(inFlight.data.createdAt, 30)));

    const run = makeRetentionRestampRunner({ now, store });
    clock.now = T0 + 5 * 60_000;
    expect(await run(ORGANIZATION_ID)).toEqual({ outcome: "waiting", restamped: 0 });

    let pages = 0;
    const crashing: RetentionRestampStore & Pick<typeof store, "getRetentionPolicy"> = {
      ...store,
      restampRetentionTtlPage: async (organizationId, input) => {
        pages += 1;
        if (pages === 3) throw new Error("worker crashed");
        return store.restampRetentionTtlPage(organizationId, input);
      },
    };
    expect(
      await listDispatchableGovernanceOperations(
        fake.client,
        TABLE_NAMES,
        new Date(T0 + 16 * 60_000),
      ),
    ).toEqual([{ kind: "retention-restamp", organizationId: ORGANIZATION_ID }]);
    clock.now = T0 + 16 * 60_000;
    const crash = await makeRetentionRestampRunner({ now, store: crashing })(ORGANIZATION_ID).catch(
      (cause: unknown) => cause,
    );
    expect(crash).toMatchObject({ message: "worker crashed" });
    const checkpointed = await store.getRetentionRestamp(ORGANIZATION_ID);
    expect(checkpointed).toMatchObject({
      dueAt: new Date(T0 + 31 * 60_000).toISOString(),
      phase: "soonest",
      policyVersion: 2,
    });
    expect(checkpointed?.cursor).toBeString();

    clock.now = T0 + 20 * 60_000;
    expect(await run(ORGANIZATION_ID)).toEqual({ outcome: "waiting", restamped: 0 });
    clock.now = T0 + 32 * 60_000;
    const resumed = await run(ORGANIZATION_ID);

    expect(resumed.outcome).toBe("completed");
    expect(await store.getRetentionRestamp(ORGANIZATION_ID)).toBeUndefined();
    expect(written.map(stored)).toEqual(
      written.map((record) => Array(3).fill(ttlAfter(record.data.createdAt, 90))),
    );
    expect(
      written.every(
        (record) =>
          Number(fake.get("execution", record)?.ttl) * 1_000 >=
          Date.parse(record.data.createdAt) + 90 * DAY,
      ),
    ).toBe(true);
  });
});
