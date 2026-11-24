import { describe, expect, test } from "bun:test";
import { WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import { Schema } from "effect";
import {
  evaluateWorkflowCondition,
  planWorkflowStep,
  recordWorkflowStepOutput,
  resolveWorkflowOperand,
} from "./engine.ts";

const DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const decode = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1);

describe("workflow execution engine", () => {
  test("plans every declared step type from the pinned definition", () => {
    const definition = decode({
      entryStepId: "agent",
      name: "Release workflow",
      schemaVersion: 1,
      slug: "release-workflow",
      steps: [
        {
          agentDeploymentId: DEPLOYMENT_ID,
          id: "agent",
          input: { instruction: "prepare" },
          next: "tool",
          type: "agent",
        },
        {
          agentDeploymentId: DEPLOYMENT_ID,
          id: "tool",
          next: "approval",
          toolName: "release.prepare",
          type: "tool",
        },
        {
          id: "approval",
          onApproved: "branch",
          onExpired: "escalate",
          onRejected: "escalate",
          prompt: "Ship it?",
          type: "approval",
        },
        {
          condition: {
            left: { path: ["approved"], source: "step", stepId: "approval" },
            operator: "equals",
            right: true,
          },
          id: "branch",
          onFalse: "escalate",
          onTrue: "notify",
          type: "branch",
        },
        {
          channel: "slack",
          id: "notify",
          message: "Shipped",
          next: "done",
          target: "#releases",
          type: "notification",
        },
        {
          id: "escalate",
          message: "Release blocked",
          next: "done",
          target: "release-manager",
          type: "escalation",
        },
        { id: "done", outcome: { status: "finished" }, type: "end" },
      ],
    });
    const context = { stepOutputs: { approval: { approved: true } } };
    const input = { version: "2026.07.31" };

    expect(planWorkflowStep(definition, "agent", input, context)).toMatchObject({
      input: { instruction: "prepare" },
      kind: "dispatch-agent",
      onSuccess: "tool",
    });
    expect(planWorkflowStep(definition, "tool", input, context)).toMatchObject({
      input,
      kind: "dispatch-tool",
      onSuccess: "approval",
    });
    expect(planWorkflowStep(definition, "approval", input, context)).toMatchObject({
      kind: "request-approval",
      onApproved: "branch",
    });
    expect(planWorkflowStep(definition, "branch", input, context)).toEqual({
      conditionResult: true,
      kind: "advance-branch",
      nextStepId: "notify",
      stepId: "branch",
    });
    expect(planWorkflowStep(definition, "notify", input, context)).toMatchObject({
      channel: "slack",
      kind: "send-notification",
    });
    expect(planWorkflowStep(definition, "escalate", input, context)).toMatchObject({
      kind: "emit-escalation",
      target: "release-manager",
    });
    expect(planWorkflowStep(definition, "done", input, context)).toEqual({
      kind: "complete",
      output: { status: "finished" },
      stepId: "done",
    });
  });

  test("resolves bounded input and prior-step operands deterministically", () => {
    const context = recordWorkflowStepOutput({ stepOutputs: {} }, "prepare", {
      nested: { flags: [false, true] },
    });
    const operand = { path: ["nested", "flags", 1], source: "step", stepId: "prepare" } as const;

    expect(resolveWorkflowOperand(operand, {}, context)).toBe(true);
    expect(
      evaluateWorkflowCondition({ left: operand, operator: "equals", right: true }, {}, context),
    ).toBe(true);
    expect(
      evaluateWorkflowCondition(
        { left: { path: ["missing"], source: "input" }, operator: "exists" },
        {},
        context,
      ),
    ).toBe(false);
  });

  test("carries an explicit approval link into tool dispatch", () => {
    const definition = decode({
      entryStepId: "approve",
      name: "Approved write",
      schemaVersion: 1,
      slug: "approved-write",
      steps: [
        {
          id: "approve",
          onApproved: "write",
          onRejected: "done",
          prompt: "Allow write?",
          type: "approval",
        },
        {
          agentDeploymentId: DEPLOYMENT_ID,
          approvalStepId: "approve",
          id: "write",
          next: "done",
          toolName: "records.write",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    });

    expect(
      planWorkflowStep(
        definition,
        "write",
        {},
        {
          stepOutputs: { approve: { outcome: "approved" } },
        },
      ),
    ).toMatchObject({ approvalStepId: "approve", kind: "dispatch-tool" });
  });

  test("does not treat inherited object or array properties as workflow data", () => {
    expect(
      resolveWorkflowOperand({ path: ["toString"], source: "input" }, {}, { stepOutputs: {} }),
    ).toBeUndefined();
    expect(
      evaluateWorkflowCondition(
        { left: { path: ["constructor"], source: "input" }, operator: "exists" },
        {},
        { stepOutputs: {} },
      ),
    ).toBe(false);
  });

  test("makes cancellation take precedence over step dispatch", () => {
    const definition = decode({
      entryStepId: "done",
      name: "Cancelable workflow",
      schemaVersion: 1,
      slug: "cancelable-workflow",
      steps: [{ id: "done", type: "end" }],
    });

    expect(planWorkflowStep(definition, "done", {}, { stepOutputs: {} }, true)).toEqual({
      kind: "cancel",
    });
  });
});
