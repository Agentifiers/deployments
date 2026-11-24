import { describe, expect, it } from "bun:test";
import {
  RuntimeArtifactPublicationError,
  type RuntimeModelGenerationRequest,
} from "@deployments-ai/agent-runtime";
import { RunRecord, withCanonicalRecordKeys, type PlatformRecord } from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { MAX_AGENT_RUN_CHECKPOINTS } from "./agent-run-input.ts";
import { runtimeInput } from "./agent-run-runtime-input.ts";
import { runToolContinuation } from "./continuation.ts";
import type {
  AgentReleaseRecordValue,
  AgentRunWorkerDependencies,
  RunRecordValue,
} from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithRuntime,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { runExecutionProfile } from "./agent-run-execution-target.ts";
import { createWorkerDrain } from "./worker-drain.ts";

function builderRelease(release: AgentReleaseRecordValue) {
  const manifest = manifestWithRuntime(
    {
      ...release.data.manifest,
      spec: {
        ...release.data.manifest.spec,
        capabilities: {
          tools: [
            {
              authorization: "none" as const,
              name: "provider.read",
              required: false,
              requiredScopes: [],
            },
          ],
        },
        model: {
          ...release.data.manifest.spec.model,
          options: {
            promptCache: "system" as const,
            provider: { allowFallbacks: false, only: ["anthropic"] },
            reasoningEffort: "high" as const,
          },
        },
      },
    },
    {
      maxModelGenerations: 24,
      maxToolCalls: 48,
      modelTools: ["provider.read"],
      toolResultImages: "screenshots",
    },
  );
  return releaseWithManifest(release, manifest);
}

function runWith(run: RunRecordValue, data: Partial<RunRecordValue["data"]>) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({ data: { ...run.data, ...data }, itemType: "run" as const }),
  );
}

function persistedRun(records: Iterable<PlatformRecord>, runId: string) {
  return [...records].find(
    (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
      record.itemType === "run" && record.data.id === runId,
  );
}

/**
 * Drives the real runtime through one model tool batch; the worker host starts draining while
 * that tool runs, so the run must checkpoint before its next generation. `fireDeadline` stands in
 * for the drain-deadline timer.
 */
function drainingDependencies(
  base: AgentRunWorkerDependencies,
  finalAnswer: string,
  options: { readonly abortSecondGeneration?: boolean } = {},
) {
  const executed: string[] = [];
  const generations: RuntimeModelGenerationRequest[] = [];
  let authorizations = 0;
  let fireDeadline: () => void = () => {
    throw new Error("The drain deadline was not scheduled.");
  };
  const drain = createWorkerDrain({
    now: () => base.now!().getTime(),
    schedule: (callback) => {
      fireDeadline = callback;
      return () => undefined;
    },
    timeoutMs: 100_000,
  });
  const dependencies: AgentRunWorkerDependencies = {
    ...base,
    hostDrain: drain,
    runtime: {
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Read is allowed.",
        toolCallId: id(300 + authorizations++),
      }),
      executeToolCall: async (request) => {
        executed.push(request.idempotencyKey);
        if (!options.abortSecondGeneration) drain.start();
        return { outputSummary: "resource value", status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        generations.push(request);
        if (request.completedToolCalls.length === 0) {
          return {
            assistantMessage: "",
            toolCalls: [
              {
                input: { resource: "account" },
                modelToolCallId: "provider-call-1",
                toolName: "provider.read",
              },
            ],
          };
        }
        if (options.abortSecondGeneration && drain.deadline() === undefined) {
          // The drain deadline passes while this generation is still streaming.
          drain.start();
          fireDeadline();
          throw new Error("model stream aborted", { cause: request.signal?.reason });
        }
        return { assistantMessage: finalAnswer };
      },
      recordArtifact: async () => undefined,
      resolveToolDefinition: async (toolName) => ({
        description: toolName,
        effect: "read",
        inputSchema: {
          additionalProperties: false,
          properties: { resource: { type: "string" } },
          type: "object",
        },
        requiredScopes: [],
        toolName,
      }),
    },
  };
  // A replacement worker host that is not draining.
  const { hostDrain: _drain, ...replacement } = dependencies;
  return { dependencies, executed, generations, replacement };
}

