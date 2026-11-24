import {
  MAX_AGENT_SANDBOX_MEMORY_MIB,
  MAX_AGENT_SANDBOX_VCPU,
} from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  ObservabilitySourceContext,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  workspaceScopeFields,
} from "../record-schema.ts";

export const MAX_SANDBOX_RESERVED_MEMORY_MIB = MAX_AGENT_SANDBOX_MEMORY_MIB;
export const MAX_SANDBOX_RESERVED_VCPU = MAX_AGENT_SANDBOX_VCPU;

function sandboxResourceReservation(maximum: number, resource: string) {
  return Schema.Number.pipe(
    Schema.check(
      Schema.isFinite({ message: "Sandbox resource reservations must be finite." }),
      Schema.isGreaterThan(0, { message: "Sandbox resource reservations must be positive." }),
      Schema.isLessThanOrEqualTo(maximum, {
        message: `Sandbox ${resource} reservations exceed the supported maximum.`,
      }),
    ),
  );
}

const SandboxMemoryReservation = sandboxResourceReservation(
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  "memory",
);
const SandboxVcpuReservation = sandboxResourceReservation(MAX_SANDBOX_RESERVED_VCPU, "vCPU");

/**
 * The durable owner of sandbox state: the production agent deployment of a customer run, or the
 * execution binding of a preview/evaluation run. Keys include the kind, so a deployment and a
 * binding never share sandbox state even when their ids are equal.
 */
export const SANDBOX_EXECUTION_TARGET_KINDS = ["agent-deployment", "execution-binding"] as const;
export const SandboxExecutionTargetKind = Schema.Literals(SANDBOX_EXECUTION_TARGET_KINDS);
export type SandboxExecutionTargetKind = typeof SandboxExecutionTargetKind.Type;

export const SandboxLeaseRecord = makeRecordSchema("sandbox-lease", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  accessPolicyRef: Schema.optional(Schema.String),
  capacitySlot: Schema.optional(NonNegativeSafeInteger),
  checkpointRef: Schema.optional(Schema.String),
  checkpointRequestedAt: Schema.optional(Timestamp),
  computeUsageActive: Schema.Boolean,
  destroyedAt: Schema.optional(Timestamp),
  destroyCompletedAt: Schema.optional(Timestamp),
  executionTargetId: Ulid,
  executionTargetKind: SandboxExecutionTargetKind,
  externalSandboxId: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  id: Ulid,
  imageRef: Schema.optional(Schema.String),
  isolationMode: Schema.Literals(["run-ephemeral", "thread-persistent"]),
  observability: Schema.optional(ObservabilitySourceContext),
  lastHeartbeatAt: Schema.optional(Schema.String),
  leaseExpiresAt: Schema.optional(Timestamp),
  poolKey: Schema.optional(Schema.String),
  preferredRegion: Schema.optional(Schema.String),
  provider: Schema.Literal("aws_lambda_microvm"),
  providerConfigFingerprint: Schema.optional(Schema.String),
  providerRouteKey: Schema.optional(Schema.String),
  readyAt: Schema.optional(Timestamp),
  recoveryExternalSandboxId: Schema.optional(Schema.String),
  requestedMemoryMiB: Schema.optional(SandboxMemoryReservation),
  requestedVcpu: Schema.optional(SandboxVcpuReservation),
  resumeRequestedAt: Schema.optional(Timestamp),
  region: Schema.optional(Schema.String),
  reservedMemoryMiB: Schema.optional(SandboxMemoryReservation),
  reservedVcpu: Schema.optional(SandboxVcpuReservation),
  runId: Schema.optional(Ulid),
  status: Schema.Literals([
    "checkpointing",
    "creating",
    "destroyed",
    "error",
    "ready",
    "releasing",
    "resuming",
    "suspended",
  ]),
  usageAccountedThrough: Schema.optional(Timestamp),
  usagePendingThrough: Schema.optional(Timestamp),
  usageStartedAt: Timestamp,
});

/**
 * The sandbox uploads its archive to S3 in one presigned `PutObject`, whose hard limit is
 * 5 GiB. Larger workspaces would need multipart uploads.
 */
export const MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_SANDBOX_WORKSPACE_FAILURE_REASON_CHARACTERS = 1024;

const SandboxWorkspaceSnapshot = Schema.Struct({
  bucket: NonEmptyString,
  byteSize: Schema.Number.pipe(
    Schema.check(
      Schema.isInt({ message: "Sandbox workspace snapshot sizes must be integers." }),
      Schema.isGreaterThanOrEqualTo(1, {
        message: "Sandbox workspace snapshots must not be empty.",
      }),
      Schema.isLessThanOrEqualTo(MAX_SANDBOX_WORKSPACE_SNAPSHOT_BYTES, {
        message: "Sandbox workspace snapshots exceed the supported maximum size.",
      }),
    ),
  ),
  capturedAt: Timestamp,
  key: NonEmptyString,
  leaseId: Ulid,
  sha256: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^[0-9a-f]{64}$/u, {
        message: "Sandbox workspace snapshot digests must be lowercase hex SHA-256.",
      }),
    ),
  ),
  versionId: NonEmptyString,
});

/**
 * `archive-too-large` and `snapshot-incomplete` (the in-sandbox archive or transfer failed or
 * ran out of time) leave a healthy sandbox that holds the only copy of its newest files, so
 * it is carried forward until the provider's maximum lifetime. `snapshot-failed` covers every
 * other failure.
 */
export const SandboxWorkspaceSnapshotFailureCode = Schema.Literals([
  "archive-too-large",
  "snapshot-failed",
  "snapshot-incomplete",
]);

const SandboxWorkspaceSnapshotFailure = Schema.Struct({
  at: Timestamp,
  code: SandboxWorkspaceSnapshotFailureCode,
  leaseId: Ulid,
  reason: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1, { message: "Sandbox snapshot failure reasons must not be empty." }),
      Schema.isMaxLength(MAX_SANDBOX_WORKSPACE_FAILURE_REASON_CHARACTERS, {
        message: "Sandbox snapshot failure reasons exceed the supported length.",
      }),
    ),
  ),
});

export const SandboxWorkspaceRecord = makeRecordSchema("sandbox-workspace", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  executionTargetId: Ulid,
  executionTargetKind: SandboxExecutionTargetKind,
  id: Ulid,
  lastSnapshotFailure: Schema.optional(SandboxWorkspaceSnapshotFailure),
  leaseId: Schema.optional(Ulid),
  leaseRunId: Schema.optional(Ulid),
  restoredLeaseId: Schema.optional(Ulid),
  snapshot: Schema.optional(SandboxWorkspaceSnapshot),
  threadId: Ulid,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      const snapshot = record.data.snapshot;
      if (!snapshot) return undefined;
      return snapshot.key.startsWith(`organizations/${record.data.organizationId}/`)
        ? undefined
        : "Sandbox workspace snapshots must be stored under their organization prefix.";
    }),
  ),
);
