import { Schema } from "effect";
import {
  Cursor,
  JsonValue,
  Metadata,
  PublicId,
  ResourceDescription,
  ResourceName,
  Slug,
  Timestamp,
} from "./primitives.ts";

const ResourceVersion = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Workflow resource versions must be integers." }),
    Schema.isGreaterThanOrEqualTo(0),
  ),
);

const StepId = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({ message: "Workflow step ids must not contain surrounding whitespace." }),
    Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/u, {
      message: "Workflow step ids must be lowercase identifiers of at most 64 characters.",
    }),
  ),
);

const WorkflowText = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({ message: "Workflow text must not contain surrounding whitespace." }),
    Schema.isMinLength(1),
    Schema.isMaxLength(32_000),
  ),
);

export const MAX_WORKFLOW_EXECUTION_INPUT_BYTES = 64 * 1024;
export const MAX_WORKFLOW_STEP_OUTPUT_BYTES = 64 * 1024;

const boundedMetadata = (label: string, maximum: number) =>
  Schema.makeFilter<typeof Metadata.Type>((value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum
      ? undefined
      : `${label} must not exceed ${maximum} encoded bytes.`,
  );

export const WorkflowExecutionInput = Metadata.pipe(
  Schema.check(boundedMetadata("Workflow execution input", MAX_WORKFLOW_EXECUTION_INPUT_BYTES)),
);

export const WorkflowStepOutput = Metadata.pipe(
  Schema.check(boundedMetadata("Workflow step output", MAX_WORKFLOW_STEP_OUTPUT_BYTES)),
);

const WorkflowPathSegment = Schema.Union([
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(999)),
  ),
]);

export const WorkflowOperandV1 = Schema.Union([
  Schema.Struct({
    path: Schema.optional(
      Schema.Array(WorkflowPathSegment).pipe(Schema.check(Schema.isMaxLength(32))),
    ),
    source: Schema.Literal("input"),
  }),
  Schema.Struct({
    path: Schema.optional(
      Schema.Array(WorkflowPathSegment).pipe(Schema.check(Schema.isMaxLength(32))),
    ),
    source: Schema.Literal("step"),
    stepId: StepId,
  }),
]);

export const WorkflowConditionV1 = Schema.Union([
  Schema.Struct({ left: WorkflowOperandV1, operator: Schema.Literal("exists") }),
  Schema.Struct({ left: WorkflowOperandV1, operator: Schema.Literal("truthy") }),
  Schema.Struct({ left: WorkflowOperandV1, operator: Schema.Literal("equals"), right: JsonValue }),
  Schema.Struct({
    left: WorkflowOperandV1,
    operator: Schema.Literal("not-equals"),
    right: JsonValue,
  }),
]);

const nextStep = { next: Schema.optional(StepId) } as const;
const failureStep = { onFailure: Schema.optional(StepId) } as const;

export const WorkflowStepV1 = Schema.Union([
  Schema.Struct({
    ...failureStep,
    ...nextStep,
    agentDeploymentId: PublicId,
    id: StepId,
    input: Schema.optional(Metadata),
    type: Schema.Literal("agent"),
  }),
  Schema.Struct({
    ...failureStep,
    ...nextStep,
    agentDeploymentId: PublicId,
    approvalStepId: Schema.optional(StepId),
    id: StepId,
    input: Schema.optional(Metadata),
    toolName: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
    type: Schema.Literal("tool"),
  }),
  Schema.Struct({
    id: StepId,
    onApproved: StepId,
    onExpired: Schema.optional(StepId),
    onRejected: StepId,
    prompt: WorkflowText,
    timeoutSeconds: Schema.optional(
      Schema.Number.pipe(
        Schema.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(60),
          Schema.isLessThanOrEqualTo(30 * 24 * 60 * 60),
        ),
      ),
    ),
    type: Schema.Literal("approval"),
  }),
  Schema.Struct({
    ...failureStep,
    ...nextStep,
    channel: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
    id: StepId,
    message: WorkflowText,
    target: WorkflowText,
    type: Schema.Literal("notification"),
  }),
  Schema.Struct({
    condition: WorkflowConditionV1,
    id: StepId,
    onFalse: StepId,
    onTrue: StepId,
    type: Schema.Literal("branch"),
  }),
  Schema.Struct({
    ...failureStep,
    ...nextStep,
    id: StepId,
    message: WorkflowText,
    target: WorkflowText,
    type: Schema.Literal("escalation"),
  }),
  Schema.Struct({
    id: StepId,
    outcome: Schema.optional(WorkflowStepOutput),
    type: Schema.Literal("end"),
  }),
]);

