import {
  RuntimeToolPreparationRetryableError,
  type RuntimeBrainEvidenceContextItem,
  type RuntimeBrainEvidenceRevalidationRequest,
  type RuntimeBrainRecallRequest,
  type RuntimeBrainRecallResult,
} from "@deployments-ai/agent-runtime";
import {
  planKnowledgeRetrieval,
  type Brain,
  type BrainQueryRuntime,
  type BrainRepository,
  type BrainSearchResult,
} from "@deployments-ai/brains";
import type { DynamoDatabaseService } from "@deployments-ai/db";
import { authorizeBrainRead, readableBrain, type BrainToolRequest } from "./authorization.ts";
import { brainRunObservability } from "./runtime-input.ts";

const MAX_ACTIVE_RECALL_BRAINS = 20;
const MAX_ACTIVE_RECALL_BRAIN_PAGES = 10;
const MAX_ACTIVE_RECALL_EVIDENCE = 3;

function runtimeEvidence(result: BrainSearchResult): RuntimeBrainEvidenceContextItem {
  return {
    brainId: result.citation.brainId,
    chunkId: result.citation.chunkId,
    coordinates: result.citation.coordinates,
    documentId: result.citation.documentId,
    documentVersionId: result.citation.documentVersionId,
    excerpt: result.excerpt,
    renditionId: result.citation.renditionId,
    score: result.score,
    sensitivity: result.sensitivity,
    sourceId: result.citation.sourceId,
    ...(result.title ? { title: result.title } : {}),
  };
}

function activeRecallToolRequest(
  request: RuntimeBrainRecallRequest | RuntimeBrainEvidenceRevalidationRequest,
): BrainToolRequest {
  return {
    ...request,
    decision: {
      action: "allow",
      reason: "Platform-controlled active Brain retrieval.",
      toolCallId: request.runId,
    },
    effect: "read",
    idempotencyKey: `${request.runId}:active-brain-retrieval`,
    inputSummary: "Retrieve live-authorized Brain evidence for model context.",
    requiredScopes: ["brains:read"],
    toolName: "agent.brain.search",
  };
}

interface RuntimeBrainCitationIdentity {
  readonly brainId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly renditionId: string;
  readonly sourceId: string;
}

async function runtimeBrainCitationIsCurrent(input: {
  readonly citation: RuntimeBrainCitationIdentity;
  readonly database: DynamoDatabaseService;
  readonly repository: BrainRepository;
  readonly request: BrainToolRequest;
}) {
  const { citation } = input;
  if (!(await readableBrain({ ...input, brainId: citation.brainId }))) return false;
  try {
    const [source, document, version, rendition] = await Promise.all([
      input.repository.getSource(input.request.organizationId, citation.brainId, citation.sourceId),
      input.repository.getDocument(
        input.request.organizationId,
        citation.brainId,
        citation.documentId,
      ),
      input.repository.getDocumentVersion(
        input.request.organizationId,
        citation.documentId,
        citation.documentVersionId,
      ),
      input.repository.getDocumentRendition(
        input.request.organizationId,
        citation.documentVersionId,
        citation.renditionId,
      ),
    ]);
    return (
      source?.brainId === citation.brainId &&
      source.status === "active" &&
      document?.brainId === citation.brainId &&
      document.lifecycle === "active" &&
      document.reviewStatus !== "rejected" &&
      document.sourceId === citation.sourceId &&
      document.currentContentVersionId === citation.documentVersionId &&
      version?.brainId === citation.brainId &&
      version.documentId === citation.documentId &&
      version.sourceId === citation.sourceId &&
      version.kind === "content" &&
      rendition?.brainId === citation.brainId &&
      rendition.documentId === citation.documentId &&
      rendition.documentVersionId === citation.documentVersionId
    );
  } catch {
    return false;
  }
}

export async function authorizeRuntimeBrainProvenance(input: {
  readonly citations: readonly RuntimeBrainCitationIdentity[];
  readonly database: DynamoDatabaseService;
  readonly repository: BrainRepository;
  readonly request: BrainToolRequest;
}) {
  if (input.citations.length === 0 || input.citations.length > 20) return false;
  const decisions = await Promise.all(
    input.citations.map((citation) => runtimeBrainCitationIsCurrent({ ...input, citation })),
  );
  return decisions.every(Boolean);
}

