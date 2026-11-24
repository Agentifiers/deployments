import { S3Client } from "@aws-sdk/client-s3";
import { ArtifactRecord, Ulid, withCanonicalRecordKeys } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  createArtifactAccessUrl,
  deleteArtifact,
  getArtifact,
  listArtifacts,
} from "./artifact-operations.ts";
import {
  NOW,
  RUN_ONE_ID,
  THREAD_ONE_ID,
  artifact,
  dependencies,
  generatedUlid,
  makeDatabase,
  principal,
  seedRun,
} from "./artifact-operations.fixture.ts";
import type { RuntimeApiDependencies } from "./runtime-support.ts";

function stored(
  artifactId: string,
  data: {
    readonly contentType?: string;
    readonly createdAt: string;
    readonly fileName?: string;
    readonly type?: string;
    readonly updatedAt?: string;
  },
  options: Parameters<typeof artifact>[1] = {},
) {
  const base = artifact(artifactId, { visibility: "organization", ...options });
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        ...base.data,
        createdAt: data.createdAt,
        storage: {
          ...base.data.storage,
          contentType: data.contentType ?? base.data.storage.contentType,
          fileName: data.fileName ?? base.data.storage.fileName,
        },
        type: data.type ?? base.data.type,
        updatedAt: data.updatedAt ?? data.createdAt,
      },
      itemType: "artifact",
      ...(base.ttl === undefined ? {} : { ttl: base.ttl }),
    }),
  );
}

const ids = (page: { readonly artifacts: readonly { readonly artifactId: string }[] }) =>
  page.artifacts.map((value) => String(value.artifactId));

function seeded() {
  const store = makeDatabase();
  const rows = [
    { contentType: "image/png", createdAt: "2026-07-20T10:00:00.000Z", type: "report" },
    {
      contentType: "text/csv; charset=utf-8",
      createdAt: "2026-07-21T10:00:00.000Z",
      type: "input",
    },
    { contentType: "image/jpeg", createdAt: "2026-07-22T10:00:00.000Z", type: "report" },
    // Updated last, so an index sorted by update time would put it first.
    {
      contentType: "application/json",
      createdAt: "2026-07-23T10:00:00.000Z",
      type: "report",
      updatedAt: "2026-07-25T11:00:00.000Z",
    },
  ];
  for (const [index, row] of rows.entries())
    store.put("execution", stored(generatedUlid(index), row));
  return { api: dependencies(store.database), store };
}

