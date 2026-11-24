import { Schema } from "effect";
import { canonicalJsonValue } from "../canonical-json.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { ActorReference, Metadata } from "../record-schema.ts";
import type { PlatformRecord } from "../records/index.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  WorkflowExecutionLookupRecord,
  WorkflowExecutionRecord,
  WorkflowStepCorrelationRecord,
} from "../records/workflows.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { transactionToken } from "./transaction-tokens.ts";

export type WorkflowExecutionRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "workflow-execution" }
>;
export type WorkflowStepAttemptRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "workflow-step-attempt" }
>;
export type WorkflowStepCorrelationRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "workflow-step-correlation" }
>;
type TransitionWorkflowApprovalRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "workflow-approval" }
>;

type WorkflowMetadata = typeof Metadata.Type;
type WorkflowActor = typeof ActorReference.Type;

export interface WorkflowExecutionScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId?: Ulid;
}

export interface CreateWorkflowExecutionInput extends WorkflowExecutionScope {
  readonly idempotencyKey: string;
  readonly initiatedBy: WorkflowActor;
  readonly input: WorkflowMetadata;
  readonly workflowContentHash: string;
  readonly workflowDefinitionId: Ulid;
  readonly workflowReleaseId: Ulid;
  readonly workflowReleaseNumber: number;
  readonly entryStepId: string;
}

export interface CommitWorkflowExecutionTransitionInput {
  readonly actor?: WorkflowActor;
  readonly approval?: TransitionWorkflowApprovalRecordValue;
  readonly eventType: string;
  readonly correlation?: WorkflowStepCorrelationRecordValue;
  readonly nextExecution: WorkflowExecutionRecordValue;
  readonly payload?: WorkflowMetadata;
  readonly previousExecution: WorkflowExecutionRecordValue;
  readonly previousApproval?: TransitionWorkflowApprovalRecordValue;
  readonly previousStepAttempt?: WorkflowStepAttemptRecordValue;
  readonly stepAttempt?: WorkflowStepAttemptRecordValue;
}

export interface WorkflowExecutionPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}

export interface WorkflowExecutionCreatePrerequisite {
  readonly pk: string;
  readonly sk: string;
  readonly version: number;
}

