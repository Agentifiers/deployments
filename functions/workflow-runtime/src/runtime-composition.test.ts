import type { RuntimeToolDecision } from "@deployments-ai/agent-runtime";
import type { Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  applyWorkflowToolApproval,
  workflowApprovalEvidenceId,
  workflowToolCapabilityFailure,
  workflowToolInputMatches,
} from "./runtime-composition.ts";

const decision: RuntimeToolDecision = {
  action: "require-approval",
  approvalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
  reason: "Writes require approval.",
  toolCallId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid,
};

describe("workflow runtime composition", () => {
  test("links an approved workflow step to a policy-gated tool", () => {
    expect(
      applyWorkflowToolApproval(
        decision,
        "approve-write",
        {
          "approve-write": { outcome: "approved" },
        },
        {
          "approve-write": decision.approvalId,
        },
      ),
    ).toEqual({
      action: "allow",
      reason: "Writes require approval.",
      toolCallId: decision.toolCallId,
    });
    expect(
      workflowApprovalEvidenceId(
        decision,
        "approve-write",
        {
          "approve-write": { outcome: "approved" },
        },
        {
          "approve-write": decision.approvalId,
        },
      ),
    ).toBe(decision.approvalId);
  });

  test("does not bypass tool policy without the linked approved outcome", () => {
    expect(applyWorkflowToolApproval(decision, undefined, {})).toBe(decision);
    expect(
      applyWorkflowToolApproval(decision, "approve-write", {
        "approve-write": { outcome: "rejected" },
      }),
    ).toBe(decision);
    expect(
      applyWorkflowToolApproval(decision, "approve-write", {
        "approve-write": { approvalId: decision.approvalId, outcome: "approved" },
      }),
    ).toBe(decision);
    expect(
      workflowApprovalEvidenceId(decision, "approve-write", {
        "approve-write": { approvalId: decision.approvalId, outcome: "approved" },
      }),
    ).toBeUndefined();
  });

  test("enforces capability scopes and workspace authorization", () => {
    expect(
      workflowToolCapabilityFailure(
        { authorization: "none", requiredScopes: ["records:write"] },
        { requiredScopes: [] },
        undefined,
        false,
      ),
    ).toMatchObject({
      error: { code: "tool_scope_mismatch" },
      state: "failed",
    });
    expect(
      workflowToolCapabilityFailure(
        { authorization: "workspace", requiredScopes: ["records:write"] },
        { requiredScopes: ["records:write"] },
        undefined,
        false,
      ),
    ).toMatchObject({
      error: { code: "tool_workspace_authorization_required" },
      state: "failed",
    });
    expect(
      workflowToolCapabilityFailure(
        { authorization: "workspace", requiredScopes: ["records:write"] },
        { requiredScopes: ["records:write"] },
        String(decision.toolCallId),
        true,
      ),
    ).toBeUndefined();
  });

  test("validates workflow tool input against the registered schema", () => {
    const definition = {
      effect: "write" as const,
      inputSchema: {
        additionalProperties: false,
        properties: { title: { minLength: 1, type: "string" } },
        required: ["title"],
        type: "object",
      },
      requiredScopes: [],
      toolName: "records.write",
    };
    expect(workflowToolInputMatches(definition, { title: "Release" })).toBe(true);
    expect(workflowToolInputMatches(definition, { title: "", unexpected: true })).toBe(false);
  });
});
