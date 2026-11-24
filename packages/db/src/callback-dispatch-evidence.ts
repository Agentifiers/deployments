import { Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import {
  CallbackDispatchControlAuthorizationError,
  callbackDispatchControlAuthorizationConditions,
  type CallbackDispatchControlAuthorizationSnapshot,
} from "./callback-dispatch-authorization.ts";
import type { DynamoDatabaseService, TransactionConditionCheck } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import { key, organizationWriteFenceCondition } from "./keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import {
  CallbackDispatchEvidenceRecord,
  type CallbackDispatchEvidenceRecordValue,
} from "./records/runtime-callbacks.ts";
import { executionEventPayload } from "./execution-bindings/events.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "./semantic-event-storage.ts";
import { isDatabaseWriteConflict, makeDatabaseTransactionToken } from "./transaction-conditions.ts";

export type CallbackDispatchEvidenceInput = CallbackDispatchEvidenceRecordValue["data"];
export type CallbackDispatchEvidenceCreateInput = CallbackDispatchEvidenceInput extends infer Input
  ? Input extends unknown
    ? Omit<Input, "createdAt">
    : never
  : never;
export type CallbackDispatchExecutionSnapshot = Extract<
  PlatformRecord,
  { readonly itemType: "run" | "workflow-execution" }
>;
export type CallbackDispatchApprovalSnapshot = Extract<
  PlatformRecord,
  { readonly itemType: "approval" | "workflow-approval" }
>;
export type {
  CallbackDispatchControlAuthorizationSnapshot,
  CallbackDispatchExecutionTarget,
} from "./callback-dispatch-authorization.ts";

export interface CallbackDispatchAuthorizationSnapshot {
  readonly approval?: CallbackDispatchApprovalSnapshot;
  readonly control: CallbackDispatchControlAuthorizationSnapshot;
  readonly execution: CallbackDispatchExecutionSnapshot;
}

export function callbackDispatchEvidenceRecord(
  input: CallbackDispatchEvidenceInput,
): CallbackDispatchEvidenceRecordValue {
  try {
    return Schema.decodeUnknownSync(CallbackDispatchEvidenceRecord)(
      withCanonicalRecordKeys({
        data: input,
        itemType: "callback-dispatch-evidence" as const,
      }),
    );
  } catch (cause) {
    throw new CallbackDispatchEvidenceError(
      "conflict",
      cause instanceof Error
        ? `Callback dispatch evidence is invalid: ${cause.message}`
        : "Callback dispatch evidence is invalid.",
      { cause },
    );
  }
}

export function callbackDispatchEvidenceKey(organizationId: Ulid, evidenceId: Ulid) {
  return {
    pk: key("ORG", organizationId, "CALLBACK-DISPATCH-EVIDENCE"),
    sk: key("CALLBACK-DISPATCH-EVIDENCE", evidenceId),
  } as const;
}

export class CallbackDispatchEvidenceError extends Error {
  constructor(
    readonly code: "authorization_conflict" | "conflict" | "not_found",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CallbackDispatchEvidenceError";
  }
}

function sameImmutableEvidence(
  left: CallbackDispatchEvidenceRecordValue,
  right: CallbackDispatchEvidenceRecordValue,
): boolean {
  const { createdAt: _leftCreatedAt, ...leftData } = left.data;
  const { createdAt: _rightCreatedAt, ...rightData } = right.data;
  return isDeepStrictEqual(leftData, rightData);
}

