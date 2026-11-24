import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  ActorReference,
  MAX_DYNAMODB_ITEM_BYTES,
  Metadata,
  NonEmptyString,
  StringList,
  Timestamp,
  dynamoItemByteSize,
  makeRecordSchema,
  workspaceScopeFields,
} from "../record-schema.ts";
import {
  ExecutionPurpose,
  hasConsistentExecutionPins,
  type BoundExecutionPins,
  type CustomerExecutionPins,
  type WithExecutionPins,
} from "./execution-bindings.ts";

const Sha256Digest = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) =>
      /^sha256:[0-9a-f]{64}$/u.test(value) ? undefined : "Expected a canonical SHA-256 digest.",
    ),
  ),
);

export const CallbackDispatchApprovalEvidence = Schema.Struct({
  expiresAt: Schema.optional(Timestamp),
  id: Ulid,
  kind: Schema.Literals(["agent-run", "workflow"]),
  resolvedBy: Schema.optional(ActorReference),
  status: Schema.Literal("approved"),
});

export const CallbackChannelOrigin = Schema.Struct({
  channelBindingId: Ulid,
  externalAccountId: Schema.optional(NonEmptyString),
  externalChannelId: NonEmptyString,
  externalMessageId: NonEmptyString,
  externalThreadKey: NonEmptyString,
  externalWorkspaceId: Schema.optional(NonEmptyString),
  kind: Schema.Literal("channel"),
  provider: NonEmptyString,
  sender: Schema.Struct({ displayName: Schema.optional(Schema.String), id: NonEmptyString }),
});
export type CallbackChannelOrigin = typeof CallbackChannelOrigin.Type;

const CallbackDispatchEvidenceRecordBase = makeRecordSchema("callback-dispatch-evidence", {
  ...workspaceScopeFields,
  agentDefinitionId: Schema.optional(Ulid),
  agentDeploymentId: Schema.optional(Ulid),
  agentReleaseId: Schema.optional(Ulid),
  approval: Schema.optional(CallbackDispatchApprovalEvidence),
  authorizationFingerprint: NonEmptyString,
  connectionId: Ulid,
  createdAt: Timestamp,
  effect: Schema.Literals(["execute", "read", "write"]),
  executionBindingId: Schema.optional(Ulid),
  executionKind: Schema.Literals(["agent-run", "workflow"]),
  executionPurpose: Schema.optional(ExecutionPurpose),
  externalAccountId: NonEmptyString,
  id: Ulid,
  idempotencyKey: NonEmptyString,
  input: Metadata,
  inputHash: Sha256Digest,
  inputSummary: Schema.String,
  origin: Schema.optional(CallbackChannelOrigin),
  policyAction: Schema.Literals(["allow", "require-approval"]),
  policyReason: Schema.String,
  requiredScopes: StringList,
  runId: Ulid,
  threadId: Ulid,
  toolAdapterId: Schema.optional(Ulid),
  toolCallId: Ulid,
  toolName: NonEmptyString,
  toolPlanFingerprint: Schema.optional(NonEmptyString),
});

/**
 * Customer dispatches pin the deployment and release they ran under. Preview/evaluation dispatches
 * pin the execution binding and carry the definition and release only when the binding came from
 * a published release.
 */
export type CallbackDispatchEvidenceRecordValue = WithExecutionPins<
  typeof CallbackDispatchEvidenceRecordBase.Type,
  CustomerExecutionPins & { readonly agentDefinitionId: Ulid; readonly agentReleaseId: Ulid },
  BoundExecutionPins & { readonly agentDefinitionId?: Ulid; readonly agentReleaseId?: Ulid }
>;

export const CallbackDispatchEvidenceRecord = CallbackDispatchEvidenceRecordBase.pipe(
  Schema.refine(
    (record): record is CallbackDispatchEvidenceRecordValue =>
      hasConsistentExecutionPins(record.data) &&
      (record.data.agentDefinitionId === undefined) ===
        (record.data.agentReleaseId === undefined) &&
      (record.data.agentDeploymentId === undefined || record.data.agentReleaseId !== undefined) &&
      (record.data.executionBindingId === undefined || record.data.executionKind === "agent-run"),
    {
      identifier: "CallbackDispatchEvidenceExecutionPins",
      message:
        "Customer callback dispatches require agentDeploymentId and agentReleaseId; preview and evaluation dispatches require executionBindingId and an agent run.",
    },
  ),
  Schema.check(
    Schema.makeFilter<CallbackDispatchEvidenceRecordValue>((record) => {
      if (dynamoItemByteSize(record) > MAX_DYNAMODB_ITEM_BYTES) {
        return "Callback dispatch evidence records must fit in one DynamoDB item.";
      }
      const requiresApproval = record.data.policyAction === "require-approval";
      if (requiresApproval !== Boolean(record.data.approval)) {
        return "Callback dispatch approval evidence must match the policy action.";
      }
      if (record.data.approval && record.data.approval.kind !== record.data.executionKind) {
        return "Callback dispatch approval kind must match the execution kind.";
      }
      if (record.data.origin && record.data.executionKind !== "agent-run") {
        return "Callback dispatch origin is recorded only for agent runs.";
      }
      return undefined;
    }),
  ),
);
