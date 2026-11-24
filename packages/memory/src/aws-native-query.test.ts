import { describe, expect, test } from "bun:test";
import {
  AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
  type AwsNativeMemoryConfig,
  type OpenSearchTransport,
} from "./aws-native-contracts.ts";
import {
  queryAwsNativeDense,
  queryAwsNativeDenseExact,
  queryAwsNativeLexical,
} from "./aws-native-query.ts";
import { ids } from "./test-fixtures.ts";

const config: AwsNativeMemoryConfig = {
  automatedSnapshotRetentionHours: AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  backupSafetyMarginMinutes: AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
  embeddingDimensions: 3,
  openSearchEndpoint: "https://search-memory.us-east-2.es.amazonaws.com",
  openSearchIndex: "memory-v3",
  region: "us-east-2",
};

const input = {
  allowedScopeKeys: ["organization:test"],
  allowedSensitivities: ["internal" as const],
  embedding: [0.1, 0.2, 0.3],
  environmentId: ids.environment,
  memorySpaceIds: [ids.space],
  now: new Date("2026-07-31T12:00:00.000Z"),
  organizationId: ids.organization,
  projectId: ids.project,
  searchKeys: ["organization:test"],
  topK: 35,
};

const candidateSourceFields = [
  "contentHash",
  "memorySpaceId",
  "memoryVersion",
  "scopeKey",
  "searchKey",
];

function metadata(index: number) {
  return {
    contentHash: `hash-${index}`,
    memorySpaceId: ids.space,
    memoryVersion: 1,
    scopeKey: "organization:test",
    searchKey: "organization:test",
  };
}

function searchResponse(
  rows: readonly { readonly id: string; readonly index: number; readonly score: number }[],
) {
  return {
    _shards: { failed: 0 },
    hits: {
      hits: rows.map((row) => ({
        _id: row.id,
        _score: row.score,
        _source: metadata(row.index),
      })),
    },
    timed_out: false,
  };
}

describe("AWS-native OpenSearch query strategy", () => {
  test("runs filtered Lucene HNSW directly and records its source telemetry", async () => {
    const requests: unknown[] = [];
    const openSearch: OpenSearchTransport = {
      request: async (request) => {
        requests.push(request);
        return searchResponse([
          { id: "first", index: 0, score: 1.99 },
          { id: "second", index: 1, score: 1.95 },
        ]);
      },
    };

    const rows = await queryAwsNativeDense({ config, input, openSearch });

    expect(requests[0]).toMatchObject({
      body: {
        _source: candidateSourceFields,
        query: {
          knn: {
            embedding: {
              k: 35,
              method_parameters: { ef_search: 256 },
              vector: input.embedding,
            },
          },
        },
        size: 35,
      },
      method: "POST",
      path: `/${config.openSearchIndex}/_search?routing=${ids.organization}`,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        denseSourceCandidateCounts: { "open-search": 2 },
        denseSourceDistances: { "open-search": expect.closeTo(0.01) },
        denseSourceRanks: { "open-search": 1 },
        id: "first",
      }),
      expect.objectContaining({
        denseSourceCandidateCounts: { "open-search": 2 },
        denseSourceRanks: { "open-search": 2 },
        id: "second",
      }),
    ]);
  });

  test("builds a filtered exact cosine control", async () => {
    const requests: unknown[] = [];
    const rows = await queryAwsNativeDenseExact({
      config,
      input: { ...input, topK: 10 },
      openSearch: {
        request: async (request) => {
          requests.push(request);
          return searchResponse([{ id: "exact", index: 1, score: 1.75 }]);
        },
      },
    });

    expect(requests[0]).toMatchObject({
      body: {
        _source: candidateSourceFields,
        query: {
          script_score: {
            script: {
              lang: "knn",
              params: {
                field: "embedding",
                query_value: input.embedding,
                space_type: "cosinesimil",
              },
              source: "knn_score",
            },
          },
        },
      },
    });
    expect(rows[0]).toMatchObject({
      denseSourceRanks: { "open-search": 1 },
      dist: 0.25,
      id: "exact",
    });
  });

  test("uses the standard, English, and shingle fields without all-token matching", async () => {
    const requests: unknown[] = [];
    await queryAwsNativeLexical({
      config,
      input: {
        ...input,
        query:
          "For the indigo river service, when is its production release window and which safety step is mandatory?",
        topK: 50,
      },
      openSearch: {
        request: async (request) => {
          requests.push(request);
          return searchResponse([]);
        },
      },
    });

    expect(requests[0]).toMatchObject({
      body: {
        _source: candidateSourceFields,
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  fields: ["content^1.5", "content.english^1.25", "content.shingles^2"],
                  minimum_should_match: "25%",
                  operator: "or",
                  type: "best_fields",
                },
              },
            ],
          },
        },
        size: 50,
      },
    });
  });
});
