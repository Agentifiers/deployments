import { expect, test } from "bun:test";
import type { RuntimeProgressEvent } from "@deployments-ai/agent-runtime";
import { progressEvent } from "./agent-run-lease.ts";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { processAgentRun } from "./index.ts";
import { makeRuntimeRunLogRegistry } from "./runtime-log-emitter.ts";

function runtimeProgress(): RuntimeProgressEvent {
  const fixture = fixtures();
  return {
    agentDefinitionId: fixture.release.data.agentDefinitionId,
    agentDeploymentId: fixture.deployment.data.id,
    agentManifestHash: fixture.release.data.contentHash,
    agentReleaseId: fixture.release.data.id,
    captureMode: fixture.run.data.captureMode,
    environmentId: fixture.run.data.environmentId,
    eventType: "model.started",
    level: "info",
    message: "Generating a response.",
    occurredAt: "2026-07-22T00:00:01.000Z",
    organizationId: fixture.run.data.organizationId,
    projectId: fixture.run.data.projectId,
    runId: fixture.run.data.id,
    spanId: fixture.run.data.spanId,
    threadId: fixture.run.data.threadId,
    traceId: fixture.run.data.traceId,
    ...(fixture.run.data.workspaceId ? { workspaceId: fixture.run.data.workspaceId } : {}),
  };
}

test("bounds a stalled best-effort progress append and aborts the underlying sink", async () => {
  const fixture = fixtures();
  const memory = inMemoryDatabase([
    fixture.release,
    fixture.deployment,
    fixture.thread,
    fixture.userMessage,
    fixture.run,
  ]);
  const base = workerDependencies(memory.database);
  let appendSignal: AbortSignal | undefined;

  const outcome = await Promise.race([
    progressEvent(
      {
        ...base.dependencies,
        appendThreadEvent: async (_event, signal?: AbortSignal) => {
          appendSignal = signal;
          await new Promise<never>((_resolve, reject) => {
            if (!signal) return;
            const rejectAbort = () => reject(signal.reason);
            if (signal.aborted) rejectAbort();
            else signal.addEventListener("abort", rejectAbort, { once: true });
          });
        },
        generateId: async () => id(200),
      },
      runtimeProgress(),
      fixture.run,
    ).then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    Bun.sleep(2_000).then(() => "still-pending" as const),
  ]);

  expect(outcome).toBe("rejected");
  expect(appendSignal).toBeDefined();
  expect(appendSignal?.aborted).toBe(true);
});

test("records the runtime's progress as the run's runtime log while it executes", async () => {
  const fixture = fixtures();
  const memory = inMemoryDatabase([
    fixture.release,
    fixture.deployment,
    fixture.thread,
    fixture.userMessage,
    fixture.run,
  ]);
  const base = workerDependencies(memory.database);
  const runtimeLogs = makeRuntimeRunLogRegistry();

  const outcome = await processAgentRun(fixture.queue, { ...base.dependencies, runtimeLogs });
  expect(outcome).toMatchObject({ action: "completed" });

  const batches = [...memory.records.values()].filter(
    (record) => record.itemType === "runtime-log-batch",
  );
  const lines = batches.flatMap((record) =>
    record.itemType === "runtime-log-batch" ? record.data.lines : [],
  );
  expect(batches.map((record) => record.pk)).toEqual([
    `ORG#${fixture.run.data.organizationId}#RUN#${fixture.run.data.id}`,
  ]);
  expect(lines.map((line) => line.attributes?.event)).toContain("model.generation.started");
  expect(lines.find((line) => line.attributes?.event === "model.generation.started")).toMatchObject(
    { level: "info", source: "model" },
  );
  expect(runtimeLogs.logger(fixture.run.data.id)).toBeUndefined();
});
