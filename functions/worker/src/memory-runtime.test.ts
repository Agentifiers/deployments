import { describe, expect, test } from "bun:test";
import {
  RuntimeToolPreparationRetryableError,
  type RuntimeMemoryRecallRequest,
} from "@deployments-ai/agent-runtime";
import { MAX_EMBEDDING_CONTENT_BYTES, type MemoryPlatform } from "@deployments-ai/memory";
import type { Ulid } from "@deployments-ai/db";
import {
  createRuntimeMemoryBuiltinExecutors,
  createRuntimeMemoryRecall,
} from "./memory-runtime.ts";
import type { RuntimeToolBindingRequest } from "./runtime-tools.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

function request(memoryMode: RuntimeMemoryRecallRequest["memoryMode"]): RuntimeMemoryRecallRequest {
  return {
    agentDefinitionId: id("5"),
    agentDeploymentId: id("6"),
    agentManifestHash: "sha256:manifest",
    agentReleaseId: id("7"),
    captureMode: "metadata-only",
    environmentId: id("3"),
    memoryMode,
    organizationId: id("1"),
    projectId: id("2"),
    prompt: "What did we decide?",
    recentMessages: [
      { content: "Review the deployment plan.", role: "user" },
      { content: "The runtime follows memory.", role: "assistant" },
    ],
    runId: id("9"),
    spanId: "0123456789abcdef",
    threadId: id("8"),
    traceId: "0123456789abcdef0123456789abcdef",
    workspaceId: id("4"),
  };
}

function platformStub(derived = false) {
  const searches: Array<{
    input: Parameters<MemoryPlatform["search"]>[1];
    scope: Parameters<MemoryPlatform["search"]>[0];
  }> = [];
  const organizationSpaceId = id("10");
  const workspaceSpaceId = id("11");
  const memoryId = id("12");
  const platform = {
    memoryAccessForRun: async () => ({
      agentDefinitionId: id("5"),
      readMemorySpaces: [
        { id: organizationSpaceId },
        { id: workspaceSpaceId, workspaceId: id("4") },
      ],
      searchKeys: [
        `organization:${id("1")}`,
        `workspace:${id("4")}`,
        `agent:${id("5")}`,
        `thread:${id("8")}`,
        `thread:${id("18")}`,
      ],
    }),
    searchCanonicalForRun: async (
      scope: Parameters<MemoryPlatform["search"]>[0],
      input: Parameters<MemoryPlatform["search"]>[1],
    ) => {
      searches.push({ input, scope });
      return {
        attempt: { data: {} },
        results: [
          {
            memory: {
              data: {
                body: "Use the hosted runtime.",
                createdAt: "2026-08-10T18:30:00.000Z",
                ...(derived
                  ? {
                      brainProvenance: [
                        {
                          brainId: id("20"),
                          chunkId: "chunk-1",
                          documentId: id("21"),
                          documentVersionId: id("22"),
                          renditionId: id("23"),
                          sourceId: id("24"),
                        },
                      ],
                    }
                  : {}),
                id: memoryId,
                memoryType: "episode",
                sensitivity: "internal",
                validFrom: "2026-08-10T18:00:00.000Z",
                validUntil: "2026-08-10T19:00:00.000Z",
              },
            },
            rank: 2,
            score: 0.82,
          },
        ],
        retrievals: [],
      };
    },
  } as unknown as MemoryPlatform;
  return { memoryId, organizationSpaceId, platform, searches, workspaceSpaceId };
}

