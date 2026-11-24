import { describe, expect, it } from "bun:test";
import { withCanonicalRecordKeys, type PlatformRecord, type Ulid } from "@deployments-ai/db";
import { executeMemoryBuiltinTool } from "./builtins.ts";
import { fixedNow, indexedUlid, memoryDatabase } from "./memory-flush-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
};
const sourceDeploymentId = indexedUlid(14_000);
const bindingId = indexedUlid(14_001);
const previewRunId = indexedUlid(14_002);

async function boundRun(input: {
  readonly expiresAt?: string;
  readonly purpose: "evaluation" | "preview";
  readonly sourceDeploymentId?: Ulid;
}) {
  const { database, put } = memoryDatabase();
  const platform = makeMemoryPlatform({
    database,
    embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
    now: () => fixedNow,
    searchProvider: fakeMemorySearchProvider().provider,
  });
  const space = await platform.createMemorySpace(scope, { name: "Production agent memory" });
  await platform.grantMemorySpace(scope, {
    agentDefinitionId: ids.agent,
    memorySpaceId: space.data.id,
    permission: "read-write",
  });
  const record = (itemType: PlatformRecord["itemType"], data: Record<string, unknown>) =>
    withCanonicalRecordKeys({ data, itemType } as never) as unknown as PlatformRecord;
  put(
    "control",
    record("agent-deployment", {
      agentDefinitionId: ids.agent,
      agentReleaseId: ids.memory2,
      createdAt: fixedNow.toISOString(),
      currentState: "ready",
      desiredState: "running",
      ...scope,
      id: sourceDeploymentId,
      updatedAt: fixedNow.toISOString(),
      version: 0,
    }),
  );
  put(
    "control",
    record("execution-binding", {
      contentHash: "manifest-hash",
      createdAt: fixedNow.toISOString(),
      createdBy: { id: ids.agent, type: "principal" },
      ...scope,
      expiresAt: input.expiresAt ?? new Date(fixedNow.getTime() + 3_600_000).toISOString(),
      id: bindingId,
      idempotencyKey: "preview-binding",
      manifest: { spec: {} },
      purpose: input.purpose,
      ...(input.sourceDeploymentId
        ? { runtimeConfigSourceAgentDeploymentId: input.sourceDeploymentId }
        : {}),
      source: { type: "manifest" },
      status: "active",
      toolPolicy: input.purpose === "preview" ? "interactive" : "evaluation",
      updatedAt: fixedNow.toISOString(),
      version: 0,
    }),
  );
  const run = record("run", {
    attempt: 0,
    captureMode: "metadata-only",
    createdAt: fixedNow.toISOString(),
    ...scope,
    executionBindingId: bindingId,
    executionPurpose: input.purpose,
    executor: "test",
    id: previewRunId,
    idempotencyKey: `run:${previewRunId}`,
    priority: 0,
    redactionPolicyVersion: 1,
    schemaVersion: 1,
    spanId: "0123456789abcdef",
    status: "completed",
    threadId: ids.thread,
    traceId: "0123456789abcdef0123456789abcdef",
    trigger: "test",
    updatedAt: fixedNow.toISOString(),
    version: 0,
  }) as Extract<PlatformRecord, { readonly itemType: "run" }>;
  put("execution", run);
  put(
    "control",
    record("run-locator", {
      createdAt: fixedNow.toISOString(),
      ...scope,
      id: previewRunId,
      runPk: run.pk,
      runSk: run.sk,
    }),
  );
  return { platform, run, space };
}

describe("preview and evaluation run memory access", () => {
  it("recalls read-only through the preview binding's source deployment grants", async () => {
    const { platform, space } = await boundRun({ purpose: "preview", sourceDeploymentId });

    const access = await platform.memoryAccessForRun(scope, previewRunId, {
      includeThreadContinuity: true,
    });

    expect(access.agentDefinitionId).toBe(ids.agent);
    expect(access.readMemorySpaceIds).toEqual([space.data.id]);
    expect(access.writeMemorySpaceIds).toEqual([]);
    expect(access.searchKeys).toEqual([
      `organization:${ids.organization}`,
      `agent:${ids.agent}`,
      `thread:${ids.thread}`,
    ]);
    expect(
      executeMemoryBuiltinTool(platform, scope, {
        input: { query: "change window" },
        runId: previewRunId,
        toolCallId: indexedUlid(14_003),
        toolName: "agent.memory.search",
      }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("denies preview memory saves, flushes, and flush candidate imports", async () => {
    const { platform, run, space } = await boundRun({ purpose: "preview", sourceDeploymentId });

    expect(
      executeMemoryBuiltinTool(platform, scope, {
        input: { content: "Remember the preview.", scope: "agent" },
        runId: previewRunId,
        toolCallId: indexedUlid(14_004),
        toolName: "agent.memory.save",
      }),
    ).rejects.toThrow("read-only");
    expect(platform.enqueueFlush(scope, run, { memoryMode: "organization" })).rejects.toMatchObject(
      { code: "execution_binding_memory_unavailable", statusCode: 409 },
    );
    expect(
      platform.importFlushCandidates(scope, {
        candidates: [{ content: "Remember the preview.", scope: "agent" }],
        flushId: indexedUlid(14_005),
        memoryMode: "agent",
        memorySpaceId: space.data.id,
        run,
      }),
    ).rejects.toMatchObject({ code: "execution_binding_memory_unavailable", statusCode: 409 });
  });

  it("keeps evaluation runs and previews without a live source deployment off memory", async () => {
    const unavailable = { code: "execution_binding_memory_unavailable", statusCode: 409 };
    for (const binding of [
      { purpose: "evaluation" as const, sourceDeploymentId },
      { purpose: "preview" as const },
      { expiresAt: fixedNow.toISOString(), purpose: "preview" as const, sourceDeploymentId },
    ]) {
      const { platform } = await boundRun(binding);
      expect(platform.memoryAccessForRun(scope, previewRunId)).rejects.toMatchObject(unavailable);
    }
  });
});
