import { describe, expect, test } from "bun:test";
import {
  WorkflowDefinitionDocumentV1,
  type WorkflowDefinitionDocumentV1 as Definition,
} from "@deployments-ai/api-contract";
import {
  DatabaseError,
  Ulid,
  makeWorkflowExecutionPersistence,
  makeWorkflowApprovalPersistence,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { continueWorkflowExecution } from "./continuation.ts";
import { dispatchWorkflowStep } from "./dispatch.ts";
import { MAX_WORKFLOW_EXECUTION_CONTEXT_BYTES, nextExecutionRecord } from "./record-builders.ts";
import { processWorkflowExecution } from "./processor.ts";

const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const PRINCIPAL_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const DEFINITION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const RELEASE_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const REFERENCE_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;

function storageKey(record: Pick<PlatformRecord, "itemType" | "pk" | "sk">) {
  return `${tableForItemType(record.itemType)}\u0000${record.pk}\u0000${record.sk}`;
}

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => void records.delete(storageKey(record)),
    getRecord: async (_table, recordKey) => {
      const found = [...records.values()].find(
        (record) => record.pk === recordKey.pk && record.sk === recordKey.sk,
      );
      return found;
    },
    putRecord: async (record) => void records.set(storageKey(record), record),
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        const existing = records.get(storageKey(operation.record));
        const existingVersion = existing
          ? (existing.data as { readonly version?: number }).version
          : undefined;
        const previousVersion = operation.previousRecord
          ? (operation.previousRecord.data as { readonly version?: number }).version
          : undefined;
        if (
          (!operation.previousRecord && !operation.allowExisting && existing) ||
          (operation.previousRecord && existingVersion !== previousVersion)
        ) {
          throw new DatabaseError({
            cause: new Error("conditional conflict"),
            message: "Conditional write failed.",
            operation: "transact-write",
            reason: "conflict",
            table: "execution",
          });
        }
      }
      for (const operation of operations) {
        if (operation.kind === "put") records.set(storageKey(operation.record), operation.record);
        if (operation.kind === "delete") records.delete(storageKey(operation.record));
      }
    },
  };
  return { database, records };
}

function ids() {
  const characters = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let index = 2;
  return async () =>
    Schema.decodeUnknownSync(Ulid)(
      `01ARZ3NDEKTSV4RRFFQ69G5F${characters[Math.floor(index / 32)]}${characters[index++ % 32]}`,
    );
}

async function runtime(
  definition: Definition,
  input: Record<string, never> | { approved: boolean } = {},
) {
  const { database, records } = memoryDatabase();
  const generateId = ids();
  const persistence = makeWorkflowExecutionPersistence({
    database,
    generateId,
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  });
  const created = await persistence.create({
    entryStepId: definition.entryStepId,
    environmentId: ENVIRONMENT_ID,
    idempotencyKey: "workflow/request-1",
    initiatedBy: { id: PRINCIPAL_ID, type: "principal" },
    input,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    workflowContentHash: CONTENT_HASH,
    workflowDefinitionId: DEFINITION_ID,
    workflowReleaseId: RELEASE_ID,
    workflowReleaseNumber: 1,
  });
  const message = {
    environmentId: ENVIRONMENT_ID,
    executionId: created.execution.data.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
  };
  const dependencies = {
    generateId,
    loadRelease: async () => ({
      contentHash: CONTENT_HASH,
      definition,
      id: RELEASE_ID,
    }),
    now: () => new Date("2026-07-31T12:00:01.000Z"),
    persistence,
  };
  return {
    created: created.execution,
    database,
    dependencies,
    generateId,
    message,
    persistence,
    records,
  };
}

