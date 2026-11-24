import { describe, expect, test } from "bun:test";
import {
  makeBrainQueryRuntime,
  type BrainRepository,
  type BrainSearchProviderClient,
  type BrainSearchTarget,
} from "@deployments-ai/brains";
import { createRuntimeBrainRecall } from "./active-recall.ts";
import { createRuntimeBrainBuiltinExecutors } from "./runtime.ts";
import {
  ids,
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
  now,
  records,
  database,
  definition,
  repository,
  runtime,
} from "./runtime.fixture.ts";

const sourceId = ids[12]!;
const documentId = ids[13]!;
const documentVersionId = ids[14]!;
const renditionId = ids[15]!;

interface EvidenceState {
  brainStatus: "active" | "archived";
  reviewStatus: "approved" | "rejected";
  sourceStatus: "active" | "archived";
}

function evidenceRepository(state: EvidenceState): BrainRepository {
  const mounted = repository({ revoked: false });
  return {
    ...mounted,
    get: async (requestedOrganizationId: string, requestedBrainId: string) => {
      const brain = await mounted.get(requestedOrganizationId, requestedBrainId);
      return brain && { ...brain, status: state.brainStatus };
    },
    getDocument: async () => ({
      brainId,
      createdAt: now,
      currentContentVersionId: documentVersionId,
      externalItemIdentity: "rollout",
      id: documentId,
      lifecycle: "active" as const,
      organizationId,
      projectionGeneration: 1,
      reviewStatus: state.reviewStatus,
      sensitivity: "internal" as const,
      sourceId,
      updatedAt: now,
      version: 0,
    }),
    getDocumentRendition: async () => ({
      bodyRef: {
        bucket: "content",
        byteSize: 12,
        contentType: "text/plain",
        key: "key",
        sha256: "sha256:content",
        versionId: "s3-version",
      },
      brainId,
      contentHash: "sha256:content",
      coordinateSystem: "utf8-byte" as const,
      createdAt: now,
      documentId,
      documentVersionId,
      id: renditionId,
      kind: "original" as const,
      organizationId,
    }),
    getDocumentVersion: async () => ({
      bodyRef: {
        bucket: "content",
        byteSize: 12,
        contentType: "text/plain",
        key: "key",
        sha256: "sha256:content",
        versionId: "s3-version",
      },
      brainId,
      byteSize: 12,
      contentHash: "sha256:content",
      createdAt: now,
      documentId,
      envelopeHash: "envelope",
      id: documentVersionId,
      kind: "content" as const,
      mediaType: "text/plain",
      organizationId,
      originalRenditionId: renditionId,
      sourceId,
      sourceOrder: 1,
    }),
    getSource: async () => ({
      brainId,
      createdAt: now,
      createdByPrincipalId: serviceAccountId,
      id: sourceId,
      kind: "upload" as const,
      name: "Rollout",
      organizationId,
      status: state.sourceStatus,
      updatedAt: now,
      updatedByPrincipalId: serviceAccountId,
      version: state.sourceStatus === "active" ? 0 : 1,
    }),
  } as BrainRepository;
}

function serviceAccountDatabase() {
  return database(
    records({
      apiCredentialId: credentialId,
      serviceAccountId,
      type: "service-account",
    }),
  );
}

function liveQueryRuntime(canonical: BrainRepository, onHydrate = () => {}) {
  const target: BrainSearchTarget = {
    location: {},
    providerId: "aws-native",
    schemaGeneration: 1,
    targetId: "target-1",
  };
  const provider = {
    providerId: "aws-native",
    search: async () => [
      {
        brainId,
        chunkId: "chunk-1",
        contentHash: "sha256:content",
        coordinates: { end: 12, kind: "utf8-byte", start: 0 },
        denseScore: 0.9,
        documentId,
        documentVersionId,
        organizationId,
        projectionGeneration: 1,
        renditionId,
        reviewStatus: "approved",
        schemaGeneration: 1,
        sensitivity: "internal",
        sourceId,
      },
    ],
    target,
  } as unknown as BrainSearchProviderClient;
  return makeBrainQueryRuntime({
    answerModel: {} as never,
    embeddings: { embedQuery: async () => [0.1, 0.2] },
    hydrator: {
      hydrateExcerpt: async () => {
        onHydrate();
        return "Rollout evidence";
      },
    },
    placement: { resolve: async () => ({ placementGeneration: 1, provider, target }) },
    repository: canonical,
    telemetry: { record: async () => ({ queryAttemptId: "attempt-1" }) },
  });
}

