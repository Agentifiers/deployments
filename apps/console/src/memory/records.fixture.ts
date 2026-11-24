export const TENANT = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G600H",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};

const ENV_PK = "ORG#01ARZ3NDEKTSV4RRFFQ69G600C#ENV#01ARZ3NDEKTSV4RRFFQ69G600H";

export const SPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G600K";
export const MEMORY_ID = "01M4FM00000000000000000001";
export const REVIEW_ID = "01M4FM00000000000000000002";
export const ATTEMPT_ID = "01M4FM00000000000000000003";
export const RETRIEVAL_ID = "01M4FM00000000000000000004";

export const PENDING_MEMORY = {
  data: {
    ...TENANT,
    body: "The QA team ships on Thursdays.",
    contentHash: "sha256:3b1f",
    createdAt: "2026-10-09T06:00:00.000Z",
    entityKeys: ["team:qa"],
    id: MEMORY_ID,
    importance: 0.5,
    memorySpaceId: SPACE_ID,
    memoryType: "fact",
    reviewStatus: "pending",
    scope: "organization",
    searchKey: "organization",
    sensitivity: "internal",
    source: "api",
    status: "active",
    updatedAt: "2026-10-09T06:00:00.000Z",
    version: 0,
  },
  gsi2pk: "ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  gsi2sk: `MEMORY#active#2026-10-09T06%3A00%3A00.000Z#${MEMORY_ID}`,
  itemType: "memory",
  pk: ENV_PK,
  sk: `MEMORY#${MEMORY_ID}`,
};

export const ARCHIVED_STORED_MEMORY = {
  ...PENDING_MEMORY,
  data: {
    ...TENANT,
    archivedAt: "2026-10-09T07:00:00.000Z",
    bodyRef: {
      bucket: "memory-bodies",
      byteSize: 48_213,
      contentType: "text/plain",
      key: `memories/${MEMORY_ID}`,
      sha256: "9c1e",
    },
    contentHash: "sha256:3b1f",
    createdAt: "2026-10-09T06:00:00.000Z",
    id: MEMORY_ID,
    memorySpaceId: SPACE_ID,
    reviewStatus: "approved",
    scope: "organization",
    searchKey: "organization",
    sensitivity: "internal",
    source: "api",
    status: "archived",
    updatedAt: "2026-10-09T07:00:00.000Z",
    version: 2,
  },
};

export const DELETED_MEMORY = {
  ...PENDING_MEMORY,
  data: {
    ...TENANT,
    contentHash: "sha256:3b1f",
    createdAt: "2026-10-09T06:00:00.000Z",
    deletedAt: "2026-10-09T08:00:00.000Z",
    id: MEMORY_ID,
    memorySpaceId: SPACE_ID,
    reviewStatus: "approved",
    scope: "organization",
    searchKey: "organization",
    sensitivity: "internal",
    source: "api",
    status: "deleted",
    updatedAt: "2026-10-09T08:00:00.000Z",
    version: 3,
  },
};

export const OPEN_REVIEW_ITEM = {
  data: {
    ...TENANT,
    createdAt: "2026-10-09T06:00:00.000Z",
    id: REVIEW_ID,
    kind: "content-governance",
    memoryId: MEMORY_ID,
    reason: "Generated workspace or organization memory requires human review before recall.",
    status: "open",
    updatedAt: "2026-10-09T06:00:00.000Z",
    version: 0,
  },
  gsi2pk: "ENV#01ARZ3NDEKTSV4RRFFQ69G600H",
  gsi2sk: `MEMORY-REVIEW#open#2026-10-09T06%3A00%3A00.000Z#${REVIEW_ID}`,
  itemType: "memory-review-item",
  pk: `${ENV_PK}#MEMORY#${MEMORY_ID}`,
  sk: `REVIEW#${REVIEW_ID}`,
};

export const RECALL_ATTEMPT = {
  data: {
    ...TENANT,
    candidateCount: 1,
    createdAt: "2026-10-09T09:00:00.000Z",
    id: ATTEMPT_ID,
    injectedCount: 0,
    latencyMs: 80,
    purpose: "search",
    retrievedCount: 1,
    status: "completed",
    strategy: "hybrid-rrf-v1",
    version: 1,
  },
  itemType: "memory-recall-attempt",
  pk: ENV_PK,
  sk: `MEMORY-RECALL#${ATTEMPT_ID}`,
};

export const RETRIEVAL = {
  data: {
    ...TENANT,
    createdAt: "2026-10-09T09:00:00.000Z",
    id: RETRIEVAL_ID,
    injected: false,
    memoryId: MEMORY_ID,
    provider: "aws-native",
    purpose: "search",
    rank: 1,
    recallAttemptId: ATTEMPT_ID,
    reviewStatus: "approved",
    score: 0.82,
    searchKey: "organization",
    sensitivity: "internal",
    version: 0,
  },
  itemType: "memory-retrieval",
  pk: ENV_PK,
  sk: `MEMORY-RETRIEVAL#${RETRIEVAL_ID}`,
};

export const RATED_RETRIEVAL = {
  ...RETRIEVAL,
  data: { ...RETRIEVAL.data, usefulness: "useful", version: 1 },
};

export const APPROVED_MEMORY = {
  ...PENDING_MEMORY,
  data: { ...PENDING_MEMORY.data, reviewStatus: "approved", version: 1 },
};

export const SEARCH_RESPONSE = {
  attempt: RECALL_ATTEMPT,
  results: [{ memory: APPROVED_MEMORY, rank: 1, score: 0.82 }],
  retrievals: [RETRIEVAL],
};

export const DEV_QUALITY = {
  attempts: 1,
  canonicalDropRate: 0,
  completed: 0,
  duplicateRate: 0,
  failed: 1,
  latencyMs: { p50: 80, p95: 80, p99: 80, samples: 1 },
  retrievals: 0,
  sampleLimit: 1000,
  shadow: { attempts: 0, completed: 0, failed: 0, retrievals: 0, strategies: {} },
  strategies: { "dense-v1": { attempts: 1, completed: 0, failed: 1 } },
  usefulness: { harmful: 0, neutral: 0, unreviewed: 0, useful: 0 },
};