describe("workflow runtime processor", () => {
  test("durably advances a branch and completes its end step", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "branch",
      name: "Branch workflow",
      schemaVersion: 1,
      slug: "branch-workflow",
      steps: [
        {
          condition: {
            left: { path: ["approved"], source: "input" },
            operator: "equals",
            right: true,
          },
          id: "branch",
          onFalse: "rejected",
          onTrue: "approved",
          type: "branch",
        },
        { id: "approved", outcome: { result: "approved" }, type: "end" },
        { id: "rejected", outcome: { result: "rejected" }, type: "end" },
      ],
    });
    const fixture = await runtime(definition, { approved: true });
    const seeded = nextExecutionRecord(
      fixture.created,
      {
        context: {
          approvalEvidenceByStep: { approval: REFERENCE_ID },
          stepOutputs: { approval: { outcome: "approved" } },
        },
      },
      "2026-07-31T12:00:00.500Z",
    );
    await fixture.database.putRecord(seeded);

    const advanced = await processWorkflowExecution(fixture.message, fixture.dependencies);
    expect(advanced).toMatchObject({ action: "advanced" });
    expect("execution" in advanced && advanced.execution.data.currentStepId).toBe("approved");
    expect("execution" in advanced && advanced.execution.data.context).toEqual({
      approvalEvidenceByStep: { approval: REFERENCE_ID },
      stepOutputs: {
        approval: { outcome: "approved" },
        branch: { conditionResult: true },
      },
    });
    const completed = await processWorkflowExecution(fixture.message, fixture.dependencies);

    expect(completed).toMatchObject({ action: "completed" });
    expect("execution" in completed && completed.execution.data).toMatchObject({
      output: { result: "approved" },
      status: "completed",
      stepTransitionCount: 2,
    });
  });

  test("commits dispatch intent before waiting for an idempotent tool", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "tool",
      name: "Tool workflow",
      schemaVersion: 1,
      slug: "tool-workflow",
      steps: [
        {
          agentDeploymentId: PRINCIPAL_ID,
          id: "tool",
          next: "done",
          toolName: "release.prepare",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const requested = await processWorkflowExecution(fixture.message, fixture.dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected dispatch request.");
    expect(requested.execution.data.status).toBe("running");
    expect(requested.stepAttempt.data.status).toBe("queued");

    const waiting = await dispatchWorkflowStep(
      { ...fixture.message, stepAttemptId: requested.stepAttempt.data.id },
      {
        ...fixture.dependencies,
        dispatchStep: async ({ idempotencyKey }) => {
          expect(idempotencyKey).toContain(requested.stepAttempt.data.stepId);
          return {
            referenceId: REFERENCE_ID,
            referenceKind: "tool-call",
            state: "waiting",
          };
        },
      },
    );
    expect(waiting).toMatchObject({ action: "waiting" });
    if (waiting.action !== "waiting") throw new Error("Expected waiting result.");
    expect(waiting.execution.data.status).toBe("waiting-for-tool");
    expect(waiting.stepAttempt.data.toolCallId).toBe(REFERENCE_ID);

    const continued = await continueWorkflowExecution(
      {
        execution: fixture.message,
        outcome: "succeeded",
        output: { prepared: true },
        stepAttemptId: requested.stepAttempt.data.id,
      },
      fixture.dependencies,
    );
    expect(continued).toMatchObject({ action: "advanced" });
    const completed = await processWorkflowExecution(fixture.message, fixture.dependencies);
    expect(completed).toMatchObject({ action: "completed" });
  });

  test("routes approval outcomes and fails unhandled external errors", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "approval",
      name: "Approval workflow",
      schemaVersion: 1,
      slug: "approval-workflow",
      steps: [
        {
          id: "approval",
          onApproved: "approved",
          onRejected: "rejected",
          prompt: "Approve?",
          type: "approval",
        },
        { id: "approved", outcome: { decision: "approved" }, type: "end" },
        { id: "rejected", outcome: { decision: "rejected" }, type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const requested = await processWorkflowExecution(fixture.message, fixture.dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected dispatch request.");
    const waiting = await dispatchWorkflowStep(
      { ...fixture.message, stepAttemptId: requested.stepAttempt.data.id },
      {
        ...fixture.dependencies,
        dispatchStep: async () => ({
          referenceId: REFERENCE_ID,
          referenceKind: "approval",
          state: "waiting",
        }),
      },
    );
    if (waiting.action !== "waiting") throw new Error("Expected waiting approval.");
    expect(
      continueWorkflowExecution(
        {
          execution: fixture.message,
          outcome: "approved",
          output: { approvalId: REFERENCE_ID, outcome: "approved" },
          stepAttemptId: requested.stepAttempt.data.id,
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow("durable approval attempt");
    const continued = await continueWorkflowExecution(
      {
        approvalId: REFERENCE_ID,
        execution: fixture.message,
        outcome: "rejected",
        stepAttemptId: requested.stepAttempt.data.id,
      },
      fixture.dependencies,
    );
    expect(continued).toMatchObject({ action: "advanced" });
    expect("execution" in continued && continued.execution.data.currentStepId).toBe("rejected");
    expect("execution" in continued && continued.execution.data.context).toEqual({
      approvalEvidenceByStep: { approval: REFERENCE_ID },
      stepOutputs: { approval: { outcome: "rejected" } },
    });
  });

  test("routes an independently canceled child through the declared failure edge", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "child",
      name: "Child cancellation",
      schemaVersion: 1,
      slug: "child-cancellation",
      steps: [
        {
          agentDeploymentId: PRINCIPAL_ID,
          id: "child",
          next: "done",
          onFailure: "recovered",
          type: "agent",
        },
        { id: "done", type: "end" },
        { id: "recovered", outcome: { recovered: true }, type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const requested = await processWorkflowExecution(fixture.message, fixture.dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected child dispatch.");
    const continued = await continueWorkflowExecution(
      {
        execution: fixture.message,
        outcome: "canceled",
        stepAttemptId: requested.stepAttempt.data.id,
      },
      fixture.dependencies,
    );
    expect(continued).toMatchObject({
      action: "advanced",
      execution: { data: { currentStepId: "recovered", status: "queued" } },
      stepAttempt: { data: { status: "failed" } },
    });
  });

  test("terminalizes a requested cancellation before another step starts", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "done",
      name: "Canceled workflow",
      schemaVersion: 1,
      slug: "canceled-workflow",
      steps: [{ id: "done", type: "end" }],
    });
    const fixture = await runtime(definition);
    const canceling = nextExecutionRecord(
      fixture.created,
      { cancelRequestedAt: "2026-07-31T12:00:01.000Z", status: "canceling" },
      "2026-07-31T12:00:01.000Z",
    );
    await fixture.persistence.commitTransition({
      eventType: "workflow-execution.cancel-requested",
      nextExecution: canceling,
      previousExecution: fixture.created,
    });

    const canceled = await processWorkflowExecution(fixture.message, fixture.dependencies);
    expect(canceled).toMatchObject({ action: "canceled" });
    expect("execution" in canceled && canceled.execution.data.status).toBe("canceled");
  });

  test("terminalizes an active waiting step immediately when cancellation is requested", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "tool",
      name: "Waiting cancellation",
      schemaVersion: 1,
      slug: "waiting-cancellation",
      steps: [
        {
          agentDeploymentId: PRINCIPAL_ID,
          id: "tool",
          next: "done",
          toolName: "release.prepare",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const requested = await processWorkflowExecution(fixture.message, fixture.dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected dispatch request.");
    const waiting = await dispatchWorkflowStep(
      { ...fixture.message, stepAttemptId: requested.stepAttempt.data.id },
      {
        ...fixture.dependencies,
        dispatchStep: async () => ({
          referenceId: REFERENCE_ID,
          referenceKind: "tool-call",
          state: "waiting",
        }),
      },
    );
    if (waiting.action !== "waiting") throw new Error("Expected waiting step.");
    const canceling = nextExecutionRecord(
      waiting.execution,
      { cancelRequestedAt: "2026-07-31T12:00:02.000Z", status: "canceling" },
      "2026-07-31T12:00:02.000Z",
    );
    await fixture.persistence.commitTransition({
      eventType: "workflow-execution.cancel-requested",
      nextExecution: canceling,
      previousExecution: waiting.execution,
    });

    const canceled = await processWorkflowExecution(fixture.message, fixture.dependencies);
    expect(canceled).toMatchObject({
      action: "canceled",
      execution: { data: { status: "canceled" } },
      stepAttempt: { data: { status: "canceled" } },
    });
  });

  test("acknowledges a stale dispatch after cancellation wins the race", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "tool",
      name: "Dispatch cancellation race",
      schemaVersion: 1,
      slug: "dispatch-cancellation-race",
      steps: [
        {
          agentDeploymentId: PRINCIPAL_ID,
          id: "tool",
          next: "done",
          toolName: "release.prepare",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const requested = await processWorkflowExecution(fixture.message, fixture.dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected dispatch request.");
    const canceling = nextExecutionRecord(
      requested.execution,
      { cancelRequestedAt: "2026-07-31T12:00:02.000Z", status: "canceling" },
      "2026-07-31T12:00:02.000Z",
    );
    await fixture.persistence.commitTransition({
      eventType: "workflow-execution.cancel-requested",
      nextExecution: canceling,
      previousExecution: requested.execution,
    });
    expect(
      dispatchWorkflowStep(
        { ...fixture.message, stepAttemptId: requested.stepAttempt.data.id },
        {
          ...fixture.dependencies,
          dispatchStep: async () => Promise.reject(new Error("unused")),
        },
      ),
    ).resolves.toEqual({
      action: "skipped",
      reason: "execution-not-dispatchable",
    });
    expect(processWorkflowExecution(fixture.message, fixture.dependencies)).resolves.toMatchObject({
      action: "canceled",
    });
  });

  test("fails deterministically before step outputs outgrow the execution record", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "branch",
      name: "Context budget",
      schemaVersion: 1,
      slug: "context-budget",
      steps: [
        {
          condition: { left: { source: "input" }, operator: "truthy" },
          id: "branch",
          onFalse: "done",
          onTrue: "done",
          type: "branch",
        },
        { id: "done", type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const oversizedContext = nextExecutionRecord(
      fixture.created,
      {
        context: {
          stepOutputs: {
            existing: "x".repeat(MAX_WORKFLOW_EXECUTION_CONTEXT_BYTES - 30),
          },
        },
      },
      "2026-07-31T12:00:00.500Z",
    );
    await fixture.persistence.commitTransition({
      eventType: "workflow-execution.context-seeded",
      nextExecution: oversizedContext,
      previousExecution: fixture.created,
    });
    expect(processWorkflowExecution(fixture.message, fixture.dependencies)).resolves.toMatchObject({
      action: "failed",
      execution: {
        data: {
          error: { code: "workflow_context_too_large" },
          status: "failed",
        },
      },
    });
  });

  test("cancels a pending workflow approval atomically with its execution", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "approval",
      name: "Approval cancellation",
      schemaVersion: 1,
      slug: "approval-cancellation",
      steps: [
        {
          id: "approval",
          onApproved: "done",
          onRejected: "done",
          prompt: "Approve?",
          type: "approval",
        },
        { id: "done", type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const approvals = makeWorkflowApprovalPersistence({
      database: fixture.database,
      generateId: fixture.generateId,
      now: fixture.dependencies.now,
    });
    const persistence = { ...fixture.persistence, getApproval: approvals.get };
    const dependencies = { ...fixture.dependencies, persistence };
    const requested = await processWorkflowExecution(fixture.message, dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected dispatch request.");
    await approvals.create({
      environmentId: ENVIRONMENT_ID,
      id: requested.stepAttempt.data.id,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      prompt: "Approve?",
      requestedBy: { id: PRINCIPAL_ID, type: "principal" },
      stepAttemptId: requested.stepAttempt.data.id,
      workflowExecutionId: requested.execution.data.id,
    });
    const waiting = await dispatchWorkflowStep(
      { ...fixture.message, stepAttemptId: requested.stepAttempt.data.id },
      {
        ...dependencies,
        dispatchStep: async () => ({
          referenceId: requested.stepAttempt.data.id,
          referenceKind: "approval",
          state: "waiting",
        }),
      },
    );
    if (waiting.action !== "waiting") throw new Error("Expected waiting approval.");
    const canceling = nextExecutionRecord(
      waiting.execution,
      { cancelRequestedAt: "2026-07-31T12:00:02.000Z", status: "canceling" },
      "2026-07-31T12:00:02.000Z",
    );
    await persistence.commitTransition({
      eventType: "workflow-execution.cancel-requested",
      nextExecution: canceling,
      previousExecution: waiting.execution,
    });

    expect(processWorkflowExecution(fixture.message, dependencies)).resolves.toMatchObject({
      action: "canceled",
    });
    expect(
      approvals.get(ORGANIZATION_ID, fixture.message.executionId, requested.stepAttempt.data.id),
    ).resolves.toMatchObject({ data: { status: "canceled" } });
    expect(
      [...fixture.records.values()].filter(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "workflow-approval.resolved" &&
          record.data.payload.decision === "canceled",
      ),
    ).toHaveLength(1);
  });

  test("cancels an approval created before its waiting transition commits", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "approval",
      name: "Approval dispatch cancellation",
      schemaVersion: 1,
      slug: "approval-dispatch-cancellation",
      steps: [
        {
          id: "approval",
          onApproved: "done",
          onRejected: "done",
          prompt: "Approve?",
          type: "approval",
        },
        { id: "done", type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const approvals = makeWorkflowApprovalPersistence({
      database: fixture.database,
      generateId: fixture.generateId,
      now: fixture.dependencies.now,
    });
    const dependencies = {
      ...fixture.dependencies,
      persistence: { ...fixture.persistence, getApproval: approvals.get },
    };
    const requested = await processWorkflowExecution(fixture.message, dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected dispatch request.");
    await approvals.create({
      environmentId: ENVIRONMENT_ID,
      id: requested.stepAttempt.data.id,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      prompt: "Approve?",
      requestedBy: { id: PRINCIPAL_ID, type: "principal" },
      stepAttemptId: requested.stepAttempt.data.id,
      workflowExecutionId: requested.execution.data.id,
    });
    const canceling = nextExecutionRecord(
      requested.execution,
      { cancelRequestedAt: "2026-07-31T12:00:02.000Z", status: "canceling" },
      "2026-07-31T12:00:02.000Z",
    );
    await fixture.persistence.commitTransition({
      eventType: "workflow-execution.cancel-requested",
      nextExecution: canceling,
      previousExecution: requested.execution,
    });

    expect(processWorkflowExecution(fixture.message, dependencies)).resolves.toMatchObject({
      action: "canceled",
    });
    expect(
      approvals.get(ORGANIZATION_ID, fixture.message.executionId, requested.stepAttempt.data.id),
    ).resolves.toMatchObject({ data: { status: "canceled" } });
  });

  test("cancels an approval step before its separate approval record exists", async () => {
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)({
      entryStepId: "approval",
      name: "Approval pre-dispatch cancellation",
      schemaVersion: 1,
      slug: "approval-pre-dispatch-cancellation",
      steps: [
        {
          id: "approval",
          onApproved: "done",
          onRejected: "done",
          prompt: "Approve?",
          type: "approval",
        },
        { id: "done", type: "end" },
      ],
    });
    const fixture = await runtime(definition);
    const approvals = makeWorkflowApprovalPersistence({
      database: fixture.database,
      generateId: fixture.generateId,
      now: fixture.dependencies.now,
    });
    const dependencies = {
      ...fixture.dependencies,
      persistence: { ...fixture.persistence, getApproval: approvals.get },
    };
    const requested = await processWorkflowExecution(fixture.message, dependencies);
    if (requested.action !== "dispatch-requested") throw new Error("Expected dispatch request.");
    const canceling = nextExecutionRecord(
      requested.execution,
      { cancelRequestedAt: "2026-07-31T12:00:02.000Z", status: "canceling" },
      "2026-07-31T12:00:02.000Z",
    );
    await fixture.persistence.commitTransition({
      eventType: "workflow-execution.cancel-requested",
      nextExecution: canceling,
      previousExecution: requested.execution,
    });

    expect(processWorkflowExecution(fixture.message, dependencies)).resolves.toMatchObject({
      action: "canceled",
      execution: { data: { status: "canceled" } },
      stepAttempt: { data: { status: "canceled" } },
    });
  });
});
