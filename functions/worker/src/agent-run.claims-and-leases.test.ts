import { describe, expect, it } from "bun:test";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  RunRecord,
  RuntimeLeaseRecord,
  TimelineEventRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { pausedToolCallRecord, processAgentRun } from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  abandonedRunWithLease,
  additionalRunOnThread,
  fixtures,
  id,
  inMemoryDatabase,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { threadExecutionLease } from "./agent-run-lease.ts";
import { compileAgentManifestRuntime } from "./agent-manifest-runtime.ts";

describe("DynamoDB agent run worker", () => {
  it("compiles only explicitly enabled capability names for model-native tool selection", () => {
    const fixture = fixtures();
    const manifest = {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        capabilities: {
          tools: [
            {
              authorization: "workspace" as const,
              name: "shopify.products.search",
              required: false,
              requiredScopes: ["read_products"],
            },
          ],
        },
        runtime: {
          ...fixture.release.data.manifest.spec.runtime,
          modelTools: ["shopify.products.search"],
        },
      },
    };

    expect(compileAgentManifestRuntime(manifest).modelToolNames).toEqual([
      "shopify.products.search",
    ]);
  });

  it("does not expose capabilities to the model by default", () => {
    const fixture = fixtures();
    expect(compileAgentManifestRuntime(fixture.release.data.manifest).modelToolNames).toEqual([]);
  });

  it("pins named platform skills ahead of the release's own skills", () => {
    const fixture = fixtures();
    const manifest = {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        platformSkills: ["computer-use" as const],
        skills: ["Prefer the terminal."],
      },
    };
    const [platformSkill, ownSkill, ...rest] = compileAgentManifestRuntime(manifest).skills;
    expect(platformSkill).toStartWith("# Use the computer\n");
    expect(platformSkill).toContain("computer.screenshot");
    expect(ownSkill).toBe("Prefer the terminal.");
    expect(rest).toEqual([]);
  });

  it("defaults enabled sandbox policies to the Lambda MicroVM provider", () => {
    const fixture = fixtures();
    const manifest = {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        sandbox: { mode: "run-ephemeral" as const },
      },
    };
    expect(compileAgentManifestRuntime(manifest).sandboxPolicy).toMatchObject({
      mode: "run-ephemeral",
      provider: "aws_lambda_microvm",
    });
  });

  it("rejects incomplete immutable manifests before they can be persisted", () => {
    const fixture = fixtures();
    expect(() =>
      Schema.decodeUnknownSync(AgentReleaseRecord)(
        withCanonicalRecordKeys({
          data: {
            ...fixture.release.data,
            manifest: { instructions: "Missing model ID." },
          },
          itemType: "agent-release" as const,
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed manifest behavior before execution", () => {
    const fixture = fixtures();
    expect(() =>
      Schema.decodeUnknownSync(AgentReleaseRecord)(
        withCanonicalRecordKeys({
          data: {
            ...fixture.release.data,
            manifest: {
              ...fixture.release.data.manifest,
              spec: {
                ...fixture.release.data.manifest.spec,
                instructions: 42,
                sandbox: "run-ephemeral",
              },
            },
          },
          itemType: "agent-release" as const,
        }),
      ),
    ).toThrow();
  });

  it("rejects runs whose trigger is not declared by the pinned release", async () => {
    const fixture = fixtures();
    const manifest = {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        triggers: ["schedule" as const],
      },
    };
    const release = releaseWithManifest(fixture.release, manifest);
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
  });

  it("retries active running claims and reclaims abandoned ones", async () => {
    const fixture = fixtures();
    const activeRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          claimedAt: "2026-07-22T00:00:00.900Z",
          claimedBy: "worker-old",
          heartbeatAt: "2026-07-22T00:00:00.900Z",
          executionSlot: 0,
          status: "running" as const,
          version: 1,
        },
        itemType: "run" as const,
      }),
    );
    const activeMemory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      activeRun,
    ]);
    const active = workerDependencies(activeMemory.database);
    expect(processAgentRun(fixture.queue, active.dependencies)).rejects.toThrow("active claim");

    const staleRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...activeRun.data, heartbeatAt: "2026-07-21T23:00:00.000Z" },
        itemType: "run" as const,
      }),
    );
    const staleMemory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      staleRun,
    ]);
    const stale = workerDependencies(staleMemory.database);
    const result = await processAgentRun(fixture.queue, stale.dependencies);
    expect(result.action).toBe("completed");
  });

  it("preserves legacy lease scope while claiming a queued run", async () => {
    const fixture = fixtures();
    const legacyLease = threadExecutionLease({
      acquiredAt: "2026-07-22T00:00:00.000Z",
      expiresAt: "2026-07-22T00:15:00.000Z",
      owner: `queued-run/${fixture.run.data.id}`,
      renewedAt: "2026-07-22T00:00:00.000Z",
      runId: fixture.run.data.id,
      threadId: fixture.run.data.threadId,
      version: 1,
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
      legacyLease,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    const claim = memory.transactionInputs.find((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "run" &&
          operation.record.data.status === "running",
      ),
    );
    const lease = claim?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "runtime-lease",
    );
    expect(lease?.kind).toBe("put");
    if (lease?.kind !== "put") throw new Error("Expected a runtime lease claim operation.");
    expect(lease.record.data).not.toHaveProperty("organizationId");
    expect(lease.record.data).not.toHaveProperty("projectId");
    expect(lease.record.data).not.toHaveProperty("environmentId");
  });

  it("releases an abandoned run lease when missing pins terminalize before reclaim", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const abandoned = abandonedRunWithLease(fixture);
    const memory = inMemoryDatabase([
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      abandoned.run,
      abandoned.lease,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => ({
          assistantMessage: `Completed ${request.runId}.`,
        }),
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "failed" } },
    });
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );

    await memory.database.putRecord(fixture.release);
    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
  });

  it("releases an abandoned run lease when invalid pins terminalize before reclaim", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const abandoned = abandonedRunWithLease(fixture);
    const stoppedDeployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.deployment.data,
          currentState: "stopped" as const,
          desiredState: "stopped" as const,
          version: fixture.deployment.data.version + 1,
        },
        itemType: "agent-deployment" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      stoppedDeployment,
      fixture.thread,
      fixture.userMessage,
      abandoned.run,
      abandoned.lease,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => ({
          assistantMessage: `Completed ${request.runId}.`,
        }),
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "failed" } },
    });
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );

    await memory.database.putRecord(fixture.deployment);
    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
  });

  it("holds a durable execution slot across concurrent invocations for one thread", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
      second.userMessage,
      second.run,
    ]);
    const base = workerDependencies(memory.database);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const observedFirst = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async (request) => {
          if (request.runId === fixture.run.data.id) {
            firstStarted();
            await firstBlocked;
          }
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    const first = processAgentRun(fixture.queue, dependencies);
    await observedFirst;
    expect(processAgentRun(second.queue, dependencies)).rejects.toThrow("active claim");
    releaseFirst();
    expect(first).resolves.toMatchObject({ action: "completed" });
    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("rejects a claim whose lease snapshot another worker's claim overtook", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
      second.userMessage,
      second.run,
    ]);
    let releaseFirstClaim!: () => void;
    const firstClaimHeld = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve;
    });
    let markFirstClaimCommitted!: () => void;
    const firstClaimCommitted = new Promise<void>((resolve) => {
      markFirstClaimCommitted = resolve;
    });
    let claims = 0;
    const database: DynamoDatabaseService = {
      ...memory.database,
      transactWrite: async (operations, token, signal) => {
        const claim = operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "run.started",
        );
        if (!claim) return memory.database.transactWrite(operations, token, signal);
        claims += 1;
        if (claims === 1) {
          await firstClaimHeld;
          await memory.database.transactWrite(operations, token, signal);
          markFirstClaimCommitted();
          return;
        }
        releaseFirstClaim();
        await firstClaimCommitted;
        return memory.database.transactWrite(operations, token, signal);
      },
    };
    const dependencies: AgentRunWorkerDependencies = {
      ...workerDependencies(database).dependencies,
      runtime: {
        generateAssistantMessage: async (request) => ({
          assistantMessage: `Completed ${request.runId}.`,
        }),
      },
    };

    const first = processAgentRun(fixture.queue, dependencies);
    const overtaken = processAgentRun(second.queue, dependencies);

    expect(overtaken).rejects.toThrow("simulated create-only write conflict");
    expect(first).resolves.toMatchObject({ action: "completed" });
    const secondRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === second.run.data.id,
    );
    expect(secondRun?.data).toMatchObject({ status: "queued", version: 0 });
  });

  it("recovers an expired earlier-run lease before starting a later run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const earlierRun = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "worker-earlier",
          heartbeatAt: "2026-07-22T00:00:00.000Z",
          status: "running" as const,
          version: 1,
        },
        itemType: "run" as const,
      }),
    );
    const expiredLease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:00:00.050Z",
          id: fixture.thread.data.id,
          leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
          owner: "worker-earlier",
          renewedAt: "2026-07-22T00:00:00.000Z",
          runId: earlierRun.data.id,
          threadId: fixture.thread.data.id,
          version: 0,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      earlierRun,
      second.userMessage,
      second.run,
      expiredLease,
    ]);
    const base = workerDependencies(memory.database);
    const modelRunIds: Ulid[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => {
          modelRunIds.push(request.runId);
          return { assistantMessage: `Completed ${request.runId}.` };
        },
      },
    };

    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    expect(modelRunIds).toEqual([second.run.data.id]);
    const runs = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
        record.itemType === "run",
    );
    expect(runs.find((run) => run.data.id === earlierRun.data.id)?.data.status).toBe("failed");
    expect(runs.find((run) => run.data.id === second.run.data.id)?.data.status).toBe("completed");
    const earlierFailed = base.events.findIndex(
      (event) => event.eventType === "run.failed" && event.runId === earlierRun.data.id,
    );
    const laterStarted = base.events.findIndex(
      (event) => event.eventType === "run.started" && event.runId === second.run.data.id,
    );
    expect(earlierFailed).toBeGreaterThanOrEqual(0);
    expect(laterStarted).toBeGreaterThan(earlierFailed);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("clears an expired orphan thread lease before starting a later run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const orphanLease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:00:00.050Z",
          id: fixture.thread.data.id,
          leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
          owner: "worker-missing",
          renewedAt: "2026-07-22T00:00:00.000Z",
          runId: id(90),
          threadId: fixture.thread.data.id,
          version: 0,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      second.userMessage,
      second.run,
      orphanLease,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => ({
          assistantMessage: `Completed ${request.runId}.`,
        }),
      },
    };

    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
    expect(base.events.some((event) => event.runId === id(90))).toBe(false);
  });

  it("replays an expired paused-run barrier before starting a later run", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const paused = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "worker-paused",
          heartbeatAt: "2026-07-22T00:00:00.000Z",
          status: "waiting-for-tool" as const,
          updatedAt: "2026-07-22T00:00:00.000Z",
          version: 2,
        },
        itemType: "run" as const,
      }),
    );
    const timeline = Schema.decodeUnknownSync(TimelineEventRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-22T00:00:00.000Z",
          data: {
            externalOperationId: "provider-operation-paused",
            message: "Waiting for provider completion.",
            status: "waiting-for-tool",
            toolCallId: id(91),
            toolName: "provider.write",
          },
          environmentId: paused.data.environmentId,
          eventType: "run.waiting-for-tool",
          id: id(92),
          organizationId: paused.data.organizationId,
          projectId: paused.data.projectId,
          runId: paused.data.id,
          sequence: paused.data.version,
          threadId: paused.data.threadId,
        },
        itemType: "timeline-event" as const,
      }),
    );
    const pendingAction = {
      effect: "write" as const,
      externalOperationId: "provider-operation-paused",
      idempotencyKey: "paused-provider-operation",
      inputSummary: "Continue the provider operation.",
      kind: "tool" as const,
      policyReason: "Allowed.",
      requiredScopes: ["provider:write"],
      toolCallId: id(91),
      toolName: "provider.write",
    };
    const toolCall = pausedToolCallRecord({
      action: pendingAction,
      now: new Date("2026-07-22T00:00:00.000Z"),
      run: paused,
    });
    const expiredLease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:00:00.050Z",
          id: fixture.thread.data.id,
          leaseKey: `agent-run-thread/${fixture.thread.data.id}`,
          owner: paused.data.claimedBy!,
          renewedAt: "2026-07-22T00:00:00.000Z",
          runId: paused.data.id,
          threadId: fixture.thread.data.id,
          version: 1,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      paused,
      timeline,
      toolCall,
      second.userMessage,
      second.run,
      expiredLease,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runningClaimTimeoutMs: 50,
      runtime: {
        generateAssistantMessage: async (request) => ({
          assistantMessage: `Completed ${request.runId}.`,
        }),
      },
    };

    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    const priorPaused = base.events.findIndex(
      (event) => event.eventType === "tool.running" && event.runId === paused.data.id,
    );
    const laterStarted = base.events.findIndex(
      (event) => event.eventType === "run.started" && event.runId === second.run.data.id,
    );
    expect(priorPaused).toBeGreaterThanOrEqual(0);
    expect(laterStarted).toBeGreaterThan(priorPaused);
  });
});
