import type { JsonValue, WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import type {
  Ulid,
  WorkflowExecutionRecordValue,
  WorkflowApprovalRecordValue,
  WorkflowStepAttemptRecordValue,
  WorkflowStepCorrelationRecordValue,
} from "@deployments-ai/db";
import type { WorkflowRuntimeAction } from "@deployments-ai/workflows";

export interface WorkflowExecutionMessage {
  readonly environmentId: Ulid;
  readonly executionId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

export type WorkflowQueueCommand =
  | ({ readonly kind: "advance" } & WorkflowExecutionMessage)
  | ({
      readonly kind: "dispatch";
      readonly stepAttemptId: Ulid;
    } & WorkflowExecutionMessage)
  | ({
      readonly approvalId?: Ulid;
      readonly error?: Readonly<Record<string, JsonValue>>;
      readonly kind: "continue";
      readonly outcome: WorkflowStepResult["outcome"];
      readonly output?: Readonly<Record<string, JsonValue>>;
      readonly stepAttemptId: Ulid;
    } & WorkflowExecutionMessage);

export interface WorkflowReleaseSnapshot {
  readonly contentHash: string;
  readonly definition: WorkflowDefinitionDocumentV1;
  readonly id: Ulid;
}

export type LoadWorkflowRelease = (
  execution: WorkflowExecutionRecordValue,
) => Promise<WorkflowReleaseSnapshot>;

export interface WorkflowStepResult {
  readonly approvalId?: Ulid;
  readonly error?: Readonly<Record<string, JsonValue>>;
  readonly execution: WorkflowExecutionMessage;
  readonly outcome:
    | "succeeded"
    | "failed"
    | "approved"
    | "rejected"
    | "expired"
    | "delivered"
    | "canceled";
  readonly output?: Readonly<Record<string, JsonValue>>;
  readonly stepAttemptId: Ulid;
}

export interface WorkflowRuntimePersistence {
  readonly commitTransition: (input: {
    readonly approval?: WorkflowApprovalRecordValue;
    readonly eventType: string;
    readonly correlation?: WorkflowStepCorrelationRecordValue;
    readonly nextExecution: WorkflowExecutionRecordValue;
    readonly payload?: Readonly<Record<string, JsonValue>>;
    readonly previousExecution: WorkflowExecutionRecordValue;
    readonly previousApproval?: WorkflowApprovalRecordValue;
    readonly previousStepAttempt?: WorkflowStepAttemptRecordValue;
    readonly stepAttempt?: WorkflowStepAttemptRecordValue;
  }) => Promise<WorkflowExecutionRecordValue>;
  readonly get: (organizationId: Ulid, executionId: Ulid) => Promise<WorkflowExecutionRecordValue>;
  readonly getStepAttempt: (
    organizationId: Ulid,
    executionId: Ulid,
    stepAttemptId: Ulid,
  ) => Promise<WorkflowStepAttemptRecordValue>;
  readonly getCorrelation: (
    organizationId: Ulid,
    externalKind: WorkflowStepCorrelationRecordValue["data"]["externalKind"],
    externalId: Ulid,
  ) => Promise<WorkflowStepCorrelationRecordValue>;
  readonly getApproval?: (
    organizationId: Ulid,
    executionId: Ulid,
    approvalId: Ulid,
  ) => Promise<WorkflowApprovalRecordValue>;
}

export interface WorkflowProcessorDependencies {
  readonly generateId: () => Promise<Ulid>;
  readonly loadRelease: LoadWorkflowRelease;
  readonly now?: () => Date;
  readonly persistence: WorkflowRuntimePersistence;
}

export interface WorkflowStepDispatchContext {
  readonly action: Exclude<
    WorkflowRuntimeAction,
    { readonly kind: "advance-branch" | "cancel" | "complete" }
  >;
  readonly execution: WorkflowExecutionRecordValue;
  readonly idempotencyKey: string;
  readonly stepAttempt: WorkflowStepAttemptRecordValue;
}

export type WorkflowStepDispatchResult =
  | {
      readonly error: Readonly<Record<string, JsonValue>>;
      readonly state: "failed";
    }
  | {
      readonly output?: Readonly<Record<string, JsonValue>>;
      readonly state: "succeeded";
    }
  | {
      readonly referenceId: Ulid;
      readonly referenceKind: "approval" | "child-run" | "delivery" | "tool-call";
      readonly state: "waiting";
    };

export interface WorkflowDispatchDependencies extends WorkflowProcessorDependencies {
  readonly dispatchStep: (
    context: WorkflowStepDispatchContext,
  ) => Promise<WorkflowStepDispatchResult>;
  readonly recoverCorrelation?: (input: {
    readonly environmentId: Ulid;
    readonly externalId: Ulid;
    readonly externalKind: WorkflowStepCorrelationRecordValue["data"]["externalKind"];
    readonly organizationId: Ulid;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly projectId: Ulid;
  }) => Promise<WorkflowStepCorrelationRecordValue | undefined>;
  readonly scheduleApprovalExpiration?: (input: {
    readonly approvalId: Ulid;
    readonly executionId: Ulid;
    readonly expiresAt: string;
    readonly organizationId: Ulid;
  }) => Promise<void>;
}

export type ProcessWorkflowExecutionResult =
  | {
      readonly action: "dispatch-requested";
      readonly execution: WorkflowExecutionRecordValue;
      readonly stepAttempt: WorkflowStepAttemptRecordValue;
    }
  | {
      readonly action: "advanced" | "canceled" | "completed" | "failed";
      readonly execution: WorkflowExecutionRecordValue;
      readonly stepAttempt?: WorkflowStepAttemptRecordValue;
    }
  | { readonly action: "skipped"; readonly reason: string };
