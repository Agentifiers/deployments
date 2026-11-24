import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { policyRecord } from "./governance/dynamo-store.ts";
import { governanceTenantDirectoryRecord } from "./governance-tenant-directory.ts";
import { makeDynamoDatabase } from "./dynamo-database.ts";
import { Ulid } from "./ids.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { makeSemanticEventRecord } from "./semantic-event-storage.ts";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "./testing/dynamo-document-client.fixture.ts";

const id = (value: string) => Schema.decodeUnknownSync(Ulid)(value);
const ORGANIZATION_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const ATTEMPT_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const TARGET_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FB2");
const CREATED_AT = "2026-08-21T10:00:00.000Z";
const TABLE_NAMES = {
  control: "control",
  events: "events",
  execution: "execution",
  usage: "usage",
} as const;

function seeded(policy?: { readonly events: number; readonly runs: number }) {
  const fake = fakeDynamoDocumentClient();
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: CREATED_AT,
        id: ORGANIZATION_ID,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active" as const,
        updatedAt: CREATED_AT,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  fake.put(
    "control",
    withCanonicalRecordKeys({
      data: { completedAt: CREATED_AT, id: "governance-inventory-shard-writes" },
      itemType: "deploy-migration" as const,
    }),
  );
  if (policy) {
    fake.put(
      "control",
      policyRecord({
        artifacts: 365,
        audit: 2_555,
        createdAt: CREATED_AT,
        events: policy.events,
        messages: 365,
        organizationId: ORGANIZATION_ID,
        runs: policy.runs,
        threads: 365,
        updatedAt: CREATED_AT,
        updatedByPrincipalId: ORGANIZATION_ID,
        version: 1,
      }),
    );
  }
  return { database: makeDynamoDatabase(fake.client, TABLE_NAMES), fake };
}

function queryAttempt() {
  return withCanonicalRecordKeys({
    data: {
      authorizedBrainCount: 1,
      candidateCount: 10,
      canonicalDropCount: 0,
      createdAt: CREATED_AT,
      emittedCount: 10,
      id: ATTEMPT_ID,
      organizationId: ORGANIZATION_ID,
      placementGeneration: 1,
      provider: "aws-native",
      purpose: "search",
      queryHash: "query-hash",
      schemaGeneration: 1,
      status: "completed",
      targetId: TARGET_ID,
      version: 0,
    },
    itemType: "brain-query-attempt",
  }) as unknown as PlatformRecord;
}

function event(aggregateType: string) {
  return makeSemanticEventRecord({
    aggregateId: ATTEMPT_ID,
    aggregateType,
    aggregateVersion: 1,
    eventId: id("01ARZ3NDEKTSV4RRFFQ69G5FB3"),
    eventType: `${aggregateType}.created`,
    occurredAt: CREATED_AT,
    organizationId: ORGANIZATION_ID,
    payload: {},
  });
}

function stored(fake: FakeDynamoDocumentClient, record: PlatformRecord) {
  const table = record.itemType === "semantic-event" ? "events" : "execution";
  const item = fake.get(table, record);
  const locator = fake.get("control", governanceTenantDirectoryRecord(record)!) as
    | Extract<PlatformRecord, { readonly itemType: "governance-tenant-record" }>
    | undefined;
  return { locator: [locator?.ttl, locator?.data.recordTtl], ttl: item?.ttl };
}

