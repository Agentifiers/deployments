import { describe, expect, test } from "bun:test";
import {
  CallbackDispatchEvidenceError,
  RunRecord,
  WorkflowApprovalRecord,
  WorkflowExecutionRecord,
  WorkflowStepAttemptRecord,
  withCanonicalRecordKeys,
  type BoundExecutionPurpose,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id, inMemoryDatabase } from "./agent-run.fixture.ts";
import {
  RuntimeHttpCallbackDispatchPermanentError,
  createRuntimeHttpCallbackDispatchPersistence,
} from "./runtime-http-callback-dispatch.ts";
import {
  controlSnapshot,
  executionBindingId,
  now,
  request,
} from "./runtime-http-callback-dispatch.fixture.ts";
import type { AuthorizedRuntimeToolBindingRequest } from "./runtime-tool-planning.ts";

type BoundAuthorizedRuntimeToolBindingRequest = Extract<
  AuthorizedRuntimeToolBindingRequest,
  { readonly executionBindingId: Ulid }
>;

const sendable = () => undefined;

function boundRequest(
  fixture: ReturnType<typeof fixtures>,
  executionPurpose: BoundExecutionPurpose,
): BoundAuthorizedRuntimeToolBindingRequest {
  const { agentDeploymentId: _deployment, ...customer } = request(fixture);
  return { ...customer, executionBindingId, executionPurpose };
}

function boundRun(fixture: ReturnType<typeof fixtures>, executionPurpose: BoundExecutionPurpose) {
  const { agentDeploymentId: _deployment, ...customer } = fixture.run.data;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: { ...customer, executionBindingId, executionPurpose, status: "running", version: 1 },
      itemType: "run" as const,
    }),
  );
}

