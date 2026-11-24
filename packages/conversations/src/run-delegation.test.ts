import { key, type PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  releaseId,
} from "./conversation-control.fixture.ts";
import { createConversationService, type SubmitConversationTurnResult } from "./index.ts";

function delegationLink(records: Map<string, PlatformRecord>, childRunId: string) {
  return [...records.values()].find(
    (record) => record.itemType === "run-delegation" && record.data.childRunId === childRunId,
  );
}

describe("delegated run links", () => {
  test("records depth, ancestry, and await intent in each child submission", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });
    const base = {
      actor: { type: "system" as const },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      environmentId,
      organizationId,
      projectId,
    };
    const childOf = (parent: SubmitConversationTurnResult, awaitResult: boolean) => ({
      ...(awaitResult ? { awaitResult: true } : {}),
      parentAgentDeploymentId: deploymentId,
      parentRunId: parent.run.data.id,
      parentSpanId: parent.run.data.spanId,
      parentThreadId: parent.thread.data.id,
      traceId: parent.run.data.traceId,
    });
    const root = await service.submitTurn({ ...base, content: "Root", idempotencyKey: "root" });
    expect(root.run.data.parentSpanId).toBeUndefined();
    expect(delegationLink(memory.records, root.run.data.id)).toBeUndefined();

    const child = await service.submitTurn({
      ...base,
      content: "Child",
      idempotencyKey: "child",
      traceContext: childOf(root, true),
    });
    const grandchild = await service.submitTurn({
      ...base,
      content: "Grandchild",
      idempotencyKey: "grandchild",
      traceContext: childOf(child, false),
    });

    const childLink = delegationLink(memory.records, child.run.data.id);
    expect(childLink).toMatchObject({
      data: {
        ancestorAgentDeploymentIds: [deploymentId],
        awaitResult: true,
        childThreadId: child.thread.data.id,
        depth: 1,
        parentRunId: root.run.data.id,
        parentThreadId: root.thread.data.id,
      },
      pk: key("ORG", organizationId, "RUN", child.run.data.id),
      sk: key("RUN-DELEGATION", child.run.data.id),
    });
    expect(delegationLink(memory.records, grandchild.run.data.id)).toMatchObject({
      data: {
        ancestorAgentDeploymentIds: [deploymentId, deploymentId],
        awaitResult: false,
        depth: 2,
        parentRunId: child.run.data.id,
      },
    });

    // The await intent is part of the idempotent command identity.
    expect(
      service.submitTurn({
        ...base,
        content: "Child",
        idempotencyKey: "child",
        traceContext: childOf(root, false),
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
