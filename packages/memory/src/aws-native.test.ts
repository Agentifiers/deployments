import { describe, expect, it } from "bun:test";
import {
  AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
  awsNativeTargetLocation,
  makeAwsNativeMemoryProvider,
  type AwsNativeMemoryConfig,
  type OpenSearchTransport,
} from "./aws-native.ts";
import {
  AWS_NATIVE_OPEN_SEARCH_DYNAMIC_INDEX_SETTINGS,
  AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
  awsNativeOpenSearchIndexDefinition,
  requireCompleteOpenSearchSearch,
  requireNoOpenSearchSnapshotRepositories,
  requireOpenSearchDeletedDocumentsExpunged,
  requireOpenSearchIndexReady,
  requireOpenSearchStorageReclaimed,
} from "./aws-native-erasure.ts";
import { scriptedPurgeOpenSearch } from "./aws-native-purge-test-transport.ts";
import { memoryContentHash } from "./governance.ts";
import { memoryScopeKey, type CanonicalMemoryRecord } from "./memory-record.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";

const config: AwsNativeMemoryConfig = {
  automatedSnapshotRetentionHours: AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  backupSafetyMarginMinutes: AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
  embeddingDimensions: 3,
  openSearchEndpoint: "https://search-memory.us-east-2.es.amazonaws.com",
  openSearchIndex: "memory-v3",
  region: "us-east-2",
};
const indexDefinition = awsNativeOpenSearchIndexDefinition(config.embeddingDimensions);
const now = new Date("2026-07-28T12:00:00.000Z");

function target(schemaGeneration = AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION) {
  return {
    componentIds: [ids.memory2],
    embeddingProfileId: ids.run,
    location: {},
    providerId: "aws-native" as const,
    schemaGeneration,
    targetId: ids.toolCall,
  };
}

function fixture(schemaGeneration = AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION) {
  const requests: Parameters<OpenSearchTransport["request"]>[0][] = [];
  const provider = makeAwsNativeMemoryProvider({
    config,
    openSearch: {
      request: async (input) => {
        requests.push(input);
        if (input.path.includes("/_update/")) return { result: "updated" };
        return { _shards: { failed: 0 }, hits: { hits: [] }, timed_out: false };
      },
    },
    target: target(schemaGeneration),
  });
  return { provider, requests };
}

function queryInput() {
  const memory = memoryFixture();
  return {
    allowedScopeKeys: [memoryScopeKey(memory)],
    allowedSensitivities: ["internal" as const],
    embedding: [0.1, 0.2, 0.3],
    environmentId: ids.environment,
    memorySpaceIds: [ids.space],
    now,
    organizationId: ids.organization,
    projectId: ids.project,
    searchKeys: [memory.data.searchKey],
    topK: 10,
  };
}

