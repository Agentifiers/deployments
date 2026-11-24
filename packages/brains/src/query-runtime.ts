import { randomUUID } from "node:crypto";
import type {
  BrainAnswer,
  BrainAnswerModel,
  BrainAnswerRejectionEvent,
  BrainModelUsageScope,
} from "./ask.ts";
import { askBrain } from "./ask.ts";
import type { Brain } from "./models.ts";
import type { BrainRepository } from "./ports.ts";
import type { BrainSearchProviderClient, BrainSearchTarget } from "./search-provider.ts";
import type { BrainHydrationRequest, BrainSearchResult } from "./search.ts";
import { searchBrains } from "./search.ts";

/** The agent run's immutable trace context, which run-attributed Brain usage must carry. */
export interface BrainRunObservability {
  readonly captureMode: string;
  readonly parentSpanId?: string;
  readonly runSpanId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly workspaceId?: string;
}

export interface BrainAuthorizedQueryInput {
  readonly authorizeDisclosure: (brainId: string) => Promise<Brain | undefined>;
  readonly brains: readonly Brain[];
  readonly organizationId: string;
  /** Aborts the query's model and search provider calls once the caller stops waiting. */
  readonly signal?: AbortSignal;
  readonly telemetryContext?: {
    readonly environmentId?: string;
    readonly operationId?: string;
    readonly projectId?: string;
    readonly purpose?: string;
    readonly toolCallId?: string;
    /** The run's workspace; Brain API queries are organization-level and name none. */
    readonly workspaceId: string | undefined;
  } & (
    | {
        readonly observability?: undefined;
        readonly runId?: undefined;
        readonly threadId?: undefined;
      }
    | {
        /** Absent only for deterministic workflow tool steps, which run without a trace. */
        readonly observability?: BrainRunObservability;
        readonly runId: string;
        readonly threadId: string;
      }
  );
}

export interface BrainRuntimeSearchRequest {
  readonly brainIds: readonly string[];
  readonly limit?: number;
  readonly query: string;
}

export interface BrainRuntimeAskRequest {
  readonly brainIds: readonly string[];
  readonly evidenceLimit?: number;
  readonly question: string;
}

export interface BrainRuntimeSearchResponse {
  readonly queryAttemptId: string;
  readonly results: readonly BrainSearchResult[];
}

export interface BrainRuntimeAnswer extends BrainAnswer {
  readonly queryAttemptId: string;
}

export interface BrainQueryRuntime {
  readonly ask: (
    input: BrainAuthorizedQueryInput & BrainRuntimeAskRequest,
  ) => Promise<BrainRuntimeAnswer>;
  readonly search: (
    input: BrainAuthorizedQueryInput & BrainRuntimeSearchRequest,
  ) => Promise<BrainRuntimeSearchResponse>;
}

export interface BrainQueryEmbeddingPort {
  readonly embedQuery: (input: {
    readonly organizationId: string;
    readonly query: string;
    readonly signal?: AbortSignal;
    readonly usageOperationId: string;
    readonly usageScope?: BrainModelUsageScope;
  }) => Promise<readonly number[]>;
}

export interface BrainRenditionHydrator {
  readonly hydrateExcerpt: (input: BrainHydrationRequest) => Promise<string>;
}

export interface BrainQueryPlacementResolver {
  readonly resolve: (organizationId: string) => Promise<{
    readonly placementGeneration: number;
    readonly provider: BrainSearchProviderClient;
    readonly target: BrainSearchTarget;
  }>;
}

export interface BrainQueryTelemetryPort {
  readonly record: (input: {
    readonly authorizedBrainIds: readonly string[];
    readonly candidateCount: number;
    readonly canonicalDropCount: number;
    readonly context?: BrainAuthorizedQueryInput["telemetryContext"];
    readonly emittedCount: number;
    readonly latencyMs: number;
    readonly organizationId: string;
    readonly placementGeneration: number;
    readonly purpose: "ask-evidence" | "search";
    readonly query: string;
    readonly results: readonly BrainSearchResult[];
    readonly target: BrainSearchTarget;
  }) => Promise<{ readonly queryAttemptId: string }>;
}

