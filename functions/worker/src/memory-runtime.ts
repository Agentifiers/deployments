import {
  RuntimeToolPreparationRetryableError,
  type RuntimeBrainEvidenceContextItem,
  type RuntimeMemoryRecallRequest,
} from "@deployments-ai/agent-runtime";
import {
  executeMemoryBuiltinTool,
  MAX_EMBEDDING_CONTENT_BYTES,
  type BrainMemoryProvenance,
  type MemoryPlatform,
} from "@deployments-ai/memory";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

type RuntimeMemorySearchResult = Awaited<ReturnType<MemoryPlatform["searchCanonicalForRun"]>>;

type AuthorizeDerivedMemory<Request> = (input: {
  readonly brainProvenance: BrainMemoryProvenance;
  readonly request: Request;
}) => Promise<boolean>;

async function authorizedRecall<Request>(
  recalled: RuntimeMemorySearchResult,
  request: Request,
  authorizeDerivedMemory?: AuthorizeDerivedMemory<Request>,
) {
  const results = [];
  for (const result of recalled.results) {
    const provenance = result.memory.data.brainProvenance;
    if (
      !provenance ||
      (authorizeDerivedMemory &&
        (await authorizeDerivedMemory({
          brainProvenance: provenance,
          request,
        })))
    ) {
      results.push(result);
    }
  }
  const memoryIds = new Set(results.map((result) => result.memory.data.id));
  return {
    ...recalled,
    results,
    retrievals: recalled.retrievals.filter((retrieval) => memoryIds.has(retrieval.data.memoryId)),
  };
}

function brainProvenanceFromCompletedCalls(
  calls: Parameters<ExecuteRuntimeBuiltinTool>[0]["completedToolCalls"],
  brainEvidence: readonly RuntimeBrainEvidenceContextItem[] = [],
): BrainMemoryProvenance | undefined {
  const citations = [];
  const seen = new Set<string>();
  for (const call of calls ?? []) {
    if (!call.toolName.startsWith("agent.brain.") || !call.output) continue;
    if (call.output.kind !== "brain-evidence-provenance" || !Array.isArray(call.output.citations)) {
      continue;
    }
    for (const candidate of call.output.citations) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const citation = candidate as Readonly<Record<string, unknown>>;
      const identifiers = [
        citation.brainId,
        citation.documentId,
        citation.documentVersionId,
        citation.renditionId,
        citation.sourceId,
      ];
      if (
        !identifiers.every((value) => typeof value === "string" && ULID_PATTERN.test(value)) ||
        typeof citation.chunkId !== "string" ||
        !citation.chunkId
      ) {
        continue;
      }
      const identity = [...identifiers, citation.chunkId].join(":");
      if (seen.has(identity)) continue;
      seen.add(identity);
      const coordinates = citation.coordinates;
      const validCoordinates =
        coordinates &&
        typeof coordinates === "object" &&
        !Array.isArray(coordinates) &&
        Number.isSafeInteger((coordinates as Record<string, unknown>).start) &&
        Number.isSafeInteger((coordinates as Record<string, unknown>).end) &&
        ["unicode-scalar", "utf8-byte"].includes(
          String((coordinates as Record<string, unknown>).kind),
        );
      citations.push({
        brainId: citation.brainId as import("@deployments-ai/db").Ulid,
        chunkId: citation.chunkId,
        ...(validCoordinates
          ? {
              coordinates: {
                end: (coordinates as Record<string, number>).end,
                kind: (coordinates as Record<string, "unicode-scalar" | "utf8-byte">).kind,
                start: (coordinates as Record<string, number>).start,
              },
            }
          : {}),
        documentId: citation.documentId as import("@deployments-ai/db").Ulid,
        documentVersionId: citation.documentVersionId as import("@deployments-ai/db").Ulid,
        renditionId: citation.renditionId as import("@deployments-ai/db").Ulid,
        sourceId: citation.sourceId as import("@deployments-ai/db").Ulid,
      });
      if (citations.length > 20) {
        throw new Error("Brain-derived memory provenance exceeds 20 citations.");
      }
    }
  }
  for (const citation of brainEvidence) {
    const identifiers = [
      citation.brainId,
      citation.documentId,
      citation.documentVersionId,
      citation.renditionId,
      citation.sourceId,
    ];
    if (!identifiers.every((value) => ULID_PATTERN.test(value)) || !citation.chunkId) continue;
    const identity = [...identifiers, citation.chunkId].join(":");
    if (seen.has(identity)) continue;
    seen.add(identity);
    citations.push({
      brainId: citation.brainId as import("@deployments-ai/db").Ulid,
      chunkId: citation.chunkId,
      coordinates: citation.coordinates,
      documentId: citation.documentId as import("@deployments-ai/db").Ulid,
      documentVersionId: citation.documentVersionId as import("@deployments-ai/db").Ulid,
      renditionId: citation.renditionId as import("@deployments-ai/db").Ulid,
      sourceId: citation.sourceId as import("@deployments-ai/db").Ulid,
    });
    if (citations.length > 20) {
      throw new Error("Brain-derived memory provenance exceeds 20 citations.");
    }
  }
  return citations.length > 0 ? (citations as BrainMemoryProvenance) : undefined;
}

