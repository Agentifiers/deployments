import { Schema } from "effect";
import { createHash } from "node:crypto";
import { canonicalJsonValue } from "../canonical-json.ts";
import { Ulid } from "../ids.ts";
import {
  ActorReference,
  MAX_DYNAMODB_ITEM_BYTES,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  dynamoItemByteSize,
  mutableResourceFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";

export function workflowDefinitionContentHash(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex")}`;
}

export const WorkflowDefinitionRecord = makeRecordSchema("workflow-definition", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  createdByPrincipalId: Ulid,
  draft: Metadata,
  id: Ulid,
  lastReleaseNumber: Schema.optional(NonNegativeSafeInteger),
  name: Schema.String,
  slug: NonEmptyString,
  status: Schema.Literals(["active", "archived"]),
});

const WorkflowReleaseRecordBase = makeRecordSchema("workflow-release", {
  ...tenantScopeFields,
  contentHash: NonEmptyString,
  createdAt: Timestamp,
  createdByPrincipalId: Ulid,
  definition: Metadata,
  id: Ulid,
  releaseNumber: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  status: Schema.Literals(["active", "archived"]),
  version: NonNegativeSafeInteger,
  workflowDefinitionId: Ulid,
});

export const WorkflowReleaseRecord = WorkflowReleaseRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof WorkflowReleaseRecordBase.Type>((record) =>
      record.data.contentHash === workflowDefinitionContentHash(record.data.definition)
        ? undefined
        : "Workflow release contentHash must match its canonical definition hash.",
    ),
  ),
);

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

export const WorkflowStepType = Schema.Literals([
  "agent",
  "tool",
  "approval",
  "notification",
  "branch",
  "escalation",
  "end",
]);

const WorkflowExecutionRecordBase = makeRecordSchema("workflow-execution", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  activeStepAttemptId: Schema.optional(Ulid),
  cancelRequestedAt: Schema.optional(Timestamp),
  completedAt: Schema.optional(Timestamp),
  context: Metadata,
  currentStepAttempt: Schema.optional(NonNegativeSafeInteger),
  currentStepId: Schema.optional(NonEmptyString),
  error: Schema.optional(Metadata),
  id: Ulid,
  idempotencyKey: NonEmptyString,
  initiatedBy: ActorReference,
  input: Metadata,
  output: Schema.optional(Metadata),
  startedAt: Schema.optional(Timestamp),
  status: WorkflowExecutionStatus,
  stepTransitionCount: NonNegativeSafeInteger,
  workflowContentHash: NonEmptyString,
  workflowDefinitionId: Ulid,
  workflowReleaseId: Ulid,
  workflowReleaseNumber: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
});

export const WorkflowExecutionRecord = WorkflowExecutionRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof WorkflowExecutionRecordBase.Type>((record) =>
      dynamoItemByteSize(record) <= MAX_DYNAMODB_ITEM_BYTES
        ? undefined
        : "Workflow execution records must fit in one DynamoDB item.",
    ),
  ),
);

export const WorkflowExecutionLookupRecord = makeRecordSchema("workflow-execution-lookup", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  executionId: Ulid,
  idempotencyKey: NonEmptyString,
});

export const WorkflowStepAttemptRecord = makeRecordSchema("workflow-step-attempt", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  approvalId: Schema.optional(Ulid),
  attempt: NonNegativeSafeInteger,
  childRunId: Schema.optional(Ulid),
  completedAt: Schema.optional(Timestamp),
  deliveryId: Schema.optional(Ulid),
  error: Schema.optional(Metadata),
  id: Ulid,
  input: Metadata,
  output: Schema.optional(Metadata),
  startedAt: Schema.optional(Timestamp),
  status: WorkflowStepAttemptStatus,
  stepId: NonEmptyString,
  stepType: WorkflowStepType,
  toolCallId: Schema.optional(Ulid),
  workflowExecutionId: Ulid,
});

export const WorkflowApprovalRecord = makeRecordSchema("workflow-approval", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  expiresAt: Schema.optional(Timestamp),
  id: Ulid,
  prompt: NonEmptyString,
  requestedBy: ActorReference,
  resolvedAt: Schema.optional(Timestamp),
  resolvedBy: Schema.optional(ActorReference),
  status: Schema.Literals(["approved", "canceled", "expired", "pending", "rejected"]),
  stepAttemptId: Ulid,
  workflowExecutionId: Ulid,
});

export const WorkflowStepCorrelationRecord = makeRecordSchema("workflow-step-correlation", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  externalId: Ulid,
  externalKind: Schema.Literals(["approval", "child-run", "delivery", "tool-call"]),
  stepAttemptId: Ulid,
  workflowExecutionId: Ulid,
});
