import { expect, test } from "bun:test";
import { AgentRunPlanRecord, RunRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { replayAgentPlanSnapshot } from "./agent-run-plan.ts";

test("does not replay a plan from an earlier explicit-retry generation", async () => {
  const fixture = fixtures();
  const run = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fixture.run.data,
        attempt: 1,
        claimedAt: "2026-08-12T12:01:00.000Z",
        status: "failed" as const,
        updatedAt: "2026-08-12T12:01:01.000Z",
        version: 8,
      },
      itemType: "run" as const,
    }),
  );
  const plan = Schema.decodeUnknownSync(AgentRunPlanRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        createdAt: "2026-08-12T12:00:00.000Z",
        environmentId: run.data.environmentId,
        id: run.data.id,
        organizationId: run.data.organizationId,
        planRevision: 1,
        projectId: run.data.projectId,
        runAttempt: 1,
        runClaimedAt: "2026-08-12T12:00:00.000Z",
        runExecutionVersion: 2,
        runId: run.data.id,
        tasks: [{ id: "respond", order: 0, status: "completed", title: "Respond" }],
        threadId: run.data.threadId,
        title: "Stale plan",
        traceId: run.data.traceId,
        updatedAt: "2026-08-12T12:00:01.000Z",
        version: 0,
        ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
      },
      itemType: "agent-run-plan" as const,
    }),
  );
  const memory = inMemoryDatabase([plan]);
  const { dependencies, events } = workerDependencies(memory.database);

  await replayAgentPlanSnapshot(dependencies, run);

  expect(events).toEqual([]);
});
