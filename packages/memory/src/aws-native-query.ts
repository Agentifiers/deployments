import type { AwsNativeMemoryConfig, OpenSearchTransport } from "./aws-native-contracts.ts";
import { requireCompleteOpenSearchSearch } from "./aws-native-erasure.ts";
import { awsNativeRequest } from "./aws-native-errors.ts";
import type {
  MemorySearchCandidateRow,
  MemorySearchEvidenceBinding,
  MemorySearchExactQueryInput,
  MemorySearchLexicalQueryInput,
  MemorySearchQueryInput,
} from "./provider.ts";

const OPEN_SEARCH_QUERY_LIMIT = 100;
const OPEN_SEARCH_CANDIDATE_SOURCE_FIELDS = [
  "contentHash",
  "memorySpaceId",
  "memoryVersion",
  "scopeKey",
  "searchKey",
] as const;

type EvidenceInput<Input> = Input & { readonly evidence?: MemorySearchEvidenceBinding };

function openSearchAuthorizationFilters(
  input: MemorySearchQueryInput | MemorySearchLexicalQueryInput | MemorySearchExactQueryInput,
  evidence?: MemorySearchEvidenceBinding,
) {
  const groupFilter = input.authorizationGroups?.length
    ? {
        bool: {
          should: input.authorizationGroups.map((group) => ({
            bool: {
              filter: [
                { terms: { memorySpaceId: [...new Set(group.memorySpaceIds)] } },
                { terms: { sensitivity: [...new Set(group.allowedSensitivities)] } },
              ],
            },
          })),
          minimum_should_match: 1,
        },
      }
    : {
        bool: {
          filter: [
            { terms: { memorySpaceId: [...new Set(input.memorySpaceIds)] } },
            { terms: { sensitivity: [...new Set(input.allowedSensitivities)] } },
          ],
        },
      };
  return [
    { term: { organizationId: input.organizationId } },
    { term: { projectId: input.projectId } },
    { term: { environmentId: input.environmentId } },
    { term: { projectionClass: evidence ? "synthetic-evidence" : "customer" } },
    ...(evidence
      ? [
          { term: { evidenceOperationId: evidence.operationId } },
          { term: { evidenceTargetId: evidence.targetId } },
        ]
      : []),
    { term: { status: "active" } },
    { term: { reviewStatus: "approved" } },
    { range: { retentionExpiresAtMs: { gt: input.now.getTime() } } },
    { range: { validFromMs: { lte: input.now.getTime() } } },
    { range: { validUntilMs: { gt: input.now.getTime() } } },
    groupFilter,
    { terms: { scopeKey: [...new Set(input.allowedScopeKeys)] } },
    { terms: { searchKey: [...new Set(input.searchKeys)] } },
  ];
}

function candidateRow(value: unknown, scoreMode: "dense" | "lexical") {
  if (!value || typeof value !== "object") return undefined;
  const hit = value as Record<string, unknown>;
  const source = hit._source;
  if (!source || typeof source !== "object") return undefined;
  const data = source as Record<string, unknown>;
  if (
    typeof hit._id !== "string" ||
    typeof data.contentHash !== "string" ||
    typeof data.memorySpaceId !== "string" ||
    !Number.isSafeInteger(data.memoryVersion) ||
    typeof data.scopeKey !== "string" ||
    typeof data.searchKey !== "string"
  ) {
    return undefined;
  }
  const score = typeof hit._score === "number" && Number.isFinite(hit._score) ? hit._score : 0;
  return {
    contentHash: data.contentHash,
    dist:
      scoreMode === "dense" ? Math.max(0, Math.min(2, 2 - score)) : 1 / (1 + Math.max(0, score)),
    id: hit._id,
    memorySpaceId: data.memorySpaceId,
    memoryVersion: data.memoryVersion as number,
    scopeKey: data.scopeKey,
    searchKey: data.searchKey,
  } satisfies MemorySearchCandidateRow;
}

function openSearchRows(value: unknown, scoreMode: "dense" | "lexical") {
  if (!value || typeof value !== "object") return [];
  const hits = (value as Record<string, unknown>).hits;
  if (!hits || typeof hits !== "object") return [];
  const rows = (hits as Record<string, unknown>).hits;
  return Array.isArray(rows)
    ? rows.flatMap((value) => {
        const parsed = candidateRow(value, scoreMode);
        return parsed ? [parsed] : [];
      })
    : [];
}