const WorkflowDefinitionDocumentV1Base = Schema.Struct({
  description: Schema.optional(ResourceDescription),
  entryStepId: StepId,
  name: ResourceName,
  schemaVersion: Schema.Literal(1),
  slug: Slug,
  steps: Schema.Array(WorkflowStepV1).pipe(
    Schema.check(
      Schema.isMinLength(1, { message: "Workflow definitions require at least one step." }),
      Schema.isMaxLength(500, { message: "Workflow definitions may contain at most 500 steps." }),
    ),
  ),
});

type WorkflowDefinitionDocumentV1Base = typeof WorkflowDefinitionDocumentV1Base.Type;
const MAX_WORKFLOW_DOCUMENT_BYTES = 192 * 1024;

export function referencedWorkflowStepIds(step: typeof WorkflowStepV1.Type) {
  switch (step.type) {
    case "agent":
    case "tool":
    case "notification":
    case "escalation":
      return [step.next, step.onFailure].filter((value): value is string => value !== undefined);
    case "approval":
      return [step.onApproved, step.onRejected, step.onExpired].filter(
        (value): value is string => value !== undefined,
      );
    case "branch":
      return [step.onTrue, step.onFalse];
    case "end":
      return [];
  }
}

function graphError(document: WorkflowDefinitionDocumentV1Base): string | undefined {
  const ids = document.steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) return "Workflow step ids must be unique.";
  const steps = new Map(document.steps.map((step) => [step.id, step] as const));
  if (!steps.has(document.entryStepId)) {
    return "Workflow entryStepId must reference a declared step.";
  }
  for (const step of document.steps) {
    for (const reference of referencedWorkflowStepIds(step)) {
      if (!steps.has(reference)) {
        return `Workflow step ${step.id} references undeclared step ${reference}.`;
      }
    }
    if (
      (step.type === "agent" ||
        step.type === "tool" ||
        step.type === "notification" ||
        step.type === "escalation") &&
      step.next === undefined
    ) {
      return `Workflow step ${step.id} requires next; only end steps may complete a successful path.`;
    }
    if (step.type === "branch" && step.condition.left.source === "step") {
      if (!steps.has(step.condition.left.stepId)) {
        return `Workflow branch ${step.id} references undeclared output step ${step.condition.left.stepId}.`;
      }
      if (step.condition.left.stepId === step.id) {
        return `Workflow branch ${step.id} cannot read its own output.`;
      }
    }
    if (step.type === "tool" && step.approvalStepId) {
      const approval = steps.get(step.approvalStepId);
      if (!approval) {
        return `Workflow tool ${step.id} references undeclared approval step ${step.approvalStepId}.`;
      }
      if (approval.type !== "approval") {
        return `Workflow tool ${step.id} approvalStepId must reference an approval step.`;
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): string | undefined => {
    if (visiting.has(stepId)) return `Workflow graph contains a cycle through step ${stepId}.`;
    if (visited.has(stepId)) return undefined;
    visiting.add(stepId);
    const step = steps.get(stepId)!;
    for (const next of referencedWorkflowStepIds(step)) {
      const error = visit(next);
      if (error) return error;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return undefined;
  };
  const cycle = visit(document.entryStepId);
  if (cycle) return cycle;
  const unreachable = ids.find((id) => !visited.has(id));
  if (unreachable) return `Workflow step ${unreachable} is unreachable from the entry step.`;

  const canReach = (sourceId: string, targetId: string) => {
    const pending = [sourceId];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const currentId = pending.pop()!;
      if (currentId === targetId) return true;
      if (seen.has(currentId)) continue;
      seen.add(currentId);
      pending.push(...referencedWorkflowStepIds(steps.get(currentId)!));
    }
    return false;
  };
  for (const step of document.steps) {
    if (
      step.type === "branch" &&
      step.condition.left.source === "step" &&
      !canReach(step.condition.left.stepId, step.id)
    ) {
      return `Workflow branch ${step.id} can only read output from a step that can precede it.`;
    }
    if (step.type === "tool" && step.approvalStepId && !canReach(step.approvalStepId, step.id)) {
      return `Workflow tool ${step.id} approval step must be able to precede it.`;
    }
  }
  return undefined;
}

export const WorkflowDefinitionDocumentV1 = WorkflowDefinitionDocumentV1Base.pipe(
  Schema.check(
    Schema.makeFilter<WorkflowDefinitionDocumentV1Base>(graphError),
    Schema.makeFilter<WorkflowDefinitionDocumentV1Base>((document) =>
      new TextEncoder().encode(JSON.stringify(document)).byteLength <= MAX_WORKFLOW_DOCUMENT_BYTES
        ? undefined
        : `Workflow definitions must not exceed ${MAX_WORKFLOW_DOCUMENT_BYTES} encoded bytes.`,
    ),
  ),
);

export const CreateWorkflowDefinitionRequest = Schema.Struct({
  definition: WorkflowDefinitionDocumentV1,
});

export const UpdateWorkflowDefinitionRequest = Schema.Struct({
  definition: WorkflowDefinitionDocumentV1,
  expectedVersion: ResourceVersion,
});

export const ArchiveWorkflowResourceRequest = Schema.Struct({
  expectedVersion: ResourceVersion,
});

export const PublishWorkflowReleaseRequest = Schema.Struct({
  expectedDefinitionVersion: ResourceVersion,
});

const tenantFields = {
  environmentId: PublicId,
  organizationId: PublicId,
  projectId: PublicId,
} as const;

const definitionSummaryFields = {
  ...tenantFields,
  createdAt: Timestamp,
  id: PublicId,
  name: ResourceName,
  slug: Slug,
  status: Schema.Literals(["active", "archived"]),
  updatedAt: Timestamp,
  version: ResourceVersion,
} as const;

export const WorkflowDefinitionSummaryResponse = Schema.Struct(definitionSummaryFields);
export const WorkflowDefinitionResponse = Schema.Struct({
  ...definitionSummaryFields,
  draft: WorkflowDefinitionDocumentV1,
});

const releaseSummaryFields = {
  ...tenantFields,
  contentHash: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^sha256:[a-f0-9]{64}$/u, {
        message: "Workflow release content hashes must be canonical SHA-256 values.",
      }),
    ),
  ),
  createdAt: Timestamp,
  createdByPrincipalId: PublicId,
  id: PublicId,
  releaseNumber: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
  status: Schema.Literals(["active", "archived"]),
  version: ResourceVersion,
  workflowDefinitionId: PublicId,
} as const;