function authorizationConflict(message: string, cause?: unknown): never {
  throw new CallbackDispatchEvidenceError(
    "authorization_conflict",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function canonicalObservedAt(observedAt: string): number {
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== observedAt) {
    authorizationConflict("Callback dispatch authorization observation time is invalid.");
  }
  return timestamp;
}

function sameWorkspace(left: Ulid | undefined, right: Ulid | undefined): boolean {
  return left === right;
}

function assertExecutionSnapshot(
  input: CallbackDispatchEvidenceInput,
  execution: CallbackDispatchExecutionSnapshot,
) {
  const commonScopeMatches =
    execution.data.id === input.runId &&
    execution.data.organizationId === input.organizationId &&
    execution.data.projectId === input.projectId &&
    execution.data.environmentId === input.environmentId &&
    sameWorkspace(execution.data.workspaceId, input.workspaceId);

  if (execution.itemType === "run") {
    if (
      input.executionKind !== "agent-run" ||
      !commonScopeMatches ||
      execution.data.status !== "running" ||
      execution.data.threadId !== input.threadId ||
      execution.data.agentDeploymentId !== input.agentDeploymentId ||
      execution.data.agentReleaseId !== input.agentReleaseId ||
      execution.data.executionBindingId !== input.executionBindingId ||
      (execution.data.executionPurpose ?? "customer") !== (input.executionPurpose ?? "customer")
    ) {
      authorizationConflict(
        "Callback dispatch evidence does not match its active canonical agent run.",
      );
    }
    return;
  }

  if (
    input.executionKind !== "workflow" ||
    !commonScopeMatches ||
    execution.data.status !== "running" ||
    execution.data.activeStepAttemptId !== input.threadId
  ) {
    authorizationConflict(
      "Callback dispatch evidence does not match its active canonical workflow step.",
    );
  }
}

function approvalEvidence(approval: CallbackDispatchApprovalSnapshot) {
  if (approval.itemType === "approval") {
    return {
      ...(approval.data.expiresAt ? { expiresAt: approval.data.expiresAt } : {}),
      id: approval.data.id,
      kind: "agent-run" as const,
      ...(approval.data.resolvedByPrincipalId
        ? {
            resolvedBy: {
              id: approval.data.resolvedByPrincipalId,
              type: "principal" as const,
            },
          }
        : {}),
      status: "approved" as const,
    };
  }
  return {
    ...(approval.data.expiresAt ? { expiresAt: approval.data.expiresAt } : {}),
    id: approval.data.id,
    kind: "workflow" as const,
    ...(approval.data.resolvedBy ? { resolvedBy: approval.data.resolvedBy } : {}),
    status: "approved" as const,
  };
}

function assertApprovalSnapshot(
  input: CallbackDispatchEvidenceInput,
  approval: CallbackDispatchApprovalSnapshot | undefined,
  observedAt: number,
) {
  if (!input.approval && !approval) return;
  if (!input.approval || !approval || input.policyAction !== "require-approval") {
    authorizationConflict("Callback dispatch approval snapshot does not match its policy action.");
  }
  const expiresAt = approval.data.expiresAt ? Date.parse(approval.data.expiresAt) : undefined;
  if (
    approval.data.status !== "approved" ||
    (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= observedAt)) ||
    approval.data.id !== input.approval.id ||
    approval.data.organizationId !== input.organizationId ||
    approval.data.projectId !== input.projectId ||
    approval.data.environmentId !== input.environmentId ||
    !isDeepStrictEqual(approvalEvidence(approval), input.approval)
  ) {
    authorizationConflict(
      "Callback dispatch evidence does not match its current canonical approval.",
    );
  }
  if (
    (approval.itemType === "approval" &&
      (input.executionKind !== "agent-run" ||
        approval.data.runId !== input.runId ||
        approval.data.toolCallId !== input.toolCallId ||
        approval.data.requestedByAgentDeploymentId !== input.agentDeploymentId ||
        approval.data.executionBindingId !== input.executionBindingId)) ||
    (approval.itemType === "workflow-approval" &&
      (input.executionKind !== "workflow" || approval.data.workflowExecutionId !== input.runId))
  ) {
    authorizationConflict("Callback dispatch approval does not belong to its canonical execution.");
  }
}

function workspaceCondition(record: CallbackDispatchExecutionSnapshot) {
  return record.data.workspaceId
    ? {
        clause: "#data.#workspaceId = :workspaceId",
        values: { ":workspaceId": record.data.workspaceId },
      }
    : { clause: "attribute_not_exists(#data.#workspaceId)", values: {} };
}

/**
 * Fences a run or approval on the execution pins it was loaded with: a customer deployment
 * (and release) or a preview/evaluation binding (and its optional release).
 */