async function queryOpenSearchDense(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly exact: boolean;
  readonly input: EvidenceInput<MemorySearchQueryInput>;
  readonly openSearch: OpenSearchTransport;
}) {
  const size = Math.max(1, Math.min(Math.trunc(args.input.topK), OPEN_SEARCH_QUERY_LIMIT));
  const authorization = {
    bool: { filter: openSearchAuthorizationFilters(args.input, args.input.evidence) },
  };
  const query = args.exact
    ? {
        script_score: {
          query: authorization,
          script: {
            lang: "knn",
            params: {
              field: "embedding",
              query_value: [...args.input.embedding],
              space_type: "cosinesimil",
            },
            source: "knn_score",
          },
        },
      }
    : {
        knn: {
          embedding: {
            filter: authorization,
            k: size,
            method_parameters: { ef_search: 256 },
            vector: [...args.input.embedding],
          },
        },
      };
  const response = await awsNativeRequest(
    args.exact ? "query-open-search-dense-exact" : "query-open-search-dense",
    () =>
      args.openSearch.request({
        body: { _source: OPEN_SEARCH_CANDIDATE_SOURCE_FIELDS, query, size },
        method: "POST",
        path: `/${encodeURIComponent(args.config.openSearchIndex)}/_search?routing=${encodeURIComponent(args.input.organizationId)}`,
        ...(args.input.signal ? { signal: args.input.signal } : {}),
      }),
  );
  requireCompleteOpenSearchSearch(response);
  return openSearchRows(response, "dense");
}

export async function queryAwsNativeDense(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly input: EvidenceInput<MemorySearchQueryInput>;
  readonly openSearch: OpenSearchTransport;
}) {
  const rows = await queryOpenSearchDense({ ...args, exact: false });
  return rows.map((row, index) => ({
    ...row,
    denseSourceCandidateCounts: { "open-search": rows.length },
    denseSourceDistances: row.dist === undefined ? {} : { "open-search": row.dist },
    denseSourceRanks: { "open-search": index + 1 },
  }));
}

export async function queryAwsNativeDenseExact(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly input: EvidenceInput<MemorySearchQueryInput>;
  readonly openSearch: OpenSearchTransport;
}) {
  const rows = await queryOpenSearchDense({ ...args, exact: true });
  return rows.map((row, index) => ({
    ...row,
    denseSourceCandidateCounts: { "open-search": rows.length },
    denseSourceDistances: row.dist === undefined ? {} : { "open-search": row.dist },
    denseSourceRanks: { "open-search": index + 1 },
  }));
}

export async function queryAwsNativeExact(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly input: EvidenceInput<MemorySearchExactQueryInput>;
  readonly openSearch: OpenSearchTransport;
}) {
  const should = [
    ...(args.input.memoryIds?.length
      ? [{ ids: { values: [...new Set(args.input.memoryIds)] } }]
      : []),
    ...(args.input.exactSearchKeys?.length
      ? [{ terms: { searchKey: [...new Set(args.input.exactSearchKeys)] } }]
      : []),
    ...(args.input.entityKeys?.length
      ? [{ terms: { entityKeys: [...new Set(args.input.entityKeys)] } }]
      : []),
  ];
  if (should.length === 0) return [];
  const response = await awsNativeRequest("query-open-search-exact", () =>
    args.openSearch.request({
      body: {
        _source: OPEN_SEARCH_CANDIDATE_SOURCE_FIELDS,
        query: {
          bool: {
            filter: openSearchAuthorizationFilters(args.input, args.input.evidence),
            minimum_should_match: 1,
            should,
          },
        },
        size: Math.max(1, Math.min(Math.trunc(args.input.topK), OPEN_SEARCH_QUERY_LIMIT)),
        sort: [{ updatedAt: "desc" }],
      },
      method: "POST",
      path: `/${encodeURIComponent(args.config.openSearchIndex)}/_search?routing=${encodeURIComponent(args.input.organizationId)}`,
      ...(args.input.signal ? { signal: args.input.signal } : {}),
    }),
  );
  requireCompleteOpenSearchSearch(response);
  return openSearchRows(response, "lexical");
}

export async function queryAwsNativeLexical(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly input: EvidenceInput<MemorySearchLexicalQueryInput>;
  readonly openSearch: OpenSearchTransport;
}) {
  const response = await awsNativeRequest("query-open-search-lexical", () =>
    args.openSearch.request({
      body: {
        _source: OPEN_SEARCH_CANDIDATE_SOURCE_FIELDS,
        query: {
          bool: {
            filter: openSearchAuthorizationFilters(args.input, args.input.evidence),
            must: [
              {
                multi_match: {
                  fields: ["content^1.5", "content.english^1.25", "content.shingles^2"],
                  minimum_should_match: "25%",
                  operator: "or",
                  query: args.input.query,
                  type: "best_fields",
                },
              },
            ],
          },
        },
        size: Math.max(1, Math.min(Math.trunc(args.input.topK), OPEN_SEARCH_QUERY_LIMIT)),
      },
      method: "POST",
      path: `/${encodeURIComponent(args.config.openSearchIndex)}/_search?routing=${encodeURIComponent(args.input.organizationId)}`,
      ...(args.input.signal ? { signal: args.input.signal } : {}),
    }),
  );
  requireCompleteOpenSearchSearch(response);
  return openSearchRows(response, "lexical");
}
