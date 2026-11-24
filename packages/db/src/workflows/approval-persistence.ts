import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { ActorReference } from "../record-schema.ts";
import type { PlatformRecord } from "../records/index.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { WorkflowApprovalRecord } from "../records/workflows.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { WorkflowExecutionPersistenceError } from "./execution-persistence.ts";
import { transactionToken } from "./transaction-tokens.ts";

export type WorkflowApprovalRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "workflow-approval" }
>;

export function canceledWorkflowApproval(previous: WorkflowApprovalRecordValue, timestamp: string) {
  if (previous.data.status !== "pending") return previous;
  return Schema.decodeUnknownSync(WorkflowApprovalRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        resolvedAt: timestamp,
        status: "canceled" as const,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
    }),
  );
}

export interface CreateWorkflowApprovalInput {
  readonly environmentId: Ulid;
  readonly expiresAt?: string;
  readonly id: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly prompt: string;
  readonly requestedBy: typeof ActorReference.Type;
  readonly stepAttemptId: Ulid;
  readonly workflowExecutionId: Ulid;
}

export interface ResolveWorkflowApprovalInput {
  readonly decision: "approved" | "expired" | "rejected";
  readonly organizationId: Ulid;
  readonly resolvedBy: typeof ActorReference.Type;
  readonly workflowApprovalId: Ulid;
  readonly workflowExecutionId: Ulid;
}

export interface WorkflowApprovalPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}

function approvalKey(organizationId: Ulid, executionId: Ulid, approvalId: Ulid) {
  return {
    pk: key("ORG", organizationId, "WORKFLOW-EXECUTION", executionId),
    sk: key("WORKFLOW-APPROVAL", approvalId),
  };
}

async function readApproval(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  executionId: Ulid,
  approvalId: Ulid,
) {
  const found = await database.getRecord(
    "execution",
    approvalKey(organizationId, executionId, approvalId),
    true,
  );
  if (
    !found ||
    found.itemType !== "workflow-approval" ||
    found.data.workflowExecutionId !== executionId
  ) {
    throw new WorkflowExecutionPersistenceError("not_found", "Workflow approval was not found.");
  }
  return found;
}

function sameApproval(record: WorkflowApprovalRecordValue, input: CreateWorkflowApprovalInput) {
  return (
    record.data.stepAttemptId === input.stepAttemptId &&
    record.data.workflowExecutionId === input.workflowExecutionId &&
    record.data.prompt === input.prompt &&
    record.data.expiresAt === input.expiresAt
  );
}