function utf8Suffix(value: string, maximumBytes: number) {
  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  let start = encoded.byteLength - maximumBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return utf8Decoder.decode(encoded.subarray(start));
}

function recallQuery(request: RuntimeMemoryRecallRequest) {
  return utf8Suffix(
    [
      ...request.recentMessages.map((message) => `${message.role}: ${message.content}`),
      `user: ${request.prompt}`,
    ].join("\n"),
    MAX_EMBEDDING_CONTENT_BYTES,
  );
}

export function createRuntimeMemoryRecall(
  loadPlatform: () => Promise<MemoryPlatform>,
  authorizeDerivedMemory?: AuthorizeDerivedMemory<RuntimeMemoryRecallRequest>,
) {
  return async (request: RuntimeMemoryRecallRequest) => {
    const platform = await loadPlatform();
    const scope = {
      environmentId: request.environmentId,
      organizationId: request.organizationId,
      projectId: request.projectId,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
    };
    const access = await platform.memoryAccessForRun(scope, request.runId, {
      includeThreadContinuity: request.memoryMode === "thread",
    });
    const spaces = access.readMemorySpaces.filter((space) => {
      if (request.memoryMode === "organization") return space.workspaceId === undefined;
      if (request.memoryMode === "workspace") return space.workspaceId === request.workspaceId;
      return true;
    });
    const scopeKeys =
      request.memoryMode === "organization"
        ? [`organization:${request.organizationId}`]
        : request.memoryMode === "workspace"
          ? [`workspace:${request.workspaceId}`]
          : request.memoryMode === "agent"
            ? // Preview runs may not pin an agent definition; the source deployment supplies it.
              [`agent:${access.agentDefinitionId}`]
            : access.searchKeys.filter((searchKey) => searchKey.startsWith("thread:"));
    const recalled = await platform.searchCanonicalForRun(scope, {
      allowedScopeKeys: scopeKeys,
      memorySpaceIds: spaces.map((space) => space.id),
      observability: {
        captureMode: request.captureMode,
        ...(request.parentSpanId ? { parentSpanId: request.parentSpanId } : {}),
        runSpanId: request.spanId,
        sessionId: request.threadId,
        traceId: request.traceId,
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      },
      purpose: "active-recall",
      query: recallQuery(request),
      runId: request.runId,
      searchKeys: scopeKeys,
      threadId: request.threadId,
    });
    const authorized = await authorizedRecall(recalled, request, authorizeDerivedMemory);
    return authorized.results.map((result) => ({
      content: result.memory.data.body!,
      createdAt: result.memory.data.createdAt,
      memoryId: result.memory.data.id,
      ...(result.memory.data.memoryType ? { memoryType: result.memory.data.memoryType } : {}),
      rank: result.rank,
      score: result.score,
      sensitivity: result.memory.data.sensitivity,
      ...(result.memory.data.validFrom ? { validFrom: result.memory.data.validFrom } : {}),
      ...(result.memory.data.validUntil ? { validUntil: result.memory.data.validUntil } : {}),
    }));
  };
}

export function createRuntimeMemoryBuiltinExecutors(
  loadPlatform: () => Promise<MemoryPlatform>,
  authorizeDerivedMemory?: AuthorizeDerivedMemory<Parameters<ExecuteRuntimeBuiltinTool>[0]>,
): Readonly<Record<"agent.memory.save" | "agent.memory.search", ExecuteRuntimeBuiltinTool>> {
  const executor = (
    toolName: "agent.memory.save" | "agent.memory.search",
  ): ExecuteRuntimeBuiltinTool => {
    return async (request) => {
      let platform: MemoryPlatform;
      try {
        platform = await loadPlatform();
      } catch (cause) {
        throw new RuntimeToolPreparationRetryableError(toolName, cause);
      }
      const requestPlatform = {
        ...platform,
        search: async (...args: Parameters<MemoryPlatform["searchCanonicalForRun"]>) =>
          authorizedRecall(
            await platform.searchCanonicalForRun(...args),
            request,
            authorizeDerivedMemory,
          ),
      } as MemoryPlatform;
      const brainProvenance =
        toolName === "agent.memory.save"
          ? brainProvenanceFromCompletedCalls(request.completedToolCalls, request.brainEvidence)
          : undefined;
      if (
        brainProvenance &&
        (!authorizeDerivedMemory || !(await authorizeDerivedMemory({ brainProvenance, request })))
      ) {
        throw new Error("Brain-derived memory evidence is no longer live-authorized.");
      }
      return executeMemoryBuiltinTool(
        requestPlatform,
        {
          environmentId: request.environmentId,
          organizationId: request.organizationId,
          projectId: request.projectId,
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        },
        {
          ...(brainProvenance ? { brainProvenance } : {}),
          ...(request.input ? { input: request.input } : {}),
          runId: request.runId,
          toolCallId: request.decision.toolCallId,
          toolName,
        },
      );
    };
  };

  return {
    "agent.memory.save": executor("agent.memory.save"),
    "agent.memory.search": executor("agent.memory.search"),
  };
}
