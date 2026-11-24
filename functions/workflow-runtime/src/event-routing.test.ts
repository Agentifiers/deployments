import { describe, expect, test } from "bun:test";
import {
  Ulid,
  WorkflowExecutionPersistenceError,
  workflowStepCorrelation,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  createWorkflowEventRouter,
  workflowQueueCommandFromSemanticEvent,
} from "./event-routing.ts";
import { decodeWorkflowQueueCommand, createWorkflowQueueHandler } from "./queue.ts";

const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const EXECUTION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const ATTEMPT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const RUN_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const MESSAGE_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB1");

function event(eventType: string, aggregateType: string, aggregateId: string, payload = {}) {
  return {
    detail: {
      aggregateId,
      aggregateType,
      environmentId: ENVIRONMENT_ID,
      eventType,
      organizationId: ORGANIZATION_ID,
      payload,
      projectId: PROJECT_ID,
    },
    "detail-type": eventType,
    id: "event-1",
  };
}

describe("workflow event and queue routing", () => {
  test("carries the persisted workflow approval ID outside the public step output", async () => {
    expect(
      workflowQueueCommandFromSemanticEvent(
        event("workflow-approval.resolved", "workflow-approval", ATTEMPT_ID, {
          decision: "approved",
          stepAttemptId: ATTEMPT_ID,
          workflowExecutionId: EXECUTION_ID,
        }),
        {
          getCorrelation: async () => {
            throw new Error("unused");
          },
        },
      ),
    ).resolves.toMatchObject({
      approvalId: ATTEMPT_ID,
      outcome: "approved",
    });
  });

  test("routes execution and dispatch events into the serialized queue", async () => {
    const persistence = {
      getCorrelation: async () => {
        throw new Error("unused");
      },
    };
    expect(
      workflowQueueCommandFromSemanticEvent(
        event("workflow-execution.requested", "workflow-execution", EXECUTION_ID),
        persistence,
      ),
    ).resolves.toEqual({
      environmentId: ENVIRONMENT_ID,
      executionId: EXECUTION_ID,
      kind: "advance",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    });
    expect(
      workflowQueueCommandFromSemanticEvent(
        event("workflow-step.dispatch-requested", "workflow-execution", EXECUTION_ID, {
          stepAttemptId: ATTEMPT_ID,
        }),
        persistence,
      ),
    ).resolves.toMatchObject({ kind: "dispatch", stepAttemptId: ATTEMPT_ID });
  });

  test("correlates terminal child runs without trusting queue payload linkage", async () => {
    const correlation = workflowStepCorrelation({
      createdAt: "2026-07-31T12:00:00.000Z",
      environmentId: ENVIRONMENT_ID,
      externalId: RUN_ID,
      externalKind: "child-run",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      stepAttemptId: ATTEMPT_ID,
      workflowExecutionId: EXECUTION_ID,
    });
    const command = await workflowQueueCommandFromSemanticEvent(
      event("run.completed", "run", RUN_ID, { messageId: MESSAGE_ID }),
      {
        getCorrelation: async (organizationId, kind, externalId) => {
          expect([organizationId, kind, externalId]).toEqual([
            ORGANIZATION_ID,
            "child-run",
            RUN_ID,
          ]);
          return correlation;
        },
      },
    );

    expect(command).toEqual({
      environmentId: ENVIRONMENT_ID,
      executionId: EXECUTION_ID,
      kind: "continue",
      organizationId: ORGANIZATION_ID,
      outcome: "succeeded",
      output: { messageId: MESSAGE_ID, runId: RUN_ID },
      projectId: PROJECT_ID,
      stepAttemptId: ATTEMPT_ID,
    });
  });

  test("preserves bounded terminal errors for workflow step history", async () => {
    const correlation = workflowStepCorrelation({
      createdAt: "2026-07-31T12:00:00.000Z",
      environmentId: ENVIRONMENT_ID,
      externalId: RUN_ID,
      externalKind: "child-run",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      stepAttemptId: ATTEMPT_ID,
      workflowExecutionId: EXECUTION_ID,
    });
    expect(
      workflowQueueCommandFromSemanticEvent(
        event("run.failed", "run", RUN_ID, {
          error: { code: "model_failed", message: "Model generation failed." },
        }),
        { getCorrelation: async () => correlation },
      ),
    ).resolves.toMatchObject({
      error: { code: "model_failed", message: "Model generation failed." },
      kind: "continue",
      outcome: "failed",
    });
  });

  test("ignores terminal resources that are not correlated to a workflow", async () => {
    let recoveryCalled = false;
    expect(
      workflowQueueCommandFromSemanticEvent(
        event("run.completed", "run", RUN_ID, { messageId: MESSAGE_ID }),
        {
          getCorrelation: async () => {
            throw new WorkflowExecutionPersistenceError("not_found", "No workflow correlation.");
          },
        },
        async () => {
          recoveryCalled = true;
          return undefined;
        },
      ),
    ).resolves.toBeUndefined();
    expect(recoveryCalled).toBe(false);
  });

  test("recovers a fast terminal child event before its correlation commit", async () => {
    const correlation = workflowStepCorrelation({
      createdAt: "2026-07-31T12:00:00.000Z",
      environmentId: ENVIRONMENT_ID,
      externalId: RUN_ID,
      externalKind: "child-run",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      stepAttemptId: ATTEMPT_ID,
      workflowExecutionId: EXECUTION_ID,
    });
    const command = await workflowQueueCommandFromSemanticEvent(
      event("run.completed", "run", RUN_ID, {
        messageId: MESSAGE_ID,
        threadId: ATTEMPT_ID,
      }),
      {
        getCorrelation: async () => {
          throw new WorkflowExecutionPersistenceError("not_found", "Not committed yet.");
        },
      },
      async (input) => {
        expect(input).toMatchObject({
          externalId: RUN_ID,
          externalKind: "child-run",
          payload: { messageId: MESSAGE_ID, threadId: ATTEMPT_ID },
        });
        return correlation;
      },
    );
    expect(command).toMatchObject({
      executionId: EXECUTION_ID,
      kind: "continue",
      stepAttemptId: ATTEMPT_ID,
    });
  });

  test("schedules approval expiration from the durable requested event", async () => {
    const scheduled: unknown[] = [];
    const router = createWorkflowEventRouter({
      enqueue: async () => undefined,
      persistence: {
        getCorrelation: async () => {
          throw new Error("unused");
        },
      },
      scheduleApprovalExpiration: async (input) => void scheduled.push(input),
    });
    expect(
      router(
        event("workflow-approval.requested", "workflow-approval", ATTEMPT_ID, {
          expiresAt: "2026-08-01T12:00:00.000Z",
          stepAttemptId: ATTEMPT_ID,
          workflowExecutionId: EXECUTION_ID,
        }),
      ),
    ).resolves.toEqual({ routed: false, scheduled: true });
    expect(scheduled).toEqual([
      {
        approvalId: ATTEMPT_ID,
        executionId: EXECUTION_ID,
        expiresAt: "2026-08-01T12:00:00.000Z",
        organizationId: ORGANIZATION_ID,
      },
    ]);
  });

  test("strictly decodes queue commands and reports partial batch failures", async () => {
    expect(
      decodeWorkflowQueueCommand({
        environmentId: ENVIRONMENT_ID,
        executionId: EXECUTION_ID,
        kind: "advance",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      }),
    ).toMatchObject({ kind: "advance" });
    expect(
      decodeWorkflowQueueCommand({
        environmentId: ENVIRONMENT_ID,
        error: { code: "child_failed" },
        executionId: EXECUTION_ID,
        kind: "continue",
        organizationId: ORGANIZATION_ID,
        outcome: "failed",
        projectId: PROJECT_ID,
        stepAttemptId: ATTEMPT_ID,
      }),
    ).toMatchObject({ error: { code: "child_failed" }, kind: "continue" });
    expect(() => decodeWorkflowQueueCommand({ kind: "advance" })).toThrow();

    const handler = createWorkflowQueueHandler({} as never);
    const result = await handler({
      Records: [{ body: "not-json", messageId: "bad" }],
    });
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
  });
});
