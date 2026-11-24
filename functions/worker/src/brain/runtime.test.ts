import { describe, expect, test } from "bun:test";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import { createRuntimeBrainBuiltinExecutors } from "./runtime.ts";
import {
  organizationId,
  projectId,
  environmentId,
  serviceAccountId,
  credentialId,
  definitionId,
  releaseId,
  deploymentId,
  runId,
  threadId,
  toolCallId,
  brainId,
  records,
  database,
  repository,
  runtime,
  definition,
} from "./runtime.fixture.ts";

function request() {
  return {
    agentDefinitionId: definitionId,
    agentDeploymentId: deploymentId,
    agentReleaseId: releaseId,
    decision: { action: "allow" as const, reason: "test", toolCallId },
    effect: "read" as const,
    environmentId,
    idempotencyKey: "brain-search",
    input: { brainIds: [brainId], query: "What changed?" },
    inputSummary: "Search company knowledge",
    organizationId,
    projectId,
    requiredScopes: [],
    runId,
    threadId,
    toolName: "agent.brain.search",
  };
}

describe("runtime Brain tools", () => {
  test("returns live-authorized evidence only as a private transient artifact", async () => {
    const values = records({
      apiCredentialId: credentialId,
      serviceAccountId,
      type: "service-account",
    });
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(values),
      loadQueryRuntime: async () => runtime(),
      repository: repository({ revoked: false }),
    });

    const result = await executors["agent.brain.search"](request(), definition);

    expect(result.status).toBe("completed");
    expect(result.artifacts).toBeUndefined();
    expect(result.transientArtifacts).toHaveLength(1);
    expect(result.transientArtifacts?.[0]).toMatchObject({
      metadata: { brainIds: [brainId], kind: "brain-evidence" },
      type: "brain-evidence",
      visibility: "private",
    });
    expect(JSON.parse(result.transientArtifacts?.[0]?.content as string)).toMatchObject({
      kind: "brain-search-results",
      results: [{ excerpt: "The rollout changed on Tuesday." }],
    });
  });

  test("rejects runs without a bound initiating caller", async () => {
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(records(undefined)),
      loadQueryRuntime: async () => runtime(),
      repository: repository({ revoked: false }),
    });

    expect(executors["agent.brain.search"](request(), definition)).rejects.toThrow(
      "not authorized",
    );
  });

  test("returns a bounded current document range only through private evidence", async () => {
    const values = records({
      apiCredentialId: credentialId,
      serviceAccountId,
      type: "service-account",
    });
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(values),
      loadDocumentEvidence: async ({ documentId, maxBytes, startByte }) => ({
        citation: {
          brainId,
          chunkId: "version-1:bytes:0-13",
          coordinates: { end: 13, kind: "utf8-byte", start: startByte },
          documentId,
          documentVersionId: "version-1",
          renditionId: "rendition-1",
          sourceId: "source-1",
        },
        excerpt: "cited evidence".slice(0, maxBytes),
        mediaType: "text/plain",
      }),
      loadQueryRuntime: async () => runtime(),
      repository: repository({ revoked: false }),
    });
    const documentRequest = {
      ...request(),
      idempotencyKey: "brain-document",
      input: { brainId, documentId: "document-1", maxBytes: 32, startByte: 0 },
      toolName: "agent.brain.get_document",
    };

    const result = await executors["agent.brain.get_document"](documentRequest, definition);

    expect(result.artifacts).toBeUndefined();
    expect(result.output).toMatchObject({
      brainIds: [brainId],
      citations: [{ documentId: "document-1", documentVersionId: "version-1" }],
    });
    expect(JSON.parse(result.transientArtifacts?.[0]?.content as string)).toMatchObject({
      evidence: { excerpt: "cited evidence" },
      kind: "brain-document-evidence",
    });
  });

  test("returns a bounded one-hop entity projection with citable provenance", async () => {
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(
        records({
          apiCredentialId: credentialId,
          serviceAccountId,
          type: "service-account",
        }),
      ),
      loadQueryRuntime: async () => runtime(),
      repository: repository({ graph: true, revoked: false }),
    });
    const result = await executors["agent.brain.get_entity"](
      {
        ...request(),
        idempotencyKey: "brain-entity",
        input: { brainId, edgeLimit: 1, entityId: "01ARZ3NDEKTSV4RRFFQ69G5FBZ" },
        toolName: "agent.brain.get_entity",
      },
      definition,
    );

    expect(result.status).toBe("completed");
    expect(result.output).toMatchObject({ brainIds: [brainId], kind: "brain-evidence-provenance" });
    expect(result.transientArtifacts?.[0]).toMatchObject({ visibility: "private" });
  });

  test("captures text only through the full caller, release, grant, and mount intersection", async () => {
    const generated = [
      "01ARZ3NDEKTSV4RRFFQ69G5FD1",
      "01ARZ3NDEKTSV4RRFFQ69G5FD2",
      "01ARZ3NDEKTSV4RRFFQ69G5FD3",
      "01ARZ3NDEKTSV4RRFFQ69G5FD4",
      "01ARZ3NDEKTSV4RRFFQ69G5FD5",
      "01ARZ3NDEKTSV4RRFFQ69G5FD6",
      "01ARZ3NDEKTSV4RRFFQ69G5FD7",
    ];
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(
        records({
          apiCredentialId: credentialId,
          serviceAccountId,
          type: "service-account",
        }),
      ),
      generateId: async () => generated.shift()!,
      loadQueryRuntime: async () => runtime(),
      repository: repository({ capture: true, revoked: false }),
      uploadContent: async ({ bytes, contentHash, contentType, objectKey }) => ({
        bucket: "content",
        byteSize: bytes.byteLength,
        contentType,
        key: objectKey,
        sha256: contentHash,
        versionId: "s3-version",
      }),
    });
    const result = await executors["agent.brain.capture"](
      {
        ...request(),
        effect: "write",
        idempotencyKey: "capture-note",
        input: {
          brainId,
          content: "# Decision\nBuild Brain natively.",
          externalItemIdentity: "agent-note:decision",
          sourceId: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
          title: "Brain decision",
        },
        toolName: "agent.brain.capture",
      },
      definition,
    );

    expect(result.status).toBe("completed");
    expect(result.output).toMatchObject({ brainId, kind: "brain-capture-provenance" });
  });

  test("fails disclosure when a grant is revoked after retrieval starts", async () => {
    const state = { revoked: false };
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(
        records({
          apiCredentialId: credentialId,
          serviceAccountId,
          type: "service-account",
        }),
      ),
      loadQueryRuntime: async () => runtime(() => (state.revoked = true)),
      repository: repository(state),
    });

    expect(executors["agent.brain.search"](request(), definition)).rejects.toThrow(
      "authorization changed before disclosure",
    );
  });

  test("classifies unavailable query infrastructure as retryable", async () => {
    const executors = createRuntimeBrainBuiltinExecutors({
      database: database(
        records({
          apiCredentialId: credentialId,
          serviceAccountId,
          type: "service-account",
        }),
      ),
      loadQueryRuntime: async () => {
        throw new Error("provider unavailable");
      },
      repository: repository({ revoked: false }),
    });

    expect(executors["agent.brain.search"](request(), definition)).rejects.toBeInstanceOf(
      RuntimeToolPreparationRetryableError,
    );
  });
});
