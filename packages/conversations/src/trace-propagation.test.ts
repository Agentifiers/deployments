import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  TraceRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  releaseId,
  workspaceId,
} from "./conversation-control.fixture.ts";
import { createConversationService } from "./index.ts";

describe("conversation trace propagation", () => {
  test("inherits trace identity while giving a child run its own span", async () => {
    const fixtures = controlFixtures();
    const childReleaseId = ids[35]!;
    const childDeploymentId = ids[36]!;
    const grandchildReleaseId = ids[37]!;
    const grandchildDeploymentId = ids[38]!;
    const childRelease = Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        ...fixtures.release,
        data: {
          ...fixtures.release.data,
          id: childReleaseId,
          releaseNumber: 2,
        },
      }),
    );
    const childDeployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        ...fixtures.deployment,
        data: {
          ...fixtures.deployment.data,
          agentReleaseId: childReleaseId,
          id: childDeploymentId,
        },
      }),
    );
    const grandchildRelease = Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        ...fixtures.release,
        data: {
          ...fixtures.release.data,
          id: grandchildReleaseId,
          releaseNumber: 3,
        },
      }),
    );
    const grandchildDeployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        ...fixtures.deployment,
        data: {
          ...fixtures.deployment.data,
          agentReleaseId: grandchildReleaseId,
          id: grandchildDeploymentId,
        },
      }),
    );
    const memory = memoryDatabase([
      fixtures.deployment,
      fixtures.release,
      childDeployment,
      childRelease,
      grandchildDeployment,
      grandchildRelease,
    ]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });
    const root = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      captureMode: "redacted-content",
      content: "Start the parent run",
      environmentId,
      idempotencyKey: "parent-run",
      organizationId,
      projectId,
      workspaceId,
    });
    const childInput = {
      actor: { type: "system" },
      agentDeploymentId: childDeploymentId,
      agentReleaseId: childReleaseId,
      content: "Start the child run",
      environmentId,
      idempotencyKey: "child-run",
      organizationId,
      projectId,
      workspaceId,
      traceContext: {
        parentAgentDeploymentId: deploymentId,
        parentRunId: root.run.data.id,
        parentSpanId: root.run.data.spanId,
        parentThreadId: root.thread.data.id,
        traceId: root.run.data.traceId,
      },
    } as const;
    const child = await service.submitTurn(childInput);

    expect(child.run.data.traceId).toBe(root.run.data.traceId);
    expect(child.run.data.captureMode).toBe(root.run.data.captureMode);
    expect(child.run.data.spanId).not.toBe(root.run.data.spanId);
    expect(child.run.data.parentSpanId).toBe(root.run.data.spanId);
    expect(child.run.data.agentDeploymentId).toBe(childDeploymentId);
    expect(child.thread.data.id).not.toBe(root.thread.data.id);
    expect(child.thread.data.agentDeploymentId).toBe(childDeploymentId);
    const grandchild = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: grandchildDeploymentId,
      agentReleaseId: grandchildReleaseId,
      content: "Start the grandchild run",
      environmentId,
      idempotencyKey: "grandchild-run",
      organizationId,
      projectId,
      workspaceId,
      traceContext: {
        parentAgentDeploymentId: childDeploymentId,
        parentRunId: child.run.data.id,
        parentSpanId: child.run.data.spanId,
        parentThreadId: child.thread.data.id,
        traceId: root.run.data.traceId,
      },
    });
    expect(grandchild.run.data.agentDeploymentId).toBe(grandchildDeploymentId);
    expect(grandchild.run.data.parentSpanId).toBe(child.run.data.spanId);
    expect(grandchild.thread.data.id).not.toBe(child.thread.data.id);
    expect(grandchild.thread.data.agentDeploymentId).toBe(grandchildDeploymentId);
    const { workspaceId: _workspaceId, ...crossWorkspaceChild } = childInput;
    expect(
      service.submitTurn({
        ...crossWorkspaceChild,
        idempotencyKey: "cross-workspace-child",
      }),
    ).rejects.toMatchObject({ code: "trace_mismatch" });
    expect(
      service.submitTurn({ ...childInput, captureMode: "metadata-only" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(memory.transactions[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "put",
          record: expect.objectContaining({
            data: expect.objectContaining({
              childRunId: child.run.data.id,
              childThreadId: child.thread.data.id,
              fromAgentDeploymentId: deploymentId,
              parentRunId: root.run.data.id,
              threadId: root.thread.data.id,
              toAgentDeploymentId: childDeploymentId,
              traceId: root.run.data.traceId,
            }),
            itemType: "run-edge",
          }),
        }),
      ]),
    );
  });

  test("retries child creation after a concurrent parent trace version change", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    const rootService = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });
    const root = await rootService.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Start the parent run",
      environmentId,
      idempotencyKey: "trace-conflict-parent",
      organizationId,
      projectId,
    });
    const traceEntry = [...memory.records.entries()].find(
      ([, record]) => record.itemType === "trace" && record.data.traceId === root.run.data.traceId,
    );
    if (!traceEntry || traceEntry[1].itemType !== "trace") throw new Error("trace fixture missing");
    const concurrentTrace = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        ...traceEntry[1],
        data: {
          ...traceEntry[1].data,
          terminalRunIds: [root.run.data.id],
          updatedAt: "2026-07-23T12:00:01.000Z",
          version: traceEntry[1].data.version + 1,
        },
      }),
    );
    const baseTransactWrite = memory.database.transactWrite;
    let conflict = true;
    const database = {
      ...memory.database,
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        if (!conflict) return baseTransactWrite(operations);
        conflict = false;
        memory.records.set(traceEntry[0], concurrentTrace);
        throw new Error("ConditionalCheckFailedException");
      },
    } as unknown as DynamoDatabaseService;
    const service = createConversationService({
      database,
      enqueueRun: async () => {},
      generateId: idGenerator(20),
      now: () => now,
    });

    const child = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Start a child after the trace watermark moves",
      environmentId,
      idempotencyKey: "trace-conflict-child",
      organizationId,
      projectId,
      threadId: root.thread.data.id,
      traceContext: {
        parentAgentDeploymentId: deploymentId,
        parentRunId: root.run.data.id,
        parentSpanId: root.run.data.spanId,
        parentThreadId: root.thread.data.id,
        traceId: root.run.data.traceId,
      },
    });

    expect(child.run.data.traceId).toBe(root.run.data.traceId);
    expect(child.run.data.parentSpanId).toBe(root.run.data.spanId);
    expect(conflict).toBe(false);
  });
});