async function recalledVersions(canonical: BrainRepository, onHydrate?: () => void) {
  const adapter = createRuntimeBrainRecall({
    database: serviceAccountDatabase(),
    loadQueryRuntime: async () => liveQueryRuntime(canonical, onHydrate),
    repository: canonical,
  });
  const result = await adapter.recall({
    agentDefinitionId: definitionId,
    agentDeploymentId: deploymentId,
    agentManifestHash: "release-content-hash",
    agentReleaseId: releaseId,
    brainRetrievalMode: "hybrid",
    captureMode: "metadata-only",
    environmentId,
    memories: [],
    organizationId,
    projectId,
    prompt: "Cite what changed in the rollout.",
    recentMessages: [],
    runId,
    spanId: "0123456789abcdef",
    threadId,
    traceId: "0123456789abcdef0123456789abcdef",
  });
  return result.evidence.map((item) => item.documentVersionId);
}

describe("runtime Brain tools", () => {
  test("actively retrieves mounted Brain evidence through the deterministic planner", async () => {
    let evidenceLimit: number | undefined;
    const queryRuntime = runtime();
    const adapter = createRuntimeBrainRecall({
      database: database(
        records({
          apiCredentialId: credentialId,
          serviceAccountId,
          type: "service-account",
        }),
      ),
      loadQueryRuntime: async () => ({
        ...queryRuntime,
        search: async (input) => {
          evidenceLimit = input.limit;
          return queryRuntime.search(input);
        },
      }),
      repository: repository({ revoked: false }),
    });

    const result = await adapter.recall({
      agentDefinitionId: definitionId,
      agentDeploymentId: deploymentId,
      agentManifestHash: "release-content-hash",
      agentReleaseId: releaseId,
      brainRetrievalMode: "hybrid",
      captureMode: "metadata-only",
      environmentId,
      memories: [
        {
          content: "The user prefers citations.",
          memoryId: ids[12]!,
          score: 0.9,
          sensitivity: "internal",
        },
      ],
      organizationId,
      projectId,
      prompt: "Cite what changed in the rollout; I prefer short answers.",
      recentMessages: [],
      runId,
      spanId: "0123456789abcdef",
      threadId,
      traceId: "0123456789abcdef0123456789abcdef",
    });

    expect(result.route).toBe("both");
    expect(result.brainRequired).toBe(true);
    expect(evidenceLimit).toBe(3);
    expect(result.evidence).toEqual([
      expect.objectContaining({ brainId, documentVersionId: "version-1" }),
    ]);
  });

  test("marks required evidence unmet when authorized Brains return no current hits", async () => {
    const adapter = createRuntimeBrainRecall({
      database: database(
        records({
          apiCredentialId: credentialId,
          serviceAccountId,
          type: "service-account",
        }),
      ),
      loadQueryRuntime: async () => ({
        ...runtime(),
        search: async () => ({ queryAttemptId: "attempt-1", results: [] }),
      }),
      repository: repository({ revoked: false }),
    });

    const result = await adapter.recall({
      agentDefinitionId: definitionId,
      agentDeploymentId: deploymentId,
      agentManifestHash: "release-content-hash",
      agentReleaseId: releaseId,
      brainRetrievalMode: "hybrid",
      captureMode: "metadata-only",
      environmentId,
      memories: [],
      organizationId,
      projectId,
      prompt: "Cite the exact rollout source.",
      recentMessages: [],
      runId,
      spanId: "0123456789abcdef",
      threadId,
      traceId: "0123456789abcdef0123456789abcdef",
    });

    expect(result.brainRequired).toBe(true);
    expect(result.evidence).toEqual([]);
    expect(result.unmetEvidenceRequirement).toBe(true);
  });

  test("suppresses active recall when its source or document review becomes ineligible", async () => {
    const state: EvidenceState = {
      brainStatus: "active",
      reviewStatus: "approved",
      sourceStatus: "active",
    };
    const canonical = evidenceRepository(state);
    const adapter = createRuntimeBrainRecall({
      database: database(
        records({
          apiCredentialId: credentialId,
          serviceAccountId,
          type: "service-account",
        }),
      ),
      loadQueryRuntime: async () => runtime(),
      repository: canonical,
    });
    const revalidationRequest = {
      agentDefinitionId: definitionId,
      agentDeploymentId: deploymentId,
      agentManifestHash: "release-content-hash",
      agentReleaseId: releaseId,
      captureMode: "metadata-only" as const,
      environmentId,
      evidence: [
        {
          brainId,
          chunkId: "chunk-1",
          coordinates: { end: 12, kind: "utf8-byte" as const, start: 0 },
          documentId,
          documentVersionId,
          excerpt: "Rollout evidence",
          renditionId,
          score: 0.9,
          sensitivity: "internal" as const,
          sourceId,
        },
      ],
      organizationId,
      projectId,
      runId,
      spanId: "0123456789abcdef" as const,
      threadId,
      traceId: "0123456789abcdef0123456789abcdef" as const,
    };

    expect(adapter.revalidate(revalidationRequest)).resolves.toHaveLength(1);
    state.sourceStatus = "archived";
    expect(adapter.revalidate(revalidationRequest)).resolves.toEqual([]);
    state.sourceStatus = "active";
    state.reviewStatus = "rejected";
    expect(adapter.revalidate(revalidationRequest)).resolves.toEqual([]);
  });

  test("discloses nothing from a Brain archived after the mounted Brains were listed", async () => {
    const state: EvidenceState = {
      brainStatus: "active",
      reviewStatus: "approved",
      sourceStatus: "active",
    };
    const canonical = evidenceRepository(state);

    expect(await recalledVersions(canonical)).toEqual([documentVersionId]);
    state.brainStatus = "archived";
    expect(await recalledVersions(canonical)).toEqual([]);
  });

  test("discloses no active recall evidence whose Brain or source is archived while it hydrates", async () => {
    const recalledAfter = async (archive: (state: EvidenceState) => void) => {
      const state: EvidenceState = {
        brainStatus: "active",
        reviewStatus: "approved",
        sourceStatus: "active",
      };
      return recalledVersions(evidenceRepository(state), () => archive(state));
    };

    expect([
      await recalledAfter(() => {}),
      await recalledAfter((state) => (state.brainStatus = "archived")),
      await recalledAfter((state) => (state.sourceStatus = "archived")),
    ]).toEqual([[documentVersionId], [], []]);
  });

  test("returns no agent.brain.search evidence whose Brain or source is archived while it hydrates", async () => {
    const searchedAfter = async (archive: (state: EvidenceState) => void) => {
      const state: EvidenceState = {
        brainStatus: "active",
        reviewStatus: "approved",
        sourceStatus: "active",
      };
      const canonical = evidenceRepository(state);
      const result = await createRuntimeBrainBuiltinExecutors({
        database: serviceAccountDatabase(),
        loadQueryRuntime: async () => liveQueryRuntime(canonical, () => archive(state)),
        repository: canonical,
      })["agent.brain.search"](
        {
          agentDefinitionId: definitionId,
          agentDeploymentId: deploymentId,
          agentReleaseId: releaseId,
          decision: { action: "allow", reason: "test", toolCallId },
          effect: "read",
          environmentId,
          idempotencyKey: "brain-search",
          input: { brainIds: [brainId], query: "What changed in the rollout?" },
          inputSummary: "Search company knowledge",
          organizationId,
          projectId,
          requiredScopes: [],
          runId,
          threadId,
          toolName: "agent.brain.search",
        },
        definition,
      );
      const evidence = JSON.parse(result.transientArtifacts?.[0]?.content as string) as {
        readonly results: readonly { readonly citation: { readonly documentVersionId: string } }[];
      };
      return evidence.results.map((item) => item.citation.documentVersionId);
    };

    expect([
      await searchedAfter(() => {}),
      await searchedAfter((state) => (state.brainStatus = "archived")),
      await searchedAfter((state) => (state.sourceStatus = "archived")),
    ]).toEqual([[documentVersionId], [], []]);
  });
});
