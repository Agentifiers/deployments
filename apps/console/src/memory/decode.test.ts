import { describe, expect, test } from "bun:test";
import {
  MemoryRecallAttemptRecord,
  MemoryRecord,
  MemoryRetrievalRecord,
  MemoryReviewItemRecord,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import {
  decodeExportedMemory,
  decodeFeedback,
  decodeGrant,
  decodeImport,
  decodeMemory,
  decodePage,
  decodePolicy,
  decodeQuality,
  decodeResolution,
  decodeReviewItem,
  decodeSearch,
  decodeSpace,
} from "./decode.ts";
import type { Memory, MemoryReviewItem, MemorySpace } from "./model.ts";
import {
  APPROVED_MEMORY,
  ARCHIVED_STORED_MEMORY,
  DELETED_MEMORY,
  DEV_QUALITY,
  OPEN_REVIEW_ITEM,
  PENDING_MEMORY,
  RATED_RETRIEVAL,
  RECALL_ATTEMPT,
  RETRIEVAL,
  SEARCH_RESPONSE,
} from "./records.fixture.ts";

const TENANT = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G600H",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};

const DEV_SPACE = {
  data: {
    createdAt: "2026-10-09T05:01:12.726Z",
    updatedAt: "2026-10-09T05:01:12.726Z",
    version: 0,
    ...TENANT,
    id: "01ARZ3NDEKTSV4RRFFQ69G600K",
    kind: "organization",
    name: "Launch checklist",
    retentionDays: 30,
    status: "active",
  },
  gsi1pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G600C",
  gsi1sk: "MEMORY-SPACE#active#2026-10-09T05%3A01%3A12.726Z#01ARZ3NDEKTSV4RRFFQ69G600K",
  gsi2pk: "ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  gsi2sk: "MEMORY-SPACE#active#2026-10-09T05%3A01%3A12.726Z#01ARZ3NDEKTSV4RRFFQ69G600K",
  itemType: "memory-space",
  pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G600C#ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  sk: "MEMORY-SPACE#01ARZ3NDEKTSV4RRFFQ69G600K",
};

const DEV_SPACE_VIEW: MemorySpace = {
  createdAt: "2026-10-09T05:01:12.726Z",
  id: "01ARZ3NDEKTSV4RRFFQ69G600K",
  kind: "organization",
  name: "Launch checklist",
  retentionDays: 30,
  status: "active",
  updatedAt: "2026-10-09T05:01:12.726Z",
  version: 0,
};

const E2E_POLICY = {
  data: {
    ...TENANT,
    activeRecallEnabled: true,
    activeRecallRolloutPercent: 100,
    createdAt: "2026-10-01T00:00:00.000Z",
    id: "01ARZ3NDEKTSV4RRFFQ69G600M",
    processingConfig: {
      memoryRetrieval: { rolloutPercent: 100, strategy: "hybrid-rerank-v1" },
      extraction: { model: "small" },
    },
    retentionDays: 1,
    scope: "environment",
    sensitivityMode: "standard",
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 2,
  },
  itemType: "memory-policy",
  pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G600C#ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  sk: "MEMORY-POLICY#01ARZ3NDEKTSV4RRFFQ69G600M",
};

const DEV_GRANT = {
  data: {
    createdAt: "2026-10-09T05:39:50.394Z",
    updatedAt: "2026-10-09T05:40:02.974Z",
    version: 1,
    ...TENANT,
    agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G600R",
    grantedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G600B",
    id: "01ARZ3NDEKTSV4RRFFQ69G600S",
    memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G600Q",
    permission: "read-write",
  },
  gsi1pk: "ENV#01ARZ3NDEKTSV4RRFFQ69G600H#AGENT#01ARZ3NDEKTSV4RRFFQ69G600R#MEMORY-SPACE-GRANTS",
  gsi1sk:
    "MEMORY-SPACE-GRANT#active#environment#01ARZ3NDEKTSV4RRFFQ69G600Q#01ARZ3NDEKTSV4RRFFQ69G600S",
  gsi2pk: "ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  gsi2sk: "MEMORY-SPACE-GRANT#all#2026-10-09T05%3A40%3A02.974Z#01ARZ3NDEKTSV4RRFFQ69G600S",
  itemType: "memory-space-grant",
  pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G600C#ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  sk: "MEMORY-SPACE-GRANT#01ARZ3NDEKTSV4RRFFQ69G600S",
};

const DEV_REVOKED_GRANT = {
  ...DEV_GRANT,
  data: {
    ...DEV_GRANT.data,
    revokedAt: "2026-10-09T05:40:50.316Z",
    updatedAt: "2026-10-09T05:40:50.316Z",
    version: 2,
  },
};

describe("decodeSpace", () => {
  test("reads the dev record's data and drops the storage keys", () => {
    expect(decodeSpace(DEV_SPACE)).toEqual(DEV_SPACE_VIEW);
  });

  test("refuses another record type and an unknown status", () => {
    expect(decodeSpace({ ...DEV_SPACE, itemType: "memory-policy" })).toBeUndefined();
    expect(
      decodeSpace({ ...DEV_SPACE, data: { ...DEV_SPACE.data, status: "paused" } }),
    ).toBeUndefined();
    expect(decodeSpace(DEV_SPACE.data)).toBeUndefined();
  });
});

describe("decodeGrant", () => {
  test("derives the status from revokedAt on the dev records", () => {
    expect(decodeGrant(DEV_GRANT)).toEqual({
      agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G600R",
      createdAt: "2026-10-09T05:39:50.394Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G600S",
      memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G600Q",
      permission: "read-write",
      status: "active",
      updatedAt: "2026-10-09T05:40:02.974Z",
      version: 1,
    });
    expect(decodeGrant(DEV_REVOKED_GRANT)).toMatchObject({
      revokedAt: "2026-10-09T05:40:50.316Z",
      status: "revoked",
      version: 2,
    });
  });
});

describe("decodePolicy", () => {
  test("reads the strategy and keeps the rest of the processing config", () => {
    expect(decodePolicy(E2E_POLICY)).toEqual({
      activeRecallEnabled: true,
      activeRecallRolloutPercent: 100,
      createdAt: "2026-10-01T00:00:00.000Z",
      id: "01ARZ3NDEKTSV4RRFFQ69G600M",
      processingConfig: {
        extraction: { model: "small" },
        memoryRetrieval: { rolloutPercent: 100, strategy: "hybrid-rerank-v1" },
      },
      retentionDays: 1,
      retrieval: "hybrid-rerank-v1",
      retrievalSettings: { rolloutPercent: 100, strategy: "hybrid-rerank-v1" },
      scope: "environment",
      sensitivityMode: "standard",
      updatedAt: "2026-10-01T00:00:00.000Z",
      version: 2,
    });
  });

  test("reports the platform default when no known strategy is named", () => {
    const { processingConfig: _config, ...withoutConfig } = E2E_POLICY.data;
    const bare = { ...E2E_POLICY, data: withoutConfig };
    expect(decodePolicy(bare)).toMatchObject({
      processingConfig: {},
      retrieval: "default",
      retrievalSettings: {},
    });
    const odd = {
      ...E2E_POLICY,
      data: { ...E2E_POLICY.data, processingConfig: { memoryRetrieval: "dense-v1" } },
    };
    expect(decodePolicy(odd)).toMatchObject({ retrieval: "default", retrievalSettings: {} });
  });

  test("reports custom retrieval when the platform would serve something other than one top-level strategy", () => {
    const withRetrieval = (memoryRetrieval: unknown) =>
      decodePolicy({
        ...E2E_POLICY,
        data: { ...E2E_POLICY.data, processingConfig: { memoryRetrieval } },
      })?.retrieval;
    expect(withRetrieval({ purposes: { "active-recall": { strategy: "hybrid-rerank-v1" } } })).toBe(
      "custom",
    );
    expect(
      withRetrieval({ purposes: { search: { rolloutPercent: 10 } }, strategy: "dense-v1" }),
    ).toBe("custom");
    expect(withRetrieval({ shadowStrategy: "hybrid-rrf-v1", strategy: "dense-v1" })).toBe("custom");
    expect(withRetrieval({ rolloutPercent: 0, strategy: "hybrid-rrf-v1" })).toBe("custom");
    expect(withRetrieval({ rolloutPercent: 100, strategy: "hybrid-rrf-v1" })).toBe("hybrid-rrf-v1");
    expect(withRetrieval({ purposes: { search: { candidateK: 40 } }, strategy: "dense-v1" })).toBe(
      "dense-v1",
    );
  });
});

describe("decodePage", () => {
  test("decodes the dev list page", () => {
    expect(decodePage(decodeSpace)({ items: [DEV_SPACE] })).toEqual({
      items: [DEV_SPACE_VIEW],
    });
    expect(decodePage(decodeSpace)({ items: [], nextCursor: "c2" })).toEqual({
      items: [],
      nextCursor: "c2",
    });
  });

  test("fails the whole page when one item is outside the view", () => {
    expect(decodePage(decodeSpace)({ items: [DEV_SPACE, DEV_GRANT] })).toBeUndefined();
    expect(decodePage(decodeSpace)({ data: [DEV_SPACE] })).toBeUndefined();
  });
});

const PENDING_VIEW: Memory = {
  body: { kind: "inline", text: "The QA team ships on Thursdays." },
  createdAt: "2026-10-09T06:00:00.000Z",
  entityKeys: ["team:qa"],
  id: "01M4FM00000000000000000001",
  importance: 0.5,
  memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G600K",
  memoryType: "fact",
  reviewStatus: "pending",
  scope: "organization",
  sensitivity: "internal",
  source: "api",
  status: "active",
  updatedAt: "2026-10-09T06:00:00.000Z",
  version: 0,
};

describe("content fixtures", () => {
  test("are records the platform itself would accept", () => {
    const accepted = (schema: Schema.Top, value: unknown) =>
      Option.isSome(Schema.decodeUnknownOption(schema as Schema.Codec<unknown>)(value));
    expect(
      [PENDING_MEMORY, APPROVED_MEMORY, ARCHIVED_STORED_MEMORY, DELETED_MEMORY].map((record) =>
        accepted(MemoryRecord, record),
      ),
    ).toEqual([true, true, true, true]);
    expect(accepted(MemoryReviewItemRecord, OPEN_REVIEW_ITEM)).toBe(true);
    expect(accepted(MemoryRecallAttemptRecord, RECALL_ATTEMPT)).toBe(true);
    expect(
      [RETRIEVAL, RATED_RETRIEVAL].map((record) => accepted(MemoryRetrievalRecord, record)),
    ).toEqual([true, true]);
    expect(
      accepted(MemoryRecord, {
        ...PENDING_MEMORY,
        data: { ...PENDING_MEMORY.data, status: "paused" },
      }),
    ).toBe(false);
  });
});

describe("decodeMemory", () => {
  test("reads an inline body", () => {
    expect(decodeMemory(PENDING_MEMORY)).toEqual(PENDING_VIEW);
  });

  test("keeps only the size of a separately stored body", () => {
    expect(decodeMemory(ARCHIVED_STORED_MEMORY)).toEqual({
      body: { byteSize: 48_213, kind: "stored" },
      createdAt: "2026-10-09T06:00:00.000Z",
      entityKeys: [],
      id: "01M4FM00000000000000000001",
      memorySpaceId: "01ARZ3NDEKTSV4RRFFQ69G600K",
      reviewStatus: "approved",
      scope: "organization",
      sensitivity: "internal",
      source: "api",
      status: "archived",
      updatedAt: "2026-10-09T07:00:00.000Z",
      version: 2,
    });
  });

  test("reads a tombstone without a body", () => {
    expect(decodeMemory(DELETED_MEMORY)).toMatchObject({ status: "deleted", version: 3 });
    expect(decodeMemory(DELETED_MEMORY)).not.toHaveProperty("body");
  });

  test("refuses a live memory with no body and another record type", () => {
    const { body: _body, ...bodiless } = PENDING_MEMORY.data;
    expect(decodeMemory({ ...PENDING_MEMORY, data: bodiless })).toBeUndefined();
    expect(decodeMemory(OPEN_REVIEW_ITEM)).toBeUndefined();
    expect(decodeMemory(PENDING_MEMORY)).toBeDefined();
  });
});

describe("decodeExportedMemory", () => {
  test("keeps the exported record's data as the platform wrote it", () => {
    expect(decodeExportedMemory(PENDING_MEMORY)).toEqual(PENDING_MEMORY.data);
    expect(decodeExportedMemory(OPEN_REVIEW_ITEM)).toBeUndefined();
  });
});

describe("decodeReviewItem and decodeResolution", () => {
  const reviewView: MemoryReviewItem = {
    createdAt: "2026-10-09T06:00:00.000Z",
    id: "01M4FM00000000000000000002",
    kind: "content-governance",
    memoryId: "01M4FM00000000000000000001",
    reason: "Generated workspace or organization memory requires human review before recall.",
    status: "open",
    updatedAt: "2026-10-09T06:00:00.000Z",
    version: 0,
  };

  test("reads the review item record", () => {
    expect(decodeReviewItem(OPEN_REVIEW_ITEM)).toEqual(reviewView);
  });

  test("reads a resolution's memory and review together", () => {
    expect(decodeResolution({ memory: PENDING_MEMORY, review: OPEN_REVIEW_ITEM })).toEqual({
      memory: PENDING_VIEW,
      review: reviewView,
    });
    expect(decodeResolution({ memory: PENDING_MEMORY })).toBeUndefined();
  });
});

describe("decodeSearch", () => {
  test("joins each hit to its retrieval for feedback", () => {
    expect(decodeSearch(SEARCH_RESPONSE)).toEqual({
      attemptId: "01M4FM00000000000000000003",
      hits: [
        {
          memory: { ...PENDING_VIEW, reviewStatus: "approved", version: 1 },
          rank: 1,
          retrievalId: "01M4FM00000000000000000004",
          score: 0.82,
        },
      ],
      strategy: "hybrid-rrf-v1",
    });
  });

  test("leaves the retrieval unset when the platform persisted none", () => {
    expect(
      decodeSearch({ ...SEARCH_RESPONSE, retrievals: [] })?.hits[0]?.retrievalId,
    ).toBeUndefined();
    expect(decodeSearch(SEARCH_RESPONSE)?.hits[0]?.retrievalId).toBe("01M4FM00000000000000000004");
  });
});

describe("decodeFeedback, decodeImport, decodeQuality", () => {
  test("reads the rated retrieval", () => {
    expect(decodeFeedback(RATED_RETRIEVAL)).toEqual({
      retrievalId: "01M4FM00000000000000000004",
      usefulness: "useful",
    });
    expect(decodeFeedback(RETRIEVAL)).toBeUndefined();
  });

  test("counts an import's outcomes and keeps each rejection", () => {
    expect(
      decodeImport({
        imported: [PENDING_MEMORY],
        rejected: [{ index: 1, reason: "Memory content contains a secret." }],
        replayed: [],
      }),
    ).toEqual({
      imported: 1,
      rejected: [{ index: 1, reason: "Memory content contains a secret." }],
      replayed: 0,
    });
  });

  test("reads the dev quality report", () => {
    expect(decodeQuality(DEV_QUALITY)).toEqual({
      attempts: 1,
      canonicalDropRate: 0,
      completed: 0,
      duplicateRate: 0,
      failed: 1,
      latencyMs: { p50: 80, p95: 80, p99: 80, samples: 1 },
      retrievals: 0,
      sampleLimit: 1000,
      strategies: [{ attempts: 1, completed: 0, failed: 1, strategy: "dense-v1" }],
      usefulness: { harmful: 0, neutral: 0, unreviewed: 0, useful: 0 },
    });
  });
});