function executionPinsCondition(
  deploymentField: "agentDeploymentId" | "requestedByAgentDeploymentId",
  pins: {
    readonly agentDeploymentId?: Ulid | undefined;
    readonly agentReleaseId?: Ulid | undefined;
    readonly executionBindingId?: Ulid | undefined;
    readonly executionPurpose?: string | undefined;
  },
  includeRelease: boolean,
) {
  const release = !includeRelease
    ? { clause: [], names: {}, values: {} }
    : pins.agentReleaseId === undefined
      ? {
          clause: ["attribute_not_exists(#data.#agentReleaseId)"],
          names: { "#agentReleaseId": "agentReleaseId" },
          values: {},
        }
      : {
          clause: ["#data.#agentReleaseId = :agentReleaseId"],
          names: { "#agentReleaseId": "agentReleaseId" },
          values: { ":agentReleaseId": pins.agentReleaseId },
        };
  const target =
    pins.executionBindingId === undefined
      ? {
          clause: [
            "#data.#pinnedDeploymentId = :agentDeploymentId",
            "attribute_not_exists(#data.#executionBindingId)",
          ],
          values: { ":agentDeploymentId": pins.agentDeploymentId },
        }
      : {
          clause: [
            "#data.#executionBindingId = :executionBindingId",
            "#data.#executionPurpose = :executionPurpose",
            "attribute_not_exists(#data.#pinnedDeploymentId)",
          ],
          values: {
            ":executionBindingId": pins.executionBindingId,
            ":executionPurpose": pins.executionPurpose,
          },
        };
  return {
    clause: [...target.clause, ...release.clause].join(" AND "),
    names: {
      "#executionBindingId": "executionBindingId",
      "#pinnedDeploymentId": deploymentField,
      ...(pins.executionBindingId === undefined ? {} : { "#executionPurpose": "executionPurpose" }),
      ...release.names,
    },
    values: { ...target.values, ...release.values },
  };
}

function executionCondition(
  execution: CallbackDispatchExecutionSnapshot,
): TransactionConditionCheck {
  const workspace = workspaceCondition(execution);
  const common = {
    expressionAttributeNames: {
      "#data": "data",
      "#environmentId": "environmentId",
      "#id": "id",
      "#itemType": "itemType",
      "#organizationId": "organizationId",
      "#projectId": "projectId",
      "#status": "status",
      "#version": "version",
      "#workspaceId": "workspaceId",
    },
    key: { pk: execution.pk, sk: execution.sk },
    kind: "condition-check" as const,
    table: "execution" as const,
  };
  const scopeExpression =
    "#data.#id = :runId AND #data.#organizationId = :organizationId AND #data.#projectId = :projectId AND #data.#environmentId = :environmentId";
  const scopeValues = {
    ":environmentId": execution.data.environmentId,
    ":organizationId": execution.data.organizationId,
    ":projectId": execution.data.projectId,
    ":runId": execution.data.id,
    ":running": "running",
    ":version": execution.data.version,
    ...workspace.values,
  };

  if (execution.itemType === "run") {
    const pins = executionPinsCondition("agentDeploymentId", execution.data, true);
    return {
      ...common,
      conditionExpression: `#itemType = :itemType AND #data.#status = :running AND #data.#version = :version AND ${scopeExpression} AND #data.#threadId = :threadId AND ${pins.clause} AND ${workspace.clause}`,
      expressionAttributeNames: {
        ...common.expressionAttributeNames,
        ...pins.names,
        "#threadId": "threadId",
      },
      expressionAttributeValues: {
        ...scopeValues,
        ...pins.values,
        ":itemType": "run",
        ":threadId": execution.data.threadId,
      },
    };
  }
  return {
    ...common,
    conditionExpression: `#itemType = :itemType AND #data.#status = :running AND #data.#version = :version AND ${scopeExpression} AND #data.#activeStepAttemptId = :activeStepAttemptId AND ${workspace.clause}`,
    expressionAttributeNames: {
      ...common.expressionAttributeNames,
      "#activeStepAttemptId": "activeStepAttemptId",
    },
    expressionAttributeValues: {
      ...scopeValues,
      ":activeStepAttemptId": execution.data.activeStepAttemptId,
      ":itemType": "workflow-execution",
    },
  };
}

