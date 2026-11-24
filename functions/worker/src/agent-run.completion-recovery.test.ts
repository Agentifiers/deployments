import { describe, expect, it } from "bun:test";
import { type PlatformRecord, type Ulid } from "@deployments-ai/db";
import { processAgentRun } from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  abandonedRunWithLease,
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  releaseWithManifest,
  storeKey,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { persistFailedRun } from "./agent-run-terminal.ts";
import { threadExecutionLease } from "./agent-run-lease.ts";
import { runToolContinuation } from "./continuation.ts";

describe("DynamoDB agent run worker", () => {
  it("preserves terminal artifact continuation state for manual recovery", async () => {
    const fixture = fixtures();
    const { lease, run } = abandonedRunWithLease(fixture);
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
      lease,
    ]);
    const base = workerDependencies(memory.database);
    const artifactContinuation = {
      artifactBytes: 8,
      artifactIndexCursor: 1,
      artifacts: [
        {
          contentType: "application/octet-stream",
          fileName: "sandbox-command-1.txt",
          label: "Sandbox command 1",
          type: "report",
        },
      ],
      sandboxCompleted: true,
    } as const;

    const failed = await persistFailedRun(
      base.dependencies,
      run,
      new Error("artifact publication failed"),
      lease,
      [],
      [],
      artifactContinuation,
    );

    expect(runToolContinuation(failed).artifactContinuation).toEqual(artifactContinuation);
  });

  it("persists completed tool effects when later model generation fails", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithToolRequests(fixture.release.data.manifest, [
        {
          effect: "write",
          idempotencyKey: "tool/completed-before-model-failure",
          input: { environment: "staging" },
          inputSummary: "Start the staging deployment.",
          requiredScopes: ["deployment:write"],
          toolName: "deployment.start",
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
    let executions = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async () => ({
          action: "allow",
          reason: "Pinned policy allows this call.",
          toolCallId: id(76),
        }),
        executeToolCall: async () => {
          executions += 1;
          return {
            externalOperationId: "provider-deployment-completed-76",
            outputSummary: "Staging deployment started.",
            status: "completed",
          };
        },
        generateAssistantMessage: async () => {
          throw new Error("model generation unavailable");
        },
        recordArtifact: async () => undefined,
        resolveToolDefinition: async (toolName) => ({
          effect: "write",
          requiredScopes: ["deployment:write"],
          toolName,
        }),
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    expect(executions).toBe(1);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "tool-call" && record.data.id === id(76),
      ),
    ).toMatchObject({
      data: {
        externalOperationId: "provider-deployment-completed-76",
        outputSummary: "Staging deployment started.",
        status: "succeeded",
      },
    });
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "tool-call.completed" &&
          record.data.aggregateId === id(76),
      ),
    ).toMatchObject({
      data: { payload: { externalOperationId: "provider-deployment-completed-76" } },
    });

    await processAgentRun(fixture.queue, dependencies);
    expect(executions).toBe(1);
  });

  it("retries completion against a concurrently advanced thread", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { conflictOnceOnThreadCompletion: true },
    );
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    const assistant = [...memory.records.values()].find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    ) as Extract<PlatformRecord, { readonly itemType: "message" }> | undefined;
    expect(assistant?.data.sequence).toBe(2);
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("completed");
  });

  it("retries an unchanged completion transaction after a transient write failure", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { failCompletionBeforeCommitOnce: true },
    );
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    expect(
      memory.transactionInputs.filter((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "completed",
        ),
      ),
    ).toHaveLength(2);
  });

  it("does not delete an externalized body when completion reconciliation is unavailable", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      {
        failCompletionReconciliationReadOnce: true,
        throwAfterCompletionCommitOnce: true,
      },
    );
    const base = workerDependencies(memory.database);
    const assistantBody = "x".repeat(300_000);
    let deletes = 0;
    let generations = 0;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      deleteMessageBody: async () => {
        deletes += 1;
      },
      runtime: {
        generateAssistantMessage: async () => {
          generations += 1;
          return { assistantMessage: assistantBody };
        },
      },
      writeMessageBody: async (input) => ({
        bucket: "message-bodies",
        byteSize: new TextEncoder().encode(input.body).byteLength,
        contentType: "text/plain; charset=utf-8",
        key: `messages/${input.messageId}`,
        sha256: input.contentHash,
        versionId: "ambiguous-completion-version",
      }),
    };

    expect(processAgentRun(fixture.queue, dependencies)).rejects.toThrow(
      "completion outcome could not be reconciled",
    );

    expect(deletes).toBe(0);
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    const assistant = [...memory.records.values()].find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    ) as Extract<PlatformRecord, { readonly itemType: "message" }> | undefined;
    expect(persistedRun?.data.status).toBe("completed");
    expect(assistant?.data.bodyRef).toMatchObject({
      versionId: "ambiguous-completion-version",
    });
    expect(
      [...memory.records.values()].filter((record) => record.itemType === "model-invocation"),
    ).toHaveLength(1);

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "skipped",
    });
    expect(generations).toBe(1);
  });

  it("deletes an externalized body while still owning a definitively rejected completion", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      {
        conflictOnceOnThreadCompletion: true,
        conflictThreadAgentDeploymentId: id(88),
      },
    );
    const base = workerDependencies(memory.database);
    const assistantBody = "x".repeat(300_000);
    const deletedMessageIds: Ulid[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      deleteMessageBody: async (input) => {
        deletedMessageIds.push(input.messageId);
      },
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: assistantBody }),
      },
      writeMessageBody: async (input) => ({
        bucket: "message-bodies",
        byteSize: new TextEncoder().encode(input.body).byteLength,
        contentType: "text/plain; charset=utf-8",
        key: `messages/${input.messageId}`,
        sha256: input.contentHash,
        versionId: "repinned-version",
      }),
    };

    const result = await processAgentRun(fixture.queue, dependencies);
    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });

    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("failed");
    expect(deletedMessageIds).toEqual([expect.any(String)]);
    expect(
      [...memory.records.values()].some(
        (record) => record.itemType === "message" && record.data.role === "assistant",
      ),
    ).toBe(false);
  });

  it("preserves a later thread timestamp when retrying completion", async () => {
    const fixture = fixtures();
    const concurrentUpdatedAt = "2026-07-22T00:00:05.000Z";
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      {
        conflictOnceOnThreadCompletion: true,
        conflictThreadUpdatedAt: concurrentUpdatedAt,
      },
    );
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    const persistedThread = [...memory.records.values()].find(
      (record) => record.itemType === "thread" && record.data.id === fixture.thread.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "thread" }> | undefined;
    expect(persistedThread?.data.updatedAt).toBe(concurrentUpdatedAt);
  });

  it("replays the stable finalized event on queue redelivery without duplicating records", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const first = workerDependencies(memory.database);
    await processAgentRun(fixture.queue, first.dependencies);
    const recordCount = memory.records.size;
    const messageQueriesBeforeReplay = memory.queryInputs.filter((input) => {
      const values = (input as { readonly ExpressionAttributeValues?: Record<string, unknown> })
        .ExpressionAttributeValues;
      return values?.[":prefix"] === "MESSAGE#";
    }).length;
    const second = workerDependencies(memory.database);

    const replay = await processAgentRun(fixture.queue, second.dependencies);

    expect(replay.action).toBe("skipped");
    expect(memory.records.size).toBe(recordCount);
    expect(
      memory.queryInputs.filter((input) => {
        const values = (input as { readonly ExpressionAttributeValues?: Record<string, unknown> })
          .ExpressionAttributeValues;
        return values?.[":prefix"] === "MESSAGE#";
      }),
    ).toHaveLength(messageQueriesBeforeReplay);
    const finalized = second.events.filter(
      (event) => event.eventType === "assistant-message.finalized",
    );
    expect(finalized).toHaveLength(1);
    const persistedMessage = [...memory.records.values()].find(
      (record) => record.itemType === "message" && record.data.role === "assistant",
    ) as Extract<PlatformRecord, { readonly itemType: "message" }> | undefined;
    expect(finalized[0]?.eventId).toBe(persistedMessage?.data.streamEventId);
  });

  it("retries a missed memory flush without generating the completed response again", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(fixture.release, {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        memory: { mode: "agent" },
      },
    });
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);
    let flushAttempts = 0;
    let generations = 0;
    const retryingDependencies = {
      ...dependencies,
      enqueueMemoryFlush: async () => {
        flushAttempts += 1;
        if (flushAttempts <= 2) throw new Error("memory flush enqueue unavailable");
        return "enqueued" as const;
      },
      runtime: {
        ...dependencies.runtime,
        generateAssistantMessage: async () => {
          generations += 1;
          return { assistantMessage: "Persisted assistant result." };
        },
        recallMemory: async () => [],
      },
    };

    expect(processAgentRun(fixture.queue, retryingDependencies)).rejects.toThrow(
      "memory flush enqueue unavailable",
    );
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
    const completedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    );
    if (completedRun?.itemType !== "run") throw new Error("Completed run was not persisted.");
    const recoveryLease = threadExecutionLease({
      acquiredAt: completedRun.data.claimedAt ?? completedRun.data.createdAt,
      expiresAt: completedRun.data.heartbeatAt ?? completedRun.data.updatedAt,
      owner: completedRun.data.claimedBy ?? `expired-run/${completedRun.data.id}`,
      runId: completedRun.data.id,
      threadId: completedRun.data.threadId,
      version: 0,
    });
    memory.records.set(storeKey("execution", recoveryLease.pk, recoveryLease.sk), recoveryLease);
    expect(processAgentRun(fixture.queue, retryingDependencies)).rejects.toThrow(
      "memory flush enqueue unavailable",
    );
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
    expect(processAgentRun(fixture.queue, retryingDependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "completed" } },
    });

    expect(flushAttempts).toBe(3);
    expect(generations).toBe(1);
  });

  it("recovers a settled external publication without generating its response again", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(fixture.release, {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        memory: { mode: "agent", reviewMode: "auto-approve" },
        runtime: {
          ...fixture.release.data.manifest.spec.runtime,
          contextCheckpointMode: "auto",
        },
      },
    });
    const run = {
      ...fixture.run,
      data: {
        ...fixture.run.data,
        responsePublication: "external" as const,
      },
    } as typeof fixture.run;
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      run,
    ]);
    const base = workerDependencies(memory.database);
    let generations = 0;
    const flushes: { checkpointMode?: "auto" | "off"; memoryMode: string }[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      enqueueMemoryFlush: async (_completed, memoryMode, checkpointMode) => {
        flushes.push({ ...(checkpointMode ? { checkpointMode } : {}), memoryMode });
        return "enqueued";
      },
      runtime: {
        ...base.dependencies.runtime,
        generateAssistantMessage: async () => {
          generations += 1;
          return { assistantMessage: "A concise external response." };
        },
        recallMemory: async () => [],
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });
    expect(flushes).toEqual([]);

    expect(
      processAgentRun(
        { ...fixture.queue, recoveryReason: "external-publication-settled" },
        dependencies,
      ),
    ).resolves.toMatchObject({ action: "skipped", run: { data: { status: "completed" } } });

    expect(flushes).toEqual([{ checkpointMode: "auto", memoryMode: "agent" }]);
    expect(generations).toBe(1);
  });
});
