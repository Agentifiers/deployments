import { describe, expect, it } from "bun:test";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  MessageRecord,
  ThreadRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { threadExecutionLease } from "./agent-run-lease.ts";
import { slackFixture } from "./slack-agent-stream.fixture.ts";

describe("DynamoDB agent run worker", () => {
  it("reads a Slack-triggered run's trigger message once before generating", async () => {
    const test = slackFixture();
    const triggerReads: string[] = [];
    let triggerReadsAtGeneration: readonly string[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...test.dependencies,
      database: {
        ...test.dependencies.database,
        getRecord: async (table, key, consistentRead) => {
          if (key.sk === test.userMessage.sk) triggerReads.push(key.sk);
          return test.dependencies.database.getRecord(table, key, consistentRead);
        },
      },
      runtime: {
        generateAssistantMessage: async () => {
          triggerReadsAtGeneration = [...triggerReads];
          return { assistantMessage: "Slack answer." };
        },
      },
    };

    const result = await processAgentRun(test.queue, dependencies);

    expect(result.action).toBe("completed");
    expect(test.calls[0]?.method).toBe("start");
    expect(triggerReadsAtGeneration).toEqual([test.userMessage.sk]);
  });

  it("terminalizes an unbound triggering message before claiming the run", async () => {
    const fixture = fixtures();
    const unbound = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          body: "Message for another run.",
          contentHash: "unbound-hash",
          id: id(53),
          runId: id(99),
          sequence: 1,
        },
        itemType: "message" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      unbound,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    expect(
      processAgentRun(
        {
          ...fixture.queue,
          userMessageId: unbound.data.id,
          userMessageSequence: unbound.data.sequence,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({
      action: "skipped",
      reason: "Run trigger message is invalid.",
      run: { data: { status: "failed" } },
    });

    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("failed");
    expect(persistedRun?.data.claimedBy).toBeUndefined();
  });

  it("terminalizes a queued run whose trigger message is missing", async () => {
    const fixture = fixtures();
    const lease = threadExecutionLease({
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
      fixture.run,
      lease,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result).toMatchObject({
      action: "skipped",
      reason: "Run trigger message is invalid.",
      run: { data: { status: "failed" } },
    });
    expect(
      [...memory.records.values()].some(
        (record) => record.itemType === "semantic-event" && record.data.eventType === "run.failed",
      ),
    ).toBe(true);
    expect([...memory.records.values()].some((record) => record.itemType === "runtime-lease")).toBe(
      false,
    );
  });

  it("rejects a cross-environment queue message before claiming the run", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    expect(
      processAgentRun({ ...fixture.queue, environmentId: id(99) }, dependencies),
    ).rejects.toThrow("Queue message scope does not match");
    const run = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(run?.data.status).toBe("queued");
  });

  it("terminalizes pinned resources from another project in the same environment", async () => {
    const fixture = fixtures();
    const foreignRelease = Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.release.data, projectId: id(88) },
        itemType: "agent-release" as const,
      }),
    );
    const memory = inMemoryDatabase([
      foreignRelease,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("skipped");
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("failed");
    expect(persistedRun?.data.error?.message).toContain("scope does not match");
  });

  it("terminalizes a queued run whose pinned deployment is inactive", async () => {
    const fixture = fixtures();
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
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("skipped");
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("failed");
    expect(memory.transactionInputs).toHaveLength(1);
  });

  it("terminalizes a queued run whose thread is archived", async () => {
    const fixture = fixtures();
    const archivedThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.thread.data, archived: true, version: fixture.thread.data.version + 1 },
        itemType: "thread" as const,
      }),
    );
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      archivedThread,
      fixture.userMessage,
      fixture.run,
    ]);
    const base = workerDependencies(memory.database);
    let generated = false;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          generated = true;
          return { assistantMessage: "unexpected" };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("skipped");
    expect(generated).toBe(false);
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("failed");
    expect(persistedRun?.data.error?.message).toContain("Archived threads");
  });

  it("terminalizes a queued run when a pinned resource is missing", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("skipped");
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("failed");
    expect(persistedRun?.data.error?.message).toContain("not found");
  });

  it("revalidates the thread pin after claiming and before runtime side effects", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase(
      [fixture.release, fixture.deployment, fixture.thread, fixture.userMessage, fixture.run],
      { repinThreadAfterClaimAgentDeploymentId: id(88) },
    );
    const base = workerDependencies(memory.database);
    let generated = false;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          generated = true;
          return { assistantMessage: "unexpected" };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);
    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });

    expect(generated).toBe(false);
    const persistedRun = [...memory.records.values()].find(
      (record) => record.itemType === "run" && record.data.id === fixture.run.data.id,
    ) as Extract<PlatformRecord, { readonly itemType: "run" }> | undefined;
    expect(persistedRun?.data.status).toBe("failed");
  });
});
