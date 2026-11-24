import { marshall } from "@aws-sdk/util-dynamodb";
import { ArtifactRecord, RunRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { fixtures } from "./agent-run.fixture.ts";
import {
  observabilityQuarantineFailure,
  observabilityQuarantinePayload,
  observabilityQuarantineKey,
  processObservabilityDynamoStream,
  type ObservabilityNormalizerRuntimeDependencies,
} from "./observability-normalizer-main.ts";

test("keeps quarantine keys stable across processing retries", () => {
  const record = {
    dynamodb: { SequenceNumber: "102" },
    eventID: "shard-event-102",
    eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
  };

  expect(observabilityQuarantineKey(record, "execution")).toBe(
    observabilityQuarantineKey({ ...record }, "execution"),
  );
  expect(observabilityQuarantineKey(record, "execution")).toMatch(
    /^unscoped\/execution\/[a-f0-9]{64}\.json$/u,
  );
  expect(
    observabilityQuarantineKey({ ...record, eventID: "other-shard-event-102" }, "execution"),
  ).not.toBe(observabilityQuarantineKey(record, "execution"));
  expect(
    observabilityQuarantineFailure(
      Object.assign(new Error("patient data"), { code: "invalid_record" }),
    ),
  ).toMatchObject({ code: "invalid_record", name: "Error" });
  expect(
    JSON.stringify(
      observabilityQuarantineFailure(
        Object.assign(new Error("patient data"), { code: "invalid_record" }),
      ),
    ),
  ).not.toContain("patient data");
});

test("quarantines only tenant-neutral failure metadata", () => {
  const payload = observabilityQuarantinePayload(
    {
      dynamodb: {
        NewImage: {
          body: { S: "patient diagnosis" },
          organizationId: { S: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        },
        SequenceNumber: "102",
      },
      eventID: "customer-event-102",
      eventName: "MODIFY",
      eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/tenant-source",
    },
    "execution",
    Object.assign(new Error("patient diagnosis"), { code: "invalid_record" }),
  );

  expect(payload).toMatchObject({
    failure: { code: "invalid_record", name: "Error" },
    source: { eventName: "MODIFY", table: "execution" },
  });
  expect(payload.source.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(payload)).not.toContain("patient diagnosis");
  expect(JSON.stringify(payload)).not.toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(JSON.stringify(payload)).not.toContain("customer-event-102");
  expect(payload).not.toHaveProperty("record");
});

test("keeps tenant-scoped quarantine records replayable and erasure-addressable", () => {
  const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const record = {
    dynamodb: {
      NewImage: {
        data: {
          M: {
            body: { S: "replayable patient diagnosis" },
            organizationId: { S: organizationId },
          },
        },
        itemType: { S: "message" },
      },
      SequenceNumber: "103",
    },
    eventID: "customer-event-103",
    eventName: "MODIFY",
    eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/tenant-source",
  };
  const payload = observabilityQuarantinePayload(record, "execution", new Error("invalid"));

  expect(observabilityQuarantineKey(record, "execution")).toMatch(
    new RegExp(`^organizations/${organizationId}/execution/[a-f0-9]{64}\\.json$`, "u"),
  );
  expect(payload).toHaveProperty(
    "record.dynamodb.NewImage.data.M.body.S",
    "replayable patient diagnosis",
  );
});

test("writes normalized DynamoDB facts with partial batch identity", async () => {
  const fixture = fixtures();
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...fixture.run,
      data: {
        ...fixture.run.data,
        completedAt: "2026-07-28T12:00:01.000Z",
        startedAt: "2026-07-28T12:00:00.000Z",
        status: "completed" as const,
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
      },
    }),
  );
  const writes: string[] = [];
  const dependencies: ObservabilityNormalizerRuntimeDependencies = {
    now: () => new Date("2026-07-28T12:00:02.000Z"),
    organizationExists: async () => true,
    quarantine: async () => "retry",
    writeFacts: async (facts) => {
      writes.push(...facts.map((fact) => Buffer.from(fact.data).toString("utf8")));
      return [];
    },
  };

  const result = await processObservabilityDynamoStream(
    {
      Records: [
        {
          dynamodb: {
            NewImage: marshall(run, { removeUndefinedValues: true }),
            SequenceNumber: "101",
          },
          eventID: "event-101",
          eventName: "MODIFY",
          eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
        },
      ],
    },
    "execution",
    dependencies,
  );

  expect(result.batchItemFailures).toEqual([]);
  expect(JSON.parse(writes[0] ?? "{}")).toMatchObject({
    factType: "span.finalized",
    source: { streamSequenceNumber: "101" },
  });
});

