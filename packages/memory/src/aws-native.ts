import { memoryContentMatchesHash, memoryRecallBlockedReason } from "./governance.ts";
import {
  AwsNativeMemoryError,
  type AwsNativeMemoryConfig,
  type OpenSearchTransport,
} from "./aws-native-contracts.ts";
export * from "./aws-native-contracts.ts";
import type {
  MemorySearchEvidenceBinding,
  MemorySearchExactQueryInput,
  MemorySearchLexicalQueryInput,
  MemorySearchProviderClient,
  MemorySearchQueryInput,
  MemorySearchTarget,
  MemorySearchWriteInput,
} from "./provider.ts";
import type { CanonicalMemoryRecord } from "./memory-record.ts";
import {
  AWS_NATIVE_OPEN_SEARCH_DYNAMIC_INDEX_SETTINGS,
  AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
  awsNativeOpenSearchIndexDefinition,
  isMissingOpenSearchIndex,
  isOpenSearchIndexAlreadyExists,
  requireOpenSearchIndexReady,
  requireOpenSearchIndexStructureReady,
} from "./aws-native-erasure.ts";
export {
  AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
  isMissingOpenSearchIndex,
} from "./aws-native-erasure.ts";
import { reconcileOpenSearchReplicaSettings } from "./aws-native-readiness.ts";
import { deleteAwsNativeEvidence } from "./aws-native-evidence.ts";
import { awsNativeFailure, awsNativeRequest } from "./aws-native-errors.ts";
import { awsNativeMetadata } from "./aws-native-metadata.ts";
import { dropMemoryOrganizationIndex } from "./aws-native-index-drop.ts";
import { purgeAwsNativeOrganization } from "./aws-native-purge.ts";
import {
  queryAwsNativeDense,
  queryAwsNativeDenseExact,
  queryAwsNativeExact,
  queryAwsNativeLexical,
} from "./aws-native-query.ts";
import { validateAwsNativeEmbedding } from "./aws-native-validation.ts";

const MAX_QUERY_LIMIT = 100;
const NORMAL_DENSE_CANDIDATE_PAGE_SIZE = 30;
type EvidenceInput<Input> = Input & {
  readonly evidence?: MemorySearchEvidenceBinding;
};

const SYNCHRONIZATION_SCRIPT = {
  lang: "painless",
  source: `
    if (ctx._source == null ||
        params.memoryVersion > ctx._source.memoryVersion ||
        (params.memoryVersion == ctx._source.memoryVersion &&
         (params.synchronizationGeneration > ctx._source.synchronizationGeneration ||
          (params.synchronizationGeneration == ctx._source.synchronizationGeneration &&
           params.mutationPriority >= ctx._source.mutationPriority)))) {
      ctx._source = params.document;
    } else { ctx.op = 'none'; }
  `,
} as const;

function openSearchMutationApplied(value: unknown) {
  const result =
    value && typeof value === "object" && "result" in value
      ? (value as Readonly<Record<string, unknown>>).result
      : undefined;
  if (result === "noop" || result === "none") return false;
  if (result === "created" || result === "updated") return true;
  throw new AwsNativeMemoryError({
    cause: value,
    message: "OpenSearch returned an invalid memory mutation result.",
    operation: "synchronize-open-search",
  });
}

function openSearchDocument(
  memory: CanonicalMemoryRecord,
  synchronizationGeneration: number,
  mutationPriority: 0 | 1,
  content: string,
  embedding: readonly number[] | undefined,
  embeddingModel: string,
  embeddingProvider: string,
  evidence?: MemorySearchEvidenceBinding,
) {
  return {
    ...awsNativeMetadata(
      memory,
      synchronizationGeneration,
      mutationPriority,
      embeddingModel,
      embeddingProvider,
      evidence,
    ),
    content,
    ...(embedding ? { embedding: [...embedding] } : {}),
    importance: memory.data.importance ?? 0.5,
    memoryType: memory.data.memoryType ?? "fact",
    sourceQuality: memory.data.sourceQuality ?? 0.5,
    updatedAt: memory.data.updatedAt,
  };
}

