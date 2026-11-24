export function requireCompleteOpenSearchDelete(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("OpenSearch erasure returned an invalid response.");
  }
  const result = value as Readonly<Record<string, unknown>>;
  if (
    result.timed_out === true ||
    (typeof result.version_conflicts === "number" && result.version_conflicts !== 0) ||
    (Array.isArray(result.failures) && result.failures.length > 0)
  ) {
    throw new Error("OpenSearch erasure was partial and must be retried.");
  }
}

export function requireCompleteOpenSearchSearch(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("OpenSearch returned an invalid search response.");
  }
  const response = value as Readonly<Record<string, unknown>>;
  const shards = response._shards;
  if (
    response.timed_out === true ||
    !shards ||
    typeof shards !== "object" ||
    (shards as Readonly<Record<string, unknown>>).failed !== 0
  ) {
    throw new Error("OpenSearch returned a timed-out or partial search result.");
  }
}

export function requireOpenSearchOrganizationAbsent(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("OpenSearch absence check failed.");
  const response = value as Readonly<Record<string, unknown>>;
  const shards = response._shards as Readonly<Record<string, unknown>> | undefined;
  if (
    response.timed_out === true ||
    !shards ||
    shards.failed !== 0 ||
    (Array.isArray(shards.failures) && shards.failures.length > 0)
  ) {
    throw new Error("OpenSearch absence check was partial and must be retried.");
  }
  const hits = response.hits;
  const total =
    hits && typeof hits === "object"
      ? (hits as Readonly<Record<string, unknown>>).total
      : undefined;
  const count =
    typeof total === "number"
      ? total
      : total && typeof total === "object"
        ? (total as Readonly<Record<string, unknown>>).value
        : undefined;
  if (count !== 0) throw new Error("OpenSearch still contains organization documents.");
}

export function requireOpenSearchMaintenanceComplete(value: unknown, operation: string) {
  if (!value || typeof value !== "object") {
    throw new Error(`OpenSearch ${operation} returned an invalid response.`);
  }
  const shards = (value as Readonly<Record<string, unknown>>)._shards;
  if (
    !shards ||
    typeof shards !== "object" ||
    (shards as Readonly<Record<string, unknown>>).failed !== 0
  ) {
    throw new Error(`OpenSearch ${operation} was partial and must be retried.`);
  }
}

export function requireOpenSearchStorageReclaimed(value: unknown, indexName: string) {
  if (!value || typeof value !== "object") {
    throw new Error("OpenSearch storage reclamation evidence is invalid.");
  }
  const response = value as Readonly<Record<string, unknown>>;
  const shards = response._shards;
  const indices = response.indices;
  const index =
    indices && typeof indices === "object"
      ? (indices as Readonly<Record<string, unknown>>)[indexName]
      : undefined;
  const indexRecord = index && typeof index === "object" ? index : undefined;
  const copies = indexRecord
    ? ["primaries", "total"].map((name) => (indexRecord as Readonly<Record<string, unknown>>)[name])
    : [];
  if (
    !shards ||
    typeof shards !== "object" ||
    (shards as Readonly<Record<string, unknown>>).failed !== 0 ||
    copies.length !== 2 ||
    copies.some((copy) => {
      if (!copy || typeof copy !== "object") return true;
      const translog = (copy as Readonly<Record<string, unknown>>).translog;
      return (
        !translog ||
        typeof translog !== "object" ||
        (translog as Readonly<Record<string, unknown>>).operations !== 0 ||
        (translog as Readonly<Record<string, unknown>>).uncommitted_operations !== 0
      );
    })
  ) {
    throw new Error("OpenSearch did not prove a flushed, trimmed translog state.");
  }
}

export function requireOpenSearchDeletedDocumentsExpunged(value: unknown, indexName: string) {
  if (!value || typeof value !== "object") {
    throw new Error("OpenSearch segment evidence is invalid.");
  }
  const response = value as Readonly<Record<string, unknown>>;
  const shardSummary = response._shards as Readonly<Record<string, unknown>> | undefined;
  const total = shardSummary?.total;
  const successful = shardSummary?.successful;
  if (
    !shardSummary ||
    !Number.isSafeInteger(total) ||
    (total as number) <= 0 ||
    successful !== total ||
    shardSummary.failed !== 0 ||
    (typeof shardSummary.skipped === "number" && shardSummary.skipped !== 0) ||
    (Array.isArray(shardSummary.failures) && shardSummary.failures.length > 0)
  ) {
    throw new Error("OpenSearch segment evidence was partial and must be retried.");
  }
  const indices = response.indices;
  const index =
    indices && typeof indices === "object"
      ? (indices as Readonly<Record<string, unknown>>)[indexName]
      : undefined;
  const shards =
    index && typeof index === "object"
      ? (index as Readonly<Record<string, unknown>>).shards
      : undefined;
  const copies =
    shards && typeof shards === "object"
      ? Object.values(shards as Readonly<Record<string, unknown>>).flatMap((value) =>
          Array.isArray(value) ? value : [],
        )
      : [];
  if (
    copies.length === 0 ||
    copies.some((copy) => {
      if (!copy || typeof copy !== "object") return true;
      const segments = (copy as Readonly<Record<string, unknown>>).segments;
      return (
        !segments ||
        typeof segments !== "object" ||
        Object.values(segments as Readonly<Record<string, unknown>>).some(
          (segment) =>
            !segment ||
            typeof segment !== "object" ||
            (segment as Readonly<Record<string, unknown>>).deleted_docs !== 0,
        )
      );
    })
  ) {
    throw new Error("OpenSearch still has deleted documents in live Lucene segments.");
  }
}