describe("agent run checkpoints", () => {
  it("compiles builder loop limits, model options, and image opt-in into runtime input", async () => {
    const fixture = fixtures();
    const release = builderRelease(fixture.release);
    const claimedAt = "2026-07-22T00:05:00.000Z";
    const run = runWith(fixture.run, {
      attempt: 1,
      claimedAt,
      claimedBy: "worker-test",
      heartbeatAt: claimedAt,
      status: "running",
    });
    const memory = inMemoryDatabase([release, fixture.deployment, fixture.thread, run]);
    const { dependencies } = workerDependencies(memory.database);

    const input = await runtimeInput({
      dependencies,
      messages: [],
      modelAdmission: { imageInput: new Map() },
      profile: runExecutionProfile({ deployment: fixture.deployment, kind: "deployment", release }),
      prompt: "Build it.",
      run,
      userMessage: fixture.userMessage,
    });

    expect(input).toMatchObject({
      maxModelGenerations: 24,
      maxToolCalls: 48,
      modelOptions: {
        promptCache: "system",
        provider: { allowFallbacks: false, only: ["anthropic"] },
        reasoningEffort: "high",
      },
      toolResultImages: "screenshots",
    });
  });

  it("turns workspace memory recall off for a run outside any workspace", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(fixture.release, {
      ...fixture.release.data.manifest,
      spec: { ...fixture.release.data.manifest.spec, memory: { mode: "workspace" } },
    });
    const { workspaceId: _workspaceId, ...withoutWorkspace } = fixture.run.data;
    const memoryModeFor = async (run: RunRecordValue) => {
      const memory = inMemoryDatabase([release, fixture.deployment, fixture.thread, run]);
      const { dependencies } = workerDependencies(memory.database);
      const input = await runtimeInput({
        dependencies,
        messages: [],
        modelAdmission: { imageInput: new Map() },
        profile: runExecutionProfile({
          deployment: fixture.deployment,
          kind: "deployment",
          release,
        }),
        prompt: "Remember this.",
        run,
        userMessage: fixture.userMessage,
      });
      return input.memoryMode;
    };

    expect(fixture.run.data.workspaceId).toBeDefined();
    expect(await memoryModeFor(fixture.run)).toBe("workspace");
    expect(
      await memoryModeFor(
        Schema.decodeUnknownSync(RunRecord)(
          withCanonicalRecordKeys({ data: withoutWorkspace, itemType: "run" as const }),
        ),
      ),
    ).toBe("off");
  });

  it("checkpoints a draining run at its tool-batch boundary and resumes it on another host", async () => {
    const fixture = fixtures();
    const release = builderRelease(fixture.release);
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const { dependencies, executed, generations, replacement } = drainingDependencies(
      base.dependencies,
      "Build finished.",
    );

    const first = await processAgentRun(fixture.queue, dependencies);

    expect(first).toEqual({
      action: "requeued",
      reason: "Run was requeued to resume its checkpointed tool loop.",
      retryAfterSeconds: 0,
    });
    expect(executed).toHaveLength(1);
    expect(generations).toHaveLength(1);
    const checkpointed = persistedRun(memory.records.values(), fixture.run.data.id);
    expect(checkpointed?.data).toMatchObject({ attempt: 1, checkpointCount: 1, status: "queued" });
    expect(checkpointed?.data.claimedBy).toBeUndefined();
    const continuation = checkpointed && runToolContinuation(checkpointed);
    expect(continuation?.completedToolCallIds).toEqual([id(300)]);
    expect(continuation?.modelContinuation).toMatchObject({
      modelCallCount: 1,
      toolRequests: [expect.objectContaining({ toolName: "provider.read" })],
    });
    const records = [...memory.records.values()];
    expect(
      records.find((record) => record.itemType === "tool-call" && record.data.id === id(300)),
    ).toMatchObject({ data: { status: "succeeded" } });
    expect(
      records.find(
        (record) =>
          record.itemType === "runtime-lease" && record.data.runId === fixture.run.data.id,
      ),
    ).toMatchObject({ data: { owner: `queued-run/${fixture.run.data.id}` } });
    expect(
      records.filter(
        (record) =>
          (record.itemType === "semantic-event" || record.itemType === "timeline-event") &&
          record.data.eventType === "run.checkpointed",
      ),
    ).toHaveLength(2);

    const second = await processAgentRun(fixture.queue, replacement);

    expect(second).toMatchObject({ action: "completed" });
    expect(executed).toHaveLength(1);
    expect(generations).toHaveLength(2);
    expect(generations[1]?.completedToolCalls.map((call) => call.toolCallId)).toEqual([id(300)]);
    expect(generations[1]?.toolResultImages).toBe("screenshots");
    expect(persistedRun(memory.records.values(), fixture.run.data.id)?.data).toMatchObject({
      attempt: 2,
      checkpointCount: 1,
      status: "completed",
    });
  });

  it("fails instead of requeueing once the run exhausted its checkpoint budget", async () => {
    const fixture = fixtures();
    const release = builderRelease(fixture.release);
    const run = runWith(fixture.run, { checkpointCount: MAX_AGENT_RUN_CHECKPOINTS });
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const base = workerDependencies(memory.database);
    const { dependencies, executed } = drainingDependencies(base.dependencies, "unused");

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    expect(result.run?.data.error?.message).toContain(
      `${MAX_AGENT_RUN_CHECKPOINTS}-checkpoint limit`,
    );
    expect(result.run?.data.checkpointCount).toBe(MAX_AGENT_RUN_CHECKPOINTS);
    expect(executed).toHaveLength(1);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "tool-call" && record.data.id === id(300),
      ),
    ).toMatchObject({ data: { status: "succeeded" } });
  });

  it("requeues a run aborted at the drain deadline without consuming a retry attempt", async () => {
    const fixture = fixtures();
    const release = builderRelease(fixture.release);
    const run = runWith(fixture.run, { attempt: 29, checkpointCount: 0 });
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const base = workerDependencies(memory.database);
    const { dependencies, executed, generations, replacement } = drainingDependencies(
      base.dependencies,
      "Build finished.",
      { abortSecondGeneration: true },
    );

    const first = await processAgentRun(fixture.queue, dependencies);

    expect(first).toEqual({
      action: "requeued",
      reason: "Run was requeued after its worker host shut down.",
      retryAfterSeconds: 0,
    });
    const interrupted = persistedRun(memory.records.values(), fixture.run.data.id);
    expect(interrupted?.data).toMatchObject({ attempt: 30, checkpointCount: 1, status: "queued" });
    expect(interrupted?.data.claimedBy).toBeUndefined();
    expect(interrupted?.data.error).toBeUndefined();
    const continuation = interrupted && runToolContinuation(interrupted);
    expect(continuation?.completedToolCallIds).toEqual([id(300)]);
    expect(continuation?.modelContinuation).toMatchObject({ modelCallCount: 1 });
    const records = [...memory.records.values()];
    expect(
      records.find((record) => record.itemType === "tool-call" && record.data.id === id(300)),
    ).toMatchObject({ data: { status: "succeeded" } });
    expect(
      records.find(
        (record) =>
          record.itemType === "runtime-lease" && record.data.runId === fixture.run.data.id,
      ),
    ).toMatchObject({ data: { owner: `queued-run/${fixture.run.data.id}` } });
    expect(
      records.some(
        (record) =>
          record.itemType === "semantic-event" &&
          (record.data.eventType === "run.canceled" || record.data.eventType === "run.failed"),
      ),
    ).toBe(false);
    expect(
      records.filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "run.interrupted",
      ),
    ).toHaveLength(1);

    // attempt − checkpointCount (retry attempts burned) stayed at 29 across the interruption.
    const second = await processAgentRun(fixture.queue, replacement);

    expect(second).toMatchObject({ action: "completed" });
    expect(executed).toHaveLength(1);
    expect(generations).toHaveLength(3);
    expect(persistedRun(memory.records.values(), fixture.run.data.id)?.data).toMatchObject({
      attempt: 31,
      checkpointCount: 1,
      status: "completed",
    });
  });

  it("does not charge checkpoint claims against the retry attempt limit", async () => {
    const fixture = fixtures();
    const run = runWith(fixture.run, { attempt: 35, checkpointCount: 10 });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          throw new RuntimeArtifactPublicationError("stream unavailable");
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "requeued", retryAfterSeconds: 60 });
    expect(persistedRun(memory.records.values(), fixture.run.data.id)?.data).toMatchObject({
      attempt: 36,
      checkpointCount: 10,
      status: "queued",
    });
  });
});