describe("runtime HTTP callback dispatch evidence", () => {
  test("persists agent-run authorization without creating a running tool-call", async () => {
    const fixture = fixtures();
    const running = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.run.data, status: "running", version: 1 },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([running]);
    let currentTime = now;
    const persist = createRuntimeHttpCallbackDispatchPersistence({
      database: memory.database,
      generateId: async () => id(90),
      now: () => currentTime,
    });
    const authorized = request(fixture);

    expect(
      persist(
        authorized,
        { resourceId: "authorized-resource" },
        controlSnapshot(fixture, authorized),
        undefined,
        sendable,
      ),
    ).resolves.toEqual({ evidenceId: authorized.decision.toolCallId });
    currentTime = new Date("2026-08-08T12:05:00.000Z");
    expect(
      persist(
        authorized,
        { resourceId: "authorized-resource" },
        controlSnapshot(fixture, authorized),
        undefined,
        sendable,
      ),
    ).resolves.toEqual({ evidenceId: authorized.decision.toolCallId });
    const records = [...memory.records.values()];
    expect(records.filter((record) => record.itemType === "tool-call")).toHaveLength(0);
    expect(
      records.find((record) => record.itemType === "callback-dispatch-evidence"),
    ).toMatchObject({
      data: {
        executionKind: "agent-run",
        createdAt: now.toISOString(),
        input: { resourceId: "authorized-resource" },
        policyAction: "allow",
        runId: running.data.id,
      },
    });
    expect(
      records.filter((record) => record.itemType === "callback-dispatch-evidence"),
    ).toHaveLength(1);
  });

  test("does not create evidence when the agent run is canceled before the transaction", async () => {
    const fixture = fixtures();
    const running = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.run.data, status: "running", version: 1 },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([running]);
    let cancelBeforeTransaction = true;
    const database = {
      ...memory.database,
      transactWrite: async (operations, token, signal) => {
        if (!cancelBeforeTransaction) {
          return memory.database.transactWrite(operations, token, signal);
        }
        cancelBeforeTransaction = false;
        memory.cancelRunningRun();
        return memory.database.transactWrite(operations, token, signal);
      },
    } satisfies typeof memory.database;
    const persist = createRuntimeHttpCallbackDispatchPersistence({
      database,
      generateId: async () => id(90),
      now: () => now,
    });

    const authorized = request(fixture);
    expect(
      persist(
        authorized,
        { resourceId: "authorized-resource" },
        controlSnapshot(fixture, authorized),
        undefined,
        sendable,
      ),
    ).rejects.toBeInstanceOf(RuntimeHttpCallbackDispatchPermanentError);
    expect(
      [...memory.records.values()].filter(
        (record) => record.itemType === "callback-dispatch-evidence",
      ),
    ).toHaveLength(0);
  });

  test("retries evidence fencing after a benign agent-run heartbeat", async () => {
    const fixture = fixtures();
    const running = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: { ...fixture.run.data, status: "running", version: 1 },
        itemType: "run" as const,
      }),
    );
    const heartbeated = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...running.data,
          heartbeatAt: "2026-08-08T12:00:01.000Z",
          updatedAt: "2026-08-08T12:00:01.000Z",
          version: running.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    const memory = inMemoryDatabase([running]);
    let heartbeatBeforeTransaction = true;
    const database = {
      ...memory.database,
      transactWrite: async (operations, token, signal) => {
        if (!heartbeatBeforeTransaction) {
          return memory.database.transactWrite(operations, token, signal);
        }
        heartbeatBeforeTransaction = false;
        const stored = [...memory.records.entries()].find(
          ([, record]) => record.itemType === "run" && record.data.id === running.data.id,
        );
        if (stored) memory.records.set(stored[0], heartbeated);
        return memory.database.transactWrite(operations, token, signal);
      },
    } satisfies typeof memory.database;
    const persist = createRuntimeHttpCallbackDispatchPersistence({
      database,
      generateId: async () => id(90),
      now: () => now,
    });

    const authorized = request(fixture);
    expect(
      persist(
        authorized,
        { resourceId: "authorized-resource" },
        controlSnapshot(fixture, authorized),
        undefined,
        sendable,
      ),
    ).resolves.toEqual({ evidenceId: authorized.decision.toolCallId });
    expect(
      [...memory.records.values()].filter(
        (record) => record.itemType === "callback-dispatch-evidence",
      ),
    ).toHaveLength(1);
  });

  test("persists workflow authorization with the actual approved workflow record and no origin", async () => {
    const fixture = fixtures();
    const executionId = id(91);
    const toolAttemptId = id(92);
    const approvalAttemptId = id(93);
    const approvalId = id(94);
    const execution = Schema.decodeUnknownSync(WorkflowExecutionRecord)(
      withCanonicalRecordKeys({
        data: {
          activeStepAttemptId: toolAttemptId,
          context: {
            stepOutputs: {
              approve: { approvalId, outcome: "approved" },
            },
          },
          createdAt: now.toISOString(),
          currentStepAttempt: 0,
          currentStepId: "write",
          environmentId: fixture.run.data.environmentId,
          id: executionId,
          idempotencyKey: "workflow-execution-1",
          initiatedBy: { id: id(95), type: "principal" },
          input: {},
          organizationId: fixture.run.data.organizationId,
          projectId: fixture.run.data.projectId,
          startedAt: now.toISOString(),
          status: "running",
          stepTransitionCount: 2,
          updatedAt: now.toISOString(),
          version: 2,
          workflowContentHash: "sha256:workflow-v1",
          workflowDefinitionId: id(96),
          workflowReleaseId: id(97),
          workflowReleaseNumber: 1,
          workspaceId: fixture.run.data.workspaceId,
        },
        itemType: "workflow-execution" as const,
      }),
    );
    const attempt = Schema.decodeUnknownSync(WorkflowStepAttemptRecord)(
      withCanonicalRecordKeys({
        data: {
          attempt: 0,
          createdAt: now.toISOString(),
          environmentId: execution.data.environmentId,
          id: toolAttemptId,
          input: {},
          organizationId: execution.data.organizationId,
          projectId: execution.data.projectId,
          startedAt: now.toISOString(),
          status: "queued",
          stepId: "write",
          stepType: "tool",
          updatedAt: now.toISOString(),
          version: 0,
          workflowExecutionId: executionId,
        },
        itemType: "workflow-step-attempt" as const,
      }),
    );
    const approval = Schema.decodeUnknownSync(WorkflowApprovalRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: now.toISOString(),
          environmentId: execution.data.environmentId,
          expiresAt: "2026-08-08T12:01:00.000Z",
          id: approvalId,
          organizationId: execution.data.organizationId,
          projectId: execution.data.projectId,
          prompt: "Approve write",
          requestedBy: { id: id(98), type: "principal" },
          resolvedAt: now.toISOString(),
          resolvedBy: { id: id(99), type: "principal" },
          status: "approved",
          stepAttemptId: approvalAttemptId,
          updatedAt: now.toISOString(),
          version: 1,
          workflowExecutionId: executionId,
        },
        itemType: "workflow-approval" as const,
      }),
    );
    const memory = inMemoryDatabase([execution, attempt, approval]);
    let currentTime = now;
    const persist = createRuntimeHttpCallbackDispatchPersistence({
      database: memory.database,
      generateId: async () => id(100),
      now: () => currentTime,
    });
    const authorized = request(fixture, {
      approvalId,
      executionKind: "workflow",
      policyAction: "require-approval",
      runId: executionId,
      threadId: toolAttemptId,
    });

    expect(
      persist(
        authorized,
        { offerId: "offer-1" },
        controlSnapshot(fixture, authorized),
        ["origin"],
        sendable,
      ),
    ).resolves.toEqual({ evidenceId: authorized.decision.toolCallId });
    currentTime = new Date("2026-08-08T12:05:00.000Z");
    expect(
      persist(
        authorized,
        { offerId: "offer-1" },
        controlSnapshot(fixture, authorized),
        undefined,
        sendable,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "callback-dispatch-evidence",
      ),
    ).toMatchObject({
      data: {
        approval: {
          id: approvalId,
          kind: "workflow",
          resolvedBy: { id: id(99), type: "principal" },
          status: "approved",
        },
        executionKind: "workflow",
        runId: executionId,
        threadId: toolAttemptId,
      },
    });
    expect(
      [...memory.records.values()].filter(
        (record) => record.itemType === "callback-dispatch-evidence",
      ),
    ).toHaveLength(1);
  });
});