test("discards facts for erased organizations while emitting live-organization facts", async () => {
  const fixture = fixtures();
  const completedRun = (organizationId: string) =>
    Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...fixture.run,
        data: {
          ...fixture.run.data,
          completedAt: "2026-07-28T12:00:01.000Z",
          organizationId,
          startedAt: "2026-07-28T12:00:00.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-28T12:00:01.000Z",
          version: 1,
        },
      }),
    );
  const liveOrganizationId = fixture.run.data.organizationId;
  const erasedOrganizationId = "01J0000000000000000000ERAS";
  const lookups: string[] = [];
  const quarantined: string[] = [];
  const written: { organizationId: string; sequence: string }[] = [];

  const result = await processObservabilityDynamoStream(
    {
      Records: (
        [
          [erasedOrganizationId, "201"],
          [liveOrganizationId, "202"],
          [erasedOrganizationId, "203"],
          [liveOrganizationId, "204"],
        ] as const
      ).map(([organizationId, sequence]) => ({
        dynamodb: {
          NewImage: marshall(completedRun(organizationId), { removeUndefinedValues: true }),
          SequenceNumber: sequence,
        },
        eventID: `event-${sequence}`,
        eventName: "MODIFY",
        eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
      })),
    },
    "execution",
    {
      now: () => new Date("2026-07-28T12:00:02.000Z"),
      organizationExists: async (organizationId) => {
        lookups.push(organizationId);
        return organizationId === liveOrganizationId;
      },
      quarantine: async (record) => {
        quarantined.push(record.eventID ?? "");
        return "retry";
      },
      writeFacts: async (facts) => {
        written.push(
          ...facts.map(({ fact, sourceIdentifier }) => ({
            organizationId: fact.scope.organizationId,
            sequence: sourceIdentifier,
          })),
        );
        return [];
      },
    },
  );

  expect(result).toEqual({
    batchItemFailures: [],
    erasedOrganizationFactCount: 2,
    normalizationFailures: [],
  });
  expect(quarantined).toEqual([]);
  expect(written).toEqual([
    { organizationId: liveOrganizationId, sequence: "202" },
    { organizationId: liveOrganizationId, sequence: "204" },
  ]);
  expect(lookups).toEqual([erasedOrganizationId, liveOrganizationId]);
});

test("retries source records whose organization lookup fails", async () => {
  const fixture = fixtures();
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...fixture.run,
      data: {
        ...fixture.run.data,
        completedAt: "2026-07-28T12:00:01.000Z",
        startedAt: "2026-07-28T12:00:00.000Z",
        status: "completed" as const,
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
      },
    }),
  );
  const quarantined: string[] = [];
  let writes = 0;

  const result = await processObservabilityDynamoStream(
    {
      Records: [
        {
          dynamodb: {
            NewImage: marshall(run, { removeUndefinedValues: true }),
            SequenceNumber: "301",
          },
          eventID: "event-301",
          eventName: "MODIFY",
          eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
        },
      ],
    },
    "execution",
    {
      now: () => new Date("2026-07-28T12:00:02.000Z"),
      organizationExists: async () => {
        throw new Error("control table unavailable");
      },
      quarantine: async (record) => {
        quarantined.push(record.eventID ?? "");
        return "discard";
      },
      writeFacts: async (facts) => {
        writes += facts.length;
        return [];
      },
    },
  );

  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: "301" }],
    erasedOrganizationFactCount: 0,
    normalizationFailures: [],
  });
  expect(quarantined).toEqual([]);
  expect(writes).toBe(0);
});

test("quarantines malformed unscoped source images without sending raw data to the DLQ", async () => {
  const quarantined: string[] = [];

  const result = await processObservabilityDynamoStream(
    {
      Records: [
        {
          dynamodb: {
            NewImage: { itemType: { S: "run" } },
            SequenceNumber: "102",
          },
          eventID: "event-102",
          eventName: "MODIFY",
          eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
        },
      ],
    },
    "execution",
    {
      organizationExists: async () => true,
      quarantine: async (record) => {
        quarantined.push(record.eventID ?? "");
        return "discard";
      },
      writeFacts: async () => [],
    },
  );

  expect(quarantined).toEqual(["event-102"]);
  expect(result.batchItemFailures).toEqual([]);
});

test("quarantines run-owned records missing immutable trace context", async () => {
  const fixture = fixtures();
  const artifact = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-28T12:00:01.000Z",
        environmentId: fixture.run.data.environmentId,
        id: fixture.run.data.id,
        name: "screenshot.png",
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        runId: fixture.run.data.id,
        status: "available" as const,
        storage: {
          bucket: "artifact-bucket",
          byteSize: 1,
          contentType: "image/png",
          key: "artifacts/screenshot.png",
          sha256: "a".repeat(64),
        },
        type: "screenshot",
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
        visibility: "organization" as const,
      },
      itemType: "artifact" as const,
    }),
  );
  const quarantined: string[] = [];

  const result = await processObservabilityDynamoStream(
    {
      Records: [
        {
          dynamodb: {
            NewImage: marshall(artifact, { removeUndefinedValues: true }),
            SequenceNumber: "103",
          },
          eventID: "event-103",
          eventName: "INSERT",
          eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
        },
      ],
    },
    "execution",
    {
      organizationExists: async () => true,
      quarantine: async (record) => {
        quarantined.push(record.eventID ?? "");
        return "retry";
      },
      writeFacts: async () => [],
    },
  );

  expect(quarantined).toEqual(["event-103"]);
  expect(result.batchItemFailures).toEqual([{ itemIdentifier: "103" }]);
});