/**
 * Amazon OpenSearch Service lists its own hourly snapshot repository (`cs-automated`, or
 * `cs-automated-enc` when data is encrypted at rest). Purged data ages out of it by the backup
 * boundary the purge reports; any other repository holds copies the platform cannot track.
 */
const SERVICE_AUTOMATED_SNAPSHOT_REPOSITORIES: Readonly<Record<string, true>> = {
  "cs-automated": true,
  "cs-automated-enc": true,
};

export function requireNoOpenSearchSnapshotRepositories(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenSearch snapshot repository inventory is invalid.");
  }
  const untracked = Object.keys(value).filter(
    (repository) => SERVICE_AUTOMATED_SNAPSHOT_REPOSITORIES[repository] !== true,
  );
  if (untracked.length !== 0) {
    throw new Error("OpenSearch has an untracked snapshot repository; erasure remains pending.");
  }
}

function openSearchErrorType(error: Readonly<Record<string, unknown>>) {
  const details = error.details;
  const detailError =
    details && typeof details === "object"
      ? (details as Readonly<Record<string, unknown>>).error
      : undefined;
  return detailError !== null && typeof detailError === "object"
    ? (detailError as Readonly<Record<string, unknown>>).type
    : undefined;
}

export function isOpenSearchIndexAlreadyExists(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as Readonly<Record<string, unknown>>;
  return error.status === 400 && openSearchErrorType(error) === "resource_already_exists_exception";
}

export function isOpenSearchIndexNotFound(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as Readonly<Record<string, unknown>>;
  return error.status === 404 && openSearchErrorType(error) === "index_not_found_exception";
}

export function isMissingOpenSearchIndex(cause: unknown) {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as Readonly<Record<string, unknown>>;
  const metadata = error.$metadata;
  const metadataStatus =
    metadata && typeof metadata === "object"
      ? (metadata as Readonly<Record<string, unknown>>).httpStatusCode
      : undefined;
  return error.status === 404 || metadataStatus === 404;
}

export const AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION = 3;

export function awsNativeOpenSearchIndexDefinition(embeddingDimensions: number) {
  if (!Number.isSafeInteger(embeddingDimensions) || embeddingDimensions <= 0) {
    throw new TypeError("OpenSearch embedding dimensions must be a positive integer.");
  }
  return {
    mappings: {
      _routing: { required: true },
      dynamic: "strict",
      properties: {
        content: {
          analyzer: "standard",
          fields: {
            english: { analyzer: "english", type: "text" },
            shingles: { analyzer: "memory_shingle", type: "text" },
          },
          type: "text",
        },
        contentHash: { type: "keyword" },
        embedding: {
          dimension: embeddingDimensions,
          method: {
            engine: "lucene",
            name: "hnsw",
            parameters: { ef_construction: 256, m: 16 },
            space_type: "cosinesimil",
          },
          type: "knn_vector",
        },
        embeddingModel: { index: false, type: "keyword" },
        embeddingProvider: { index: false, type: "keyword" },
        entityKeys: { type: "keyword" },
        evidenceOperationId: { type: "keyword" },
        evidenceTargetId: { type: "keyword" },
        environmentId: { type: "keyword" },
        importance: { type: "float" },
        memorySpaceId: { type: "keyword" },
        memoryType: { type: "keyword" },
        memoryVersion: { type: "long" },
        mutationPriority: { type: "integer" },
        organizationId: { type: "keyword" },
        projectId: { type: "keyword" },
        projectionClass: { type: "keyword" },
        retentionExpiresAtMs: { format: "epoch_millis", type: "date" },
        reviewStatus: { type: "keyword" },
        scopeKey: { type: "keyword" },
        searchKey: { type: "keyword" },
        sensitivity: { type: "keyword" },
        sourceQuality: { type: "float" },
        status: { type: "keyword" },
        synchronizationGeneration: { type: "long" },
        updatedAt: { type: "date" },
        validFromMs: { format: "epoch_millis", type: "date" },
        validUntilMs: { format: "epoch_millis", type: "date" },
      },
    },
    settings: {
      index: {
        analysis: {
          analyzer: {
            memory_shingle: {
              filter: ["lowercase", "memory_shingle_filter"],
              tokenizer: "standard",
              type: "custom",
            },
          },
          filter: {
            memory_shingle_filter: {
              max_shingle_size: 3,
              min_shingle_size: 2,
              output_unigrams: true,
              type: "shingle",
            },
          },
        },
        auto_expand_replicas: "0-1",
        knn: true,
        number_of_replicas: 1,
        number_of_shards: 1,
      },
    },
  } as const;
}