describe("environment artifact listing", () => {
  test("lists every environment artifact newest created first", async () => {
    const { api } = seeded();
    expect(ids(await listArtifacts(api, principal, {}))).toEqual([
      generatedUlid(3),
      generatedUlid(2),
      generatedUlid(1),
      generatedUlid(0),
    ]);
  });

  test("filters by type, media type, media family, and creation window", async () => {
    const { api } = seeded();
    expect(ids(await listArtifacts(api, principal, { type: "input" }))).toEqual([generatedUlid(1)]);
    expect(ids(await listArtifacts(api, principal, { contentType: "text/csv" }))).toEqual([
      generatedUlid(1),
    ]);
    expect(ids(await listArtifacts(api, principal, { contentType: "image/*" }))).toEqual([
      generatedUlid(2),
      generatedUlid(0),
    ]);
    expect(
      ids(
        await listArtifacts(api, principal, {
          createdAfter: "2026-07-21T10:00:00.000Z",
          createdBefore: "2026-07-22T10:00:00.000Z",
        }),
      ),
    ).toEqual([generatedUlid(2), generatedUlid(1)]);
    expect(
      ids(
        await listArtifacts(api, principal, {
          contentType: "image/*",
          createdAfter: "2026-07-21T00:00:00.000Z",
          type: "report",
        }),
      ),
    ).toEqual([generatedUlid(2)]);
  });

  test("keeps artifacts stored before the creation index in an open-ended list", async () => {
    const { api, store } = seeded();
    const legacy = stored(generatedUlid(9), { createdAt: "2026-07-01T10:00:00.000Z" });
    store.put("execution", {
      ...legacy,
      gsi2sk: `ARTIFACT#available#${legacy.data.updatedAt}#${legacy.data.id}`,
    });

    expect(ids(await listArtifacts(api, principal, {}))).toContain(generatedUlid(9));
    expect(
      ids(await listArtifacts(api, principal, { createdBefore: "2026-07-24T00:00:00.000Z" })),
    ).not.toContain(generatedUlid(9));
  });

  test("rejects malformed filters", async () => {
    const { api } = seeded();
    for (const [parameters, code] of [
      [{ contentType: "image" }, "invalid_artifact_content_type"],
      [{ contentType: "*/*" }, "invalid_artifact_content_type"],
      [{ createdAfter: "2026-07-21" }, "invalid_request"],
      [
        { createdAfter: "2026-07-22T00:00:00.000Z", createdBefore: "2026-07-21T00:00:00.000Z" },
        "invalid_request",
      ],
      [{ type: " report" }, "invalid_request"],
    ] as const) {
      expect(listArtifacts(api, principal, parameters)).rejects.toMatchObject({
        code,
        status: 400,
      });
    }
  });

  test("pages with a cursor that only resumes the filters that produced it", async () => {
    const { api, store } = seeded();
    seedRun(store.put, RUN_ONE_ID, THREAD_ONE_ID);
    const first = await listArtifacts(api, principal, { contentType: "image/*", limit: "1" });
    expect(ids(first)).toEqual([generatedUlid(2)]);
    expect(first.nextCursor).toBeTruthy();

    const second = await listArtifacts(api, principal, {
      contentType: "image/*",
      cursor: first.nextCursor,
      limit: "1",
    });
    expect(ids(second)).toEqual([generatedUlid(0)]);
    expect(second.nextCursor).toBeUndefined();

    for (const parameters of [
      { contentType: "image/png" },
      { contentType: "image/*", type: "report" },
      { contentType: "image/*", runId: RUN_ONE_ID },
    ]) {
      expect(
        listArtifacts(api, principal, { ...parameters, cursor: first.nextCursor, limit: "1" }),
      ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    }
  });

  test("applies filters to a run's artifacts", async () => {
    const store = makeDatabase();
    seedRun(store.put, RUN_ONE_ID, THREAD_ONE_ID);
    store.put(
      "execution",
      stored(generatedUlid(0), { contentType: "image/png", createdAt: NOW }, { runId: RUN_ONE_ID }),
    );
    store.put("execution", stored(generatedUlid(1), { createdAt: NOW }, { runId: RUN_ONE_ID }));
    store.put("execution", stored(generatedUlid(2), { contentType: "image/png", createdAt: NOW }));

    expect(
      ids(
        await listArtifacts(dependencies(store.database), principal, {
          contentType: "image/*",
          runId: RUN_ONE_ID,
        }),
      ),
    ).toEqual([generatedUlid(0)]);
  });
});

describe("artifact deletion", () => {
  test("hides the artifact at once and hands erasure to retention", async () => {
    const { api, store } = seeded();
    const artifactId = Schema.decodeUnknownSync(Ulid)(generatedUlid(2));

    const deleted = await deleteArtifact(api, principal, artifactId);

    expect(deleted).toMatchObject({ retentionExpiresAt: NOW, status: "deleted" });
    expect(store.transactionBatches.at(-1)?.at(0)).toMatchObject({
      data: { status: "deleted", version: 1 },
      ttl: Date.parse(NOW) / 1_000,
    });
    expect(getArtifact(api, principal, artifactId)).rejects.toMatchObject({ status: 404 });
    expect(createArtifactAccessUrl(api, principal, artifactId, {})).rejects.toMatchObject({
      code: "artifact_unavailable",
    });
    expect(deleteArtifact(api, principal, artifactId)).rejects.toMatchObject({ status: 404 });
    expect(ids(await listArtifacts(api, principal, {}))).not.toContain(generatedUlid(2));
  });

  test("keeps a pending upload's expiry so bytes still arriving are erased with it", async () => {
    const store = makeDatabase();
    const uploadExpiresAt = "2026-07-26T12:00:00.000Z";
    store.put(
      "execution",
      artifact(generatedUlid(0), {
        status: "pending",
        uploadExpiresAt,
        visibility: "organization",
      }),
    );

    await deleteArtifact(
      dependencies(store.database),
      principal,
      Schema.decodeUnknownSync(Ulid)(generatedUlid(0)),
    );

    expect(store.transactionBatches.at(-1)?.at(0)).toMatchObject({
      data: { status: "deleted", uploadExpiresAt },
      ttl: Date.parse(uploadExpiresAt) / 1_000,
    });
  });
});

describe("artifact download disposition", () => {
  test("asks storage to send an attachment when the caller wants a download", async () => {
    const store = makeDatabase();
    store.put(
      "execution",
      stored(generatedUlid(0), { createdAt: NOW, fileName: 'résumé "final".html' }),
    );
    const api = {
      ...dependencies(store.database),
      artifactS3: new S3Client({
        credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
        region: "us-east-1",
      }),
    } as RuntimeApiDependencies;
    const artifactId = Schema.decodeUnknownSync(Ulid)(generatedUlid(0));

    const attachment = await createArtifactAccessUrl(api, principal, artifactId, {
      disposition: "attachment",
    });
    const inline = await createArtifactAccessUrl(api, principal, artifactId, {});

    expect(new URL(attachment.url).searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="r_sum_ _final_.html"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.html`,
    );
    expect(new URL(inline.url).searchParams.has("response-content-disposition")).toBe(false);
    expect(
      createArtifactAccessUrl(api, principal, artifactId, { disposition: "render" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
