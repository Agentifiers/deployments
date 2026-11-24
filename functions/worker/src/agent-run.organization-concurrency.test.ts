import { describe, expect, it } from "bun:test";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import {
  makeStandingTenantLimitResolver,
  MessageRecord,
  OrganizationStandingRecord,
  RunRecord,
  ThreadRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import type { TenantLimitResolver } from "@deployments-ai/tenant-limits";
import { Schema } from "effect";
import {
  fifoQueueRecord,
  fixtures,
  id,
  inMemoryDatabase,
  manifestWithToolRequests,
  manifestWithTriggers,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { processAgentRunQueueDelivery } from "./queue.ts";
import { recordingTenantLimitMetrics, testTenantLimits } from "./tenant-limits.fixture.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

type Runtime = AgentRunWorkerDependencies["runtime"];

const ORGANIZATION_ID = id(1);
const SLOT_NAMESPACE = `organization:${ORGANIZATION_ID}:run-execution-slot`;

function runOnOwnThread(index: number, data: Partial<RunRecordValue["data"]> = {}) {
  const fixture = fixtures();
  const base = 900 + index * 10;
  const runId = id(base);
  const thread = Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: { ...fixture.thread.data, id: id(base + 1), streamId: id(base + 2) },
      itemType: "thread" as const,
    }),
  );
  const message = Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.userMessage.data,
        contentHash: `user-hash-${index}`,
        id: id(base + 3),
        runId,
        threadId: thread.data.id,
      },
      itemType: "message" as const,
    }),
  );
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.run.data,
        id: runId,
        idempotencyKey: `run/request-${base}`,
        threadId: thread.data.id,
        ...data,
      },
      itemType: "run" as const,
    }),
  );
  const queue: AgentRunQueueMessage = {
    ...fixture.queue,
    idempotencyKey: run.data.idempotencyKey,
    runId,
    threadId: thread.data.id,
    userMessageId: message.data.id,
    userMessageSequence: message.data.sequence,
  };
  return { queue, records: [thread, message, run] as PlatformRecord[], run };
}

function runningElsewhere(index: number, executionSlot: number) {
  return runOnOwnThread(index, {
    claimedAt: "2026-07-22T00:00:00.900Z",
    claimedBy: "worker-other",
    executionSlot,
    heartbeatAt: "2026-07-22T00:00:00.900Z",
    status: "running",
    version: 1,
  });
}

function harness(
  records: readonly PlatformRecord[],
  concurrentRuns: number,
  resolve?: (database: DynamoDatabaseService) => TenantLimitResolver,
) {
  const fixture = fixtures();
  const memory = inMemoryDatabase([
    fixture.deployment,
    fixture.thread,
    fixture.userMessage,
    ...records,
  ]);
  const limits = testTenantLimits({ concurrentRuns });
  const metrics = recordingTenantLimitMetrics();
  const handBacks: number[] = [];
  const base = workerDependencies(memory.database);
  const tenantLimits = resolve?.(memory.database) ?? limits.resolver;
  const dependencies = (runtime: Runtime): AgentRunWorkerDependencies => ({
    ...base.dependencies,
    retryQueueMessage: async (_record, _message, retryAfterSeconds) =>
      void handBacks.push(retryAfterSeconds),
    runtime,
    tenantLimitMetrics: metrics.metrics,
    tenantLimits,
  });
  const deliver = (queue: AgentRunQueueMessage, runtime: Runtime, receiveCount = 1) =>
    processAgentRunQueueDelivery(
      { ...fifoQueueRecord(queue, queue.runId, queue.runId), receiveCount },
      dependencies(runtime),
    );
  const stored = (runId: string) =>
    [...memory.records.values()].find(
      (record): record is RunRecordValue => record.itemType === "run" && record.data.id === runId,
    );
  const heldSlots = () =>
    [...memory.records.values()]
      .flatMap((record) =>
        record.itemType === "unique-claim" && record.data.namespace === SLOT_NAMESPACE
          ? [`${record.data.value}:${record.data.ownerId}`]
          : [],
      )
      .sort();
  return { deliver, handBacks, heldSlots, limits, memory, metrics: metrics.hits, stored };
}

const answers: Runtime = {
  generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
};

function gatedRuntime(runIds: readonly string[]) {
  const gates = new Map(runIds.map((runId) => [runId, Promise.withResolvers<void>()]));
  const started = new Map(runIds.map((runId) => [runId, Promise.withResolvers<void>()]));
  const runtime: Runtime = {
    generateAssistantMessage: async (request) => {
      started.get(request.runId)?.resolve();
      await gates.get(request.runId)?.promise;
      return { assistantMessage: `Completed ${request.runId}.` };
    },
  };
  return {
    release: (runId: string) => gates.get(runId)!.resolve(),
    runtime,
    started: (runId: string) => started.get(runId)!.promise,
  };
}

