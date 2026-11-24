import {
  WorkflowDefinitionDocumentV1,
  WorkflowStepAttemptResponse,
} from "@deployments-ai/api-contract";
import { Schema } from "effect";

export const TENANT = {
  environmentId: "01K0000000000000000000000C",
  organizationId: "01K0000000000000000000000A",
  projectId: "01K0000000000000000000000B",
};

export const APPROVAL_DOCUMENT = {
  entryStepId: "review",
  name: "QA approval gate",
  schemaVersion: 1,
  slug: "qa-approval-gate",
  steps: [
    {
      id: "review",
      onApproved: "approved",
      onRejected: "rejected",
      prompt: "QA: approve this execution?",
      type: "approval",
    },
    { id: "approved", type: "end" },
    { id: "rejected", type: "end" },
  ],
};

export const DOCUMENT = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)(APPROVAL_DOCUMENT);

export function attemptJson(overrides: Readonly<Record<string, unknown>>) {
  return {
    ...TENANT,
    attempt: 1,
    createdAt: "2026-10-09T05:00:00.000Z",
    id: "01K0000000000000000000000S",
    input: {},
    object: "workflow-step-attempt",
    status: "succeeded",
    stepId: "review",
    stepType: "approval",
    updatedAt: "2026-10-09T05:00:00.000Z",
    version: 1,
    workflowExecutionId: "01K0000000000000000000000E",
    ...overrides,
  };
}

export function attempt(overrides: Readonly<Record<string, unknown>>) {
  return Schema.decodeUnknownSync(WorkflowStepAttemptResponse)(attemptJson(overrides));
}
