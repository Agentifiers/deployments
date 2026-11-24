import type {
  BrainIndexChunk,
  BrainSearchComponentKind,
  BrainSearchProviderClient,
  BrainSearchProviderHit,
  BrainSearchTarget,
} from "./search-provider.ts";
import {
  dropBrainIndex,
  isBrainIndexNotFound,
  isBrainOrganizationIndex,
} from "./organization-index.ts";
import { mergeBrainSearchRanks } from "./search-ranking.ts";

export interface BrainOpenSearchTransport {
  request(input: {
    readonly body?: unknown;
    readonly contentType?: "application/json" | "application/x-ndjson";
    readonly method: "DELETE" | "GET" | "POST" | "PUT";
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface AwsNativeBrainSearchConfig {
  readonly embeddingDimensions: number;
  readonly openSearchIndex: string;
}

const OPEN_SEARCH_QUERY_LIMIT = 100;
const SEARCH_COMPONENTS = ["dense", "lexical", "exact", "entity"] as const;
const SEARCH_SOURCE_FIELDS = [
  "brainId",
  "coordinatesEnd",
  "coordinatesKind",
  "coordinatesStart",
  "contentHash",
  "documentId",
  "documentVersionId",
  "organizationId",
  "projectionGeneration",
  "renditionId",
  "reviewStatus",
  "schemaGeneration",
  "sensitivity",
  "sourceId",
] as const;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function requireCompleteSearch(value: unknown) {
  const response = record(value);
  const shards = record(response._shards);
  if (
    response.timed_out === true ||
    shards.failed !== 0 ||
    (Array.isArray(shards.failures) && shards.failures.length > 0)
  ) {
    throw new Error("AWS-native Brain OpenSearch search was partial or timed out.");
  }
}

function requireCompleteDelete(value: unknown) {
  const response = record(value);
  if (
    response.timed_out === true ||
    (typeof response.version_conflicts === "number" && response.version_conflicts !== 0) ||
    (Array.isArray(response.failures) && response.failures.length > 0)
  ) {
    throw new Error("AWS-native Brain OpenSearch deletion was partial.");
  }
}

function hasCompleteShardAcknowledgement(value: unknown) {
  const shards = record(record(value)._shards);
  return (
    Number.isSafeInteger(shards.total) &&
    (shards.total as number) > 0 &&
    shards.successful === shards.total &&
    shards.failed === 0 &&
    (!Array.isArray(shards.failures) || shards.failures.length === 0)
  );
}

function hitFromMetadata(
  key: string | undefined,
  metadataValue: unknown,
  score: number,
  kind: BrainSearchComponentKind,
): BrainSearchProviderHit | undefined {
  const metadata = record(metadataValue);
  if (
    typeof key !== "string" ||
    typeof metadata.brainId !== "string" ||
    typeof metadata.documentId !== "string" ||
    typeof metadata.documentVersionId !== "string" ||
    typeof metadata.organizationId !== "string" ||
    typeof metadata.renditionId !== "string" ||
    typeof metadata.sourceId !== "string" ||
    typeof metadata.sensitivity !== "string" ||
    typeof metadata.coordinatesKind !== "string" ||
    typeof metadata.coordinatesStart !== "number" ||
    typeof metadata.coordinatesEnd !== "number" ||
    typeof metadata.contentHash !== "string" ||
    typeof metadata.projectionGeneration !== "number" ||
    typeof metadata.reviewStatus !== "string" ||
    typeof metadata.schemaGeneration !== "number"
  ) {
    return undefined;
  }
  return {
    brainId: metadata.brainId,
    chunkId: key,
    coordinates: {
      end: metadata.coordinatesEnd,
      kind: metadata.coordinatesKind as BrainSearchProviderHit["coordinates"]["kind"],
      start: metadata.coordinatesStart,
    },
    ...(kind === "dense"
      ? { denseScore: score }
      : kind === "lexical"
        ? { lexicalScore: score }
        : kind === "exact"
          ? { exactScore: score }
          : { entityScore: score }),
    contentHash: metadata.contentHash,
    documentId: metadata.documentId,
    documentVersionId: metadata.documentVersionId,
    organizationId: metadata.organizationId,
    projectionGeneration: metadata.projectionGeneration,
    renditionId: metadata.renditionId,
    reviewStatus: metadata.reviewStatus as BrainSearchProviderHit["reviewStatus"],
    schemaGeneration: metadata.schemaGeneration,
    sensitivity: metadata.sensitivity as BrainSearchProviderHit["sensitivity"],
    sourceId: metadata.sourceId,
  };
}

function metadata(chunk: BrainIndexChunk) {
  return {
    brainId: chunk.brainId,
    coordinatesEnd: chunk.coordinates.end,
    coordinatesKind: chunk.coordinates.kind,
    coordinatesStart: chunk.coordinates.start,
    contentHash: chunk.contentHash,
    documentId: chunk.documentId,
    documentVersionId: chunk.documentVersionId,
    entityKeys: chunk.entityKeys,
    organizationId: chunk.organizationId,
    projectionGeneration: chunk.projectionGeneration,
    renditionId: chunk.renditionId,
    sensitivity: chunk.sensitivity,
    reviewStatus: chunk.reviewStatus,
    retentionExpiresAtMs: chunk.retentionExpiresAtMs,
    schemaGeneration: chunk.schemaGeneration,
    sourceId: chunk.sourceId,
    status: "active",
  };
}

function authorizationFilters(
  input: Parameters<BrainSearchProviderClient["search"]>[0],
  schemaGeneration: number,
) {
  return [
    { term: { organizationId: input.organizationId } },
    { terms: { brainId: [...new Set(input.authorizedBrainIds)] } },
    { term: { status: "active" } },
    { terms: { reviewStatus: [...new Set(input.allowedReviewStatuses)] } },
    { terms: { sensitivity: [...new Set(input.allowedSensitivities)] } },
    { term: { schemaGeneration } },
    { range: { retentionExpiresAtMs: { gt: input.retentionCutoffMs } } },
  ];
}

function normalizedScore(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function readyComponents() {
  return SEARCH_COMPONENTS.map((kind) => ({ kind, ready: true }));
}

export function makeAwsNativeBrainSearchProvider(args: {
  readonly config: AwsNativeBrainSearchConfig;
  readonly openSearch: BrainOpenSearchTransport;
  readonly target: BrainSearchTarget;
}): BrainSearchProviderClient {
  if (
    !Number.isSafeInteger(args.config.embeddingDimensions) ||
    args.config.embeddingDimensions < 1
  ) {
    throw new TypeError("AWS-native Brain embedding dimensions must be a positive integer.");
  }
  const index = encodeURIComponent(args.config.openSearchIndex);
  const search = async (
    input: Parameters<BrainSearchProviderClient["search"]>[0],
    kind: BrainSearchComponentKind,
  ) => {
    if (input.embedding.length !== args.config.embeddingDimensions) {
      throw new TypeError("AWS-native Brain query embedding dimension mismatch.");
    }
    const size = Math.max(1, Math.min(Math.trunc(input.limit), OPEN_SEARCH_QUERY_LIMIT));
    const filters = authorizationFilters(input, args.target.schemaGeneration);
    const query =
      kind === "dense"
        ? {
            knn: {
              embedding: {
                filter: { bool: { filter: filters } },
                k: size,
                method_parameters: { ef_search: 256 },
                vector: [...input.embedding],
              },
            },
          }
        : {
            bool: {
              filter: filters,
              must: [
                kind === "lexical"
                  ? {
                      multi_match: {
                        fields: ["text^1.5", "text.english^1.25", "text.shingles^2", "title^2"],
                        minimum_should_match: "25%",
                        operator: "or",
                        query: input.query,
                        type: "best_fields",
                      },
                    }
                  : kind === "exact"
                    ? { match_phrase: { text: input.query } }
                    : { match: { entityKeys: input.query.toLowerCase() } },
              ],
            },
          };
    const response = await args.openSearch.request({
      body: { _source: SEARCH_SOURCE_FIELDS, query, size },
      method: "POST",
      path: `/${index}/_search?routing=${encodeURIComponent(input.organizationId)}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    requireCompleteSearch(response);
    const hits = record(record(response).hits).hits;
    if (!Array.isArray(hits)) return [];
    return hits.flatMap((value) => {
      const candidate = record(value);
      const hit = hitFromMetadata(
        typeof candidate._id === "string" ? candidate._id : undefined,
        candidate._source,
        normalizedScore(candidate._score),
        kind,
      );
      return hit ? [hit] : [];
    });
  };

  const purge = async (input: {
    readonly brainId?: string;
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }) => {
    const terms = [
      { term: { organizationId: input.organizationId } },
      ...(input.brainId ? [{ term: { brainId: input.brainId } }] : []),
    ];
    const query = terms.length === 1 ? terms[0] : { bool: { filter: terms } };
    const verifiedAbsence = (deletedDocuments: unknown) => ({
      deleted: true,
      receipt: {
        absenceVerified: true,
        backupBoundary: "no-deployment-owned-opensearch-snapshots",
        ...(input.brainId ? { brainId: input.brainId } : {}),
        deletedDocuments,
        providerId: "aws-native",
        store: "opensearch",
        targetId: args.target.targetId,
      },
    });
    let deletion: unknown;
    try {
      deletion = await args.openSearch.request({
        body: { query },
        method: "POST",
        path: `/${index}/_delete_by_query?conflicts=proceed&refresh=true&routing=${encodeURIComponent(input.organizationId)}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (cause) {
      // An organization purge drops the organization's own index, so a retry finds it gone.
      if (isBrainIndexNotFound(cause)) return verifiedAbsence(0);
      throw cause;
    }
    requireCompleteDelete(deletion);
    const absence = await args.openSearch.request({
      body: { query },
      method: "POST",
      path: `/${index}/_count?routing=${encodeURIComponent(input.organizationId)}`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    requireCompleteSearch(absence);
    if (record(absence).count !== 0) {
      throw new Error("AWS-native Brain OpenSearch absence could not be verified.");
    }
    return verifiedAbsence(record(deletion).deleted ?? 0);
  };

  return {
    capabilities: { components: SEARCH_COMPONENTS, hybrid: true },
    providerId: "aws-native",
    target: args.target,
    async deleteDocument(input) {
      if (input.chunkIds.length === 0) return { deleted: true };
      const result = await args.openSearch.request({
        body: {
          query: {
            bool: {
              filter: [
                { term: { organizationId: input.organizationId } },
                { term: { brainId: input.brainId } },
                { term: { documentId: input.documentId } },
                { ids: { values: input.chunkIds } },
              ],
            },
          },
        },
        method: "POST",
        path: `/${index}/_delete_by_query?conflicts=proceed&refresh=true&routing=${encodeURIComponent(input.organizationId)}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      requireCompleteDelete(result);
      return { deleted: true };
    },
    async inspect(input) {
      const result = await Promise.allSettled([
        args.openSearch.request({
          body: { query: { term: { organizationId: input.organizationId } } },
          method: "POST",
          path: `/${index}/_count?routing=${encodeURIComponent(input.organizationId)}`,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      ]);
      const response = result[0]!;
      let ready = response.status === "fulfilled";
      if (response.status === "fulfilled") {
        try {
          requireCompleteSearch(response.value);
        } catch {
          ready = false;
        }
      }
      const error = response.status === "rejected" ? String(response.reason) : undefined;
      const count = response.status === "fulfilled" ? record(response.value).count : undefined;
      return {
        components: SEARCH_COMPONENTS.map((kind) => ({
          ...(error ? { error } : {}),
          kind,
          ready,
        })),
        ready,
        ...(typeof count === "number" ? { rowCount: count } : {}),
      };
    },
    async prepare(input) {
      await args.openSearch.request({
        body: {
          mappings: {
            _routing: { required: true },
            dynamic: "strict",
            properties: {
              brainId: { type: "keyword" },
              coordinatesEnd: { type: "long" },
              coordinatesKind: { type: "keyword" },
              coordinatesStart: { type: "long" },
              contentHash: { type: "keyword" },
              documentId: { type: "keyword" },
              documentVersionId: { type: "keyword" },
              embedding: {
                dimension: args.config.embeddingDimensions,
                method: {
                  engine: "lucene",
                  name: "hnsw",
                  parameters: { ef_construction: 256, m: 16 },
                  space_type: "cosinesimil",
                },
                type: "knn_vector",
              },
              entityKeys: { type: "keyword" },
              organizationId: { type: "keyword" },
              projectionGeneration: { type: "long" },
              renditionId: { type: "keyword" },
              reviewStatus: { type: "keyword" },
              retentionExpiresAtMs: { format: "epoch_millis", type: "date" },
              schemaGeneration: { type: "long" },
              sensitivity: { type: "keyword" },
              sourceId: { type: "keyword" },
              status: { type: "keyword" },
              text: {
                analyzer: "standard",
                fields: {
                  english: { analyzer: "english", type: "text" },
                  shingles: { analyzer: "brain_shingle", type: "text" },
                },
                type: "text",
              },
              title: { type: "text" },
            },
          },
          settings: {
            index: {
              analysis: {
                analyzer: {
                  brain_shingle: {
                    filter: ["lowercase", "brain_shingle_filter"],
                    tokenizer: "standard",
                    type: "custom",
                  },
                },
                filter: {
                  brain_shingle_filter: {
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
        },
        method: "PUT",
        path: `/${index}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
    async purgeBrain(input) {
      return purge(input);
    },
    async purgeOrganization(input) {
      const purged = await purge(input);
      const ownIndex = args.config.openSearchIndex;
      if (!isBrainOrganizationIndex(input.organizationId, ownIndex)) return purged;
      return {
        ...purged,
        receipt: { ...purged.receipt, indexDrop: await dropBrainIndex(args.openSearch, ownIndex) },
      };
    },
    async search(input) {
      if (input.authorizedBrainIds.length === 0) return [];
      const [denseHits, lexicalHits, exactHits, entityHits] = await Promise.all([
        search(input, "dense"),
        search(input, "lexical"),
        search(input, "exact"),
        search(input, "entity"),
      ]);
      return mergeBrainSearchRanks(denseHits, lexicalHits, input.limit, exactHits, entityHits);
    },
    async upsert(input) {
      for (const chunk of input.chunks) {
        if (chunk.organizationId !== input.organizationId) {
          throw new TypeError("AWS-native Brain chunk tenant mismatch.");
        }
        if (chunk.embedding.length !== args.config.embeddingDimensions) {
          throw new TypeError("AWS-native Brain chunk embedding dimension mismatch.");
        }
      }
      if (input.chunks.length === 0) return { components: readyComponents(), written: 0 };
      const response = record(
        await args.openSearch.request({
          body: `${input.chunks
            .flatMap((chunk) => [
              JSON.stringify({
                index: {
                  _id: chunk.chunkId,
                  routing: chunk.organizationId,
                },
              }),
              JSON.stringify({
                ...metadata(chunk),
                embedding: [...chunk.embedding],
                text: chunk.text,
                title: chunk.title ?? "",
              }),
            ])
            .join("\n")}\n`,
          contentType: "application/x-ndjson",
          method: "POST",
          path: `/${index}/_bulk?refresh=wait_for&wait_for_active_shards=all`,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      const items = response.items;
      if (
        response.errors !== false ||
        !Array.isArray(items) ||
        items.length !== input.chunks.length ||
        items.some((item) => {
          const result = record(record(item).index);
          return (
            typeof result.status !== "number" ||
            result.status < 200 ||
            result.status >= 300 ||
            result.error !== undefined ||
            !hasCompleteShardAcknowledgement(result)
          );
        })
      ) {
        throw new Error("AWS-native Brain OpenSearch bulk indexing was incomplete.");
      }
      return { components: readyComponents(), written: input.chunks.length };
    },
  };
}
