import {
  agentManifestContentHash,
  AgentDeploymentConfigV1,
  ValidatedAgentManifestV1,
} from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  ActorReference,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

/** Why a run executes: customer traffic, an interactive preview, or an evaluation case. */
export const EXECUTION_PURPOSES = ["customer", "evaluation", "preview"] as const;
export const ExecutionPurpose = Schema.Literals(EXECUTION_PURPOSES);
export type ExecutionPurpose = typeof ExecutionPurpose.Type;

/** Purposes that execute through an execution binding instead of a production deployment. */
export const BOUND_EXECUTION_PURPOSES = ["evaluation", "preview"] as const;
export const BoundExecutionPurpose = Schema.Literals(BOUND_EXECUTION_PURPOSES);
export type BoundExecutionPurpose = typeof BoundExecutionPurpose.Type;

/**
 * `interactive` behaves like a deployment (approvals are resolvable); `evaluation` denies
 * write/execute-effect tools and rejects approval-gated calls without pausing.
 */
export const ExecutionBindingToolPolicy = Schema.Literals(["evaluation", "interactive"]);
export type ExecutionBindingToolPolicy = typeof ExecutionBindingToolPolicy.Type;

/** Customer executions are pinned to a production agent deployment. */
export type CustomerExecutionPins = {
  readonly agentDeploymentId: Ulid;
  readonly executionBindingId?: undefined;
  readonly executionPurpose?: "customer";
};

/** Preview and evaluation executions are pinned to an execution binding, never a deployment. */
export type BoundExecutionPins = {
  readonly agentDeploymentId?: undefined;
  readonly executionBindingId: Ulid;
  readonly executionPurpose: BoundExecutionPurpose;
};

/** Replaces a record's flat pin fields with the purpose-discriminated execution pins. */
export type WithExecutionPins<
  Record extends { readonly data: object },
  Customer extends CustomerExecutionPins,
  Bound extends BoundExecutionPins,
> = Omit<Record, "data"> & {
  readonly data: Omit<Record["data"], keyof Customer | keyof Bound> & (Customer | Bound);
};

export function hasConsistentExecutionPins(data: {
  readonly agentDeploymentId?: unknown;
  readonly executionBindingId?: unknown;
  readonly executionPurpose?: ExecutionPurpose | undefined;
}): boolean {
  return (data.executionPurpose ?? "customer") === "customer"
    ? data.agentDeploymentId !== undefined && data.executionBindingId === undefined
    : data.agentDeploymentId === undefined && data.executionBindingId !== undefined;
}

export const ExecutionBindingSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manifest") }),
  Schema.Struct({
    agentDefinitionId: Ulid,
    agentReleaseId: Ulid,
    type: Schema.Literal("release"),
  }),
]);
export type ExecutionBindingSource = typeof ExecutionBindingSource.Type;

const ExecutionBindingRecordBase = makeRecordSchema(
  "execution-binding",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    contentHash: Schema.String,
    createdBy: ActorReference,
    expiredAt: Schema.optional(Timestamp),
    expiresAt: Timestamp,
    id: Ulid,
    idempotencyKey: Schema.String,
    manifest: ValidatedAgentManifestV1,
    purpose: BoundExecutionPurpose,
    runtimeConfig: Schema.optional(AgentDeploymentConfigV1),
    runtimeConfigSourceAgentDeploymentId: Schema.optional(Ulid),
    source: ExecutionBindingSource,
    status: Schema.Literals(["active", "expired"]),
    toolPolicy: ExecutionBindingToolPolicy,
  },
  { expiresAtField: "expiresAt" },
);

export const ExecutionBindingRecord = ExecutionBindingRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof ExecutionBindingRecordBase.Type>((record) => {
      if (record.data.contentHash !== agentManifestContentHash(record.data.manifest)) {
        return "Execution binding contentHash must match the canonical manifest hash.";
      }
      if ((record.data.status === "expired") !== (record.data.expiredAt !== undefined)) {
        return "Execution binding expiredAt is present exactly when the binding is expired.";
      }
      return Date.parse(record.data.expiresAt) > Date.parse(record.data.createdAt)
        ? undefined
        : "Execution binding expiresAt must follow createdAt.";
    }),
  ),
);
