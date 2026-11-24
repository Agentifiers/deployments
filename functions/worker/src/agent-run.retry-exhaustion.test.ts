import { describe, expect, it } from "bun:test";
import { RuntimeArtifactPublicationError } from "@deployments-ai/agent-runtime";
import { RunRecord, withCanonicalRecordKeys, type PlatformRecord } from "@deployments-ai/db";
import { Schema } from "effect";
import { MAX_AGENT_RUN_ATTEMPTS } from "./agent-run-input.ts";
import { threadExecutionLease } from "./agent-run-lease.ts";
import {
  additionalRunOnThread,
  fixtures,
  inMemoryDatabase,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { processAgentRun } from "./index.ts";
import type { AgentRunQueueMessage, AgentRunWorkerDependencies } from "./types.ts";

function runWithAttempt(run: ReturnType<typeof fixtures>["run"], attempt: number) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: { ...run.data, attempt },
      itemType: "run" as const,
    }),
  );
}

describe("agent run retry exhaustion", () => {
  it("terminalizes a retryable failure at the persisted attempt limit", async () => {
    const fixture = fixtures();
    const run = runWithAttempt(fixture.run, MAX_AGENT_RUN_ATTEMPTS - 1);
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

    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    if (!result.run) throw new Error("Expected a terminal run result.");
    expect(result.run.data.attempt).toBe(MAX_AGENT_RUN_ATTEMPTS);
    expect(result.run.data.error?.message).toContain("retry limit");
    expect(
      [...memory.records.values()].some(
        (record) =>
          record.itemType === "runtime-lease" && record.data.runId === fixture.run.data.id,
      ),
    ).toBe(false);
  });

  it("terminalizes an exhausted stale queued run instead of creating a fresh delivery", async () => {
    const fixture = fixtures();
    const second = additionalRunOnThread(fixture);
    const exhausted = runWithAttempt(fixture.run, MAX_AGENT_RUN_ATTEMPTS);
    const queuedLease = threadExecutionLease({
      acquiredAt: "2026-07-22T00:00:00.000Z",
      expiresAt: "2026-07-22T00:00:00.050Z",
      owner: `queued-run/${exhausted.data.id}`,
      renewedAt: "2026-07-22T00:00:00.000Z",
      runId: exhausted.data.id,
      threadId: exhausted.data.threadId,
      version: 3,
    });
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      exhausted,
      second.userMessage,
      second.run,
      queuedLease,
    ]);
    const base = workerDependencies(memory.database);
    const requeued: AgentRunQueueMessage[] = [];
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      enqueueRun: async ({ message }) => void requeued.push(message),
      now: () => new Date("2026-07-22T01:00:00.000Z"),
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

    expect(requeued).toEqual([]);
    const runs = [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
        record.itemType === "run",
    );
    expect(runs.find((run) => run.data.id === exhausted.data.id)?.data.status).toBe("failed");
    expect(runs.find((run) => run.data.id === second.run.data.id)?.data.status).toBe("completed");
  });
});