export const WorkflowReleaseSummaryResponse = Schema.Struct(releaseSummaryFields);
export const WorkflowReleaseResponse = Schema.Struct({
  ...releaseSummaryFields,
  definition: WorkflowDefinitionDocumentV1,
});

export const ListWorkflowDefinitionsResponse = Schema.Struct({
  items: Schema.Array(WorkflowDefinitionSummaryResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const ListWorkflowReleasesResponse = Schema.Struct({
  items: Schema.Array(WorkflowReleaseSummaryResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const WorkflowExecutionStatus = Schema.Literals([
  "queued",
  "running",
  "waiting-for-agent",
  "waiting-for-tool",
  "waiting-for-approval",
  "waiting-for-delivery",
  "completed",
  "failed",
  "canceling",
  "canceled",
]);

export const WorkflowStepAttemptStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);

export const StartWorkflowExecutionRequest = Schema.Struct({
  input: Schema.optional(WorkflowExecutionInput),
  workspaceId: Schema.optional(PublicId),
});

export const CancelWorkflowExecutionRequest = Schema.Struct({
  expectedVersion: ResourceVersion,
});

const workflowExecutionFields = {
  ...tenantFields,
  completedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  currentStepAttempt: Schema.optional(ResourceVersion),
  currentStepId: Schema.optional(StepId),
  id: PublicId,
  startedAt: Schema.optional(Timestamp),
  status: WorkflowExecutionStatus,
  updatedAt: Timestamp,
  version: ResourceVersion,
  workflowContentHash: releaseSummaryFields.contentHash,
  workflowDefinitionId: PublicId,
  workflowReleaseId: PublicId,
  workflowReleaseNumber: releaseSummaryFields.releaseNumber,
  workspaceId: Schema.optional(PublicId),
} as const;

export const WorkflowExecutionSummaryResponse = Schema.Struct(workflowExecutionFields);
export const WorkflowExecutionResponse = Schema.Struct({
  ...workflowExecutionFields,
  error: Schema.optional(Metadata),
  input: Metadata,
  object: Schema.Literal("workflow-execution"),
  output: Schema.optional(Metadata),
});

export const WorkflowStepAttemptResponse = Schema.Struct({
  ...tenantFields,
  approvalId: Schema.optional(PublicId),
  attempt: ResourceVersion,
  childRunId: Schema.optional(PublicId),
  completedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  deliveryId: Schema.optional(PublicId),
  error: Schema.optional(Metadata),
  id: PublicId,
  input: Metadata,
  object: Schema.Literal("workflow-step-attempt"),
  output: Schema.optional(Metadata),
  startedAt: Schema.optional(Timestamp),
  status: WorkflowStepAttemptStatus,
  stepId: StepId,
  stepType: Schema.Literals([
    "agent",
    "tool",
    "approval",
    "notification",
    "branch",
    "escalation",
    "end",
  ]),
  toolCallId: Schema.optional(PublicId),
  updatedAt: Timestamp,
  version: ResourceVersion,
  workflowExecutionId: PublicId,
});

export const ListWorkflowExecutionsResponse = Schema.Struct({
  items: Schema.Array(WorkflowExecutionSummaryResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const ListWorkflowStepAttemptsResponse = Schema.Struct({
  items: Schema.Array(WorkflowStepAttemptResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const ResolveWorkflowApprovalRequest = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
});

export const WorkflowApprovalResponse = Schema.Struct({
  ...tenantFields,
  createdAt: Timestamp,
  expiresAt: Schema.optional(Timestamp),
  id: PublicId,
  object: Schema.Literal("workflow-approval"),
  prompt: WorkflowText,
  resolvedAt: Schema.optional(Timestamp),
  resolvedBy: Schema.optional(
    Schema.Struct({
      id: Schema.optional(PublicId),
      type: Schema.Literals(["agent", "principal", "service-account", "system", "worker"]),
    }),
  ),
  status: Schema.Literals(["approved", "canceled", "expired", "pending", "rejected"]),
  stepAttemptId: PublicId,
  updatedAt: Timestamp,
  version: ResourceVersion,
  workflowExecutionId: PublicId,
});

export type WorkflowDefinitionDocumentV1 = typeof WorkflowDefinitionDocumentV1.Type;
export type CreateWorkflowDefinitionRequest = typeof CreateWorkflowDefinitionRequest.Type;
export type UpdateWorkflowDefinitionRequest = typeof UpdateWorkflowDefinitionRequest.Type;
export type ArchiveWorkflowResourceRequest = typeof ArchiveWorkflowResourceRequest.Type;
export type PublishWorkflowReleaseRequest = typeof PublishWorkflowReleaseRequest.Type;
export type WorkflowDefinitionResponse = typeof WorkflowDefinitionResponse.Type;
export type WorkflowReleaseResponse = typeof WorkflowReleaseResponse.Type;
export type WorkflowConditionV1 = typeof WorkflowConditionV1.Type;
export type WorkflowOperandV1 = typeof WorkflowOperandV1.Type;
export type StartWorkflowExecutionRequest = typeof StartWorkflowExecutionRequest.Type;
export type CancelWorkflowExecutionRequest = typeof CancelWorkflowExecutionRequest.Type;
export type WorkflowExecutionResponse = typeof WorkflowExecutionResponse.Type;
export type WorkflowExecutionSummaryResponse = typeof WorkflowExecutionSummaryResponse.Type;
export type ListWorkflowExecutionsResponse = typeof ListWorkflowExecutionsResponse.Type;
export type WorkflowStepAttemptResponse = typeof WorkflowStepAttemptResponse.Type;
export type ListWorkflowStepAttemptsResponse = typeof ListWorkflowStepAttemptsResponse.Type;
export type ResolveWorkflowApprovalRequest = typeof ResolveWorkflowApprovalRequest.Type;
export type WorkflowApprovalResponse = typeof WorkflowApprovalResponse.Type;
