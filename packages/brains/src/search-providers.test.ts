import { describe, expect, test } from "bun:test";
import { makeAwsNativeBrainSearchProvider } from "./aws-native-search.ts";
import type { BrainIndexChunk } from "./search-provider.ts";

const chunk: BrainIndexChunk = {
  brainId: "brain-1",
  chunkId: "chunk-1",
  contentHash: "sha256:content",
  coordinates: { end: 12, kind: "unicode-scalar", start: 0 },
  documentId: "document-1",
  documentVersionId: "version-1",
  embedding: [0.1, 0.2],
  entityKeys: ["decision"],
  organizationId: "organization-1",
  projectionGeneration: 1,
  renditionId: "rendition-1",
  sensitivity: "internal",
  retentionExpiresAtMs: 8_640_000_000_000_000,
  reviewStatus: "approved",
  schemaGeneration: 1,
  sourceId: "source-1",
  text: "The decision evidence.",
  title: "Decision",
};

function row() {
  return {
    brainId: chunk.brainId,
    coordinatesEnd: chunk.coordinates.end,
    coordinatesKind: chunk.coordinates.kind,
    coordinatesStart: chunk.coordinates.start,
    contentHash: chunk.contentHash,
    documentId: chunk.documentId,
    documentVersionId: chunk.documentVersionId,
    id: chunk.chunkId,
    organizationId: chunk.organizationId,
    projectionGeneration: chunk.projectionGeneration,
    renditionId: chunk.renditionId,
    sensitivity: chunk.sensitivity,
    reviewStatus: chunk.reviewStatus,
    schemaGeneration: chunk.schemaGeneration,
    sourceId: chunk.sourceId,
  };
}