export class WorkflowExecutionPersistenceError extends Error {
  constructor(
    readonly code: "conflict" | "idempotency_conflict" | "not_found",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowExecutionPersistenceError";
  }
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function executionKey(organizationId: Ulid, executionId: Ulid) {
  return {
    pk: key("ORG", organizationId, "WORKFLOW-EXECUTION", executionId),
    sk: key("WORKFLOW-EXECUTION", executionId),
  };
}

function stepAttemptKey(organizationId: Ulid, executionId: Ulid, stepAttemptId: Ulid) {
  return {
    pk: key("ORG", organizationId, "WORKFLOW-EXECUTION", executionId),
    sk: key("WORKFLOW-STEP-ATTEMPT", stepAttemptId),
  };
}

function correlationKey(
  organizationId: Ulid,
  externalKind: WorkflowStepCorrelationRecordValue["data"]["externalKind"],
  externalId: Ulid,
) {
  return {
    pk: key("ORG", organizationId, "WORKFLOW-CORRELATION", externalKind),
    sk: key("EXTERNAL", externalId),
  };
}

function lookupRecord(
  input: Pick<
    CreateWorkflowExecutionInput,
    "environmentId" | "idempotencyKey" | "organizationId" | "projectId"
  >,
  executionId: Ulid,
  createdAt: string,
) {
  return Schema.decodeUnknownSync(WorkflowExecutionLookupRecord)(
    withCanonicalRecordKeys({
      data: { ...input, createdAt, executionId },
      itemType: "workflow-execution-lookup" as const,
    }),
  );
}

function assertExecution(value: PlatformRecord | undefined, label: string) {
  if (!value || value.itemType !== "workflow-execution") {
    throw new WorkflowExecutionPersistenceError("not_found", `${label} was not found.`);
  }
  return value;
}

function assertCreateReplay(
  execution: WorkflowExecutionRecordValue,
  input: CreateWorkflowExecutionInput,
) {
  if (
    execution.data.workflowReleaseId !== input.workflowReleaseId ||
    execution.data.workflowDefinitionId !== input.workflowDefinitionId ||
    execution.data.workflowContentHash !== input.workflowContentHash ||
    execution.data.workspaceId !== input.workspaceId ||
    !sameJson(execution.data.input, input.input)
  ) {
    throw new WorkflowExecutionPersistenceError(
      "idempotency_conflict",
      "The workflow execution idempotency key belongs to a different request.",
    );
  }
}

function assertImmutablePins(
  previous: WorkflowExecutionRecordValue,
  next: WorkflowExecutionRecordValue,
) {
  const fields = [
    "id",
    "idempotencyKey",
    "organizationId",
    "projectId",
    "environmentId",
    "workspaceId",
    "workflowDefinitionId",
    "workflowReleaseId",
    "workflowReleaseNumber",
    "workflowContentHash",
    "createdAt",
  ] as const;
  if (fields.some((field) => previous.data[field] !== next.data[field])) {
    throw new TypeError(
      "Workflow execution transitions cannot change immutable identity or release pins.",
    );
  }
  if (next.data.version !== previous.data.version + 1) {
    throw new TypeError("Workflow execution transitions must increment version by exactly one.");
  }
  if (next.data.stepTransitionCount < previous.data.stepTransitionCount) {
    throw new TypeError("Workflow execution stepTransitionCount cannot decrease.");
  }
}

export function makeWorkflowExecutionPersistence(
  dependencies: WorkflowExecutionPersistenceDependencies,
) {
  const { database, generateId } = dependencies;

  const get = async (organizationId: Ulid, executionId: Ulid) =>
    assertExecution(
      await database.getRecord("execution", executionKey(organizationId, executionId), true),
      "Workflow execution",
    );

  const getByIdempotencyKey = async (
    input: Pick<
      CreateWorkflowExecutionInput,
      "environmentId" | "idempotencyKey" | "organizationId" | "projectId"
    >,
  ) => {
    const probe = lookupRecord(
      input,
      "00000000000000000000000000" as Ulid,
      "1970-01-01T00:00:00.000Z",
    );
    const found = await database.getRecord("execution", { pk: probe.pk, sk: probe.sk }, true);
    if (!found) return undefined;
    if (
      found.itemType !== "workflow-execution-lookup" ||
      found.data.organizationId !== input.organizationId ||
      found.data.projectId !== input.projectId ||
      found.data.environmentId !== input.environmentId ||
      found.data.idempotencyKey !== input.idempotencyKey
    ) {
      throw new WorkflowExecutionPersistenceError(
        "idempotency_conflict",
        "The workflow execution idempotency lookup is inconsistent.",
      );
    }
    return get(input.organizationId, found.data.executionId);
  };

  const getStepAttempt = async (organizationId: Ulid, executionId: Ulid, stepAttemptId: Ulid) => {
    const found = await database.getRecord(
      "execution",
      stepAttemptKey(organizationId, executionId, stepAttemptId),
      true,
    );
    if (
      !found ||
      found.itemType !== "workflow-step-attempt" ||
      found.data.workflowExecutionId !== executionId
    ) {
      throw new WorkflowExecutionPersistenceError(
        "not_found",
        "Workflow step attempt was not found.",
      );
    }
    return found;
  };

  const getCorrelation = async (
    organizationId: Ulid,
    externalKind: WorkflowStepCorrelationRecordValue["data"]["externalKind"],
    externalId: Ulid,
  ) => {
    const found = await database.getRecord(
      "execution",
      correlationKey(organizationId, externalKind, externalId),
      true,
    );
    if (
      !found ||
      found.itemType !== "workflow-step-correlation" ||
      found.data.externalKind !== externalKind ||
      found.data.externalId !== externalId
    ) {
      throw new WorkflowExecutionPersistenceError(
        "not_found",
        "Workflow step correlation was not found.",
      );
    }
    return found;
  };

  const create = async (
    input: CreateWorkflowExecutionInput,
    options: {
      readonly prerequisites?: readonly WorkflowExecutionCreatePrerequisite[];
    } = {},
  ) => {
    const replay = await getByIdempotencyKey(input);
    if (replay) {
      assertCreateReplay(replay, input);
      return { created: false, execution: replay } as const;
    }
    const [executionId, eventId] = await Promise.all([generateId(), generateId()]);
    const timestamp = (dependencies.now?.() ?? new Date()).toISOString();
    const execution = Schema.decodeUnknownSync(WorkflowExecutionRecord)(
      withCanonicalRecordKeys({
        data: {
          ...input,
          context: {},
          createdAt: timestamp,
          currentStepAttempt: 0,
          currentStepId: input.entryStepId,
          id: executionId,
          status: "queued" as const,
          stepTransitionCount: 0,
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "workflow-execution" as const,
      }),
    );
    const lookup = lookupRecord(input, executionId, timestamp);
    const event = makeSemanticEventRecord({
      actor: input.initiatedBy,
      aggregateId: executionId,
      aggregateType: "workflow-execution",
      aggregateVersion: 1,
      environmentId: input.environmentId,
      eventId,
      eventType: "workflow-execution.requested",
      occurredAt: timestamp,
      organizationId: input.organizationId,
      payload: {
        status: execution.data.status,
        workflowContentHash: input.workflowContentHash,
        workflowDefinitionId: input.workflowDefinitionId,
        workflowReleaseId: input.workflowReleaseId,
      },
      projectId: input.projectId,
    });
    try {
      await transactWithSemanticEvents(
        database,
        [
          ...(options.prerequisites ?? []).map((prerequisite) => ({
            conditionExpression: "#data.#status = :active AND #data.#version = :version",
            expressionAttributeNames: {
              "#data": "data",
              "#status": "status",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":active": "active",
              ":version": prerequisite.version,
            },
            key: { pk: prerequisite.pk, sk: prerequisite.sk },
            kind: "condition-check" as const,
            table: "control" as const,
          })),
          { kind: "put", record: lookup },
          { kind: "put", record: execution },
        ],
        [event],
        transactionToken(
          "workflow-execution.create",
          input.organizationId,
          input.idempotencyKey,
          executionId,
        ),
      );
      return { created: true, execution } as const;
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      const reconciled = await getByIdempotencyKey(input);
      if (!reconciled) {
        throw new WorkflowExecutionPersistenceError(
          "conflict",
          "Workflow execution creation conflicted and could not be reconciled.",
          { cause },
        );
      }
      assertCreateReplay(reconciled, input);
      return { created: false, execution: reconciled } as const;
    }
  };

  const commitTransition = async (input: CommitWorkflowExecutionTransitionInput) => {
    assertImmutablePins(input.previousExecution, input.nextExecution);
    if (
      input.stepAttempt &&
      input.stepAttempt.data.workflowExecutionId !== input.nextExecution.data.id
    ) {
      throw new TypeError("Workflow step attempt does not belong to the transitioned execution.");
    }
    if (
      input.previousStepAttempt &&
      (!input.stepAttempt ||
        input.previousStepAttempt.data.id !== input.stepAttempt.data.id ||
        input.stepAttempt.data.version !== input.previousStepAttempt.data.version + 1)
    ) {
      throw new TypeError("Workflow step attempt updates must increment one matching attempt.");
    }
    if (
      input.previousApproval &&
      (!input.approval ||
        input.previousApproval.data.id !== input.approval.data.id ||
        input.approval.data.workflowExecutionId !== input.nextExecution.data.id ||
        input.approval.data.version !== input.previousApproval.data.version + 1)
    ) {
      throw new TypeError("Workflow approval updates must increment one matching approval.");
    }
    const eventId = await generateId();
    const event = makeSemanticEventRecord({
      actor: input.actor ?? { type: "worker" },
      aggregateId: input.nextExecution.data.id,
      aggregateType: "workflow-execution",
      aggregateVersion: input.nextExecution.data.version + 1,
      environmentId: input.nextExecution.data.environmentId,
      eventId,
      eventType: input.eventType,
      occurredAt: input.nextExecution.data.updatedAt,
      organizationId: input.nextExecution.data.organizationId,
      payload: {
        status: input.nextExecution.data.status,
        ...(input.nextExecution.data.currentStepId
          ? { currentStepId: input.nextExecution.data.currentStepId }
          : {}),
        ...input.payload,
      },
      projectId: input.nextExecution.data.projectId,
    });
    const approvalEvent =
      input.previousApproval &&
      input.approval &&
      input.previousApproval.data.status !== input.approval.data.status
        ? makeSemanticEventRecord({
            actor: input.actor ?? { type: "worker" },
            aggregateId: input.approval.data.id,
            aggregateType: "workflow-approval",
            aggregateVersion: input.approval.data.version + 1,
            environmentId: input.approval.data.environmentId,
            eventId: await generateId(),
            eventType: "workflow-approval.resolved",
            occurredAt: input.approval.data.updatedAt,
            organizationId: input.approval.data.organizationId,
            payload: {
              decision: input.approval.data.status,
              stepAttemptId: input.approval.data.stepAttemptId,
              workflowExecutionId: input.approval.data.workflowExecutionId,
            },
            projectId: input.approval.data.projectId,
          })
        : undefined;
    try {
      await transactWithSemanticEvents(
        database,
        [
          {
            kind: "put",
            previousRecord: input.previousExecution,
            record: input.nextExecution,
          },
          ...(input.stepAttempt
            ? [
                {
                  kind: "put" as const,
                  ...(input.previousStepAttempt
                    ? { previousRecord: input.previousStepAttempt }
                    : {}),
                  record: input.stepAttempt,
                },
              ]
            : []),
          ...(input.correlation ? [{ kind: "put" as const, record: input.correlation }] : []),
          ...(input.approval
            ? [
                {
                  kind: "put" as const,
                  ...(input.previousApproval ? { previousRecord: input.previousApproval } : {}),
                  record: input.approval,
                },
              ]
            : []),
        ],
        [event, ...(approvalEvent ? [approvalEvent] : [])],
        transactionToken(
          "workflow-execution.transition",
          input.nextExecution.data.id,
          String(input.nextExecution.data.version),
          event.data.eventId,
        ),
      );
      return input.nextExecution;
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      throw new WorkflowExecutionPersistenceError(
        "conflict",
        "Workflow execution changed concurrently.",
        { cause },
      );
    }
  };

  return {
    commitTransition,
    create,
    get,
    getByIdempotencyKey,
    getCorrelation,
    getStepAttempt,
  };
}

export function workflowStepCorrelation(input: {
  readonly createdAt: string;
  readonly environmentId: Ulid;
  readonly externalId: Ulid;
  readonly externalKind: WorkflowStepCorrelationRecordValue["data"]["externalKind"];
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly stepAttemptId: Ulid;
  readonly workflowExecutionId: Ulid;
}) {
  return Schema.decodeUnknownSync(WorkflowStepCorrelationRecord)(
    withCanonicalRecordKeys({
      data: input,
      itemType: "workflow-step-correlation" as const,
    }),
  );
}