describe("runtime memory recall", () => {
  test("limits organization recall to organization spaces and scope keys", async () => {
    const stub = platformStub();
    const recall = createRuntimeMemoryRecall(async () => stub.platform);

    expect(recall(request("organization"))).resolves.toEqual([
      {
        content: "Use the hosted runtime.",
        createdAt: "2026-08-10T18:30:00.000Z",
        memoryId: stub.memoryId,
        memoryType: "episode",
        rank: 2,
        score: 0.82,
        sensitivity: "internal",
        validFrom: "2026-08-10T18:00:00.000Z",
        validUntil: "2026-08-10T19:00:00.000Z",
      },
    ]);
    expect(stub.searches).toEqual([
      {
        input: {
          allowedScopeKeys: [`organization:${id("1")}`],
          memorySpaceIds: [stub.organizationSpaceId],
          observability: {
            captureMode: "metadata-only",
            runSpanId: "0123456789abcdef",
            sessionId: id("8"),
            traceId: "0123456789abcdef0123456789abcdef",
            workspaceId: id("4"),
          },
          purpose: "active-recall",
          query:
            "user: Review the deployment plan.\nassistant: The runtime follows memory.\nuser: What did we decide?",
          runId: id("9"),
          searchKeys: [`organization:${id("1")}`],
          threadId: id("8"),
        },
        scope: {
          environmentId: id("3"),
          organizationId: id("1"),
          projectId: id("2"),
          workspaceId: id("4"),
        },
      },
    ]);
  });

  test("limits workspace recall to the requested workspace space", async () => {
    const stub = platformStub();
    const recall = createRuntimeMemoryRecall(async () => stub.platform);

    await recall(request("workspace"));

    expect(stub.searches[0]?.input).toMatchObject({
      allowedScopeKeys: [`workspace:${id("4")}`],
      memorySpaceIds: [stub.workspaceSpaceId],
      searchKeys: [`workspace:${id("4")}`],
    });
  });

  test("suppresses Brain-derived memory unless every citation is live-authorized", async () => {
    const denied = platformStub(true);
    const suppressed = createRuntimeMemoryRecall(async () => denied.platform);
    expect(suppressed(request("organization"))).resolves.toEqual([]);

    const authorized = platformStub(true);
    const recalled = createRuntimeMemoryRecall(
      async () => authorized.platform,
      async ({ brainProvenance }) => brainProvenance[0]?.brainId === id("20"),
    );
    expect(recalled(request("organization"))).resolves.toEqual([
      expect.objectContaining({ memoryId: authorized.memoryId }),
    ]);
  });

  test("bounds active recall queries by UTF-8 bytes without splitting code points", async () => {
    const stub = platformStub();
    const recall = createRuntimeMemoryRecall(async () => stub.platform);
    const oversized = {
      ...request("organization"),
      prompt: `retain-this-suffix-${"界".repeat(10_000)}`,
      recentMessages: [],
    } as const;

    await recall(oversized);

    const query = stub.searches[0]?.input.query ?? "";
    expect(Buffer.byteLength(query, "utf8")).toBeLessThanOrEqual(MAX_EMBEDDING_CONTENT_BYTES);
    expect(query).not.toContain("�");
    expect(query).toEndWith("界");
  });

  test.each([["agent", `agent:${id("5")}`]] as const)(
    "uses the %s search key across granted spaces",
    async (memoryMode, scopeKey) => {
      const stub = platformStub();
      const recall = createRuntimeMemoryRecall(async () => stub.platform);

      await recall(request(memoryMode));

      expect(stub.searches[0]?.input).toMatchObject({
        allowedScopeKeys: [scopeKey],
        memorySpaceIds: [stub.organizationSpaceId, stub.workspaceSpaceId],
        searchKeys: [scopeKey],
      });
    },
  );

  test("recalls thread memories across its validated continuation ancestry", async () => {
    const stub = platformStub();
    const recall = createRuntimeMemoryRecall(async () => stub.platform);

    await recall(request("thread"));

    expect(stub.searches[0]?.input).toMatchObject({
      allowedScopeKeys: [`thread:${id("8")}`, `thread:${id("18")}`],
      searchKeys: [`thread:${id("8")}`, `thread:${id("18")}`],
    });
  });
});

function runtimeToolRequest(
  toolName: "agent.memory.save" | "agent.memory.search",
  input: Readonly<Record<string, unknown>>,
): RuntimeToolBindingRequest & {
  readonly decision: {
    readonly action: "allow";
    readonly reason: string;
    readonly toolCallId: Ulid;
  };
} {
  return {
    agentDefinitionId: id("5"),
    agentDeploymentId: id("6"),
    agentReleaseId: id("7"),
    decision: { action: "allow", reason: "Allowed in test.", toolCallId: id("13") },
    effect: toolName === "agent.memory.search" ? "read" : "write",
    environmentId: id("3"),
    idempotencyKey: `test:${toolName}`,
    input,
    inputSummary: toolName,
    organizationId: id("1"),
    projectId: id("2"),
    requiredScopes: [],
    runId: id("9"),
    threadId: id("8"),
    toolName,
  };
}