describe("Brain search providers", () => {
  test("serves every AWS-native retrieval component from one OpenSearch index", async () => {
    const openSearchCalls: {
      body?: unknown;
      contentType?: string;
      method: string;
      path: string;
    }[] = [];
    const provider = makeAwsNativeBrainSearchProvider({
      config: {
        embeddingDimensions: 2,
        openSearchIndex: "brain-search",
      },
      openSearch: {
        request: async (input) => {
          openSearchCalls.push(input);
          if (input.path.includes("/_count")) return { _shards: { failed: 0 }, count: 0 };
          if (input.path === "/brain-search/_bulk?refresh=wait_for&wait_for_active_shards=all") {
            return {
              errors: false,
              items: [{ index: { _shards: { failed: 0, successful: 2, total: 2 }, status: 201 } }],
            };
          }
          if (input.path.includes("/_delete_by_query")) {
            return { deleted: 1, failures: [], timed_out: false, version_conflicts: 0 };
          }
          return input.path.includes("/_search")
            ? {
                _shards: { failed: 0 },
                hits: {
                  hits: [{ _id: chunk.chunkId, _score: 0.9, _source: row() }],
                },
                timed_out: false,
              }
            : {};
        },
      },
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: "target-aws",
      },
    });

    await provider.prepare({ organizationId: chunk.organizationId });
    await provider.upsert({
      chunks: [chunk],
      organizationId: chunk.organizationId,
    });
    const results = await provider.search({
      allowedReviewStatuses: ["approved"],
      allowedSensitivities: ["internal"],
      authorizedBrainIds: [chunk.brainId],
      embedding: chunk.embedding,
      limit: 5,
      organizationId: chunk.organizationId,
      query: "decision",
      retentionCutoffMs: Date.parse("2026-07-30T12:00:00.000Z"),
    });

    const prepare = openSearchCalls.find((call) => call.method === "PUT");
    expect(prepare?.body).toMatchObject({
      mappings: {
        _routing: { required: true },
        properties: { embedding: { dimension: 2, type: "knn_vector" } },
      },
      settings: { index: { knn: true, number_of_shards: 1 } },
    });
    const bulk = openSearchCalls.find(
      (call) => call.path === "/brain-search/_bulk?refresh=wait_for&wait_for_active_shards=all",
    );
    expect(bulk?.contentType).toBe("application/x-ndjson");
    expect(typeof bulk?.body === "string" && bulk.body.endsWith("\n")).toBe(true);
    if (typeof bulk?.body !== "string") throw new TypeError("Missing NDJSON bulk body.");
    const bulkLines = bulk.body
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(bulkLines).toHaveLength(2);
    expect(bulkLines[0]).toEqual({
      index: {
        _id: chunk.chunkId,
        routing: chunk.organizationId,
      },
    });
    expect(bulkLines[1]).toMatchObject({
      brainId: chunk.brainId,
      documentId: chunk.documentId,
      embedding: chunk.embedding,
      entityKeys: chunk.entityKeys,
      status: "active",
      text: chunk.text,
      title: chunk.title,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      denseScore: 0.9,
      documentVersionId: chunk.documentVersionId,
    });
    const searchCalls = openSearchCalls.filter((call) => call.path.includes("/_search"));
    expect(searchCalls).toHaveLength(4);
    expect(searchCalls.every((call) => call.path.includes("routing=organization-1"))).toBe(true);
    expect(JSON.stringify(searchCalls.map((call) => call.body))).toContain('"knn"');
    expect(JSON.stringify(searchCalls.map((call) => call.body))).toContain(
      '"organizationId":"organization-1"',
    );
    await provider.deleteDocument({
      brainId: chunk.brainId,
      chunkIds: [chunk.chunkId],
      documentId: chunk.documentId,
      organizationId: chunk.organizationId,
    });
    expect(
      openSearchCalls.find(
        (call) =>
          call.path.includes("/_delete_by_query") && JSON.stringify(call.body).includes("ids"),
      )?.body,
    ).toMatchObject({
      query: {
        bool: {
          filter: [
            { term: { organizationId: chunk.organizationId } },
            { term: { brainId: chunk.brainId } },
            { term: { documentId: chunk.documentId } },
            { ids: { values: [chunk.chunkId] } },
          ],
        },
      },
    });
    expect(
      provider.purgeBrain({ brainId: chunk.brainId, organizationId: chunk.organizationId }),
    ).resolves.toMatchObject({
      receipt: { absenceVerified: true, brainId: chunk.brainId, store: "opensearch" },
    });
    expect(
      openSearchCalls.find(
        (call) =>
          call.path.includes("_delete_by_query?conflicts=proceed") &&
          JSON.stringify(call.body).includes(chunk.brainId) &&
          !JSON.stringify(call.body).includes("ids"),
      )?.body,
    ).toMatchObject({
      query: {
        bool: {
          filter: [
            { term: { organizationId: chunk.organizationId } },
            { term: { brainId: chunk.brainId } },
          ],
        },
      },
    });
    expect(
      provider.purgeOrganization({ organizationId: chunk.organizationId }),
    ).resolves.toMatchObject({
      deleted: true,
      receipt: {
        absenceVerified: true,
        providerId: "aws-native",
        store: "opensearch",
      },
    });
  });

  test("fails closed on partial OpenSearch search results", async () => {
    const provider = makeAwsNativeBrainSearchProvider({
      config: { embeddingDimensions: 2, openSearchIndex: "brain-search" },
      openSearch: {
        request: async () => ({
          _shards: { failed: 1, failures: [{ reason: "unavailable" }] },
          hits: { hits: [] },
          timed_out: false,
        }),
      },
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: "target-aws",
      },
    });
    expect(
      provider.search({
        allowedReviewStatuses: ["approved"],
        allowedSensitivities: ["internal"],
        authorizedBrainIds: [chunk.brainId],
        embedding: chunk.embedding,
        limit: 5,
        organizationId: chunk.organizationId,
        query: "decision",
        retentionCutoffMs: Date.parse("2026-07-30T12:00:00.000Z"),
      }),
    ).rejects.toThrow("partial or timed out");
  });

  test("fails closed on incomplete OpenSearch bulk shard acknowledgements", async () => {
    const provider = makeAwsNativeBrainSearchProvider({
      config: { embeddingDimensions: 2, openSearchIndex: "brain-search" },
      openSearch: {
        request: async () => ({
          errors: false,
          items: [{ index: { _shards: { failed: 1, successful: 1, total: 2 }, status: 201 } }],
        }),
      },
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: "target-aws",
      },
    });
    expect(
      provider.upsert({ chunks: [chunk], organizationId: chunk.organizationId }),
    ).rejects.toThrow("bulk indexing was incomplete");
  });

  test("purges an organization whose Brain index holds no documents", async () => {
    const requests: string[] = [];
    const provider = makeAwsNativeBrainSearchProvider({
      config: { embeddingDimensions: 2, openSearchIndex: "brain-search" },
      openSearch: {
        request: async ({ method, path }) => {
          requests.push(`${method} ${path}`);
          if (path.includes("/_delete_by_query")) {
            return {
              batches: 0,
              deleted: 0,
              failures: [],
              noops: 0,
              timed_out: false,
              total: 0,
              version_conflicts: 0,
            };
          }
          return { _shards: { failed: 0, skipped: 0, successful: 1, total: 1 }, count: 0 };
        },
      },
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: "target-aws",
      },
    });

    expect({
      purge: await provider.purgeOrganization({ organizationId: chunk.organizationId }),
      requests,
    }).toEqual({
      purge: {
        deleted: true,
        receipt: {
          absenceVerified: true,
          backupBoundary: "no-deployment-owned-opensearch-snapshots",
          deletedDocuments: 0,
          providerId: "aws-native",
          store: "opensearch",
          targetId: "target-aws",
        },
      },
      requests: [
        "POST /brain-search/_delete_by_query?conflicts=proceed&refresh=true&routing=organization-1",
        "POST /brain-search/_count?routing=organization-1",
      ],
    });
  });
});