describe("AWS-native OpenSearch-only memory provider", () => {
  it("accepts only the service's automated snapshot repository during live verification", () => {
    expect(() => requireNoOpenSearchSnapshotRepositories({})).not.toThrow();
    expect(() =>
      requireNoOpenSearchSnapshotRepositories({
        "cs-automated": { type: "s3" },
        "cs-automated-enc": { type: "s3" },
      }),
    ).not.toThrow();
    expect(() =>
      requireNoOpenSearchSnapshotRepositories({
        "cs-automated-enc": { type: "s3" },
        "manual-backups": { type: "s3" },
      }),
    ).toThrow("untracked snapshot repository");
    expect(() => requireNoOpenSearchSnapshotRepositories([])).toThrow(
      "snapshot repository inventory is invalid",
    );
  });

  it("defines the current AWS-native schema with one primary shard and the complete vector mapping", () => {
    expect(AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION).toBe(3);
    expect(indexDefinition.settings.index).toMatchObject({
      auto_expand_replicas: "0-1",
      knn: true,
      number_of_replicas: 1,
      number_of_shards: 1,
    });
    expect(indexDefinition.mappings.properties.embedding).toMatchObject({
      dimension: 3,
      method: { engine: "lucene", name: "hnsw", space_type: "cosinesimil" },
      type: "knn_vector",
    });
    expect(() =>
      requireOpenSearchIndexReady(
        {
          [config.openSearchIndex]: {
            mappings: indexDefinition.mappings,
            settings: indexDefinition.settings,
          },
        },
        config.embeddingDimensions,
      ),
    ).not.toThrow();
  });

  it("rejects the old three-primary physical schema", () => {
    expect(() =>
      requireOpenSearchIndexReady(
        {
          [config.openSearchIndex]: {
            mappings: indexDefinition.mappings,
            settings: {
              index: { ...indexDefinition.settings.index, number_of_shards: 3 },
            },
          },
        },
        config.embeddingDimensions,
      ),
    ).toThrow("settings.number_of_shards");
  });

  it("requires deployment-owned backup settings and only an OpenSearch location", () => {
    const location = awsNativeTargetLocation({
      ...target(),
      location: { ...config },
    });
    expect(location).toEqual(config);
    expect(() =>
      awsNativeTargetLocation({
        ...target(),
        location: { ...config, automatedSnapshotRetentionHours: 1 },
      }),
    ).toThrow("deployment-owned backup policy");
  });

  it("gates serving on the current AWS-native schema while preserving erasure access", async () => {
    const { provider, requests } = fixture(2);
    const unsupported = {
      cause: { actual: 2, expected: 3 },
      name: "AwsNativeMemoryError",
      operation: "validate-target-schema-generation",
    };

    expect(provider.query(queryInput())).rejects.toMatchObject(unsupported);
    expect(provider.readiness!({ organizationId: ids.organization })).rejects.toMatchObject(
      unsupported,
    );
    expect(requests).toHaveLength(0);

    const purge = makeAwsNativeMemoryProvider({
      config,
      now: () => now,
      openSearch: { request: async () => ({ task: "delete-task" }) },
      target: target(2),
    });
    expect(purge.purgeOrganization!({ organizationId: ids.organization })).resolves.toMatchObject({
      deleted: false,
      receipt: { providerPurgeState: { stage: "delete-by-query", taskId: "delete-task" } },
    });
  });

  it("removes a finished delete-by-query task result through the document API", async () => {
    const requests: Parameters<OpenSearchTransport["request"]>[0][] = [];
    const purge = makeAwsNativeMemoryProvider({
      config,
      now: () => now,
      openSearch: {
        request: async (input) => {
          requests.push(input);
          if (input.method === "GET") {
            return {
              completed: true,
              response: { deleted: 2, failures: [], timed_out: false, version_conflicts: 0 },
            };
          }
          if (input.method === "DELETE") return { result: "deleted" };
          return { task: "merge-task" };
        },
      },
      target: target(),
    });
    expect(
      await purge.purgeOrganization!({
        organizationId: ids.organization,
        providerPurgeStartedAt: now.toISOString(),
        providerPurgeState: { stage: "delete-by-query", taskId: "node:42" },
      }),
    ).toMatchObject({
      receipt: { providerPurgeState: { stage: "force-merge", taskId: "merge-task" } },
    });
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([
      { method: "DELETE", path: "/.tasks/_doc/node%3A42" },
    ]);
  });

  it.each([
    ["refused", { status: 403 }],
    ["a 404 that names no missing index", { details: { message: "Not Found" }, status: 404 }],
  ])("fails an organization purge when the index probe is %s", async (_, failure) => {
    const requests: string[] = [];
    const purge = makeAwsNativeMemoryProvider({
      config,
      now: () => now,
      openSearch: {
        request: async ({ method, path }) => {
          requests.push(`${method} ${path}`);
          if (method === "GET") throw Object.assign(new Error("probe failed"), failure);
          return { task: "delete-task" };
        },
      },
      target: target(),
    });

    expect(
      await purge.purgeOrganization!({ organizationId: ids.organization }).catch((cause) => cause),
    ).toMatchObject(failure);
    expect(requests).toEqual(["GET /memory-v3"]);
  });

  it("reports backups pending after live verification until the backup boundary passes", async () => {
    const openSearch = scriptedPurgeOpenSearch(config.openSearchIndex);
    let current = now;
    const purge = makeAwsNativeMemoryProvider({
      config,
      now: () => current,
      openSearch: openSearch.transport,
      target: target(),
    });
    const backupWait = { liveStorageVerifiedAt: now.toISOString(), stage: "backup-wait" };
    const resume = (providerPurgeState: Readonly<Record<string, unknown>>) =>
      purge.purgeOrganization!({
        organizationId: ids.organization,
        providerPurgeStartedAt: now.toISOString(),
        providerPurgeState,
      });

    expect(await resume({ stage: "force-merge", taskId: "merge-task" })).toEqual({
      deleted: false,
      receipt: {
        absenceVerified: false,
        backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
        liveStorageVerified: true,
        openSearch: { taskCompleted: true },
        providerPurgeStartedAt: now.toISOString(),
        providerPurgeState: backupWait,
        snapshotInventoryVerified: true,
      },
    });
    current = new Date("2026-08-11T12:59:59.999Z");
    expect(await resume(backupWait)).toMatchObject({
      deleted: false,
      receipt: { absenceVerified: false, providerPurgeState: backupWait },
    });
    current = new Date("2026-08-11T13:00:00.000Z");
    expect(await resume(backupWait)).toEqual({
      deleted: true,
      receipt: {
        absenceVerified: true,
        backupErasureEligibleAt: "2026-08-11T13:00:00.000Z",
        liveStorageVerified: true,
        openSearch: { backupWait: true },
        providerPurgeStartedAt: now.toISOString(),
        snapshotInventoryVerified: true,
      },
    });
  });

  it("creates only OpenSearch and reconciles bounded replicas before readiness", async () => {
    const requests: Parameters<OpenSearchTransport["request"]>[0][] = [];
    const provider = makeAwsNativeMemoryProvider({
      config,
      openSearch: {
        request: async (input) => {
          requests.push(input);
          if (input.method === "GET") {
            return {
              [config.openSearchIndex]: {
                mappings: indexDefinition.mappings,
                settings: {
                  index: { ...indexDefinition.settings.index, number_of_replicas: "0" },
                },
              },
            };
          }
          return { acknowledged: true };
        },
      },
      target: target(),
    });

    expect(provider.prepare!({ organizationId: ids.organization })).resolves.toMatchObject({
      denseReady: true,
      lexicalReady: true,
      ready: true,
      reference: config.openSearchIndex,
    });
    expect(requests).toEqual([
      { body: indexDefinition, method: "PUT", path: `/${config.openSearchIndex}` },
      {
        body: AWS_NATIVE_OPEN_SEARCH_DYNAMIC_INDEX_SETTINGS,
        method: "PUT",
        path: `/${config.openSearchIndex}/_settings`,
      },
      { method: "GET", path: `/${config.openSearchIndex}` },
    ]);
  });

  it("writes the embedding and lexical content in one ordered OpenSearch mutation", async () => {
    const { provider, requests } = fixture();
    const memory = memoryFixture({ entityKeys: ["service:memory-api"] });

    expect(
      provider.write({
        content: memory.data.body!,
        embedding: [0.1, 0.2, 0.3],
        embeddingContentHash: memory.data.contentHash,
        embeddingModel: "openai/text-embedding-3-small",
        embeddingProvider: "bifrost",
        memory,
        synchronizationGeneration: 7,
      }),
    ).resolves.toEqual({ status: "written" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      body: {
        script: {
          params: {
            document: {
              content: memory.data.body,
              embedding: [0.1, 0.2, 0.3],
              entityKeys: ["service:memory-api"],
              projectionClass: "customer",
              synchronizationGeneration: 7,
            },
          },
        },
      },
      method: "POST",
    });
    expect(requests[0]!.path).toContain("refresh=wait_for");
    expect(requests[0]!.path).toContain(`routing=${ids.organization}`);
  });

  it("writes health-flagged content only when a reviewer approved that exact content", async () => {
    const { provider, requests } = fixture();
    const body = "Ava has physical therapy every Thursday at noon.";
    const write = (memory: CanonicalMemoryRecord) =>
      provider.write({
        content: body,
        embedding: [0.1, 0.2, 0.3],
        embeddingContentHash: memory.data.contentHash,
        embeddingModel: "openai/text-embedding-3-small",
        embeddingProvider: "bifrost",
        memory,
        synchronizationGeneration: 7,
      });
    const contentHash = memoryContentHash(body);

    expect(
      write(memoryFixture({ body, contentHash, sensitivity: "restricted" })),
    ).rejects.toMatchObject({ cause: "content-governance-or-hash-mismatch" });
    expect(
      write(
        memoryFixture({
          body,
          contentHash,
          reviewerApprovedContentHash: contentHash,
          sensitivity: "restricted",
        }),
      ),
    ).resolves.toEqual({ status: "written" });
    expect(requests).toHaveLength(1);
  });

  it("does not perform a second write when OpenSearch rejects a stale tuple", async () => {
    const requests: unknown[] = [];
    const provider = makeAwsNativeMemoryProvider({
      config,
      openSearch: {
        request: async (input) => {
          requests.push(input);
          return { result: "noop" };
        },
      },
      target: target(),
    });
    const memory = memoryFixture();

    expect(
      provider.write({
        content: memory.data.body!,
        embedding: [0.1, 0.2, 0.3],
        embeddingContentHash: memory.data.contentHash,
        embeddingModel: "openai/text-embedding-3-small",
        embeddingProvider: "bifrost",
        memory,
        synchronizationGeneration: 6,
      }),
    ).resolves.toEqual({ status: "not-applied" });
    expect(requests).toHaveLength(1);
  });

  it("tombstones the single OpenSearch projection", async () => {
    const { provider, requests } = fixture();
    const memory = memoryFixture({ status: "deleted", version: 4 });

    expect(provider.delete({ memory, synchronizationGeneration: 8 })).resolves.toEqual({
      status: "synchronized",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      body: {
        script: {
          params: {
            document: { content: "", reviewStatus: "pending", status: "deleted" },
            mutationPriority: 1,
          },
        },
      },
    });
  });

  it("isolates synthetic evidence in the OpenSearch authorization filter", async () => {
    const { provider, requests } = fixture();
    const evidence = { operationId: ids.thread, targetId: ids.toolCall };

    await provider.queryEvidence!({ ...queryInput(), evidence });
    const serialized = JSON.stringify(requests[0]);
    expect(serialized).toContain('"projectionClass":"synthetic-evidence"');
    expect(serialized).toContain(ids.thread);
    expect(serialized).toContain(ids.toolCall);
    expect(serialized).toContain('"knn"');
  });

  it("rejects requests above the OpenSearch serving limit", async () => {
    const { provider, requests } = fixture();
    expect(provider.query({ ...queryInput(), topK: 101 })).rejects.toThrow("at most 100");
    expect(requests).toHaveLength(0);
  });

  it("bounds ordinary dense candidate pages without lowering the public result limit", () => {
    const { provider } = fixture();
    expect(provider.capabilities).toMatchObject({ densePageSize: 30, denseResultLimit: 100 });
  });

  it("rejects timed-out and partial OpenSearch search evidence", () => {
    expect(() =>
      requireCompleteOpenSearchSearch({ _shards: { failed: 0 }, timed_out: true }),
    ).toThrow("partial search");
    expect(() =>
      requireCompleteOpenSearchSearch({ _shards: { failed: 1 }, timed_out: false }),
    ).toThrow("partial search");
  });

  it("does not certify storage reclamation with translog operations or partial shards", () => {
    expect(() =>
      requireOpenSearchStorageReclaimed(
        {
          _shards: { failed: 0 },
          indices: {
            [config.openSearchIndex]: {
              primaries: { translog: { operations: 1, uncommitted_operations: 0 } },
              total: { translog: { operations: 1, uncommitted_operations: 0 } },
            },
          },
        },
        config.openSearchIndex,
      ),
    ).toThrow("trimmed translog");
    expect(() =>
      requireOpenSearchDeletedDocumentsExpunged(
        {
          _shards: { failed: 1, successful: 0, total: 1 },
          indices: {
            [config.openSearchIndex]: {
              shards: { "0": [{ segments: { segment0: { deleted_docs: 0 } } }] },
            },
          },
        },
        config.openSearchIndex,
      ),
    ).toThrow("partial");
  });
});