export function makeWorkflowApprovalPersistence(
  dependencies: WorkflowApprovalPersistenceDependencies,
) {
  const { database, generateId } = dependencies;

  const create = async (input: CreateWorkflowApprovalInput) => {
    const timestamp = (dependencies.now?.() ?? new Date()).toISOString();
    const record = Schema.decodeUnknownSync(WorkflowApprovalRecord)(
      withCanonicalRecordKeys({
        data: {
          ...input,
          createdAt: timestamp,
          status: "pending" as const,
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "workflow-approval" as const,
      }),
    );
    const event = makeSemanticEventRecord({
      actor: input.requestedBy,
      aggregateId: input.id,
      aggregateType: "workflow-approval",
      aggregateVersion: 1,
      environmentId: input.environmentId,
      eventId: await generateId(),
      eventType: "workflow-approval.requested",
      occurredAt: timestamp,
      organizationId: input.organizationId,
      payload: {
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        stepAttemptId: input.stepAttemptId,
        workflowExecutionId: input.workflowExecutionId,
      },
      projectId: input.projectId,
    });
    try {
      await transactWithSemanticEvents(
        database,
        [{ kind: "put", record }],
        [event],
        transactionToken(
          "workflow-approval.create",
          input.workflowExecutionId,
          input.id,
          event.data.eventId,
        ),
      );
      return { created: true, approval: record } as const;
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      const existing = await readApproval(
        database,
        input.organizationId,
        input.workflowExecutionId,
        input.id,
      );
      if (!sameApproval(existing, input)) {
        throw new WorkflowExecutionPersistenceError(
          "idempotency_conflict",
          "Workflow approval identity belongs to a different request.",
          { cause },
        );
      }
      return { created: false, approval: existing } as const;
    }
  };

  const resolvePrevious = async (
    previous: WorkflowApprovalRecordValue,
    input: ResolveWorkflowApprovalInput,
  ) => {
    if (previous.data.status !== "pending") {
      if (previous.data.status === input.decision) return previous;
      throw new WorkflowExecutionPersistenceError(
        "conflict",
        `Workflow approval is already ${previous.data.status}.`,
      );
    }
    const now = dependencies.now?.() ?? new Date();
    const expiresAt = previous.data.expiresAt ? Date.parse(previous.data.expiresAt) : undefined;
    const deadlineElapsed =
      expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= now.getTime();
    if (input.decision === "expired" && !deadlineElapsed) {
      throw new WorkflowExecutionPersistenceError(
        "conflict",
        "Workflow approval has not reached its expiration deadline.",
      );
    }
    const decision = deadlineElapsed ? ("expired" as const) : input.decision;
    const timestamp = now.toISOString();
    const next = Schema.decodeUnknownSync(WorkflowApprovalRecord)(
      withCanonicalRecordKeys({
        ...previous,
        data: {
          ...previous.data,
          resolvedAt: timestamp,
          ...(decision !== "expired" ? { resolvedBy: input.resolvedBy } : {}),
          status: decision,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
      }),
    );
    const event = makeSemanticEventRecord({
      actor: input.resolvedBy,
      aggregateId: next.data.id,
      aggregateType: "workflow-approval",
      aggregateVersion: next.data.version + 1,
      environmentId: next.data.environmentId,
      eventId: await generateId(),
      eventType: "workflow-approval.resolved",
      occurredAt: timestamp,
      organizationId: next.data.organizationId,
      payload: {
        decision,
        stepAttemptId: next.data.stepAttemptId,
        workflowExecutionId: next.data.workflowExecutionId,
      },
      projectId: next.data.projectId,
    });
    try {
      await transactWithSemanticEvents(
        database,
        [{ kind: "put", previousRecord: previous, record: next }],
        [event],
        transactionToken(
          "workflow-approval.resolve",
          next.data.id,
          String(next.data.version),
          event.data.eventId,
        ),
      );
      return next;
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      const existing = await readApproval(
        database,
        input.organizationId,
        input.workflowExecutionId,
        input.workflowApprovalId,
      );
      if (existing.data.status === decision) return existing;
      throw new WorkflowExecutionPersistenceError(
        "conflict",
        "Workflow approval changed concurrently.",
        { cause },
      );
    }
  };

  const get = async (organizationId: Ulid, executionId: Ulid, approvalId: Ulid) => {
    const previous = await readApproval(database, organizationId, executionId, approvalId);
    const expiresAt = previous.data.expiresAt ? Date.parse(previous.data.expiresAt) : undefined;
    const deadlineElapsed =
      expiresAt !== undefined &&
      Number.isFinite(expiresAt) &&
      expiresAt <= (dependencies.now?.() ?? new Date()).getTime();
    if (previous.data.status !== "pending" || !deadlineElapsed) return previous;
    try {
      return await resolvePrevious(previous, {
        decision: "expired",
        organizationId,
        resolvedBy: { type: "system" },
        workflowApprovalId: approvalId,
        workflowExecutionId: executionId,
      });
    } catch (cause) {
      if (!(cause instanceof WorkflowExecutionPersistenceError && cause.code === "conflict")) {
        throw cause;
      }
      return readApproval(database, organizationId, executionId, approvalId);
    }
  };

  const resolve = async (input: ResolveWorkflowApprovalInput) =>
    resolvePrevious(
      await readApproval(
        database,
        input.organizationId,
        input.workflowExecutionId,
        input.workflowApprovalId,
      ),
      input,
    );

  const getStored = (organizationId: Ulid, executionId: Ulid, approvalId: Ulid) =>
    readApproval(database, organizationId, executionId, approvalId);

  return { create, get, getStored, resolve };
}