describe("AWS-native Brain organization purge", () => {
  const organizationId = "01JA0000000000000000000002";
  const ownIndex = "brain-01ja0000000000000000000002-v1";

  function domain(openSearchIndex: string, deleteAnswer = (): unknown => ({ acknowledged: true })) {
    let live = true;
    const requests: string[] = [];
    const provider = makeAwsNativeBrainSearchProvider({
      config: { embeddingDimensions: 2, openSearchIndex },
      openSearch: {
        request: async ({ method, path }) => {
          requests.push(`${method} ${path}`);
          if (!live) {
            throw Object.assign(new Error("Brain OpenSearch request failed with status 404."), {
              status: 404,
              type: "index_not_found_exception",
            });
          }
          if (method === "DELETE") {
            const answer = deleteAnswer();
            live = false;
            return answer;
          }
          return path.includes("/_delete_by_query")
            ? { deleted: 3, failures: [], timed_out: false, version_conflicts: 0 }
            : { _shards: { failed: 0, skipped: 0, successful: 1, total: 1 }, count: 0 };
        },
      },
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: "target-aws",
      },
    });
    return { provider, requests };
  }

  const receipt = (deletedDocuments: number, indexDrop?: string) => ({
    absenceVerified: true,
    backupBoundary: "no-deployment-owned-opensearch-snapshots",
    deletedDocuments,
    ...(indexDrop ? { indexDrop } : {}),
    providerId: "aws-native",
    store: "opensearch",
    targetId: "target-aws",
  });

  test("drops the organization's own index after verified absence, and a retry converges", async () => {
    const search = domain(ownIndex);

    expect([
      (await search.provider.purgeOrganization({ organizationId })).receipt,
      (await search.provider.purgeOrganization({ organizationId })).receipt,
      search.requests,
    ]).toEqual([
      receipt(3, "dropped"),
      receipt(0, "already-absent"),
      [
        `POST /${ownIndex}/_delete_by_query?conflicts=proceed&refresh=true&routing=${organizationId}`,
        `POST /${ownIndex}/_count?routing=${organizationId}`,
        `DELETE /${ownIndex}`,
        `POST /${ownIndex}/_delete_by_query?conflicts=proceed&refresh=true&routing=${organizationId}`,
        `DELETE /${ownIndex}`,
      ],
    ]);
  });

  test("never drops a shared or misnamed index", async () => {
    const names = [
      "brain-search",
      "brain-01ja0000000000000000000003-v1",
      "brain-01JA0000000000000000000002-v1",
      "brain-01ja0000000000000000000002-v1-shared",
      "brain-01ja0000000000000000000002-vx",
      "memory-01ja0000000000000000000002-v1",
    ];
    const deletes: string[] = [];
    for (const name of names) {
      const search = domain(name);
      await search.provider.purgeOrganization({ organizationId });
      deletes.push(...search.requests.filter((request) => request.startsWith("DELETE")));
    }

    expect(deletes).toEqual([]);
  });

  test("keeps the index when one Brain is purged", async () => {
    const search = domain(ownIndex);

    await search.provider.purgeBrain({ brainId: "brain-1", organizationId });

    expect(search.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
  });

  test("fails the purge when OpenSearch refuses or does not acknowledge the drop", async () => {
    const refused = domain(ownIndex, () => {
      throw Object.assign(new Error("Brain OpenSearch request failed with status 403."), {
        status: 403,
      });
    });
    const unacknowledged = domain(ownIndex, () => ({ acknowledged: false }));

    expect([
      await refused.provider
        .purgeOrganization({ organizationId })
        .catch((error: Error) => error.message),
      await unacknowledged.provider
        .purgeOrganization({ organizationId })
        .catch((error: Error) => error.message),
    ]).toEqual([
      "Brain OpenSearch request failed with status 403.",
      `OpenSearch did not acknowledge the deletion of ${ownIndex}.`,
    ]);
  });

  test("fails the purge on a 404 that does not say the index is missing", async () => {
    const provider = makeAwsNativeBrainSearchProvider({
      config: { embeddingDimensions: 2, openSearchIndex: ownIndex },
      openSearch: {
        request: async () => {
          throw Object.assign(new Error("Brain OpenSearch request failed with status 404."), {
            status: 404,
          });
        },
      },
      target: {
        location: {},
        providerId: "aws-native",
        schemaGeneration: 1,
        targetId: "target-aws",
      },
    });

    expect(
      await provider.purgeOrganization({ organizationId }).catch((error: Error) => error.message),
    ).toBe("Brain OpenSearch request failed with status 404.");
  });
});
