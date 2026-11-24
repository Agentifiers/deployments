import { action, id, json, requiredNumber, requiredText, text } from "./catalog-helpers.ts";

export const workflowRuntimeCommands = {
  "workflow-execution": {
    summary: "Durable workflow executions",
    actions: {
      list: action({
        summary: "List workflow executions",
        method: "GET",
        path: "/v1/workflow-executions",
        scope: "environment",
        output: "list",
        listField: "items",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: { status: text("Workflow execution status", "query") },
      }),
      start: action({
        summary: "Start an immutable workflow release",
        method: "POST",
        path: "/v1/workflow-releases/:workflowReleaseId/executions",
        scope: "environment",
        output: "detail",
        idempotent: true,
        args: {
          release: {
            ...requiredText("Workflow release ID", "path"),
            field: "workflowReleaseId",
          },
          input: json("Workflow input JSON"),
          "workspace-id": { ...text("Workspace ID"), field: "workspaceId" },
        },
      }),
      show: action({
        summary: "Show a workflow execution",
        method: "GET",
        path: "/v1/workflow-executions/:workflowExecutionId",
        scope: "environment",
        output: "detail",
        args: { id: { ...id, field: "workflowExecutionId" } },
      }),
      steps: action({
        summary: "List workflow step attempts",
        method: "GET",
        path: "/v1/workflow-executions/:workflowExecutionId/steps",
        scope: "environment",
        output: "list",
        listField: "items",
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: { id: { ...id, field: "workflowExecutionId" } },
      }),
      cancel: action({
        summary: "Request workflow execution cancellation",
        method: "POST",
        path: "/v1/workflow-executions/:workflowExecutionId/cancel",
        scope: "environment",
        output: "action",
        destructive: true,
        args: {
          id: { ...id, field: "workflowExecutionId" },
          "expected-version": {
            ...requiredNumber("Expected workflow execution version"),
            field: "expectedVersion",
          },
        },
      }),
    },
  },
  "workflow-approval": {
    summary: "Workflow approval decisions",
    actions: {
      show: action({
        summary: "Show a workflow approval",
        method: "GET",
        path: "/v1/workflow-executions/:workflowExecutionId/approvals/:workflowApprovalId",
        scope: "environment",
        output: "detail",
        args: {
          id: { ...id, field: "workflowApprovalId" },
          execution: {
            ...requiredText("Workflow execution ID", "path"),
            field: "workflowExecutionId",
          },
        },
      }),
      approve: action({
        summary: "Approve a pending workflow step",
        method: "POST",
        path: "/v1/workflow-executions/:workflowExecutionId/approvals/:workflowApprovalId/resolve",
        scope: "environment",
        output: "action",
        fixedBody: { decision: "approved" },
        args: {
          id: { ...id, field: "workflowApprovalId" },
          execution: {
            ...requiredText("Workflow execution ID", "path"),
            field: "workflowExecutionId",
          },
        },
      }),
      reject: action({
        summary: "Reject a pending workflow step",
        method: "POST",
        path: "/v1/workflow-executions/:workflowExecutionId/approvals/:workflowApprovalId/resolve",
        scope: "environment",
        output: "action",
        fixedBody: { decision: "rejected" },
        destructive: true,
        args: {
          id: { ...id, field: "workflowApprovalId" },
          execution: {
            ...requiredText("Workflow execution ID", "path"),
            field: "workflowExecutionId",
          },
        },
      }),
    },
  },
} as const;