export function makeAwsNativeMemoryProvider(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly now?: () => Date;
  readonly openSearch: OpenSearchTransport;
  readonly target: MemorySearchTarget;
}): MemorySearchProviderClient {
  const { config, openSearch, target } = args;
  const now = args.now ?? (() => new Date());
  if (target.providerId !== "aws-native") {
    throw new TypeError("AWS-native memory provider requires an aws-native target.");
  }
  const requireServingSchemaGeneration = () => {
    if (target.schemaGeneration !== AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION) {
      throw new AwsNativeMemoryError({
        cause: {
          actual: target.schemaGeneration,
          expected: AWS_NATIVE_OPEN_SEARCH_SCHEMA_VERSION,
        },
        message: "AWS-native memory target schema generation is not supported for serving.",
        operation: "validate-target-schema-generation",
      });
    }
  };
  const requireEvidenceTarget = (evidence: MemorySearchEvidenceBinding) => {
    if (evidence.targetId !== target.targetId) {
      throw new TypeError("Synthetic evidence is not bound to this AWS-native target.");
    }
  };

  async function putOpenSearch(
    memory: CanonicalMemoryRecord,
    synchronizationGeneration: number,
    mutationPriority: 0 | 1,
    content: string,
    embedding: readonly number[] | undefined,
    embeddingModel: string,
    embeddingProvider: string,
    evidence?: MemorySearchEvidenceBinding,
    metadataOverrides?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) {
    const document = {
      ...openSearchDocument(
        memory,
        synchronizationGeneration,
        mutationPriority,
        content,
        embedding,
        embeddingModel,
        embeddingProvider,
        evidence,
      ),
      ...metadataOverrides,
    };
    const response = await awsNativeRequest("synchronize-open-search", () =>
      openSearch.request({
        body: {
          scripted_upsert: true,
          script: {
            ...SYNCHRONIZATION_SCRIPT,
            params: {
              document,
              memoryVersion: memory.data.version,
              mutationPriority,
              synchronizationGeneration,
            },
          },
          upsert: document,
        },
        method: "POST",
        path: `/${encodeURIComponent(config.openSearchIndex)}/_update/${encodeURIComponent(memory.data.id)}?refresh=wait_for&routing=${encodeURIComponent(memory.data.organizationId)}`,
        ...(signal ? { signal } : {}),
      }),
    );
    return openSearchMutationApplied(response);
  }

  async function tombstone(
    memory: CanonicalMemoryRecord,
    synchronizationGeneration: number,
    evidence?: MemorySearchEvidenceBinding,
    signal?: AbortSignal,
  ) {
    requireServingSchemaGeneration();
    const applied = await putOpenSearch(
      memory,
      synchronizationGeneration,
      1,
      "",
      undefined,
      "tombstone",
      "internal",
      evidence,
      { reviewStatus: "pending", status: "deleted" },
      signal,
    );
    if (!applied) return { status: "not-applied" as const };
    return { status: "synchronized" as const };
  }

  async function queryDense(input: EvidenceInput<MemorySearchQueryInput>, exact: boolean) {
    requireServingSchemaGeneration();
    validateAwsNativeEmbedding(config, input.embedding);
    if (!Number.isSafeInteger(input.topK) || input.topK < 1 || input.topK > MAX_QUERY_LIMIT) {
      throw new RangeError(`AWS-native dense queries accept at most ${MAX_QUERY_LIMIT} results.`);
    }
    if (
      input.allowedScopeKeys.length === 0 ||
      input.memorySpaceIds.length === 0 ||
      input.searchKeys.length === 0 ||
      (!input.authorizationGroups?.length && input.allowedSensitivities.length === 0)
    ) {
      return [];
    }
    return exact
      ? queryAwsNativeDenseExact({ config, input, openSearch })
      : queryAwsNativeDense({ config, input, openSearch });
  }

  return {
    capabilities: {
      dense: true,
      densePageSize: NORMAL_DENSE_CANDIDATE_PAGE_SIZE,
      denseResultLimit: MAX_QUERY_LIMIT,
      exact: true,
      lexical: true,
      purgeOrganization: true,
    },
    delete: (input) =>
      tombstone(input.memory, input.synchronizationGeneration, undefined, input.signal),
    dropOrganizationIndex: (input) =>
      dropMemoryOrganizationIndex({ index: config.openSearchIndex, openSearch, ...input }),
    providerId: "aws-native",
    async prepare(input) {
      requireServingSchemaGeneration();
      try {
        await openSearch.request({
          body: awsNativeOpenSearchIndexDefinition(config.embeddingDimensions),
          method: "PUT",
          path: `/${encodeURIComponent(config.openSearchIndex)}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (cause) {
        if (!isOpenSearchIndexAlreadyExists(cause)) {
          throw awsNativeFailure("prepare-open-search-index", cause);
        }
        const existing = await awsNativeRequest("read-open-search-index-for-v3-upgrade", () =>
          openSearch.request({
            method: "GET",
            path: `/${encodeURIComponent(config.openSearchIndex)}`,
            ...(input.signal ? { signal: input.signal } : {}),
          }),
        );
        try {
          requireOpenSearchIndexStructureReady(existing, config.embeddingDimensions);
        } catch (cause) {
          throw awsNativeFailure("validate-existing-open-search-index", cause);
        }
      }
      await awsNativeRequest("prepare-open-search-replicas", () =>
        openSearch.request({
          body: AWS_NATIVE_OPEN_SEARCH_DYNAMIC_INDEX_SETTINGS,
          method: "PUT",
          path: `/${encodeURIComponent(config.openSearchIndex)}/_settings`,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      return this.readiness!(input);
    },
    async purgeOrganization(input) {
      return purgeAwsNativeOrganization({ config, input, now, openSearch });
    },
    query: (input) => queryDense(input, false),
    queryDenseAnn: (input) => queryDense(input, false),
    queryDenseExact: (input) => queryDense(input, true),
    async queryExact(input: EvidenceInput<MemorySearchExactQueryInput>) {
      requireServingSchemaGeneration();
      return queryAwsNativeExact({ config, input, openSearch });
    },
    async queryLexical(input: EvidenceInput<MemorySearchLexicalQueryInput>) {
      requireServingSchemaGeneration();
      return queryAwsNativeLexical({ config, input, openSearch });
    },
    async readiness(input) {
      requireServingSchemaGeneration();
      let index: unknown;
      try {
        index = await openSearch.request({
          method: "GET",
          path: `/${encodeURIComponent(config.openSearchIndex)}`,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (cause) {
        if (!isMissingOpenSearchIndex(cause)) {
          throw awsNativeFailure("read-open-search-readiness", cause);
        }
        return {
          denseReady: false,
          lexicalReady: false,
          ready: false,
          reference: config.openSearchIndex,
          schemaReady: false,
        };
      }
      try {
        index = await reconcileOpenSearchReplicaSettings({
          embeddingDimensions: config.embeddingDimensions,
          index,
          indexName: config.openSearchIndex,
          openSearch,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        requireOpenSearchIndexReady(index, config.embeddingDimensions);
      } catch (cause) {
        throw awsNativeFailure("validate-open-search-readiness", cause);
      }
      return {
        denseReady: true,
        lexicalReady: true,
        ready: true,
        reference: config.openSearchIndex,
        schemaReady: true,
      };
    },
    reference: () => config.openSearchIndex,
    synchronizeLifecycle: (input) =>
      tombstone(input.memory, input.synchronizationGeneration, undefined, input.signal),
    target,
    async write(input: EvidenceInput<MemorySearchWriteInput>) {
      requireServingSchemaGeneration();
      validateAwsNativeEmbedding(config, input.embedding);
      if (
        memoryRecallBlockedReason(input.memory.data, input.content) ||
        !memoryContentMatchesHash(input.content, input.memory.data.contentHash) ||
        input.embeddingContentHash !== input.memory.data.contentHash
      ) {
        throw new AwsNativeMemoryError({
          cause: "content-governance-or-hash-mismatch",
          message: "AWS-native memory content failed governance or canonical hash validation.",
          operation: "validate-content",
        });
      }
      const applied = await putOpenSearch(
        input.memory,
        input.synchronizationGeneration,
        0,
        input.content,
        input.embedding,
        input.embeddingModel,
        input.embeddingProvider,
        input.evidence,
        undefined,
        input.signal,
      );
      if (!applied) return { status: "not-applied" as const };
      return { status: "written" as const };
    },

    async deleteEvidence(input) {
      requireEvidenceTarget(input.evidence);
      return deleteAwsNativeEvidence({
        config,
        memory: input.memory,
        openSearch,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },

    queryEvidence(input) {
      requireEvidenceTarget(input.evidence);
      return this.query(input);
    },

    queryEvidenceExact(input) {
      requireEvidenceTarget(input.evidence);
      return this.queryExact!(input);
    },

    queryEvidenceLexical(input) {
      requireEvidenceTarget(input.evidence);
      return this.queryLexical!(input);
    },

    writeEvidence(input) {
      requireEvidenceTarget(input.evidence);
      return this.write(input);
    },
  };
}