export function makeBrainQueryRuntime(input: {
  readonly answerModel: BrainAnswerModel;
  readonly embeddings: BrainQueryEmbeddingPort;
  readonly hydrator: BrainRenditionHydrator;
  readonly onAnswerRejected?: (event: BrainAnswerRejectionEvent) => void;
  readonly placement: BrainQueryPlacementResolver;
  readonly repository: BrainRepository;
  readonly telemetry: BrainQueryTelemetryPort;
}): BrainQueryRuntime {
  const usageScope = (request: BrainAuthorizedQueryInput): BrainModelUsageScope | undefined =>
    request.telemetryContext?.environmentId && request.telemetryContext.projectId
      ? {
          environmentId: request.telemetryContext.environmentId,
          organizationId: request.organizationId,
          projectId: request.telemetryContext.projectId,
          workspaceId: request.telemetryContext.workspaceId,
        }
      : undefined;
  const usageOperationId = (request: BrainAuthorizedQueryInput) => {
    const runtimeOperationId = [
      request.telemetryContext?.runId,
      request.telemetryContext?.toolCallId,
    ]
      .filter((value): value is string => Boolean(value))
      .join(":");
    return request.telemetryContext?.operationId ?? (runtimeOperationId || randomUUID());
  };
  const search = async (
    request: Parameters<BrainQueryRuntime["search"]>[0],
    purpose: "ask-evidence" | "search" = "search",
    operationId = usageOperationId(request),
  ) => {
    const startedAt = Date.now();
    const modelUsageScope = usageScope(request);
    const [selected, embedding] = await Promise.all([
      input.placement.resolve(request.organizationId),
      input.embeddings.embedQuery({
        organizationId: request.organizationId,
        query: request.query,
        ...(request.signal ? { signal: request.signal } : {}),
        usageOperationId: operationId,
        ...(modelUsageScope ? { usageScope: modelUsageScope } : {}),
      }),
    ]);
    const requestedBrainIds = new Set(request.brainIds);
    const brains = request.brains.filter((brain) => requestedBrainIds.has(brain.id));
    let telemetry = { candidateCount: 0, canonicalDropCount: 0, emittedCount: 0 };
    const results = await searchBrains({
      brains,
      canonical: {
        authorizeDisclosure: request.authorizeDisclosure,
        getDocument: (brainId, documentId) =>
          input.repository.getDocument(request.organizationId, brainId, documentId),
        getRendition: (documentVersionId, renditionId) =>
          input.repository.getDocumentRendition(
            request.organizationId,
            documentVersionId,
            renditionId,
          ),
        getSource: (brainId, sourceId) =>
          input.repository.getSource(request.organizationId, brainId, sourceId),
        getVersion: (documentId, versionId) =>
          input.repository.getDocumentVersion(request.organizationId, documentId, versionId),
        hydrate: input.hydrator.hydrateExcerpt,
      },
      embedding,
      limit: request.limit ?? 10,
      organizationId: request.organizationId,
      provider: selected.provider,
      query: request.query,
      ...(request.signal ? { signal: request.signal } : {}),
      target: selected.target,
      telemetry: (value) => {
        telemetry = value;
      },
    });
    const attempt = await input.telemetry.record({
      authorizedBrainIds: brains.map((brain) => brain.id),
      ...telemetry,
      ...(request.telemetryContext ? { context: request.telemetryContext } : {}),
      latencyMs: Math.max(0, Date.now() - startedAt),
      organizationId: request.organizationId,
      placementGeneration: selected.placementGeneration,
      purpose,
      query: request.query,
      results,
      target: selected.target,
    });
    return { queryAttemptId: attempt.queryAttemptId, results };
  };
  return {
    async ask(request) {
      const modelUsageScope = usageScope(request);
      const operationId = usageOperationId(request);
      const evidence = await search(
        {
          ...request,
          limit: request.evidenceLimit ?? 12,
          query: request.question,
        },
        "ask-evidence",
        operationId,
      );
      const answer = await askBrain({
        authorizeDisclosure: async (result) => {
          const brain = await request.authorizeDisclosure(result.citation.brainId);
          if (!brain) return false;
          const [source, document, version, rendition] = await Promise.all([
            input.repository.getSource(
              request.organizationId,
              result.citation.brainId,
              result.citation.sourceId,
            ),
            input.repository.getDocument(
              request.organizationId,
              result.citation.brainId,
              result.citation.documentId,
            ),
            input.repository.getDocumentVersion(
              request.organizationId,
              result.citation.documentId,
              result.citation.documentVersionId,
            ),
            input.repository.getDocumentRendition(
              request.organizationId,
              result.citation.documentVersionId,
              result.citation.renditionId,
            ),
          ]);
          return Boolean(
            brain.status === "active" &&
            source?.status === "active" &&
            document?.lifecycle === "active" &&
            document.currentContentVersionId === result.citation.documentVersionId &&
            version?.id === result.citation.documentVersionId &&
            rendition?.id === result.citation.renditionId &&
            rendition.contentHash === version.contentHash,
          );
        },
        evidence: evidence.results,
        model: input.answerModel,
        ...(input.onAnswerRejected ? { onAnswerRejected: input.onAnswerRejected } : {}),
        organizationId: request.organizationId,
        question: request.question,
        ...(request.signal ? { signal: request.signal } : {}),
        usageOperationId: operationId,
        ...(modelUsageScope ? { usageScope: modelUsageScope } : {}),
      });
      return { ...answer, queryAttemptId: evidence.queryAttemptId };
    },
    search,
  };
}
