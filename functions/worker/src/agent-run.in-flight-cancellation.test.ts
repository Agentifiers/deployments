import { describe, expect, it } from "bun:test";
import { RunRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  abandonedRunWithLease,
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

describe("retryable agent run failures", () => {
  it("reconciles an in-flight provider response with external cancellation", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { cancelRunBeforeModelInvocationCommitOnce: true },
    );
    const base = workerDependencies(memory.database);

    expect(processAgentRun(fixture.queue, base.dependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "canceled" } },
    });

    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    );
    expect(persistedRun?.data).toMatchObject({ status: "canceled" });
    expect(persistedRun?.data).not.toHaveProperty("claimedBy");
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "model-invocation" && record.data.status === "succeeded",
      ),
    ).toBeDefined();
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "run.cancellation-reconciled",
      ),
    ).toBeDefined();
  });

  it("reconciles cancellation that lands during terminal claim release", async () => {
    for (const options of [
      { cancelRunBeforeCompletionCommitOnce: true },
      { cancelRunBeforeHeartbeatCommitOnce: true },
    ]) {
      const fixture = fixtures();
      const memory = inMemoryDatabase(
        [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
        options,
      );
      const base = workerDependencies(memory.database);

      expect(processAgentRun(fixture.queue, base.dependencies)).resolves.toMatchObject({
        action: "skipped",
        run: { data: { status: "canceled" } },
      });

      const persistedRun = [...memory.records.values()].find(
        (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
      );
      expect(persistedRun?.data).not.toHaveProperty("claimedBy");
      expect(
        [...memory.records.values()].find(
          (record) =>
            record.itemType === "semantic-event" &&
            record.data.eventType === "run.cancellation-reconciled",
        ),
      ).toBeDefined();
    }
  });

  it("persists in-flight tool state before acknowledging external cancellation", async () => {
    const fixture = fixtures();
    const request = {
      effect: "write" as const,
      idempotencyKey: "external-cancellation-tool",
      inputSummary: "Start external work",
      requiredScopes: [],
      toolName: "provider.async",
    };
    const release = releaseWithManifest(
      fixture.release,
      manifestWithToolRequests(fixture.release.data.manifest, [request]),
    );
    const memory = inMemoryDatabase([
      release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        authorizeToolCall: async () => ({
          action: "allow",
          reason: "Allowed.",
          toolCallId: id(80),
        }),
        executeToolCall: async () => {
          memory.cancelRunningRun();
          return {
            externalOperationId: "provider-operation-1",
            status: "running",
          };
        },
        generateAssistantMessage: async () => {
          throw new Error("Canceled asynchronous tool must not reach model generation.");
        },
        recordArtifact: async () => undefined,
        resolveToolDefinition: async () => ({
          description: "Start external provider work.",
          effect: "write",
          inputSchema: { additionalProperties: false, type: "object" },
          requiredScopes: [],
          toolName: "provider.async",
        }),
      },
    };

    expect(processAgentRun(fixture.queue, dependencies)).resolves.toMatchObject({
      action: "skipped",
      run: { data: { status: "canceled" } },
    });

    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "tool-call" &&
          record.data.status === "running" &&
          record.data.externalOperationId === "provider-operation-1",
      ),
    ).toBeDefined();
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "meter-event" && record.data.metric === "worker_ms",
      ),
    ).toBeDefined();
  });

  it("reconciles an externally canceled claim after its thread lease is released", async () => {
    const fixture = fixtures();
    const abandoned = abandonedRunWithLease(fixture);
    const canceled = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...abandoned.run,
        data: {
          ...abandoned.run.data,
          completedAt: "2026-07-22T00:00:00.100Z",
          status: "canceled" as const,
          updatedAt: "2026-07-22T00:00:00.100Z",
          version: abandoned.run.data.version + 1,
        },
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      canceled,
    ]);
    const base = workerDependencies(memory.database);

    expect(
      processAgentRun(fixture.queue, {
        ...base.dependencies,
        runningClaimTimeoutMs: 100,
      }),
    ).resolves.toMatchObject({ action: "skipped", run: { data: { status: "canceled" } } });

    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === canceled.data.id,
    );
    expect(persistedRun?.data).toMatchObject({
      claimedBy: canceled.data.claimedBy,
      status: "canceled",
      version: canceled.data.version,
    });
    expect(
      [...memory.records.values()].find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "run.cancellation-reconciled",
      ),
    ).toBeUndefined();
  });
});
