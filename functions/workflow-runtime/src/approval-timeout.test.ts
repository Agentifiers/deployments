import { CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { createWorkflowApprovalExpirationScheduler } from "./approval-timeout.ts";

const executionId = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;

const env = {
  DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN: "arn:aws:sqs:us-east-1:123:automation-failures",
  DEPLOYMENTS_AI_SCHEDULER_GROUP: "runtime",
  DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN: "arn:aws:iam::123:role/scheduler",
  DEPLOYMENTS_AI_WORKFLOW_APPROVAL_TIMEOUT_LAMBDA_ARN:
    "arn:aws:lambda:us-east-1:123:function:workflow-approval-timeout",
};
const approvalId = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;

describe("workflow approval expiration scheduling", () => {
  test("schedules a one-time approval expiry no earlier than its deadline", async () => {
    const commands: unknown[] = [];
    const schedule = createWorkflowApprovalExpirationScheduler({
      client: { send: async (value: unknown) => void commands.push(value) } as never,
      env,
    });

    await schedule({
      approvalId,
      executionId,
      expiresAt: "2026-08-01T12:34:56.789Z",
      organizationId,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(CreateScheduleCommand);
    expect((commands[0] as CreateScheduleCommand).input).toMatchObject({
      ActionAfterCompletion: "DELETE",
      Name: "workflow-approval-01ARZ3NDEKTSV4RRFFQ69G5FB0",
      ScheduleExpression: "at(2026-08-01T12:34:57)",
      Target: {
        Input: JSON.stringify({ approvalId, executionId, organizationId }),
      },
    });
  });

  test("requires all scheduler routing configuration", () => {
    expect(() => createWorkflowApprovalExpirationScheduler({ env: {} })).toThrow(
      "DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN is required",
    );
  });

  test("rejects malformed expiration timestamps before sending", async () => {
    const schedule = createWorkflowApprovalExpirationScheduler({
      client: { send: async () => undefined } as never,
      env,
    });
    expect(
      schedule({
        approvalId,
        executionId,
        expiresAt: "not-a-time",
        organizationId,
      }),
    ).rejects.toThrow("Approval expiresAt is invalid");
  });
});
