import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { ArtifactRecord } from "../records/artifacts.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { makeArtifactIndexPersistence } from "./artifact-index-persistence.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5${suffix.padStart(3, "0")}`);
const ORG_ID = id("1");
const PROJECT_ID = id("2");
const ENVIRONMENT_ID = id("3");
const OTHER_ENVIRONMENT_ID = id("4");
const RUN_ID = id("5");

interface ArtifactInput {
  readonly artifactId: string;
  readonly createdAt: string;
  readonly environmentId?: string;
  readonly runId?: string;
  readonly status?: "available" | "pending";
  readonly updatedAt?: string;
}

function artifactRecord(input: ArtifactInput) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: input.createdAt,
        environmentId: input.environmentId ?? ENVIRONMENT_ID,
        id: input.artifactId,
        name: input.artifactId,
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        ...(input.runId ? { runId: input.runId } : {}),
        status: input.status ?? "available",
        storage: {
          bucket: "artifact-bucket",
          byteSize: 1,
          contentType: "text/plain",
          key: `artifacts/${input.artifactId}`,
          sha256: "a".repeat(64),
        },
        type: "report",
        updatedAt: input.updatedAt ?? input.createdAt,
        version: 0,
        visibility: "organization",
      },
      itemType: "artifact",
    }),
  );
}

const OLDEST = id("21");
const MIDDLE = id("22");
const NEWEST = id("23");

function seeded() {
  const dynamo = fakeDynamoDocumentClient();
  for (const record of [
    artifactRecord({ artifactId: OLDEST, createdAt: "2026-09-01T00:00:01.000Z", runId: RUN_ID }),
    // Updated last, so an index ordered by update time would list it first.
    artifactRecord({
      artifactId: MIDDLE,
      createdAt: "2026-09-01T00:00:02.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    }),
    artifactRecord({
      artifactId: NEWEST,
      createdAt: "2026-09-01T00:00:03.000Z",
      status: "pending",
    }),
    artifactRecord({
      artifactId: id("24"),
      createdAt: "2026-09-01T00:00:04.000Z",
      environmentId: OTHER_ENVIRONMENT_ID,
    }),
  ]) {
    dynamo.put(DEFAULT_TABLE_NAMES.execution, record);
  }
  return { dynamo, persistence: makeArtifactIndexPersistence(makeDynamoDatabase(dynamo.client)) };
}

const ids = (page: { readonly artifacts: readonly { readonly data: { readonly id: string } }[] }) =>
  page.artifacts.map((artifact) => artifact.data.id);

describe("artifact index", () => {
  test("lists an environment's artifacts newest first by creation, whatever their status", async () => {
    const { persistence } = seeded();
    expect(ids(await persistence.environmentPage(ENVIRONMENT_ID, {}, {}))).toEqual([
      NEWEST,
      MIDDLE,
      OLDEST,
    ]);
  });

  test("bounds the environment listing by an inclusive creation window", async () => {
    const { persistence } = seeded();
    expect(
      ids(
        await persistence.environmentPage(
          ENVIRONMENT_ID,
          { createdAfter: "2026-09-01T00:00:02.000Z", createdBefore: "2026-09-01T00:00:02.000Z" },
          {},
        ),
      ),
    ).toEqual([MIDDLE]);
    expect(
      ids(
        await persistence.environmentPage(
          ENVIRONMENT_ID,
          { createdBefore: "2026-09-01T00:00:01.999Z" },
          {},
        ),
      ),
    ).toEqual([OLDEST]);
  });

  test("keeps an artifact's environment position when its status and update time change", () => {
    const pending = artifactRecord({ artifactId: NEWEST, createdAt: "2026-09-01T00:00:03.000Z" });
    const deleted = withCanonicalRecordKeys({
      ...pending,
      data: {
        ...pending.data,
        status: "deleted",
        updatedAt: "2026-10-01T00:00:00.000Z",
        version: 1,
      },
    });
    expect(deleted.gsi2sk).toBe(pending.gsi2sk);
    expect(pending.gsi2sk).toBe(`ARTIFACT#2026-09-01T00%3A00%3A03.000Z#${NEWEST}`);
  });

  test("reads a run's artifacts from the run index", async () => {
    const { persistence } = seeded();
    expect(ids(await persistence.runPage(ORG_ID, RUN_ID, {}))).toEqual([OLDEST]);
  });

  test("resumes after the last evaluated key", async () => {
    const { dynamo } = seeded();
    const database = makeDynamoDatabase(dynamo.client);
    const send = dynamo.client.send.bind(dynamo.client);
    dynamo.client.send = ((command: { input: Record<string, unknown> }) => {
      if ("IndexName" in command.input) command.input.Limit = 1;
      return send(command as never);
    }) as typeof dynamo.client.send;
    const persistence = makeArtifactIndexPersistence(database);
    const first = await persistence.environmentPage(ENVIRONMENT_ID, {}, {});
    const second = await persistence.environmentPage(
      ENVIRONMENT_ID,
      {},
      { exclusiveStartKey: first.lastEvaluatedKey },
    );
    expect([ids(first), ids(second)]).toEqual([[NEWEST], [MIDDLE]]);
  });

  test("still lists and decodes an artifact stored with the status-ordered environment key", async () => {
    const { dynamo, persistence } = seeded();
    const legacyId = id("30");
    const legacy = artifactRecord({ artifactId: legacyId, createdAt: "2026-08-01T00:00:00.000Z" });
    const legacySortKey = key("ARTIFACT", "available", legacy.data.updatedAt, legacyId);
    dynamo.put(DEFAULT_TABLE_NAMES.execution, { ...legacy, gsi2sk: legacySortKey });

    const listed = await persistence.environmentPage(ENVIRONMENT_ID, {}, {});
    expect(ids(listed)).toContain(legacyId);
    expect(
      ids(
        await persistence.environmentPage(
          ENVIRONMENT_ID,
          { createdBefore: "2026-09-30T00:00:00.000Z" },
          {},
        ),
      ),
    ).not.toContain(legacyId);
    expect(
      (await Effect.runPromise(decodePlatformRecord({ ...legacy, gsi2sk: legacySortKey }))).gsi2sk,
    ).toBe(legacySortKey);
    expect(
      Effect.runPromise(decodePlatformRecord({ ...legacy, gsi2sk: `${legacySortKey}x` })),
    ).rejects.toThrow();
  });
});