async function authorizedMountedBrains(input: {
  readonly database: DynamoDatabaseService;
  readonly repository: BrainRepository;
  readonly request: RuntimeBrainRecallRequest | RuntimeBrainEvidenceRevalidationRequest;
}) {
  const request = activeRecallToolRequest(input.request);
  const brains: Brain[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_ACTIVE_RECALL_BRAIN_PAGES; pageNumber += 1) {
    const page = await input.repository.listByOrganization(input.request.organizationId, {
      ...(cursor ? { cursor } : {}),
      limit: 100,
      status: "active",
    });
    for (const brain of page.items) {
      if (brains.length >= MAX_ACTIVE_RECALL_BRAINS) return brains;
      try {
        await authorizeBrainRead({
          brain,
          database: input.database,
          repository: input.repository,
          request,
        });
        brains.push(brain);
      } catch {
        // Unauthorized Brains are intentionally indistinguishable from absent Brains.
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return brains;
}

export function createRuntimeBrainRecall(input: {
  readonly database: DynamoDatabaseService;
  readonly loadQueryRuntime: (runId: string) => Promise<BrainQueryRuntime>;
  readonly repository: BrainRepository;
}) {
  const recall = async (request: RuntimeBrainRecallRequest): Promise<RuntimeBrainRecallResult> => {
    const brains = await authorizedMountedBrains({ ...input, request });
    const memoryScores = request.memories
      .map((memory) => memory.score)
      .filter((score): score is number => score !== undefined);
    const plan = planKnowledgeRetrieval({
      authorizedBrainCount: brains.length,
      hasMemory: request.memories.length > 0,
      ...(memoryScores.length > 0 ? { memoryConfidence: Math.max(...memoryScores) } : {}),
      mode: request.brainRetrievalMode,
      query: request.prompt,
    });
    if (plan.route !== "brain" && plan.route !== "both") return { ...plan, evidence: [] };
    if (brains.length === 0) return { ...plan, evidence: [] };
    let runtime: BrainQueryRuntime;
    try {
      runtime = await input.loadQueryRuntime(request.runId);
    } catch (cause) {
      throw new RuntimeToolPreparationRetryableError("agent.brain.search", cause);
    }
    const requestBinding = activeRecallToolRequest(request);
    const mountedBrainIds = new Set(brains.map((brain) => brain.id));
    const authorizeDisclosure = async (brainId: string) =>
      mountedBrainIds.has(brainId)
        ? readableBrain({
            brainId,
            database: input.database,
            repository: input.repository,
            request: requestBinding,
          })
        : undefined;
    const evidence = await runtime.search({
      authorizeDisclosure,
      brainIds: brains.map((brain) => brain.id),
      brains,
      limit: MAX_ACTIVE_RECALL_EVIDENCE,
      organizationId: request.organizationId,
      query: request.prompt,
      telemetryContext: {
        environmentId: request.environmentId,
        observability: brainRunObservability(request),
        projectId: request.projectId,
        purpose: "active-recall",
        runId: request.runId,
        threadId: request.threadId,
        workspaceId: request.workspaceId,
      },
    });
    const runtimeEvidenceItems = evidence.results.map(runtimeEvidence);
    return {
      ...plan,
      evidence: runtimeEvidenceItems,
      unmetEvidenceRequirement:
        plan.unmetEvidenceRequirement || (plan.brainRequired && runtimeEvidenceItems.length === 0),
    };
  };

  const revalidate = async (request: RuntimeBrainEvidenceRevalidationRequest) => {
    const requestBinding = activeRecallToolRequest(request);
    const output: RuntimeBrainEvidenceContextItem[] = [];
    for (const item of request.evidence) {
      if (
        await runtimeBrainCitationIsCurrent({
          citation: item,
          database: input.database,
          repository: input.repository,
          request: requestBinding,
        })
      ) {
        output.push(item);
      }
    }
    return output;
  };
  return { recall, revalidate };
}
