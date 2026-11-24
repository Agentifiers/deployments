import { S3Client } from "@aws-sdk/client-s3";
import {
  ArtifactRecord,
  Ulid,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  artifactRetentionExpired,
  completeArtifactUpload,
  createArtifactAccessUrl,
  updateArtifactRetention,
} from "./artifact-operations.ts";
import type { RuntimeApiCredentialPrincipal, RuntimeApiDependencies } from "./runtime-support.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ARTIFACT_ONE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const ARTIFACT_PENDING_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
const NOW = "2026-07-25T12:00:00.000Z";

const scope = {
  environmentId: Schema.decodeUnknownSync(Ulid)(ENVIRONMENT_ID),
  organizationId: Schema.decodeUnknownSync(Ulid)(ORGANIZATION_ID),
  projectId: Schema.decodeUnknownSync(Ulid)(PROJECT_ID),
};
const principal = {
  credential: { data: { id: Schema.decodeUnknownSync(Ulid)(ARTIFACT_PENDING_ID) } },
  scope,
  serviceAccount: { data: { id: Schema.decodeUnknownSync(Ulid)(ORGANIZATION_ID) } },
} as RuntimeApiCredentialPrincipal;

function storageKey(table: string, value: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${value.pk}\u0000${value.sk}`;
}

function makeDatabase() {
  const records = new Map<string, PlatformRecord>();
  const transactionBatches: PlatformRecord[][] = [];
  const put = (table: string, record: PlatformRecord) =>
    records.set(storageKey(table, record), structuredClone(record));
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey("execution", record));
    },
    getRecord: async (table, recordKey) => {
      const record = records.get(storageKey(table, recordKey));
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put("execution", record);
    },
    queryRecords: async (_table, input) => {
      const names = input.ExpressionAttributeNames as Record<string, string>;
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const partitionName = names["#pk"]!;
      const sortName = names["#sk"]!;
      const matching = [...records.values()]
        .filter((record) => {
          const indexed = record as unknown as Record<string, unknown>;
          return (
            indexed[partitionName] === values[":pk"] &&
            String(indexed[sortName]).startsWith(String(values[":prefix"]))
          );
        })
        .toSorted((left, right) => {
          const leftValue = String((left as unknown as Record<string, unknown>)[sortName]);
          const rightValue = String((right as unknown as Record<string, unknown>)[sortName]);
          return leftValue.localeCompare(rightValue);
        });
      if (input.ScanIndexForward === false) matching.reverse();
      const exclusiveStartKey = input.ExclusiveStartKey as
        | { readonly pk: string; readonly sk: string }
        | undefined;
      const start = exclusiveStartKey
        ? matching.findIndex(
            (record) => record.pk === exclusiveStartKey.pk && record.sk === exclusiveStartKey.sk,
          ) + 1
        : 0;
      const limit = input.Limit ?? 100;
      const items = matching.slice(start, start + limit).map((record) => structuredClone(record));
      const last = items.at(-1);
      return {
        items,
        ...(last && start + items.length < matching.length
          ? {
              lastEvaluatedKey: {
                gsi2pk: last.gsi2pk,
                gsi2sk: last.gsi2sk,
                pk: last.pk,
                sk: last.sk,
              },
            }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      transactionBatches.push(
        operations.flatMap((operation) =>
          operation.kind === "condition-check" ? [] : [structuredClone(operation.record)],
        ),
      );
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          records.delete(storageKey("execution", operation.record));
        } else {
          put("execution", operation.record);
        }
      }
    },
  };
  return { database, put, transactionBatches };
}

function artifact(
  artifactId: string,
  options: {
    readonly accessUrlExpiresAt?: string;
    readonly agentDeploymentId?: string;
    readonly ownerServiceAccountId?: string | null;
    readonly retentionExpiresAt?: string;
    readonly runId?: string;
    readonly status?: "available" | "pending";
    readonly threadId?: string;
    readonly uploadExpiresAt?: string;
    readonly uploadUrlExpiresAt?: string;
    readonly version?: number;
    readonly visibility?: "organization" | "private";
  } = {},
) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(options.accessUrlExpiresAt ? { accessUrlExpiresAt: options.accessUrlExpiresAt } : {}),
        ...(options.agentDeploymentId
          ? { agentDeploymentId: Schema.decodeUnknownSync(Ulid)(options.agentDeploymentId) }
          : {}),
        createdAt: NOW,
        ...scope,
        id: Schema.decodeUnknownSync(Ulid)(artifactId),
        name: `Artifact ${artifactId.at(-1)}`,
        ...(options.ownerServiceAccountId === null
          ? {}
          : {
              owner: {
                serviceAccountId: Schema.decodeUnknownSync(Ulid)(
                  options.ownerServiceAccountId ?? principal.serviceAccount.data.id,
                ),
                type: "service-account",
              },
            }),
        ...(options.retentionExpiresAt ? { retentionExpiresAt: options.retentionExpiresAt } : {}),
        ...(options.runId ? { runId: Schema.decodeUnknownSync(Ulid)(options.runId) } : {}),
        status: options.status ?? "available",
        storage: {
          bucket: "artifact-bucket",
          byteSize: 12,
          contentType: "text/plain",
          fileName: "report.txt",
          key: `artifacts/${artifactId}`,
          sha256: "a".repeat(64),
        },
        ...(options.threadId ? { threadId: Schema.decodeUnknownSync(Ulid)(options.threadId) } : {}),
        type: "report",
        updatedAt: NOW,
        ...(options.uploadExpiresAt ? { uploadExpiresAt: options.uploadExpiresAt } : {}),
        ...(options.uploadUrlExpiresAt ? { uploadUrlExpiresAt: options.uploadUrlExpiresAt } : {}),
        version: options.version ?? 0,
        visibility: options.visibility ?? "private",
      },
      itemType: "artifact",
      ...(options.retentionExpiresAt || options.uploadExpiresAt
        ? {
            ttl: Math.floor(
              Math.max(
                ...[options.retentionExpiresAt, options.uploadExpiresAt]
                  .filter((value): value is string => value !== undefined)
                  .map((value) => Date.parse(value)),
              ) / 1_000,
            ),
          }
        : {}),
    }),
  );
}

function dependencies(
  database: DynamoDatabaseService,
  send: (command: unknown) => Promise<unknown> = async () => ({}),
) {
  return {
    artifactBucket: "artifact-bucket",
    artifactKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
    artifactS3: { send },
    database,
    generateId: async () => Schema.decodeUnknownSync(Ulid)(ARTIFACT_PENDING_ID),
    now: () => new Date(NOW),
  } as unknown as RuntimeApiDependencies;
}

describe("artifact operations", () => {
  test("serializes access grants with retention changes", async () => {
    const store = makeDatabase();
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, {
        retentionExpiresAt: "2026-07-25T13:00:00.000Z",
      }),
    );
    const api = {
      ...dependencies(store.database),
      artifactS3: new S3Client({
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
        region: "us-east-1",
      }),
    } as RuntimeApiDependencies;
    const artifactId = Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID);

    const access = await createArtifactAccessUrl(api, principal, artifactId, {
      expiresInSeconds: 1_800,
    });

    expect(access.expiresAt).toBe("2026-07-25T12:30:00.000Z");
    expect(new URL(access.url).searchParams.get("X-Amz-Date")).toBe("20260725T120000Z");
    expect(
      store.transactionBatches.at(-1)?.find((record) => record.itemType === "artifact"),
    ).toMatchObject({
      data: {
        accessUrlExpiresAt: "2026-07-25T12:30:00.000Z",
        version: 1,
      },
    });
    expect(
      updateArtifactRetention(api, principal, artifactId, {
        expectedVersion: 0,
        retentionExpiresAt: "2026-07-25T12:45:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "artifact_version_conflict", status: 409 });
    expect(
      updateArtifactRetention(api, principal, artifactId, {
        expectedVersion: 1,
        retentionExpiresAt: "2026-07-25T12:20:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "artifact_retention_too_soon", status: 409 });
    expect(
      updateArtifactRetention(api, principal, artifactId, {
        expectedVersion: 1,
        retentionExpiresAt: "2026-07-25T12:45:00.000Z",
      }),
    ).resolves.toMatchObject({ version: 2 });
  });

  test("keeps a conservative access reservation when URL signing fails", async () => {
    const store = makeDatabase();
    store.put("execution", artifact(ARTIFACT_ONE_ID));
    const api = {
      ...dependencies(store.database),
      artifactS3: new S3Client({
        credentials: async () => {
          throw new Error("simulated credential failure");
        },
        region: "us-east-1",
      }),
    } as RuntimeApiDependencies;
    const artifactId = Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID);

    expect(createArtifactAccessUrl(api, principal, artifactId, {})).rejects.toThrow(
      "simulated credential failure",
    );
    expect(
      store.transactionBatches.at(-1)?.find((record) => record.itemType === "artifact"),
    ).toMatchObject({
      data: {
        accessUrlExpiresAt: "2026-07-25T12:15:00.000Z",
        version: 1,
      },
    });
    expect(
      updateArtifactRetention(api, principal, artifactId, {
        expectedVersion: 0,
        retentionExpiresAt: "2026-08-25T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "artifact_version_conflict", status: 409 });
  });

  test("does not revive a logically expired artifact during TTL deletion lag", async () => {
    const store = makeDatabase();
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, {
        retentionExpiresAt: "2026-07-25T11:59:59.000Z",
      }),
    );
    const artifactId = Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID);
    expect(
      artifactRetentionExpired(
        artifact(ARTIFACT_ONE_ID, {
          retentionExpiresAt: "2026-07-25T11:59:59.000Z",
        }),
        new Date(NOW),
      ),
    ).toBe(true);

    for (const retentionExpiresAt of ["2026-08-25T12:00:00.000Z", null]) {
      expect(
        updateArtifactRetention(dependencies(store.database), principal, artifactId, {
          expectedVersion: 0,
          retentionExpiresAt,
        }),
      ).rejects.toMatchObject({
        code: "artifact_retention_expired",
        status: 409,
      });
    }
  });

  test("does not fan out private artifact metadata through semantic events", async () => {
    const store = makeDatabase();
    store.put(
      "execution",
      artifact(ARTIFACT_PENDING_ID, {
        accessUrlExpiresAt: "2026-07-25T12:15:00.000Z",
        status: "pending",
        uploadExpiresAt: "2026-07-26T12:00:00.000Z",
      }),
    );
    const head = {
      ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
      ContentLength: 12,
      ContentType: "text/plain",
      SSEKMSKeyId: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
      ServerSideEncryption: "aws:kms",
      VersionId: "version-1",
    };

    await completeArtifactUpload(
      dependencies(store.database, async () => head),
      principal,
      Schema.decodeUnknownSync(Ulid)(ARTIFACT_PENDING_ID),
    );

    expect(
      store.transactionBatches
        .flat()
        .some(
          (record) =>
            record.itemType === "semantic-event" && record.data.eventType === "artifact.available",
        ),
    ).toBe(false);
  });

  test("verifies upload bytes, checksum, media type, encryption, and object version", async () => {
    const store = makeDatabase();
    store.put(
      "execution",
      artifact(ARTIFACT_PENDING_ID, {
        accessUrlExpiresAt: "2026-07-25T12:15:00.000Z",
        status: "pending",
        uploadExpiresAt: "2026-07-26T12:00:00.000Z",
        version: 2,
        visibility: "organization",
      }),
    );
    let head = {
      ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
      ContentLength: 11,
      ContentType: "text/plain",
      SSEKMSKeyId: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
      ServerSideEncryption: "aws:kms",
      VersionId: "version-1",
    };
    let sends = 0;
    const api = dependencies(store.database, async () => {
      sends += 1;
      return head;
    });
    const artifactId = Schema.decodeUnknownSync(Ulid)(ARTIFACT_PENDING_ID);

    expect(
      completeArtifactUpload(
        dependencies(store.database, async () => {
          throw { $metadata: { httpStatusCode: 404 }, name: "NotFound" };
        }),
        principal,
        artifactId,
      ),
    ).rejects.toMatchObject({
      code: "artifact_upload_incomplete",
      status: 409,
    });
    expect(completeArtifactUpload(api, principal, artifactId)).rejects.toMatchObject({
      code: "artifact_upload_mismatch",
      status: 409,
    });
    head = { ...head, ContentLength: 12 };
    const completed = await completeArtifactUpload(api, principal, artifactId);
    const replayed = await completeArtifactUpload(api, principal, artifactId);

    expect(completed).toMatchObject({ status: "available", version: 3 });
    expect(replayed).toEqual(completed);
    expect(sends).toBe(2);
    expect(
      store.transactionBatches.some(
        (batch) =>
          batch.some((record) => record.itemType === "artifact") &&
          batch.some(
            (record) =>
              record.itemType === "semantic-event" &&
              record.data.eventType === "artifact.available",
          ),
      ),
    ).toBe(true);
    const availabilityEvent = store.transactionBatches
      .flat()
      .find(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "artifact.available",
      );
    expect(availabilityEvent).toMatchObject({
      data: {
        aggregateId: ARTIFACT_PENDING_ID,
        aggregateType: "artifact",
        aggregateVersion: 1,
      },
    });
    const persisted = await store.database.getRecord("execution", {
      pk: key("ORG", ORGANIZATION_ID, "ENV", ENVIRONMENT_ID),
      sk: key("ARTIFACT", ARTIFACT_PENDING_ID),
    });
    expect(persisted?.ttl).toBeUndefined();
    expect(
      (persisted?.data as Readonly<{ readonly uploadExpiresAt?: string }> | undefined)
        ?.uploadExpiresAt,
    ).toBeUndefined();
    expect(
      (persisted?.data as Readonly<{ readonly accessUrlExpiresAt?: string }> | undefined)
        ?.accessUrlExpiresAt,
    ).toBe("2026-07-25T12:15:00.000Z");
  });
});