describe("organization concurrent-run limit", () => {
  it("claims up to the limit and hands the next run back for 30 to 60 seconds without writing", async () => {
    const fixture = fixtures();
    const [first, second, third] = [1, 2, 3].map((index) => runOnOwnThread(index));
    const test = harness(
      [fixture.release, ...first!.records, ...second!.records, ...third!.records],
      2,
    );
    const gate = gatedRuntime([first!.run.data.id, second!.run.data.id]);
    const firstDelivery = test.deliver(first!.queue, gate.runtime);
    const secondDelivery = test.deliver(second!.queue, gate.runtime);
    await Promise.all([gate.started(first!.run.data.id), gate.started(second!.run.data.id)]);
    const writesBefore = test.memory.transactionInputs.length;
    const recordsBefore = new Map(test.memory.records);

    const deferred = await test.deliver(third!.queue, answers);

    expect(deferred).toBe("returned");
    expect(test.handBacks).toHaveLength(1);
    expect(test.handBacks[0]).toBeGreaterThanOrEqual(30);
    expect(test.handBacks[0]).toBeLessThanOrEqual(60);
    expect(test.memory.transactionInputs).toHaveLength(writesBefore);
    expect(test.memory.records).toEqual(recordsBefore);
    expect(test.stored(third!.run.data.id)?.data).toMatchObject({ status: "queued", version: 0 });
    expect(test.metrics).toEqual([
      {
        inUse: 2,
        limit: 2,
        metric: "RunsDeferred",
        organizationId: ORGANIZATION_ID,
        runId: third!.run.data.id,
      },
    ]);

    gate.release(first!.run.data.id);
    expect(await firstDelivery).toBe("processed");
    expect(test.heldSlots()).toHaveLength(1);
    expect(await test.deliver(third!.queue, answers)).toBe("processed");
    expect(test.stored(third!.run.data.id)?.data.status).toBe("completed");
    gate.release(second!.run.data.id);
    expect(await secondDelivery).toBe("processed");
    expect(test.heldSlots()).toEqual([]);
  });

  const toolRequest = {
    effect: "write" as const,
    idempotencyKey: "tool/organization-limit",
    input: { environment: "staging" },
    inputSummary: "Start a staging deployment.",
    requiredScopes: ["deployment:write"],
    toolName: "deployment.start",
  };
  const toolDefinition = async (toolName: string) => ({
    effect: "write" as const,
    requiredScopes: ["deployment:write"],
    toolName,
  });
  const toolsComplete = (toolCallId: number): Runtime => ({
    authorizeToolCall: async () => ({
      action: "allow",
      reason: "Allowed.",
      toolCallId: id(toolCallId),
    }),
    executeToolCall: async () => ({ outputSummary: "Deployment started.", status: "completed" }),
    generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
    recordArtifact: async () => undefined,
    resolveToolDefinition: toolDefinition,
  });
  const releasedBy: Array<{
    readonly name: string;
    readonly runtime: Runtime;
    readonly status: RunRecordValue["data"]["status"];
  }> = [
    {
      name: "fails",
      runtime: {
        ...toolsComplete(980),
        generateAssistantMessage: async () => {
          throw new Error("Model refused the request.");
        },
      },
      status: "failed",
    },
    {
      name: "is requeued for a retry",
      runtime: {
        ...toolsComplete(980),
        generateAssistantMessage: async () => {
          throw new RuntimeToolPreparationRetryableError("deployment.start", new Error("busy"));
        },
      },
      status: "queued",
    },
    {
      name: "pauses for approval",
      runtime: {
        ...toolsComplete(980),
        authorizeToolCall: async () => ({
          action: "require-approval",
          approvalId: id(981),
          reason: "Deployments require approval.",
          toolCallId: id(980),
        }),
      },
      status: "waiting-for-approval",
    },
    {
      name: "pauses for an asynchronous tool",
      runtime: {
        ...toolsComplete(980),
        executeToolCall: async () => ({
          externalOperationId: "provider-deployment-1",
          status: "running",
        }),
      },
      status: "waiting-for-tool",
    },
    {
      name: "pauses for an awaited sub-agent",
      runtime: {
        ...toolsComplete(980),
        executeToolCall: async () => ({
          externalOperationId: id(984),
          outputSummary: `Waiting for sub-agent researcher run ${id(984)}.`,
          status: "running",
        }),
      },
      status: "waiting-for-tool",
    },
  ];

  it.each(releasedBy)("frees the slot when a running run $name", async ({ runtime, status }) => {
    const fixture = fixtures();
    const release = releaseWithManifest(
      fixture.release,
      manifestWithTriggers(manifestWithToolRequests(fixture.release.data.manifest, [toolRequest]), [
        "api",
      ]),
    );
    const [holder, waiting] = [1, 2].map((index) => runOnOwnThread(index));
    const test = harness([release, ...holder!.records, ...waiting!.records], 1);

    await test.deliver(holder!.queue, runtime);

    expect(test.stored(holder!.run.data.id)?.data.status).toBe(status);
    expect(test.heldSlots()).toEqual([]);
    expect(await test.deliver(waiting!.queue, toolsComplete(990))).toBe("processed");
    expect(test.stored(waiting!.run.data.id)?.data.status).toBe("completed");
  });

  it("reclaims a crashed worker's run in the slot it holds, even above the limit", async () => {
    const fixture = fixtures();
    const crashed = runOnOwnThread(1, {
      claimedAt: "2026-07-21T23:00:00.000Z",
      claimedBy: "worker-crashed",
      executionSlot: 0,
      heartbeatAt: "2026-07-21T23:00:00.000Z",
      status: "running",
      version: 1,
    });
    const active = runningElsewhere(2, 1);
    const test = harness([fixture.release, ...crashed.records, ...active.records], 1);
    const claimBefore = [...test.memory.records.values()].find(
      (record) =>
        record.itemType === "unique-claim" &&
        record.data.namespace === SLOT_NAMESPACE &&
        record.data.value === "0",
    );
    const gate = gatedRuntime([crashed.run.data.id]);

    const delivery = test.deliver(crashed.queue, gate.runtime);
    await gate.started(crashed.run.data.id);

    const reclaimed = test.stored(crashed.run.data.id)!.data;
    expect([reclaimed.status, reclaimed.executionSlot]).toEqual(["running", 0]);
    expect(reclaimed.claimedBy?.startsWith("worker-test:")).toBe(true);
    expect(
      [...test.memory.records.values()].find(
        (record) =>
          record.itemType === "unique-claim" &&
          record.data.namespace === SLOT_NAMESPACE &&
          record.data.value === "0",
      ),
    ).toEqual(claimBefore);
    expect(test.metrics).toEqual([]);
    gate.release(crashed.run.data.id);
    expect(await delivery).toBe("processed");
    expect(test.heldSlots()).toEqual([`1:${active.run.data.id}`]);
  });

  it("fails a run still waiting for a slot six hours after it was queued", async () => {
    const fixture = fixtures();
    const active = runningElsewhere(1, 0);
    const expired = runOnOwnThread(2, { queuedAt: "2026-07-21T18:00:00.000Z" });
    const recent = runOnOwnThread(3, { queuedAt: "2026-07-21T18:00:02.000Z" });
    const test = harness(
      [fixture.release, ...active.records, ...expired.records, ...recent.records],
      1,
    );

    expect(await test.deliver(expired.queue, answers)).toBe("processed");
    expect(await test.deliver(recent.queue, answers)).toBe("returned");

    expect(test.stored(expired.run.data.id)?.data).toMatchObject({
      error: {
        code: "organization_concurrency_wait_expired",
        message:
          "Run waited more than 6 hours for one of its organization's 1 concurrent run slots.",
      },
      status: "failed",
    });
    expect(test.stored(recent.run.data.id)?.data.status).toBe("queued");
    expect(test.metrics.map((hit) => [hit.metric, hit.runId])).toEqual([
      ["RunConcurrencyWaitExpired", expired.run.data.id],
      ["RunsDeferred", recent.run.data.id],
    ]);
    expect(test.heldSlots()).toEqual([`0:${active.run.data.id}`]);
  });

  it("fails a recently queued run whose message has too few receives left for another deferral", async () => {
    const fixture = fixtures();
    const active = runningElsewhere(1, 0);
    const exhausted = runOnOwnThread(2);
    const waiting = runOnOwnThread(3);
    const test = harness(
      [fixture.release, ...active.records, ...exhausted.records, ...waiting.records],
      1,
    );

    expect(await test.deliver(exhausted.queue, answers, 750)).toBe("processed");
    expect(await test.deliver(waiting.queue, answers, 749)).toBe("returned");

    expect(test.stored(exhausted.run.data.id)?.data).toMatchObject({
      error: {
        code: "organization_concurrency_wait_expired",
        message:
          "Run stopped waiting for one of its organization's 1 concurrent run slots: its queue message has 150 of 900 receives left.",
      },
      status: "failed",
    });
    expect(test.stored(waiting.run.data.id)?.data.status).toBe("queued");
    expect(test.metrics.map((hit) => [hit.metric, hit.runId])).toEqual([
      ["RunConcurrencyWaitExpired", exhausted.run.data.id],
      ["RunsDeferred", waiting.run.data.id],
    ]);
    expect(test.heldSlots()).toEqual([`0:${active.run.data.id}`]);
  });

  it("admits nothing new while a lowered limit is still exceeded", async () => {
    const fixture = fixtures();
    const [first, second, third] = [1, 2, 3].map((index) => runOnOwnThread(index));
    const test = harness(
      [fixture.release, ...first!.records, ...second!.records, ...third!.records],
      3,
    );
    const gate = gatedRuntime([first!.run.data.id, second!.run.data.id]);
    const firstDelivery = test.deliver(first!.queue, gate.runtime);
    const secondDelivery = test.deliver(second!.queue, gate.runtime);
    await Promise.all([gate.started(first!.run.data.id), gate.started(second!.run.data.id)]);

    test.limits.set({ concurrentRuns: 1 });

    expect(await test.deliver(third!.queue, answers)).toBe("returned");
    gate.release(first!.run.data.id);
    expect(await firstDelivery).toBe("processed");
    expect(await test.deliver(third!.queue, answers)).toBe("returned");
    gate.release(second!.run.data.id);
    expect(await secondDelivery).toBe("processed");
    expect(await test.deliver(third!.queue, answers)).toBe("processed");
    expect(test.stored(third!.run.data.id)?.data.status).toBe("completed");
    expect(test.metrics.map((hit) => [hit.metric, hit.inUse, hit.limit])).toEqual([
      ["RunsDeferred", 2, 1],
      ["RunsDeferred", 1, 1],
    ]);
  });
});