describe("runtime HTTP callback dispatch evidence for bound runs", () => {
  test("persists preview evidence pinned to the execution binding instead of a deployment", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([boundRun(fixture, "preview")]);
    const persist = createRuntimeHttpCallbackDispatchPersistence({
      database: memory.database,
      generateId: async () => id(90),
      now: () => now,
    });
    const authorized = boundRequest(fixture, "preview");

    expect(
      persist(
        authorized,
        { resourceId: "authorized-resource" },
        controlSnapshot(fixture, authorized),
        undefined,
        sendable,
      ),
    ).resolves.toEqual({ evidenceId: authorized.decision.toolCallId });

    const records = [...memory.records.values()];
    const evidence = records.find((record) => record.itemType === "callback-dispatch-evidence");
    expect(evidence?.data).toMatchObject({
      agentDefinitionId: fixture.release.data.agentDefinitionId,
      agentReleaseId: fixture.release.data.id,
      executionBindingId,
      executionKind: "agent-run",
      executionPurpose: "preview",
      input: { resourceId: "authorized-resource" },
    });
    expect(evidence?.data).not.toHaveProperty("agentDeploymentId");
    expect(
      records.find(
        (record) =>
          record.itemType === "semantic-event" &&
          record.data.eventType === "callback-dispatch-evidence.created",
      ),
    ).toBeDefined();
  });

  test("does not persist evidence once the preview binding has expired", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([boundRun(fixture, "preview")]);
    const persist = createRuntimeHttpCallbackDispatchPersistence({
      database: memory.database,
      generateId: async () => id(90),
      now: () => now,
    });
    const authorized = boundRequest(fixture, "preview");

    expect(
      persist(
        authorized,
        { resourceId: "authorized-resource" },
        controlSnapshot(fixture, authorized, {
          createdAt: "2026-08-07T12:00:00.000Z",
          expiresAt: now.toISOString(),
        }),
        undefined,
        sendable,
      ),
    ).rejects.toMatchObject({ code: "authorization_conflict" });
    expect(
      [...memory.records.values()].filter(
        (record) => record.itemType === "callback-dispatch-evidence",
      ),
    ).toHaveLength(0);
  });

  test("rejects a preview dispatch fenced against a customer deployment snapshot", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([boundRun(fixture, "preview")]);
    const persist = createRuntimeHttpCallbackDispatchPersistence({
      database: memory.database,
      generateId: async () => id(90),
      now: () => now,
    });
    const authorized = boundRequest(fixture, "preview");

    expect(
      persist(
        authorized,
        { resourceId: "authorized-resource" },
        controlSnapshot(fixture, request(fixture)),
        undefined,
        sendable,
      ),
    ).rejects.toBeInstanceOf(CallbackDispatchEvidenceError);
  });
});
