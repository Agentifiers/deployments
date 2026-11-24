import {
  captureBrainContent,
  type Brain,
  type BrainQueryRuntime,
  type BrainRepository,
  type BrainBlobReference,
} from "@deployments-ai/brains";
import { type DynamoDatabaseService, type Ulid } from "@deployments-ai/db";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import {
  authorizeBrainRead,
  authorizeBrainWrite,
  denyBrainAccess,
  readableBrain,
} from "./authorization.ts";
import {
  boundedInteger,
  brainIds,
  brainRunObservability,
  evidenceArtifact,
  inputRecord,
  requiredText,
  searchLimit,
  type BrainDocumentEvidence,
} from "./runtime-input.ts";
export type { BrainDocumentEvidence } from "./runtime-input.ts";
import type { ExecuteRuntimeBuiltinTool } from "../runtime-tools.ts";

const MAX_BRAIN_DOCUMENT_BYTES = 65_536;

export function createRuntimeBrainBuiltinExecutors(input: {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Promise<string>;
  readonly loadDocumentEvidence?: (input: {
    readonly brain: Brain;
    readonly documentId: string;
    readonly maxBytes: number;
    readonly startByte: number;
  }) => Promise<BrainDocumentEvidence>;
  /** The query runtime for a run: its model calls are admitted on that run's claim. */
  readonly loadQueryRuntime: (runId: string) => Promise<BrainQueryRuntime>;
  readonly repository: BrainRepository;
  readonly uploadContent?: (input: {
    readonly brainId: string;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly contentType: string;
    readonly objectKey: string;
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }) => Promise<BrainBlobReference>;
}): Readonly<
  Record<
    | "agent.brain.ask"
    | "agent.brain.capture"
    | "agent.brain.get_document"
    | "agent.brain.get_entity"
    | "agent.brain.search",
    ExecuteRuntimeBuiltinTool
  >
