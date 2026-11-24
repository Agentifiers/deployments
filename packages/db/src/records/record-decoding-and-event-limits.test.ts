import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { Ulid } from "../ids.ts";
import { hasSameImmutableIdentity } from "../transaction-conditions.ts";
import { ArtifactRecord } from "./execution.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./index.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const RUN_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB0");

describe("record routing and claims", () => {
  test("indexes artifacts by their exact organization run", () => {
    const artifact = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: MESSAGE_1_ID,
        id: MESSAGE_2_ID,
        name: "Run report",
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        runId: RUN_ID,
        status: "available" as const,
        storage: {
          bucket: "artifact-bucket",
          byteSize: 1,
          contentType: "application/octet-stream",
          key: "artifacts/run-report",
          sha256: "a".repeat(64),
        },
        type: "report",
        updatedAt: "2026-07-20T01:00:00.000Z",
        version: 0,
        visibility: "private" as const,
      },
      itemType: "artifact" as const,
    });

    expect(artifact).toMatchObject({
      gsi1pk: `ORG#${ORG_ID}#RUN#${RUN_ID}#ARTIFACTS`,
      gsi1sk: `ARTIFACT#available#2026-07-20T01%3A00%3A00.000Z#${MESSAGE_2_ID}`,
    });
  });

  test("rejects retained artifacts that omit their DynamoDB TTL", () => {
    expect(() =>
      Schema.decodeUnknownSync(ArtifactRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            environmentId: MESSAGE_1_ID,
            id: MESSAGE_2_ID,
            name: "Retained artifact",
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            retentionExpiresAt: "2026-07-21T00:00:00.000Z",
            status: "available",
            storage: {
              bucket: "artifact-bucket",
              byteSize: 1,
              contentType: "application/octet-stream",
              key: "artifacts/retained",
              sha256: "a".repeat(64),
            },
            type: "report",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 0,
            visibility: "private",
          },
          itemType: "artifact",
        }),
      ),
    ).toThrow();
  });

  test("requires an artifact TTL to match its latest physical expiration", async () => {
    const retentionExpiresAt = "2026-07-21T00:00:00.000Z";
    const uploadExpiresAt = "2026-07-22T00:00:00.000Z";
    const input = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        environmentId: MESSAGE_1_ID,
        id: MESSAGE_2_ID,
        name: "Pending retained artifact",
        organizationId: ORG_ID,
        projectId: BILLING_ID,
        retentionExpiresAt,
        status: "pending" as const,
        storage: {
          bucket: "artifact-bucket",
          byteSize: 1,
          contentType: "application/octet-stream",
          key: "artifacts/pending",
          sha256: "a".repeat(64),
        },
        type: "report",
        updatedAt: "2026-07-20T00:00:00.000Z",
        uploadExpiresAt,
        version: 0,
        visibility: "private" as const,
      },
      itemType: "artifact" as const,
    });

    const valid = await Effect.runPromiseExit(
      decodePlatformRecord({
        ...input,
        ttl: Math.floor(Date.parse(uploadExpiresAt) / 1_000),
      }),
    );
    const earlierTtl = await Effect.runPromiseExit(
      decodePlatformRecord({
        ...input,
        ttl: Math.floor(Date.parse(retentionExpiresAt) / 1_000),
      }),
    );
    const invalidExpiration = await Effect.runPromiseExit(
      decodePlatformRecord({
        ...input,
        data: { ...input.data, uploadExpiresAt: "2026-07-22T00:00:00" },
        ttl: Math.floor(Date.parse("2026-07-22T00:00:00") / 1_000),
      }),
    );

    expect(Exit.isSuccess(valid)).toBe(true);
    expect(Exit.isFailure(earlierTtl)).toBe(true);
    expect(Exit.isFailure(invalidExpiration)).toBe(true);
  });

  test("rejects artifact records above DynamoDB's item-size limit", () => {
    expect(() =>
      Schema.decodeUnknownSync(ArtifactRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            environmentId: MESSAGE_1_ID,
            id: MESSAGE_2_ID,
            metadata: { values: Array.from({ length: 140_000 }, () => 0) },
            name: "Oversized artifact",
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            status: "pending",
            storage: {
              bucket: "artifact-bucket",
              byteSize: 1,
              contentType: "application/octet-stream",
              key: "artifacts/oversized",
              sha256: "a".repeat(64),
            },
            type: "report",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 0,
            visibility: "private",
          },
          itemType: "artifact",
        }),
      ),
    ).toThrow();
  });

  test("owns a private artifact by exactly one principal, service account, or ingress source for life", () => {
    const owned = (owner: Readonly<Record<string, string>>) =>
      Schema.decodeUnknownSync(ArtifactRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            environmentId: MESSAGE_1_ID,
            id: MESSAGE_2_ID,
            name: "Uploaded artifact",
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            status: "available",
            storage: {
              bucket: "artifact-bucket",
              byteSize: 1,
              contentType: "application/octet-stream",
              key: "artifacts/uploaded",
              sha256: "a".repeat(64),
            },
            type: "report",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 0,
            visibility: "private",
            owner,
          },
          itemType: "artifact",
        }),
      );

    expect(owned({ principalId: RUN_ID, type: "principal" }).data.owner).toEqual({
      principalId: RUN_ID,
      type: "principal",
    });
    expect(owned({ serviceAccountId: RUN_ID, type: "service-account" }).data.owner).toEqual({
      serviceAccountId: RUN_ID,
      type: "service-account",
    });
    expect(
      owned({ sourceId: RUN_ID, sourceKind: "agent-email-binding", type: "ingress" }).data.owner,
    ).toEqual({ sourceId: RUN_ID, sourceKind: "agent-email-binding", type: "ingress" });
    expect(() => owned({ principalId: RUN_ID, type: "service-account" })).toThrow();
    expect(() => owned({ sourceId: RUN_ID, sourceKind: "inbox", type: "ingress" })).toThrow();
    const serviceAccount = { serviceAccountId: RUN_ID, type: "service-account" };
    expect(hasSameImmutableIdentity(owned(serviceAccount), owned(serviceAccount))).toBe(true);
    expect(
      hasSameImmutableIdentity(
        owned(serviceAccount),
        owned({ principalId: RUN_ID, type: "principal" }),
      ),
    ).toBe(false);
  });

  test("canonical decoding rejects unregistered top-level attributes", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          id: ORG_ID,
          name: "Deployments.ai",
          slug: "deployments-ai",
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version: 1,
        },
        itemType: "organization",
        gsi2pk: undefined,
        name: "must-not-be-top-level",
        pk: `ORG#${ORG_ID}`,
        sk: `ORG#${ORG_ID}`,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("does not materialize absent sparse index attributes", () => {
    const record = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        id: ORG_ID,
        kind: "human",
        status: "active",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 1,
      },
      gsi1pk: "stale",
      gsi1sk: "stale",
      gsi2pk: undefined,
      gsi2sk: undefined,
      itemType: "principal",
    } as const);

    expect("gsi1pk" in record).toBe(false);
    expect("gsi1sk" in record).toBe(false);
    expect("gsi2pk" in record).toBe(false);
    expect("gsi2sk" in record).toBe(false);
  });

  test("requires ttl to match logical expiration for disposable records", async () => {
    const expiresAt = "2026-07-21T00:00:00.000Z";
    const input = {
      data: {
        commandHash: "sha256:command",
        createdAt: "2026-07-20T00:00:00.000Z",
        expiresAt,
        idempotencyKey: "request-123",
        organizationId: ORG_ID,
        resourceIds: [],
        status: "in-progress",
        version: 1,
      },
      itemType: "idempotency",
    } as const;

    const missingTtl = await Effect.runPromiseExit(
      decodePlatformRecord(withCanonicalRecordKeys(input)),
    );
    const wrongTtl = await Effect.runPromiseExit(
      decodePlatformRecord(withCanonicalRecordKeys({ ...input, ttl: 1 })),
    );
    const validTtl = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          ...input,
          ttl: Math.floor(Date.parse(expiresAt) / 1_000),
        }),
      ),
    );
    const noncanonicalExpiration = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          ...input,
          data: { ...input.data, expiresAt: "2026-07-21T00:00:00" },
          ttl: Math.floor(Date.parse("2026-07-21T00:00:00") / 1_000),
        }),
      ),
    );

    expect(Exit.isFailure(missingTtl)).toBe(true);
    expect(Exit.isFailure(wrongTtl)).toBe(true);
    expect(Exit.isSuccess(validTtl)).toBe(true);
    expect(Exit.isFailure(noncanonicalExpiration)).toBe(true);
  });

  test("rejects keys that do not match the record payload", async () => {
    const canonical = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-20T00:00:00.000Z",
        id: ORG_ID,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: "2026-07-20T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    } as const);
    const error = await Effect.runPromise(
      Effect.flip(
        decodePlatformRecord({
          ...canonical,
          gsi1sk: "ORGANIZATION#stale",
          pk: `ORG#${BILLING_ID}`,
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "RecordDecodeError",
      message:
        "DynamoDB organization item keys do not match the registered record payload: pk, gsi1sk.",
    });
  });

  test("rejects non-integer resource versions", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-20T00:00:00.000Z",
            id: ORG_ID,
            name: "Deployments.ai",
            slug: "deployments-ai",
            status: "active",
            updatedAt: "2026-07-20T00:00:00.000Z",
            version: 1.5,
          },
          itemType: "organization",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects invalid semantic event aggregate versions", async () => {
    const semanticEvent = (aggregateVersion: number) =>
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion,
            environmentId: BILLING_ID,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: {},
            projectId: BILLING_ID,
          },
          itemType: "semantic-event",
        }),
      );

    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent(0)))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent(1.5)))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(semanticEvent(1)))).toBe(true);
  });

  test("rejects persisted semantic events beyond envelope string limits", async () => {
    const semanticEvent = (aggregateType: string, traceId: string) =>
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType,
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: {},
            traceId,
          },
          itemType: "semantic-event",
        }),
      );

    expect(
      Exit.isFailure(await Effect.runPromiseExit(semanticEvent("x".repeat(129), "trace"))),
    ).toBe(true);
    expect(
      Exit.isFailure(await Effect.runPromiseExit(semanticEvent("organization", "x".repeat(257)))),
    ).toBe(true);
  });

  test("rejects semantic event types that EventBridge cannot dispatch", async () => {
    const semanticEvent = (eventType: string) =>
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType,
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: {},
          },
          itemType: "semantic-event",
        }),
      );

    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent("   ")))).toBe(true);
    expect(
      Exit.isFailure(await Effect.runPromiseExit(semanticEvent(" organization.updated "))),
    ).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(semanticEvent("x".repeat(129))))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(semanticEvent("x".repeat(128))))).toBe(true);
  });

  test("rejects semantic events whose serialized EventBridge detail is too large", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: { body: "\0".repeat(180_000) },
          },
          itemType: "semantic-event",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects semantic event records above DynamoDB's item-size limit", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            aggregateId: ORG_ID,
            aggregateType: "organization",
            aggregateVersion: 1,
            eventId: MESSAGE_1_ID,
            eventType: "organization.updated",
            occurredAt: "2026-07-20T00:00:00.000Z",
            organizationId: ORG_ID,
            payload: { body: "x".repeat(410_000) },
          },
          itemType: "semantic-event",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("rejects invalid ordered message sequences", async () => {
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            contentHash: "sha256:message",
            createdAt: "2026-07-20T00:00:00.000Z",
            environmentId: BILLING_ID,
            id: MESSAGE_1_ID,
            organizationId: ORG_ID,
            projectId: BILLING_ID,
            role: "user",
            sequence: 1.5,
            threadId: MESSAGE_2_ID,
          },
          itemType: "message",
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