describe("runtime memory built-in executors", () => {
  test("loads the shared platform and dispatches both governed memory tools", async () => {
    const memorySpaceId = id("10");
    const memoryId = id("12");
    const access = {
      agentDefinitionId: id("5"),
      readMemorySpaces: [{ id: memorySpaceId }],
      readMemorySpaceIds: [memorySpaceId],
      run: { data: { id: id("9"), threadId: id("8") } },
      searchKeys: [`agent:${id("5")}`],
      writeMemorySpaces: [{ id: memorySpaceId }],
      writeMemorySpaceIds: [memorySpaceId],
    };
    let loads = 0;
    let searchInput: unknown;
    let importInput: unknown;
    const platform = {
      importMemories: async (_scope: unknown, input: unknown) => {
        importInput = input;
        return {
          imported: [
            {
              data: {
                id: memoryId,
                reviewStatus: "approved",
                scope: "agent",
              },
            },
          ],
          rejected: [],
          replayed: [],
        };
      },
      memoryAccessForRun: async () => access,
      searchCanonicalForRun: async (_scope: unknown, input: unknown) => {
        searchInput = input;
        return { attempt: {}, results: [], retrievals: [] };
      },
    } as unknown as MemoryPlatform;
    const executors = createRuntimeMemoryBuiltinExecutors(
      async () => {
        loads += 1;
        return platform;
      },
      async () => true,
    );

    expect(
      executors["agent.memory.search"]!(
        runtimeToolRequest("agent.memory.search", { query: "change window" }),
        {} as never,
      ),
    ).resolves.toMatchObject({
      outputSummary: "No relevant approved memory was found.",
      status: "completed",
    });
    const derivedSaveRequest = {
      ...runtimeToolRequest("agent.memory.save", {
        content: "Use the Tuesday change window.",
        scope: "agent",
      }),
      completedToolCalls: [
        {
          effect: "read",
          idempotencyKey: "brain-search",
          inputSummary: "Search Brain",
          output: {
            citations: [
              {
                brainId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
                chunkId: "chunk-1",
                coordinates: { end: 12, kind: "utf8-byte", start: 0 },
                documentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
                documentVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
                renditionId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
                sourceId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
              },
            ],
            kind: "brain-evidence-provenance",
          },
          policyAction: "allow",
          policyReason: "Allowed",
          requiredScopes: [],
          toolCallId: id("25"),
          toolName: "agent.brain.search",
        },
      ],
    } as const;
    expect(executors["agent.memory.save"]!(derivedSaveRequest, {} as never)).resolves.toMatchObject(
      {
        outputSummary: expect.stringContaining(`Saved memory ${memoryId}`),
        status: "completed",
      },
    );

    expect(loads).toBe(2);
    expect(searchInput).toMatchObject({
      query: "change window",
      runId: id("9"),
      toolCallId: id("13"),
    });
    expect(importInput).toMatchObject({
      items: [
        {
          agentDefinitionId: id("5"),
          brainProvenance: [
            {
              brainId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
              chunkId: "chunk-1",
              coordinates: { end: 12, kind: "utf8-byte", start: 0 },
              documentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
              documentVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
              renditionId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
              sourceId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
            },
          ],
          idempotencyKey: `memory-tool:${id("13")}`,
          sourceRunId: id("9"),
        },
      ],
      memorySpaceId,
    });

    const activeRecallSaveRequest = {
      ...runtimeToolRequest("agent.memory.save", {
        content: "Use the active recall evidence.",
        scope: "agent",
      }),
      brainEvidence: [
        {
          brainId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
          chunkId: "chunk-active",
          coordinates: { end: 8, kind: "utf8-byte" as const, start: 0 },
          documentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
          documentVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
          excerpt: "Active evidence",
          renditionId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
          score: 0.91,
          sensitivity: "internal" as const,
          sourceId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
        },
      ],
    };
    await executors["agent.memory.save"]!(activeRecallSaveRequest, {} as never);
    expect(importInput).toMatchObject({
      items: [
        {
          brainProvenance: [
            {
              brainId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
              chunkId: "chunk-active",
              documentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
            },
          ],
        },
      ],
    });
    const oversizedProvenanceRequest = {
      ...runtimeToolRequest("agent.memory.save", {
        content: "This must not lose contributing Brain provenance.",
        scope: "agent",
      }),
      brainEvidence: Array.from({ length: 21 }, (_, index) => ({
        brainId: id(String(100 + index * 5)),
        chunkId: `chunk-${index}`,
        coordinates: { end: 8, kind: "utf8-byte" as const, start: 0 },
        documentId: id(String(101 + index * 5)),
        documentVersionId: id(String(102 + index * 5)),
        excerpt: `Evidence ${index}`,
        renditionId: id(String(103 + index * 5)),
        score: 0.9,
        sensitivity: "internal" as const,
        sourceId: id(String(104 + index * 5)),
      })),
    };
    expect(
      executors["agent.memory.save"]!(oversizedProvenanceRequest, {} as never),
    ).rejects.toThrow("exceeds 20 citations");

    const revoked = createRuntimeMemoryBuiltinExecutors(
      async () => platform,
      async () => false,
    );
    expect(revoked["agent.memory.save"]!(derivedSaveRequest, {} as never)).rejects.toThrow(
      "no longer live-authorized",
    );
  });

  test("classifies platform loading failures before memory writes as retryable", async () => {
    const loadFailure = new Error("Memory platform is temporarily unavailable.");
    const executors = createRuntimeMemoryBuiltinExecutors(async () => {
      throw loadFailure;
    });

    expect(
      executors["agent.memory.save"]!(
        runtimeToolRequest("agent.memory.save", {
          content: "Use the Tuesday change window.",
          scope: "agent",
        }),
        {} as never,
      ),
    ).rejects.toMatchObject({
      name: "RuntimeToolPreparationRetryableError",
      preparationCause: loadFailure,
    });
    expect(
      executors["agent.memory.save"]!(
        runtimeToolRequest("agent.memory.save", {
          content: "Use the Tuesday change window.",
          scope: "agent",
        }),
        {} as never,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });
});
