import { describe, expect, it } from "bun:test";
import type { RuntimeArtifact } from "@deployments-ai/agent-runtime";
import {
  RunRecord,
  TimelineEventRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  pausedToolCallRecord,
  pendingApprovalRecord,
  processAgentRun,
  resolveRunApproval,
  resolveRunToolResult,
} from "./index.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies } from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  manifestWithTriggers,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("replays persisted approval and asynchronous-tool pauses to the thread stream", async () => {
    const fixture = fixtures();
    const scenarios = [
      {
        data: { approvalId: id(70) },
        eventType: "approval.requested",
        kind: "approval",
        status: "waiting-for-approval",
      },
      {
        data: { externalOperationId: "provider-operation-1" },
        eventType: "tool.running",
        kind: "tool",
        status: "waiting-for-tool",
      },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const paused = Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          data: {
            ...fixture.run.data,
            heartbeatAt: "2026-07-22T00:00:01.000Z",
            status: scenario.status,
            updatedAt: "2026-07-22T00:00:01.000Z",
            version: 1,
          },
          itemType: "run" as const,
        }),
      );
      const timeline = Schema.decodeUnknownSync(TimelineEventRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-22T00:00:01.000Z",
            data: {
              ...scenario.data,
              status: scenario.status,
              toolCallId: id(72 + index),
              toolName: "provider.write",
            },
            environmentId: paused.data.environmentId,
            eventType: `run.${scenario.status}`,
            id: id(74 + index),
            organizationId: paused.data.organizationId,
            projectId: paused.data.projectId,
            runId: paused.data.id,
            sequence: paused.data.version,
            threadId: paused.data.threadId,
          },
          itemType: "timeline-event" as const,
        }),
      );
      const common = {
        effect: "write" as const,
        idempotencyKey: `paused-tool-${index}`,
        inputSummary: "Persisted paused tool request.",
        policyReason: "Persisted policy decision.",
        requiredScopes: ["provider:write"],
        toolCallId: id(72 + index),
        toolName: "provider.write",
      };
      const action =
        scenario.kind === "approval"
          ? ({ ...common, approvalId: id(70), kind: "approval" as const } as const)
          : ({
              ...common,
              externalOperationId: "provider-operation-1",
              kind: "tool" as const,
            } as const);
      const toolCall = pausedToolCallRecord({
        action,
        now: new Date("2026-07-22T00:00:01.000Z"),
        run: paused,
      });
      const approval =
        action.kind === "approval"
          ? pendingApprovalRecord({
              action,
              now: new Date("2026-07-22T00:00:01.000Z"),
              run: paused,
            })
          : undefined;
      const memory = inMemoryDatabase([
        paused,
        timeline,
        toolCall,
        ...(approval ? [approval] : []),
      ]);
      const { dependencies, events } = workerDependencies(memory.database);

      const first = await processAgentRun(fixture.queue, dependencies);
      const replay = await processAgentRun(fixture.queue, dependencies);

      expect(first.action).toBe("paused");
      expect(replay.action).toBe("paused");
      expect(events.map((event) => event.eventType)).toEqual([
        scenario.eventType,
        scenario.eventType,
      ]);
      expect(events[0]?.eventId).toBe(`run-paused:${paused.data.id}:1:${scenario.kind}`);
      expect(events[1]?.eventId).toBe(events[0]?.eventId);
      expect(events[0]?.toolCallId).toBe(id(72 + index));
      if (scenario.kind === "approval") expect(events[0]?.approvalId).toBe(id(70));
      else expect(events[0]?.payload).toMatchObject({ pendingAction: scenario.data });
    }
  });

  it("resumes an approved multi-tool run without repeating completed effects or policy", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithTriggers(
        manifestWithToolRequests(fixture.release.data.manifest, [
          {
            effect: "read",
            idempotencyKey: "tool/read-before-approval",
            input: { resource: "deployment" },
            inputSummary: "Read the deployment.",
            requiredScopes: ["deployment:read"],
            toolName: "deployment.read",
          },
          {
            effect: "write",
            idempotencyKey: "tool/write-after-approval",
            input: { environment: "production" },
            inputSummary: "Deploy to production.",
            requiredScopes: ["deployment:write"],
            toolName: "deployment.start",
          },
        ]),
        ["api"],
      ),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const authorized: string[] = [];
    const executed: string[] = [];
    const recordedArtifactIndexes: number[] = [];
    const persistedArtifacts = new Map<number, RuntimeArtifact>();
    const executionBinding = {
      authorizationFingerprint: "sha256:deployment-production:v1",
      connectionId: id(74),
      externalAccountId: "deployment-production-account",
      toolAdapterId: id(75),
      toolPlanFingerprint: "sha256:deployment-start:plan-v1",
    } as const;
    let modelCompletedCalls: readonly { readonly toolName: string }[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async (request) => {
          authorized.push(request.toolName);
          if (request.toolName === "deployment.read") {
            return {
              action: "allow",
              reason: "Read policy allows this call.",
              toolCallId: id(70),
            };
          }
          return {
            action: "require-approval",
            approvalId: id(72),
            executionBinding,
            reason: "Production deployment requires approval.",
            toolCallId: id(71),
          };
        },
        executeToolCall: async (request) => {
          executed.push(request.toolName);
          if (request.toolName === "deployment.start") {
            expect(request.decision.executionBinding).toEqual(executionBinding);
          }
          return {
            artifacts: [
              {
                content: `${request.toolName} evidence`,
                fileName: `${request.toolName}.txt`,
                label: `${request.toolName} evidence`,
              },
            ],
            outputSummary:
              request.toolName === "deployment.read"
                ? "Deployment is ready."
                : "Production deployment started.",
            status: "completed",
          };
        },
        generateAssistantMessage: async (request) => {
          modelCompletedCalls = request.completedToolCalls;
          expect(request.sandboxArtifacts.map((artifact) => artifact.fileName)).toEqual([
            "deployment.read.txt",
            "deployment.start.txt",
          ]);
          return { assistantMessage: "Both tool calls completed." };
        },
        loadArtifact: async (index) => persistedArtifacts.get(index)!,
        recordArtifact: async (artifact, index) => {
          persistedArtifacts.set(index, artifact);
          recordedArtifactIndexes.push(index);
        },
        resolveToolDefinition: async (toolName) => ({
          effect: toolName === "deployment.read" ? "read" : "write",
          requiredScopes:
            toolName === "deployment.read" ? ["deployment:read"] : ["deployment:write"],
          toolName,
        }),
      },
    };

    const first = await processAgentRun(fixture.queue, dependencies);

    expect(first).toMatchObject({ action: "paused", status: "waiting-for-approval" });
    if (first.action !== "paused") throw new Error("Run did not pause for approval.");
    expect(first.run.data.toolContinuation).toEqual({
      artifactContinuation: {
        artifactBytes: "deployment.read evidence".length,
        artifactIndexCursor: 1,
        artifacts: [
          {
            contentType: "application/octet-stream",
            fileName: "deployment.read.txt",
            label: "deployment.read evidence",
            type: "report",
          },
        ],
      },
      completedToolCallIds: [id(70)],
      pendingAction: { kind: "approval", toolCallId: id(71) },
      version: 3,
    });
    expect(JSON.stringify(first.run.data.toolContinuation)).not.toContain("production");
    expect(authorized).toEqual(["deployment.read", "deployment.start"]);
    expect(executed).toEqual(["deployment.read"]);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "tool-call" && record.data.id === id(70),
      ),
    ).toMatchObject({ data: { status: "succeeded" } });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "tool-call" && record.data.id === id(71),
      ),
    ).toMatchObject({
      data: {
        authorizationFingerprint: executionBinding.authorizationFingerprint,
        connectionId: executionBinding.connectionId,
        externalAccountId: executionBinding.externalAccountId,
        status: "waiting",
        toolAdapterId: executionBinding.toolAdapterId,
        toolPlanFingerprint: executionBinding.toolPlanFingerprint,
      },
    });

    const enqueued: AgentRunQueueMessage[] = [];
    const resolved = await resolveRunApproval(
      {
        approvalId: id(72),
        decision: "approved",
        environmentId: fixture.queue.environmentId,
        organizationId: fixture.queue.organizationId,
        projectId: fixture.queue.projectId,
        resolvedByPrincipalId: id(73),
        runId: fixture.queue.runId,
        threadId: fixture.queue.threadId,
      },
      {
        appendThreadEvent: base.dependencies.appendThreadEvent!,
        database: memory.database,
        enqueueRun: async ({ message }) => void enqueued.push(message),
        generateId: base.dependencies.generateId,
        now: base.dependencies.now!,
      },
    );

    const resumeQueueMessage = resolved.queueMessage;
    expect(resumeQueueMessage).toBeDefined();
    if (!resumeQueueMessage) throw new Error("Approved run did not return a queue message.");
    expect(enqueued).toEqual([resumeQueueMessage]);
    const second = await processAgentRun(resumeQueueMessage, dependencies);

    expect(second.action).toBe("completed");
    expect(authorized).toEqual(["deployment.read", "deployment.start"]);
    expect(executed).toEqual(["deployment.read", "deployment.start"]);
    expect(modelCompletedCalls.map((call) => call.toolName)).toEqual([
      "deployment.read",
      "deployment.start",
    ]);
    const completedToolCalls = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "tool-call" }> =>
        record.itemType === "tool-call" && record.data.status === "succeeded",
    );
    expect(completedToolCalls.map((record) => record.data.id).toSorted()).toEqual(
      [id(70), id(71)].toSorted(),
    );
    expect(completedToolCalls.find((record) => record.data.id === id(71))).toMatchObject({
      data: {
        authorizationFingerprint: executionBinding.authorizationFingerprint,
        connectionId: executionBinding.connectionId,
        externalAccountId: executionBinding.externalAccountId,
        toolAdapterId: executionBinding.toolAdapterId,
        toolPlanFingerprint: executionBinding.toolPlanFingerprint,
      },
    });
    expect(recordedArtifactIndexes).toEqual([0, 1]);
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "tool-call.completed",
      ),
    ).toHaveLength(2);
    const completionTimeline = [...memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "timeline-event" }> =>
        record.itemType === "timeline-event" && record.data.eventType === "run.completed",
    );
    expect(completionTimeline?.data.data).toMatchObject({
      completedToolCallIds: JSON.stringify([id(70), id(71)]),
    });
    expect(completionTimeline?.data.data).not.toHaveProperty("completedToolCalls");
  });

  it("updates an approved tool call when the executor outcome is unknown", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithToolRequests(fixture.release.data.manifest, [
        {
          effect: "write",
          idempotencyKey: "tool/approved-async",
          input: { environment: "production" },
          inputSummary: "Deploy to production asynchronously.",
          requiredScopes: ["deployment:write"],
          toolName: "deployment.start-async",
        },
      ]),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let authorizations = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async () => {
          authorizations += 1;
          return {
            action: "require-approval",
            approvalId: id(82),
            reason: "Production deployment requires approval.",
            toolCallId: id(81),
          };
        },
        executeToolCall: async () => {
          throw new Error("provider request outcome unknown");
        },
        generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          effect: "write",
          requiredScopes: ["deployment:write"],
          toolName,
        }),
      },
    };

    const first = await processAgentRun(fixture.queue, dependencies);
    expect(first).toMatchObject({ action: "paused", status: "waiting-for-approval" });
    const enqueued: AgentRunQueueMessage[] = [];
    const resolved = await resolveRunApproval(
      {
        approvalId: id(82),
        decision: "approved",
        environmentId: fixture.queue.environmentId,
        organizationId: fixture.queue.organizationId,
        projectId: fixture.queue.projectId,
        resolvedByPrincipalId: id(83),
        runId: fixture.queue.runId,
        threadId: fixture.queue.threadId,
      },
      {
        appendThreadEvent: base.dependencies.appendThreadEvent!,
        database: memory.database,
        enqueueRun: async ({ message }) => void enqueued.push(message),
        generateId: base.dependencies.generateId,
        now: base.dependencies.now!,
      },
    );
    const resumeQueueMessage = resolved.queueMessage;
    expect(resumeQueueMessage).toBeDefined();
    if (!resumeQueueMessage) throw new Error("Approval did not return a queue message.");

    const second = await processAgentRun(resumeQueueMessage, dependencies);

    expect(second).toMatchObject({ action: "paused", status: "waiting-for-tool" });
    expect(authorizations).toBe(1);
    expect(enqueued).toEqual([resumeQueueMessage]);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "tool-call" && record.data.id === id(81),
      ),
    ).toMatchObject({
      data: {
        approvalId: id(82),
        externalOperationId: `unknown:${id(81)}`,
        policyAction: "require-approval",
        status: "running",
        version: 2,
      },
    });
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.aggregateId === id(81) &&
          record.data.aggregateVersion === 3 &&
          record.data.eventType === "tool-call.running",
      ),
    ).toBe(true);
  });

  it("resumes an asynchronously completed multi-tool run without repeating effects", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithTriggers(
        manifestWithToolRequests(fixture.release.data.manifest, [
          {
            effect: "read",
            idempotencyKey: "tool/read-before-async",
            inputSummary: "Read current deployment state.",
            requiredScopes: ["deployment:read"],
            toolName: "deployment.read",
          },
          {
            effect: "write",
            idempotencyKey: "tool/start-async",
            input: { environment: "staging" },
            inputSummary: "Start a staging deployment.",
            requiredScopes: ["deployment:write"],
            toolName: "deployment.start-async",
          },
        ]),
        ["api"],
      ),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const authorized: string[] = [];
    const executed: string[] = [];
    let modelCompletedCalls: readonly { readonly toolName: string }[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async (request) => {
          authorized.push(request.toolName);
          return {
            action: "allow",
            reason: "Pinned policy allows this call.",
            toolCallId: request.toolName === "deployment.read" ? id(74) : id(75),
          };
        },
        executeToolCall: async (request) => {
          executed.push(request.toolName);
          return request.toolName === "deployment.read"
            ? { outputSummary: "Deployment is ready.", status: "completed" }
            : {
                externalOperationId: "provider-deployment-75",
                status: "running",
              };
        },
        generateAssistantMessage: async (request) => {
          modelCompletedCalls = request.completedToolCalls;
          return { assistantMessage: "The asynchronous deployment completed." };
        },
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          effect: toolName === "deployment.read" ? "read" : "write",
          requiredScopes:
            toolName === "deployment.read" ? ["deployment:read"] : ["deployment:write"],
          toolName,
        }),
      },
    };

    const first = await processAgentRun(fixture.queue, dependencies);

    expect(first).toMatchObject({ action: "paused", status: "waiting-for-tool" });
    expect(authorized).toEqual(["deployment.read", "deployment.start-async"]);
    expect(executed).toEqual(["deployment.read", "deployment.start-async"]);

    const enqueued: AgentRunQueueMessage[] = [];
    const resolved = await resolveRunToolResult(
      {
        environmentId: fixture.queue.environmentId,
        externalOperationId: "provider-deployment-75",
        organizationId: fixture.queue.organizationId,
        outcome: "completed",
        outputSummary: "Staging deployment completed.",
        projectId: fixture.queue.projectId,
        runId: fixture.queue.runId,
        threadId: fixture.queue.threadId,
        toolCallId: id(75),
      },
      {
        appendThreadEvent: base.dependencies.appendThreadEvent!,
        database: memory.database,
        enqueueRun: async ({ message }) => void enqueued.push(message),
        generateId: base.dependencies.generateId,
        now: base.dependencies.now!,
      },
    );
    const resumeQueueMessage = resolved.queueMessage;
    expect(resumeQueueMessage).toBeDefined();
    if (!resumeQueueMessage) throw new Error("Completed tool did not return a queue message.");
    expect(enqueued).toEqual([resumeQueueMessage]);

    const second = await processAgentRun(resumeQueueMessage, dependencies);

    expect(second.action).toBe("completed");
    expect(authorized).toEqual(["deployment.read", "deployment.start-async"]);
    expect(executed).toEqual(["deployment.read", "deployment.start-async"]);
    expect(modelCompletedCalls.map((call) => call.toolName)).toEqual([
      "deployment.read",
      "deployment.start-async",
    ]);
    const completedToolCalls = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "tool-call" }> =>
        record.itemType === "tool-call" && record.data.status === "succeeded",
    );
    expect(completedToolCalls.map((record) => record.data.id).toSorted()).toEqual(
      [id(74), id(75)].toSorted(),
    );
    expect(
      [...memory.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "tool-call.completed",
      ),
    ).toHaveLength(2);
  });
});
