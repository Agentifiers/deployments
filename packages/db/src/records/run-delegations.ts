import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { Timestamp, makeRecordSchema, tenantScopeFields } from "../record-schema.ts";

/** Maximum delegation ancestry retained per child run; trace graphs are capped at 1,024 runs. */
export const MAX_RUN_DELEGATION_ANCESTORS = 1_024;

const DelegationDepth = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Delegation depth must be an integer." }),
    Schema.isGreaterThanOrEqualTo(1, { message: "Delegation depth must be at least 1." }),
    Schema.isLessThanOrEqualTo(MAX_RUN_DELEGATION_ANCESTORS, {
      message: `Delegation depth must not exceed ${MAX_RUN_DELEGATION_ANCESTORS}.`,
    }),
  ),
);

/**
 * Immutable child-to-parent link written with a delegated child run. It lives in the child run
 * partition so terminal child processing and nested delegation checks read it by child run ID.
 */
export const RunDelegationRecord = makeRecordSchema("run-delegation", {
  ...tenantScopeFields,
  /** Agent deployments from the root run through the parent run, in delegation order. */
  ancestorAgentDeploymentIds: Schema.Array(Ulid).pipe(
    Schema.check(
      Schema.isMinLength(1, { message: "Delegation ancestry must include the parent." }),
      Schema.isMaxLength(MAX_RUN_DELEGATION_ANCESTORS, {
        message: `Delegation ancestry must not exceed ${MAX_RUN_DELEGATION_ANCESTORS} deployments.`,
      }),
    ),
  ),
  /** The parent tool call waits for this child's terminal result. */
  awaitResult: Schema.Boolean,
  childAgentDeploymentId: Ulid,
  childRunId: Ulid,
  childThreadId: Ulid,
  createdAt: Timestamp,
  depth: DelegationDepth,
  edgeKind: Schema.String,
  parentAgentDeploymentId: Ulid,
  parentRunId: Ulid,
  parentThreadId: Ulid,
});
export type RunDelegationRecordValue = typeof RunDelegationRecord.Type;