describe("organization concurrent-run limit from standing", () => {
  const AT = "2026-07-21T00:00:00.000Z";
  const standing = (grants: Record<string, unknown>) =>
    Schema.decodeUnknownSync(OrganizationStandingRecord)(
      withCanonicalRecordKeys({
        data: { createdAt: AT, grants, organizationId: ORGANIZATION_ID, updatedAt: AT, version: 1 },
        itemType: "organization-standing" as const,
      }),
    );
  const serviceGrant = {
    entitlements: { tenantLimits: { concurrentRuns: 16 } },
    grantedAt: AT,
    grantedBy: { kind: "service", service: "billing" },
  };
  const fromStanding = (database: DynamoDatabaseService) =>
    makeStandingTenantLimitResolver({
      database,
      installDefaults: {
        operatorFundedModelSpendCeiling: "unlimited",
        tenantLimits: {
          activeSandboxes: 1,
          apiRequestBurst: 40,
          apiRequestsPerSecond: 20,
          concurrentRuns: 2,
        },
      },
    });
  const deferredAt = (limit: number, extra: readonly PlatformRecord[]) => {
    const fixture = fixtures();
    const active = Array.from({ length: limit }, (_, slot) => runningElsewhere(slot + 1, slot));
    const queued = runOnOwnThread(limit + 1);
    const test = harness(
      [fixture.release, ...active.flatMap((run) => run.records), ...queued.records, ...extra],
      256,
      fromStanding,
    );
    return { queued, test };
  };

  it("enforces a service grant of 16 concurrent runs", async () => {
    const { queued, test } = deferredAt(16, [standing({ service: serviceGrant })]);

    expect(await test.deliver(queued.queue, answers)).toBe("returned");
    expect(test.metrics.map((hit) => [hit.metric, hit.inUse, hit.limit])).toEqual([
      ["RunsDeferred", 16, 16],
    ]);
  });

  it("takes the operator grant's limit over the service grant's", async () => {
    const { queued, test } = deferredAt(16, [
      standing({
        operator: {
          entitlements: { tenantLimits: { concurrentRuns: 17 } },
          grantedAt: AT,
          grantedBy: { kind: "operator", principalId: id(2) },
        },
        service: serviceGrant,
      }),
    ]);

    expect(await test.deliver(queued.queue, answers)).toBe("processed");
    expect(test.stored(queued.run.data.id)?.data.status).toBe("completed");
    expect(test.metrics).toEqual([]);
  });

  it("enforces the install default without a grant", async () => {
    const { queued, test } = deferredAt(2, []);

    expect(await test.deliver(queued.queue, answers)).toBe("returned");
    expect(test.metrics.map((hit) => [hit.metric, hit.inUse, hit.limit])).toEqual([
      ["RunsDeferred", 2, 2],
    ]);
  });
});