describe("retention TTL", () => {
  test("stamps telemetry and its locator with the organization's runs period", async () => {
    const { database, fake } = seeded({ events: 10, runs: 30 });
    const attempt = queryAttempt();

    await database.transactWrite([{ kind: "put", record: attempt }]);

    const expected = Date.parse("2026-09-20T10:00:00.000Z") / 1_000 + 172_800;
    expect(stored(fake, attempt)).toEqual({ locator: [expected, expected], ttl: expected });
  });

  test("stamps a direct put with the default 365 days when the organization set no policy", async () => {
    const { database, fake } = seeded();
    const attempt = queryAttempt();

    await database.putRecord(attempt, "attribute_not_exists(pk) AND attribute_not_exists(sk)");

    const expected = Date.parse("2027-08-21T10:00:00.000Z") / 1_000 + 172_800;
    expect(stored(fake, attempt)).toEqual({ locator: [expected, expected], ttl: expected });
  });

  test("stamps semantic events with the events period but leaves thread events to retention", async () => {
    const { database, fake } = seeded({ events: 10, runs: 30 });
    const memoryEvent = event("memory");
    const threadEvent = event("thread");

    await database.transactWrite([{ kind: "put", record: memoryEvent }]);
    await database.transactWrite([{ kind: "put", record: threadEvent }]);

    const expected = Date.parse("2026-08-31T10:00:00.000Z") / 1_000 + 172_800;
    expect(stored(fake, memoryEvent)).toEqual({ locator: [expected, expected], ttl: expected });
    expect(stored(fake, threadEvent)).toEqual({
      locator: [undefined, undefined],
      ttl: undefined,
    });
  });

  test("restamps a rewrite from the policy in force when it is written", async () => {
    const { database, fake } = seeded({ events: 10, runs: 30 });
    const attempt = queryAttempt();
    await database.transactWrite([{ kind: "put", record: attempt }]);
    const written = fake.get("execution", attempt) as unknown as PlatformRecord;
    fake.put(
      "control",
      policyRecord({
        artifacts: 365,
        audit: 2_555,
        createdAt: CREATED_AT,
        events: 10,
        messages: 365,
        organizationId: ORGANIZATION_ID,
        runs: 7,
        threads: 365,
        updatedAt: CREATED_AT,
        updatedByPrincipalId: ORGANIZATION_ID,
        version: 2,
      }),
    );

    await database.transactWrite([
      {
        kind: "put",
        previousRecord: written,
        record: {
          ...written,
          data: { ...written.data, usefulness: "useful", version: 1 },
        } as PlatformRecord,
      },
    ]);

    const expected = Date.parse("2026-08-28T10:00:00.000Z") / 1_000 + 172_800;
    expect(stored(fake, attempt)).toEqual({ locator: [expected, expected], ttl: expected });
  });

  test("leaves telemetry of a run or thread and a running attempt to retention", async () => {
    const { database, fake } = seeded({ events: 10, runs: 30 });
    const base = queryAttempt();
    const variant = (id: string, fields: Readonly<Record<string, unknown>>) =>
      withCanonicalRecordKeys({
        ...base,
        data: { ...base.data, id, ...fields },
      }) as unknown as PlatformRecord;
    const runTelemetry = variant("01ARZ3NDEKTSV4RRFFQ69G5FB4", {
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
    });
    const threadTelemetry = variant("01ARZ3NDEKTSV4RRFFQ69G5FB6", {
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
    });
    const running = variant("01ARZ3NDEKTSV4RRFFQ69G5FB8", { status: "running" });

    for (const record of [runTelemetry, threadTelemetry, running]) {
      await database.transactWrite([{ kind: "put", record }]);
    }

    expect([runTelemetry, threadTelemetry, running].map((record) => stored(fake, record))).toEqual(
      Array.from({ length: 3 }, () => ({ locator: [undefined, undefined], ttl: undefined })),
    );
  });

  test("reads no policy for a transaction it rejects", async () => {
    const { fake } = seeded({ events: 10, runs: 30 });
    const reads: unknown[] = [];
    const client = {
      send: (command: GetCommand) => {
        if (command instanceof GetCommand) reads.push(command.input.Key);
        return fake.client.send(command);
      },
    } as unknown as DynamoDBDocumentClient;
    const database = makeDynamoDatabase(client, TABLE_NAMES);

    expect(
      database.transactWrite([{ kind: "put", record: { ...queryAttempt(), pk: " " } }]),
    ).rejects.toThrow();
    expect(reads).toEqual([]);
  });
});
