import { S3Client } from "@aws-sdk/client-s3";
import { DatabaseError, Ulid, key, type DynamoDatabaseService } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  createArtifactUpload,
  listArtifacts,
  updateArtifactRetention,
} from "./artifact-operations.ts";
import type { RuntimeApiDependencies } from "./runtime-support.ts";
import {
  ORGANIZATION_ID,
  ENVIRONMENT_ID,
  THREAD_ONE_ID,
  THREAD_TWO_ID,
  RUN_ONE_ID,
  RUN_TWO_ID,
  ARTIFACT_ONE_ID,
  ARTIFACT_TWO_ID,
  ARTIFACT_THREE_ID,
  ARTIFACT_PENDING_ID,
  principal,
  generatedUlid,
  makeDatabase,
  artifact,
  seedThread,
  seedRun,
  dependencies,
} from "./artifact-operations.fixture.ts";

describe("artifact operations", () => {
  test("enforces published artifact name and type text constraints", async () => {
    const store = makeDatabase();
    const request = {
      byteSize: 12,
      contentType: "text/plain",
      fileName: "report.txt",
      name: "Release report",
      sha256: "a".repeat(64),
      type: "report",
    };
    expect(
      createArtifactUpload(dependencies(store.database), principal, {
        ...request,
        name: "x".repeat(256),
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      createArtifactUpload(dependencies(store.database), principal, {
        ...request,
        type: " report",
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      createArtifactUpload(dependencies(store.database), principal, {
        ...request,
        metadata: { payload: "x".repeat(321 * 1024) },
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      createArtifactUpload(dependencies(store.database), principal, {
        ...request,
        metadata: { count: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      createArtifactUpload(dependencies(store.database), principal, {
        ...request,
        retentionExpiresAt: "2026-07-25T12:05:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_retention", status: 400 });
  });

  test("issues a one-shot upload grant that cannot outlive retention", async () => {
    const store = makeDatabase();
    seedThread(store.put, THREAD_ONE_ID);
    seedRun(store.put, RUN_ONE_ID, THREAD_ONE_ID);
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
    const result = await createArtifactUpload(api, principal, {
      byteSize: 12,
      contentType: "text/plain",
      fileName: "report.txt",
      name: "Release report",
      retentionExpiresAt: "2026-07-25T12:15:00.000Z",
      runId: RUN_ONE_ID,
      sha256: "a".repeat(64),
      type: "report",
    });
    const signedUrl = new URL(result.upload.url);

    expect(result.upload.expiresAt).toBe("2026-07-25T12:15:00.000Z");
    expect(result.artifact.version).toBe(0);
    expect(result.upload.headers["if-none-match"]).toBe("*");
    expect(signedUrl.searchParams.get("X-Amz-Date")).toBe("20260725T120000Z");
    expect(signedUrl.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(signedUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain("content-type");
    expect(signedUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain(
      "if-none-match",
    );
    expect(signedUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain(
      "x-amz-checksum-sha256",
    );
    expect(signedUrl.searchParams.has("x-amz-checksum-sha256")).toBe(false);
    const pending = await store.database.getRecord("execution", {
      pk: key("ORG", ORGANIZATION_ID, "ENV", ENVIRONMENT_ID),
      sk: key("ARTIFACT", ARTIFACT_PENDING_ID),
    });
    expect(pending).toMatchObject({
      data: {
        observability: {
          captureMode: "metadata-only",
          runSpanId: "0123456789abcdef",
          sessionId: THREAD_ONE_ID,
          traceId: "0123456789abcdef0123456789abcdef",
        },
        owner: { serviceAccountId: principal.serviceAccount.data.id, type: "service-account" },
        retentionExpiresAt: "2026-07-25T12:15:00.000Z",
        uploadExpiresAt: "2026-07-26T12:00:00.000Z",
        uploadUrlExpiresAt: "2026-07-25T12:15:00.000Z",
      },
      ttl: Math.floor(Date.parse("2026-07-26T12:00:00.000Z") / 1_000),
    });
    expect(
      updateArtifactRetention(
        api,
        principal,
        Schema.decodeUnknownSync(Ulid)(String(result.artifact.artifactId)),
        {
          expectedVersion: 0,
          retentionExpiresAt: "2026-07-25T12:10:00.000Z",
        },
      ),
    ).rejects.toMatchObject({ code: "artifact_retention_too_soon", status: 409 });
  });

  test("gives abandoned pending uploads a bounded cleanup TTL", async () => {
    const store = makeDatabase();
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
    await createArtifactUpload(api, principal, {
      byteSize: 12,
      contentType: "text/plain",
      fileName: "report.txt",
      name: "Release report",
      sha256: "a".repeat(64),
      type: "report",
    });
    const pending = await store.database.getRecord("execution", {
      pk: key("ORG", ORGANIZATION_ID, "ENV", ENVIRONMENT_ID),
      sk: key("ARTIFACT", ARTIFACT_PENDING_ID),
    });
    const uploadExpiresAt = (
      pending?.data as Readonly<{ readonly uploadExpiresAt?: string }> | undefined
    )?.uploadExpiresAt;

    expect(uploadExpiresAt).toBe("2026-07-26T12:00:00.000Z");
    expect(pending?.ttl).toBe(Math.floor(Date.parse(uploadExpiresAt!) / 1_000));
  });

  test("filters artifacts by run and thread, including legacy artifacts without threadId", async () => {
    const store = makeDatabase();
    seedThread(store.put, THREAD_ONE_ID);
    seedThread(store.put, THREAD_TWO_ID);
    seedRun(store.put, RUN_ONE_ID, THREAD_ONE_ID);
    seedRun(store.put, RUN_TWO_ID, THREAD_TWO_ID);
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, { runId: RUN_ONE_ID, threadId: THREAD_ONE_ID }),
    );
    store.put("execution", artifact(ARTIFACT_TWO_ID, { runId: RUN_ONE_ID }));
    store.put(
      "execution",
      artifact(ARTIFACT_THREE_ID, { runId: RUN_TWO_ID, threadId: THREAD_TWO_ID }),
    );
    for (let index = 400; index < 501; index++) {
      store.put(
        "execution",
        artifact(generatedUlid(index), { runId: RUN_TWO_ID, threadId: THREAD_TWO_ID }),
      );
    }

    const byRun = await listArtifacts(dependencies(store.database), principal, {
      runId: RUN_ONE_ID,
    });
    const byThread = await listArtifacts(dependencies(store.database), principal, {
      threadId: THREAD_ONE_ID,
    });

    expect(byRun.artifacts.map((value) => String(value.artifactId)).toSorted()).toEqual(
      [ARTIFACT_ONE_ID, ARTIFACT_TWO_ID].toSorted(),
    );
    expect(byThread.artifacts.map((value) => String(value.artifactId)).toSorted()).toEqual(
      [ARTIFACT_ONE_ID, ARTIFACT_TWO_ID].toSorted(),
    );

    const firstPage = await listArtifacts(dependencies(store.database), principal, {
      limit: "1",
      runId: RUN_ONE_ID,
    });
    const secondPage = await listArtifacts(dependencies(store.database), principal, {
      cursor: firstPage.nextCursor,
      limit: "1",
      runId: RUN_ONE_ID,
    });
    expect(firstPage.artifacts).toHaveLength(1);
    expect(secondPage.artifacts).toHaveLength(1);
    expect(
      [...firstPage.artifacts, ...secondPage.artifacts]
        .map((value) => String(value.artifactId))
        .toSorted(),
    ).toEqual([ARTIFACT_ONE_ID, ARTIFACT_TWO_ID].toSorted());
    expect(
      listArtifacts(dependencies(store.database), principal, {
        cursor: firstPage.nextCursor,
        limit: "1",
        runId: RUN_TWO_ID,
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("uses the run artifact index for run-scoped listings", async () => {
    const store = makeDatabase();
    seedThread(store.put, THREAD_ONE_ID);
    seedRun(store.put, RUN_ONE_ID, THREAD_ONE_ID);
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, { runId: RUN_ONE_ID, threadId: THREAD_ONE_ID }),
    );
    let queryInput: Readonly<Record<string, unknown>> | undefined;
    const database: DynamoDatabaseService = {
      ...store.database,
      queryRecords: (table, input) => {
        queryInput = input;
        return store.database.queryRecords(table, input);
      },
    };

    expect(
      listArtifacts(dependencies(database), principal, { runId: RUN_ONE_ID }),
    ).resolves.toMatchObject({ artifacts: [{ artifactId: ARTIFACT_ONE_ID }] });
    expect(queryInput).toMatchObject({
      ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
      ExpressionAttributeValues: {
        ":pk": key("ORG", ORGANIZATION_ID, "RUN", RUN_ONE_ID, "ARTIFACTS"),
        ":prefix": "ARTIFACT#",
      },
      IndexName: "gsi1",
    });
  });

  test("uses optimistic versions for retention changes", async () => {
    const store = makeDatabase();
    store.put("execution", artifact(ARTIFACT_ONE_ID));
    const api = dependencies(store.database);

    expect(
      updateArtifactRetention(api, principal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID), {
        expectedVersion: 1,
        retentionExpiresAt: "2026-08-25T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "artifact_version_conflict", status: 409 });

    const conflictingApi = dependencies({
      ...store.database,
      transactWrite: () =>
        Promise.reject(
          new DatabaseError({
            cause: new Error("simulated concurrent retention update"),
            message: "Conditional write failed.",
            operation: "transact-write",
            reason: "conflict",
            table: "execution",
          }),
        ),
    });
    expect(
      updateArtifactRetention(
        conflictingApi,
        principal,
        Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID),
        {
          expectedVersion: 0,
          retentionExpiresAt: "2026-08-25T12:00:00.000Z",
        },
      ),
    ).rejects.toMatchObject({ code: "artifact_version_conflict", status: 409 });

    const updated = await updateArtifactRetention(
      api,
      principal,
      Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID),
      {
        expectedVersion: 0,
        retentionExpiresAt: "2026-08-25T12:00:00.000Z",
      },
    );
    expect(updated).toMatchObject({
      retentionExpiresAt: "2026-08-25T12:00:00.000Z",
      version: 1,
    });
  });
});