function approvalCondition(
  approval: CallbackDispatchApprovalSnapshot,
  observedAt: string,
): TransactionConditionCheck {
  const expiry = approval.data.expiresAt
    ? {
        clause: "#data.#expiresAt = :expiresAt AND #data.#expiresAt > :observedAt",
        values: { ":expiresAt": approval.data.expiresAt, ":observedAt": observedAt },
      }
    : { clause: "attribute_not_exists(#data.#expiresAt)", values: {} };
  const common = {
    expressionAttributeNames: {
      "#data": "data",
      "#environmentId": "environmentId",
      "#expiresAt": "expiresAt",
      "#id": "id",
      "#itemType": "itemType",
      "#organizationId": "organizationId",
      "#projectId": "projectId",
      "#status": "status",
      "#version": "version",
    },
    key: { pk: approval.pk, sk: approval.sk },
    kind: "condition-check" as const,
    table: "execution" as const,
  };
  const scopeExpression =
    "#data.#id = :approvalId AND #data.#organizationId = :organizationId AND #data.#projectId = :projectId AND #data.#environmentId = :environmentId";
  const scopeValues = {
    ":approvalId": approval.data.id,
    ":approved": "approved",
    ":environmentId": approval.data.environmentId,
    ":organizationId": approval.data.organizationId,
    ":projectId": approval.data.projectId,
    ":version": approval.data.version,
    ...expiry.values,
  };

  if (approval.itemType === "approval") {
    const pins = executionPinsCondition(
      "requestedByAgentDeploymentId",
      {
        agentDeploymentId: approval.data.requestedByAgentDeploymentId,
        executionBindingId: approval.data.executionBindingId,
        executionPurpose: approval.data.executionPurpose,
      },
      false,
    );
    return {
      ...common,
      conditionExpression: `#itemType = :itemType AND #data.#status = :approved AND #data.#version = :version AND ${scopeExpression} AND #data.#runId = :runId AND #data.#toolCallId = :toolCallId AND ${pins.clause} AND ${expiry.clause}`,
      expressionAttributeNames: {
        ...common.expressionAttributeNames,
        ...pins.names,
        "#runId": "runId",
        "#toolCallId": "toolCallId",
      },
      expressionAttributeValues: {
        ...scopeValues,
        ...pins.values,
        ":itemType": "approval",
        ":runId": approval.data.runId,
        ":toolCallId": approval.data.toolCallId,
      },
    };
  }
  return {
    ...common,
    conditionExpression: `#itemType = :itemType AND #data.#status = :approved AND #data.#version = :version AND ${scopeExpression} AND #data.#workflowExecutionId = :workflowExecutionId AND ${expiry.clause}`,
    expressionAttributeNames: {
      ...common.expressionAttributeNames,
      "#workflowExecutionId": "workflowExecutionId",
    },
    expressionAttributeValues: {
      ...scopeValues,
      ":itemType": "workflow-approval",
      ":workflowExecutionId": approval.data.workflowExecutionId,
    },
  };
}