test("acknowledges a repair of a record whose old image no longer decodes", async () => {
  const fixture = fixtures();
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...fixture.run,
      data: {
        ...fixture.run.data,
        completedAt: "2026-07-28T12:00:01.000Z",
        startedAt: "2026-07-28T12:00:00.000Z",
        status: "completed" as const,
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
      },
    }),
  );
  const { threadId: _threadId, ...legacyData } = run.data;
  const legacy = marshall({ ...run, data: legacyData }, { removeUndefinedValues: true });
  const current = marshall(run, { removeUndefinedValues: true });
  const legacyRunning = marshall(
    { ...run, data: { ...legacyData, status: "running" } },
    { removeUndefinedValues: true },
  );
  const legacyRetyped = marshall(
    { ...run, data: legacyData, itemType: "trace" },
    { removeUndefinedValues: true },
  );
  const quarantined: string[] = [];
  let writes = 0;

  const result = await processObservabilityDynamoStream(
    {
      Records: [
        { NewImage: current, OldImage: legacy, SequenceNumber: "301" },
        { NewImage: legacy, OldImage: current, SequenceNumber: "302" },
        { NewImage: current, OldImage: legacyRunning, SequenceNumber: "303" },
        { NewImage: current, OldImage: legacyRetyped, SequenceNumber: "304" },
      ].map((dynamodb) => ({
        dynamodb,
        eventID: `event-${dynamodb.SequenceNumber}`,
        eventName: "MODIFY",
        eventSourceARN: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
      })),
    },
    "execution",
    {
      organizationExists: async () => true,
      quarantine: async (record) => {
        quarantined.push(record.eventID ?? "");
        return "retry";
      },
      writeFacts: async (facts) => {
        writes += facts.length;
        return [];
      },
    },
  );

  expect(quarantined).toEqual(["event-302", "event-303", "event-304"]);
  expect(result.batchItemFailures).toEqual([
    { itemIdentifier: "302" },
    { itemIdentifier: "303" },
    { itemIdentifier: "304" },
  ]);
  expect(writes).toBe(0);
});

test("reports each failed record by key, item type, and tenant-neutral cause", async () => {
  const fixture = fixtures();
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...fixture.run,
      data: {
        ...fixture.run.data,
        completedAt: "2026-07-28T12:00:01.000Z",
        startedAt: "2026-07-28T12:00:00.000Z",
        status: "completed" as const,
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
      },
    }),
  );
  const { threadId: _threadId, ...legacyData } = run.data;
  const artifact = Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-28T12:00:01.000Z",
        environmentId: run.data.environmentId,
        id: run.data.id,
        name: "screenshot.png",
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        runId: run.data.id,
        status: "available" as const,
        storage: {
          bucket: "artifact-bucket",
          byteSize: 1,
          contentType: "image/png",
          key: "artifacts/screenshot.png",
          sha256: "a".repeat(64),
        },
        type: "screenshot",
        updatedAt: "2026-07-28T12:00:01.000Z",
        version: 1,
        visibility: "organization" as const,
      },
      itemType: "artifact" as const,
    }),
  );
  const streamArn = "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1";

  const result = await processObservabilityDynamoStream(
    {
      Records: [
        {
          dynamodb: {
            NewImage: marshall(run, { removeUndefinedValues: true }),
            OldImage: marshall(
              { ...run, data: { ...legacyData, status: "running" } },
              { removeUndefinedValues: true },
            ),
            SequenceNumber: "501",
          },
          eventID: "event-501",
          eventName: "MODIFY",
          eventSourceARN: streamArn,
        },
        {
          dynamodb: {
            NewImage: marshall(artifact, { removeUndefinedValues: true }),
            SequenceNumber: "502",
          },
          eventID: "event-502",
          eventName: "INSERT",
          eventSourceARN: streamArn,
        },
      ],
    },
    "execution",
    {
      organizationExists: async () => true,
      quarantine: async () => "retry",
      writeFacts: async () => [],
    },
  );

  const quarantineKey = expect.stringMatching(
    new RegExp(`^organizations/${run.data.organizationId}/execution/[a-f0-9]{64}\\.json$`, "u"),
  );
  expect(result.normalizationFailures).toEqual([
    {
      decodeIssues: ["OldImage data.threadId: MissingKey"],
      eventName: "MODIFY",
      failure: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), name: "RecordDecodeError" },
      itemType: "run",
      quarantineKey,
      sequenceNumber: "501",
    },
    {
      decodeIssues: [],
      eventName: "INSERT",
      failure: {
        code: "missing-trace-context",
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        name: "ObservabilitySourceError",
      },
      itemType: "artifact",
      quarantineKey,
      sequenceNumber: "502",
    },
  ]);
});