export const AWS_NATIVE_OPEN_SEARCH_DYNAMIC_INDEX_SETTINGS = {
  index: { auto_expand_replicas: "0-1" },
} as const;

function requiredSubsetMatches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "boolean" || typeof expected === "number") {
    return String(actual) === String(expected);
  }
  if (typeof expected !== "object" || expected === null) return actual === expected;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => requiredSubsetMatches(actual[index], value))
    );
  }
  if (!actual || typeof actual !== "object") return false;
  const record = actual as Readonly<Record<string, unknown>>;
  return Object.entries(expected as Readonly<Record<string, unknown>>).every(([name, value]) =>
    requiredSubsetMatches(record[name], value),
  );
}

export function requireOpenSearchIndexStructureReady(value: unknown, embeddingDimensions: number) {
  if (!value || typeof value !== "object") throw new Error("OpenSearch index is unavailable.");
  const index = Object.values(value as Readonly<Record<string, unknown>>)[0];
  if (!index || typeof index !== "object") throw new Error("OpenSearch index is unavailable.");
  const definition = index as Readonly<Record<string, unknown>>;
  const mapping =
    definition.mappings && typeof definition.mappings === "object"
      ? (definition.mappings as Readonly<Record<string, unknown>>)
      : undefined;
  const fields =
    mapping?.properties && typeof mapping.properties === "object"
      ? (mapping.properties as Readonly<Record<string, unknown>>)
      : undefined;
  const expectedDefinition = awsNativeOpenSearchIndexDefinition(embeddingDimensions);
  const requiredFields = expectedDefinition.mappings.properties;
  const fieldsReady =
    fields &&
    Object.keys(fields).length === Object.keys(requiredFields).length &&
    Object.entries(requiredFields).every(([name, expected]) =>
      requiredSubsetMatches(fields[name], expected),
    );
  const routing = mapping?._routing;
  const routingRequired =
    routing &&
    typeof routing === "object" &&
    (routing as Readonly<Record<string, unknown>>).required === true;
  const settings =
    definition.settings && typeof definition.settings === "object"
      ? (definition.settings as Readonly<Record<string, unknown>>).index
      : undefined;
  const configured =
    settings && typeof settings === "object"
      ? (settings as Readonly<Record<string, unknown>>)
      : undefined;
  const incompatibilities = [
    ...(!fieldsReady ? ["mappings.properties"] : []),
    ...(mapping?.dynamic !== expectedDefinition.mappings.dynamic ? ["mappings.dynamic"] : []),
    ...(!routingRequired ? ["mappings._routing.required"] : []),
    ...(String(configured?.number_of_shards) !== "1" ? ["settings.number_of_shards"] : []),
    ...(String(configured?.knn) !== "true" ? ["settings.knn"] : []),
    ...(!requiredSubsetMatches(configured?.analysis, expectedDefinition.settings.index.analysis)
      ? ["settings.analysis"]
      : []),
  ];
  if (incompatibilities.length > 0) {
    throw new Error(`OpenSearch index is incompatible (${incompatibilities.join(", ")}).`);
  }
  return configured as Readonly<Record<string, unknown>>;
}

export function openSearchReplicaSettingsReady(value: unknown, embeddingDimensions = 1_536) {
  const configured = requireOpenSearchIndexStructureReady(value, embeddingDimensions);
  const replicaCount = String(configured.number_of_replicas);
  return (
    configured.auto_expand_replicas === "0-1" && (replicaCount === "0" || replicaCount === "1")
  );
}

export function requireOpenSearchIndexReady(value: unknown, embeddingDimensions = 1_536) {
  if (!openSearchReplicaSettingsReady(value, embeddingDimensions)) {
    throw new Error("OpenSearch index mapping, routing, or settings are incompatible.");
  }
}