> {
  const executor = (
    toolName: "agent.brain.ask" | "agent.brain.search",
  ): ExecuteRuntimeBuiltinTool => {
    return async (request) => {
      const toolInput = inputRecord(request.input);
      const selectedBrainIds = brainIds(toolInput.brainIds);
      const authorize = async (brainId: string) =>
        selectedBrainIds.includes(brainId as Ulid)
          ? readableBrain({
              brainId,
              database: input.database,
              repository: input.repository,
              request,
            })
          : undefined;
      const brains: Brain[] = [];
      for (const brainId of selectedBrainIds) {
        const brain = await authorize(brainId);
        if (!brain) return denyBrainAccess();
        brains.push(brain);
      }
      let runtime: BrainQueryRuntime;
      try {
        runtime = await input.loadQueryRuntime(request.runId);
      } catch (cause) {
        throw new RuntimeToolPreparationRetryableError(toolName, cause);
      }
      const shared = {
        authorizeDisclosure: authorize,
        brains,
        organizationId: request.organizationId,
        telemetryContext: {
          environmentId: request.environmentId,
          ...(request.traceId === undefined
            ? {}
            : { observability: brainRunObservability(request) }),
          projectId: request.projectId,
          purpose: toolName,
          runId: request.runId,
          threadId: request.threadId,
          toolCallId: request.decision.toolCallId,
          workspaceId: request.workspaceId,
        },
      };
      const content =
        toolName === "agent.brain.search"
          ? {
              kind: "brain-search-results",
              query: requiredText(toolInput, "query"),
              ...(await runtime.search({
                ...shared,
                brainIds: selectedBrainIds,
                limit: searchLimit(toolInput.limit),
                query: requiredText(toolInput, "query"),
              })),
            }
          : {
              answer: await runtime.ask({
                ...shared,
                brainIds: selectedBrainIds,
                evidenceLimit: searchLimit(toolInput.evidenceLimit),
                question: requiredText(toolInput, "question"),
              }),
              kind: "brain-answer",
              question: requiredText(toolInput, "question"),
            };
      return {
        output: {
          brainIds: selectedBrainIds,
          citations:
            "results" in content
              ? content.results.map((result) => result.citation)
              : content.answer.usedCitations,
          kind: "brain-evidence-provenance",
        },
        outputSummary: `${toolName} produced live-authorized evidence in a private transient artifact.`,
        status: "completed",
        transientArtifacts: [evidenceArtifact(request, selectedBrainIds, content)],
      };
    };
  };

  const getDocument: ExecuteRuntimeBuiltinTool = async (request) => {
    const toolInput = inputRecord(request.input);
    const brainId = requiredText(toolInput, "brainId") as Ulid;
    const documentId = requiredText(toolInput, "documentId");
    const brain = await input.repository.get(request.organizationId, brainId);
    if (!brain) return denyBrainAccess();
    await authorizeBrainRead({
      brain,
      database: input.database,
      repository: input.repository,
      request,
    });
    if (!input.loadDocumentEvidence) {
      throw new RuntimeToolPreparationRetryableError(
        "agent.brain.get_document",
        new Error("Brain document evidence loader is unavailable."),
      );
    }
    const evidence = await input.loadDocumentEvidence({
      brain,
      documentId,
      maxBytes: boundedInteger(
        toolInput.maxBytes,
        32_768,
        1,
        MAX_BRAIN_DOCUMENT_BYTES,
        "Brain document maxBytes",
      ),
      startByte: boundedInteger(
        toolInput.startByte,
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        "Brain document startByte",
      ),
    });
    await authorizeBrainRead({
      brain,
      database: input.database,
      repository: input.repository,
      request,
    });
    return {
      output: {
        brainIds: [brainId],
        citations: [evidence.citation],
        kind: "brain-evidence-provenance",
      },
      outputSummary:
        "agent.brain.get_document produced live-authorized evidence in a private transient artifact.",
      status: "completed",
      transientArtifacts: [
        evidenceArtifact(request, [brainId], {
          evidence,
          kind: "brain-document-evidence",
        }),
      ],
    };
  };

  const capture: ExecuteRuntimeBuiltinTool = async (request) => {
    const toolInput = inputRecord(request.input);
    const brainId = requiredText(toolInput, "brainId") as Ulid;
    const sourceId = requiredText(toolInput, "sourceId");
    const content = requiredText(toolInput, "content");
    const mediaType =
      toolInput.mediaType === undefined ? "text/markdown" : requiredText(toolInput, "mediaType");
    if (!new Set(["application/json", "text/markdown", "text/plain"]).has(mediaType)) {
      throw new TypeError("Brain capture mediaType is not supported.");
    }
    if (mediaType === "application/json") JSON.parse(content);
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > 1_048_576) throw new TypeError("Brain capture content is too large.");
    const brain = await input.repository.get(request.organizationId, brainId);
    if (!brain) return denyBrainAccess();
    const access = await authorizeBrainWrite({
      brain,
      database: input.database,
      repository: input.repository,
      request,
    });
    const source = await input.repository.getSource(request.organizationId, brainId, sourceId);
    if (!source || source.status !== "active" || source.kind !== "upload") return denyBrainAccess();
    if (!input.generateId || !input.uploadContent) {
      throw new RuntimeToolPreparationRetryableError(
        "agent.brain.capture",
        new Error("Brain capture storage is unavailable."),
      );
    }
    const captured = await captureBrainContent({
      actor: access.actor,
      agentAuthorization: access.agentAuthorization,
      authorizingGrant: access.authorizingGrant,
      brain,
      bytes,
      externalItemIdentity: requiredText(toolInput, "externalItemIdentity"),
      generateId: input.generateId,
      mediaType,
      repository: input.repository,
      source,
      sourceRevision:
        typeof toolInput.sourceRevision === "string" && toolInput.sourceRevision.trim()
          ? toolInput.sourceRevision.trim()
          : request.idempotencyKey,
      title: requiredText(toolInput, "title"),
      upload: ({ bytes: uploadBytes, ticket }) =>
        input.uploadContent!({
          brainId,
          bytes: uploadBytes,
          contentHash: ticket.expectedContentHash,
          contentType: ticket.mediaType,
          objectKey: ticket.objectKey,
          organizationId: request.organizationId,
          ...(request.signal ? { signal: request.signal } : {}),
        }),
    });
    await authorizeBrainWrite({
      brain,
      database: input.database,
      repository: input.repository,
      request,
    });
    return {
      output: {
        brainId,
        documentId: captured.document.id,
        documentVersionId: captured.version.id,
        kind: "brain-capture-provenance",
        sourceId,
      },
      outputSummary:
        "agent.brain.capture stored an immutable, attributable Brain document version.",
      status: "completed",
    };
  };

  const getEntity: ExecuteRuntimeBuiltinTool = async (request) => {
    const toolInput = inputRecord(request.input);
    const brainId = requiredText(toolInput, "brainId") as Ulid;
    const entityId = requiredText(toolInput, "entityId");
    const brain = await input.repository.get(request.organizationId, brainId);
    if (!brain) return denyBrainAccess();
    await authorizeBrainRead({
      brain,
      database: input.database,
      repository: input.repository,
      request,
    });
    const entity = await input.repository.getEntity(request.organizationId, brainId, entityId);
    if (!entity || entity.status !== "active" || entity.reviewStatus === "rejected") {
      return denyBrainAccess();
    }
    const edgeLimit = boundedInteger(toolInput.edgeLimit, 20, 1, 50, "Brain entity edgeLimit");
    const outgoing = await input.repository.listEntityEdges(
      request.organizationId,
      brainId,
      entityId,
      "outgoing",
      { limit: edgeLimit },
    );
    const incoming =
      outgoing.items.length >= edgeLimit
        ? { items: [] as const }
        : await input.repository.listEntityEdges(
            request.organizationId,
            brainId,
            entityId,
            "incoming",
            { limit: edgeLimit - outgoing.items.length },
          );
    const edges = [...outgoing.items, ...incoming.items];
    const citations = [];
    for (const edge of edges) {
      const documentId = edge.from.kind === "document" ? edge.from.id : edge.to.id;
      const document = await input.repository.getDocument(
        request.organizationId,
        brainId,
        documentId,
      );
      if (
        !document ||
        document.lifecycle !== "active" ||
        document.currentContentVersionId !== edge.documentVersionId
      ) {
        continue;
      }
      citations.push({
        brainId,
        chunkId: `${edge.id}:edge`,
        documentId,
        documentVersionId: edge.documentVersionId,
        renditionId: edge.renditionId,
        sourceId: document.sourceId,
      });
    }
    await authorizeBrainRead({
      brain,
      database: input.database,
      repository: input.repository,
      request,
    });
    return {
      output: {
        brainIds: [brainId],
        citations,
        kind: "brain-evidence-provenance",
      },
      outputSummary:
        "agent.brain.get_entity produced live-authorized graph evidence in a private transient artifact.",
      status: "completed",
      transientArtifacts: [
        evidenceArtifact(request, [brainId], {
          edges,
          entity,
          kind: "brain-entity-evidence",
        }),
      ],
    };
  };

  return {
    "agent.brain.ask": executor("agent.brain.ask"),
    "agent.brain.capture": capture,
    "agent.brain.get_document": getDocument,
    "agent.brain.get_entity": getEntity,
    "agent.brain.search": executor("agent.brain.search"),
  };
}