function reuseTenantConditions(
  organizationId: Ulid,
  observedAt: string,
): readonly TransactionConditionCheck[] {
  return [
    {
      ...organizationWriteFenceCondition(new Date(observedAt)),
      key: {
        pk: key("ORG", organizationId),
        sk: key("ERASURE-FENCE", organizationId),
      },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression: "attribute_exists(pk)",
      key: { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
      kind: "condition-check",
      table: "control",
    },
  ];
}

function authorizationConditions(
  input: CallbackDispatchEvidenceInput,
  authorization: CallbackDispatchAuthorizationSnapshot,
  observedAt: string,
): readonly TransactionConditionCheck[] {
  const observedTimestamp = canonicalObservedAt(observedAt);
  assertExecutionSnapshot(input, authorization.execution);
  assertApprovalSnapshot(input, authorization.approval, observedTimestamp);
  let controlConditions: readonly TransactionConditionCheck[];
  try {
    controlConditions = callbackDispatchControlAuthorizationConditions(
      input,
      authorization.control,
      observedAt,
    );
  } catch (cause) {
    if (!(cause instanceof CallbackDispatchControlAuthorizationError)) throw cause;
    authorizationConflict(cause.message, cause);
  }
  return [
    executionCondition(authorization.execution),
    ...(authorization.approval ? [approvalCondition(authorization.approval, observedAt)] : []),
    ...controlConditions,
  ];
}

function transactionToken(
  operation: "create" | "reauthorize",
  input: CallbackDispatchEvidenceInput,
  authorization: CallbackDispatchAuthorizationSnapshot,
  observedAt: string,
  eventId?: Ulid,
) {
  return makeDatabaseTransactionToken([
    `callback-dispatch-evidence.${operation}`,
    input.organizationId,
    input.id,
    observedAt,
    authorization.execution.itemType,
    String(authorization.execution.data.version),
    authorization.approval?.itemType ?? "",
    String(authorization.approval?.data.version ?? ""),
    authorization.control.executionTarget.itemType,
    String(authorization.control.executionTarget.data.version),
    String(authorization.control.workspaceAuthorization.data.version),
    String(authorization.control.connection.data.version),
    String(authorization.control.toolPolicy?.data.version ?? ""),
    String(authorization.control.toolAdapter.data.version),
    String(authorization.control.toolCredential.data.version),
    eventId ?? "",
  ]);
}

function authorizationActor(execution: CallbackDispatchExecutionSnapshot) {
  if (execution.itemType === "workflow-execution") return execution.data.initiatedBy;
  const caller = execution.data.initiatingCaller;
  if (!caller || caller.type === "ingress") return undefined;
  return caller.type === "principal"
    ? ({ id: caller.principalId, type: "principal" } as const)
    : ({ id: caller.serviceAccountId, type: "service-account" } as const);
}

function evidenceCreatedEvent(
  record: CallbackDispatchEvidenceRecordValue,
  authorization: CallbackDispatchAuthorizationSnapshot,
  eventId: Ulid,
) {
  const actor = authorizationActor(authorization.execution);
  return makeSemanticEventRecord({
    ...(actor ? { actor } : {}),
    aggregateId: record.data.id,
    aggregateType: "callback-dispatch-evidence",
    aggregateVersion: 1,
    environmentId: record.data.environmentId,
    eventId,
    eventType: "callback-dispatch-evidence.created",
    occurredAt: record.data.createdAt,
    organizationId: record.data.organizationId,
    payload: executionEventPayload(record.data, {
      effect: record.data.effect,
      executionKind: record.data.executionKind,
      policyAction: record.data.policyAction,
      runId: record.data.runId,
      toolCallId: record.data.toolCallId,
      toolName: record.data.toolName,
    }),
    projectId: record.data.projectId,
  });
}

export function makeCallbackDispatchEvidencePersistence(options: {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}) {
  const getStored = async (organizationId: Ulid, evidenceId: Ulid) => {
    const found = await options.database.getRecord(
      "execution",
      callbackDispatchEvidenceKey(organizationId, evidenceId),
      true,
    );
    if (!found) return undefined;
    if (
      found.itemType !== "callback-dispatch-evidence" ||
      found.data.organizationId !== organizationId ||
      found.data.id !== evidenceId
    ) {
      throw new CallbackDispatchEvidenceError(
        "conflict",
        "Callback dispatch evidence key resolved to an invalid record.",
      );
    }
    return found;
  };

  const get = async (organizationId: Ulid, evidenceId: Ulid) => {
    const found = await getStored(organizationId, evidenceId);
    if (!found) {
      throw new CallbackDispatchEvidenceError(
        "not_found",
        "Callback dispatch evidence was not found.",
      );
    }
    return found;
  };

  const reauthorize = async (
    input: CallbackDispatchEvidenceInput,
    authorization: CallbackDispatchAuthorizationSnapshot,
    conditions: readonly TransactionConditionCheck[],
    observedAt: string,
  ) => {
    try {
      await options.database.transactWrite(
        [...conditions, ...reuseTenantConditions(input.organizationId, observedAt)],
        transactionToken("reauthorize", input, authorization, observedAt),
      );
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      authorizationConflict(
        "Callback dispatch authorization changed before evidence could be reused.",
        cause,
      );
    }
  };

  const create = async (
    input: CallbackDispatchEvidenceCreateInput,
    authorization: CallbackDispatchAuthorizationSnapshot,
  ) => {
    const current = await getStored(input.organizationId, input.id);
    const observedAt = (options.now?.() ?? new Date()).toISOString();
    const evidenceInput = { ...input, createdAt: observedAt };
    const record = callbackDispatchEvidenceRecord(evidenceInput);
    const conditions = authorizationConditions(evidenceInput, authorization, observedAt);
    if (current) {
      if (sameImmutableEvidence(current, record)) {
        await reauthorize(evidenceInput, authorization, conditions, observedAt);
        return current;
      }
      throw new CallbackDispatchEvidenceError(
        "conflict",
        "Callback dispatch evidence already exists with different authorization data.",
      );
    }
    const eventId = await options.generateId();
    const createObservedAt = (options.now?.() ?? new Date()).toISOString();
    const createInput = { ...input, createdAt: createObservedAt };
    const createRecord = callbackDispatchEvidenceRecord(createInput);
    const createConditions = authorizationConditions(createInput, authorization, createObservedAt);
    const event = evidenceCreatedEvent(createRecord, authorization, eventId);
    try {
      await transactWithSemanticEvents(
        options.database,
        [{ kind: "put", record: createRecord }, ...createConditions],
        [event],
        transactionToken("create", createInput, authorization, createObservedAt, eventId),
      );
      return createRecord;
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause)) throw cause;
      const raced = await getStored(input.organizationId, input.id);
      if (raced && sameImmutableEvidence(raced, createRecord)) {
        const replayObservedAt = (options.now?.() ?? new Date()).toISOString();
        const replayInput = { ...input, createdAt: replayObservedAt };
        await reauthorize(
          replayInput,
          authorization,
          authorizationConditions(replayInput, authorization, replayObservedAt),
          replayObservedAt,
        );
        return raced;
      }
      authorizationConflict(
        "Callback dispatch evidence could not be created from the current authorization state.",
        cause,
      );
    }
  };

  return { create, get, getStored };
}
