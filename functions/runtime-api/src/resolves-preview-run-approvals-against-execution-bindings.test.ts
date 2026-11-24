import {
  ApprovalResponse,
  ListApprovalsResponse,
  ResolveApprovalResponse,
} from "@deployments-ai/api-contract/runtime";
import {
  RunRecord,
  ThreadRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import {
  pausedToolCallRecord,
  pendingApprovalRecord,
  runLookupRecord,
  type AgentRunQueueEnqueueInput,
} from "@deployments-ai/worker";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { handleApprovalArtifactRoutes } from "./approval-artifact-routes.ts";
import { cancelRun, retryRun } from "./runtime-operations.ts";
import {
  runtimeApiErrorFromCause,
  type HttpApiResult,
  type RuntimeApiDependencies,
} from "./runtime-support.ts";
import {
  deployment,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  principal,
  projectId,
  release,
  runLocator,
  runRecord,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";

type RunRecordValue = Extract<PlatformRecord, { readonly itemType: "run" }>;
type Purpose = "customer" | "evaluation" | "preview";

const bindingId = ids[20]!;
const approvalId = ids[21]!;
const toolCallId = ids[22]!;

function executionBinding(options: { readonly expiresAt?: string; readonly purpose: Purpose }) {
  return withCanonicalRecordKeys({
    data: {
      contentHash: "binding-content-hash",
      createdAt: "2026-07-25T00:00:00.000Z",
      createdBy: { id: serviceAccountId, type: "service-account" as const },
      environmentId,
      expiresAt: options.expiresAt ?? "2026-07-26T00:00:00.000Z",
      id: bindingId,
      idempotencyKey: "binding-1",
      manifest: { spec: {} },
      organizationId,
      projectId,
      purpose: options.purpose,
      source: { type: "manifest" as const },
      status: "active" as const,
      toolPolicy: options.purpose === "evaluation" ? "evaluation" : "interactive",
      updatedAt: "2026-07-25T00:00:00.000Z",
      version: 0,
    },
    itemType: "execution-binding" as const,
  }) as unknown as Extract<PlatformRecord, { readonly itemType: "execution-binding" }>;
}

function pinnedRun(
  purpose: Purpose,
  status: RunRecordValue["data"]["status"],
  toolContinuation?: RunRecordValue["data"]["toolContinuation"],
): RunRecordValue {
  const {
    agentDeploymentId: _agentDeploymentId,
    agentReleaseId: _agentReleaseId,
    ...base
  } = runRecord("queued").data;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...base,
        ...(purpose === "customer"
          ? { agentDeploymentId: ids[4]!, agentReleaseId: ids[6]! }
          : { executionBindingId: bindingId, executionPurpose: purpose }),
        ...(status === "failed" ? { completedAt: now.toISOString() } : {}),
        status,
        ...(toolContinuation ? { toolContinuation } : {}),
      },
      itemType: "run" as const,
    }),
  );
}

function threadFor(run: RunRecordValue) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(run.data.executionBindingId === undefined
          ? { agentDeploymentId: run.data.agentDeploymentId }
          : {
              executionBindingId: run.data.executionBindingId,
              executionPurpose: run.data.executionPurpose,
            }),
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: { id: serviceAccountId, type: "service-account" as const },
        environmentId,
        id: run.data.threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Preview conversation",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
}

const approvalAction = {
  approvalId,
  effect: "write" as const,
  idempotencyKey: "tool/deploy-1",
  input: { environment: "staging" },
  inputSummary: "Deploy to staging.",
  kind: "approval" as const,
  policyReason: "Deployment requires approval.",
  requiredScopes: ["deploy:write"],
  toolCallId,
  toolName: "deployment.start",
};

const asyncToolAction = {
  effect: "write" as const,
  externalOperationId: "provider-operation-1",
  idempotencyKey: "tool/deploy-async-1",
  input: { environment: "staging" },
  inputSummary: "Deploy to staging asynchronously.",
  kind: "tool" as const,
  policyReason: "Allowed.",
  requiredScopes: ["deploy:write"],
  toolCallId,
  toolName: "deployment.start",
};

function waitingForApproval(
  purpose: Purpose,
  bindingExpiresAt?: string,
  approvalExpiresAt?: string,
) {
  const run = pinnedRun(purpose, "waiting-for-approval", {
    completedToolCallIds: [],
    pendingAction: { kind: "approval", toolCallId },
    version: 2,
  });
  const toolCall = pausedToolCallRecord({ action: approvalAction, now, run });
  const approval = pendingApprovalRecord({ action: approvalAction, now, run });
  const records = [
    toolCall,
    approvalExpiresAt
      ? { ...approval, data: { ...approval.data, expiresAt: approvalExpiresAt } }
      : approval,
  ];
  return harness(run, records, purpose, bindingExpiresAt);
}

function harness(
  run: RunRecordValue,
  records: readonly PlatformRecord[],
  purpose: Purpose,
  bindingExpiresAt?: string,
) {
  const memory = memoryDatabase([
    run,
    runLocator(run),
    runLookupRecord(run),
    threadFor(run),
    ...(purpose === "customer"
      ? [deployment(), release()]
      : [
          executionBinding({
            purpose,
            ...(bindingExpiresAt ? { expiresAt: bindingExpiresAt } : {}),
          }),
        ]),
    ...records,
  ]);
  const enqueued: AgentRunQueueEnqueueInput[] = [];
  let nextId = 100;
  const dependencies = {
    database: memory.database,
    durableTransport: {
      append: async () => ({}),
      currentOffset: async () => "0",
    },
    enqueueRun: async (input: AgentRunQueueEnqueueInput) => {
      enqueued.push(input);
    },
    generateId: async () => `01ARZ3NDEKTSV4RRFFQ69G${String(nextId++).padStart(4, "0")}` as Ulid,
    now: () => now,
  } as unknown as RuntimeApiDependencies;
  const route = (path: string, body: Readonly<Record<string, unknown>>) =>
    handleApprovalArtifactRoutes({
      body,
      dependencies,
      event: { rawPath: path },
      method: "POST",
      path,
      principal: principal(),
    });
  const events = () =>
    [...memory.records.values()].filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
        record.itemType === "semantic-event",
    );
  const bindingChecks = () =>
    memory.transactions
      .flat()
      .filter(
        (operation: TransactionOperation) =>
          operation.kind === "condition-check" && operation.key.sk.startsWith("EXECUTION-BINDING#"),
      );
  return { bindingChecks, dependencies, enqueued, events, memory, route, run };
}

const resolveApproval = (
  fixture: {
    readonly route: (
      path: string,
      body: Readonly<Record<string, unknown>>,
    ) => Promise<HttpApiResult | undefined>;
    readonly run: RunRecordValue;
  },
  decision: string,
) =>
  fixture.route(`/v1/runs/${fixture.run.data.id}/approvals/${approvalId}/resolve`, {
    decision,
    threadId: fixture.run.data.threadId,
  });

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (cause) {
    return runtimeApiErrorFromCause(cause);
  }
  throw new Error("Expected the request to be rejected.");
}

describe("preview and evaluation run callbacks", () => {
  test("resumes an approved preview run fenced on its active binding with internal events", async () => {
    const fixture = waitingForApproval("preview");

    const result = await resolveApproval(fixture, "approved");

    expect(result?.statusCode).toBe(200);
    expect(JSON.parse(result!.body!)).toMatchObject({
      approval: { executionBindingId: bindingId, executionPurpose: "preview", status: "approved" },
      run: { executionBindingId: bindingId, status: "queued" },
    });
    expect(fixture.enqueued).toHaveLength(1);
    expect(fixture.bindingChecks()).toHaveLength(1);
    const resolved = fixture.events();
    expect(resolved.map((event) => event.data.eventType).sort()).toEqual([
      "approval.resolved",
      "run.resumed",
      "tool-call.approved",
    ]);
    for (const event of resolved) {
      expect(event.data.payload).toMatchObject({ deploymentsAiInternal: true });
    }
  });

  test("refuses to resume a preview run whose binding has logically expired", async () => {
    const fixture = waitingForApproval("preview", "2026-07-25T11:59:59.000Z");

    const error = await rejection(resolveApproval(fixture, "approved"));

    expect(error).toMatchObject({ code: "execution_binding_expired", status: 409 });
    expect(fixture.events()).toHaveLength(0);
    expect(fixture.enqueued).toHaveLength(0);
  });

  test("lists, reads, and resolves a preview approval through the public approval contract", async () => {
    const fixture = waitingForApproval("preview");
    const get = (path: string, query: Readonly<Record<string, string>> = {}) =>
      handleApprovalArtifactRoutes({
        body: {},
        dependencies: fixture.dependencies,
        event: { queryStringParameters: query, rawPath: path },
        method: "GET",
        path,
        principal: principal(),
      });
    const previewApproval = {
      executionBindingId: bindingId,
      executionPurpose: "preview",
      id: approvalId,
      runId: fixture.run.data.id,
    };

    const listed = Schema.decodeUnknownSync(ListApprovalsResponse)(
      JSON.parse((await get("/v1/approvals", { status: "pending" }))!.body!),
    );
    expect(listed.approvals).toEqual([expect.objectContaining(previewApproval)]);
    expect(listed.approvals[0]).not.toHaveProperty("requestedByAgentDeploymentId");

    const fetched = Schema.decodeUnknownSync(ApprovalResponse)(
      JSON.parse((await get(`/v1/runs/${fixture.run.data.id}/approvals/${approvalId}`))!.body!),
    );
    expect(fetched).toMatchObject({ ...previewApproval, status: "pending" });

    const resolved = Schema.decodeUnknownSync(ResolveApprovalResponse)(
      JSON.parse((await resolveApproval(fixture, "rejected"))!.body!),
    );
    expect(resolved).toMatchObject({
      approval: { ...previewApproval, status: "rejected" },
      decision: "rejected",
      run: { executionBindingId: bindingId, executionPurpose: "preview" },
    });
  });

  test("reports an approval resolved past its expiry as expired within the public contract", async () => {
    const fixture = waitingForApproval("customer", undefined, "2026-07-25T11:59:59.000Z");

    const result = await resolveApproval(fixture, "approved");

    expect(result?.statusCode).toBe(200);
    expect(
      Schema.decodeUnknownSync(ResolveApprovalResponse)(JSON.parse(result!.body!)),
    ).toMatchObject({
      approval: { id: approvalId, status: "expired" },
      decision: "expired",
      run: { status: "failed" },
    });
  });

  test("rejects evaluation approval resolution by policy", async () => {
    const fixture = waitingForApproval("evaluation");

    const error = await rejection(resolveApproval(fixture, "approved"));

    expect(error).toMatchObject({ code: "evaluation_approval_unsupported", status: 409 });
    expect(fixture.memory.transactions).toHaveLength(0);
  });

  test("keeps customer approval events public and unfenced by bindings", async () => {
    const fixture = waitingForApproval("customer");

    const result = await resolveApproval(fixture, "approved");

    expect(result?.statusCode).toBe(200);
    expect(fixture.bindingChecks()).toHaveLength(0);
    const resolved = fixture.events();
    expect(resolved).toHaveLength(3);
    for (const event of resolved) {
      expect(event.data.payload).not.toHaveProperty("deploymentsAiInternal");
    }
  });

  test("resumes a preview run from an asynchronous tool result with internal events", async () => {
    const run = pinnedRun("preview", "waiting-for-tool", {
      completedToolCallIds: [],
      pendingAction: { kind: "tool", toolCallId },
      version: 2,
    });
    const toolCall = pausedToolCallRecord({ action: asyncToolAction, now, run });
    const fixture = harness(run, [toolCall], "preview");

    const result = await fixture.route(`/v1/runs/${run.data.id}/tool-calls/${toolCallId}/results`, {
      externalOperationId: "provider-operation-1",
      outcome: "completed",
      outputSummary: "Deployment completed.",
      threadId: run.data.threadId,
    });

    expect(result?.statusCode).toBe(200);
    expect(JSON.parse(result!.body!)).toMatchObject({
      run: { status: "queued" },
      toolCall: { status: "succeeded" },
    });
    expect(fixture.enqueued).toHaveLength(1);
    expect(fixture.bindingChecks()).toHaveLength(1);
    const resolved = fixture.events();
    expect(resolved.map((event) => event.data.eventType).sort()).toEqual([
      "run.resumed",
      "tool-call.completed",
    ]);
    for (const event of resolved) {
      expect(event.data.payload).toMatchObject({ deploymentsAiInternal: true });
    }
  });

  test("resolves a preview run's client tool call with structured output", async () => {
    const run = pinnedRun("preview", "waiting-for-tool", {
      completedToolCallIds: [],
      pendingAction: { kind: "tool", toolCallId },
      version: 2,
    });
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const toolCall = pausedToolCallRecord({
      action: {
        client: {
          expiresAt,
          outputSchema: {
            additionalProperties: false,
            properties: { temperature: { type: "number" } },
            required: ["temperature"],
            type: "object",
          },
        },
        effect: "read",
        executionBinding: {
          authorizationFingerprint: "client:weather.local",
          connectionId: toolCallId,
          externalAccountId: "client:weather.local",
        },
        externalOperationId: toolCallId,
        idempotencyKey: "tool/weather-1",
        input: { city: "Oslo" },
        inputSummary: "Read the local weather.",
        kind: "tool",
        policyReason: "Allowed.",
        requiredScopes: [],
        toolCallId,
        toolName: "weather.local",
      },
      now,
      run,
    });
    const fixture = harness(run, [toolCall], "preview");
    const submit = (output: Readonly<Record<string, unknown>>) =>
      fixture.route(`/v1/runs/${run.data.id}/tool-calls/${toolCallId}/results`, {
        outcome: "completed",
        output,
        outputSummary: "Local weather read.",
        threadId: run.data.threadId,
      });

    const invalid = await rejection(submit({ temperature: "warm" }));
    expect(invalid).toMatchObject({ code: "invalid_tool_output" });
    const result = await submit({ temperature: 21.5 });

    expect(result?.statusCode).toBe(200);
    expect(JSON.parse(result!.body!)).toMatchObject({
      run: { executionBindingId: bindingId, status: "queued" },
      toolCall: {
        executionType: "client",
        expiresAt,
        input: { city: "Oslo" },
        output: { temperature: 21.5 },
        status: "succeeded",
      },
    });
    expect(fixture.enqueued).toHaveLength(1);
    expect(fixture.bindingChecks()).toHaveLength(1);
  });

  test("cancels a preview run awaiting approval with internal events", async () => {
    const fixture = waitingForApproval("preview");

    const result = await cancelRun(fixture.dependencies, principal(), fixture.run.data.id);

    expect(result.run).toMatchObject({ executionBindingId: bindingId, status: "canceled" });
    expect(result.approval?.data.status).toBe("rejected");
    const canceled = fixture.events();
    expect(canceled.map((event) => event.data.eventType)).toEqual(
      expect.arrayContaining(["approval.resolved", "run.canceled", "tool-call.failed"]),
    );
    for (const event of canceled) {
      expect(event.data.payload).toMatchObject({ deploymentsAiInternal: true });
    }
  });

  test("retries a failed preview run against its active execution binding", async () => {
    const run = pinnedRun("preview", "failed");
    const fixture = harness(run, [], "preview");

    const result = await retryRun(fixture.dependencies, principal(), run.data.id);

    expect(result.run).toMatchObject({ executionBindingId: bindingId, status: "queued" });
    expect(fixture.bindingChecks()).toHaveLength(1);
    expect(fixture.memory.transactions.flat()).not.toContainEqual(
      expect.objectContaining({
        kind: "condition-check",
        key: expect.objectContaining({ sk: expect.stringContaining("AGENT-DEPLOYMENT#") }),
      }),
    );
    for (const event of fixture.events()) {
      expect(event.data.payload).toMatchObject({ deploymentsAiInternal: true });
    }
  });

  test("refuses to retry a preview run whose binding has expired", async () => {
    const run = pinnedRun("preview", "failed");
    const fixture = harness(run, [], "preview", "2026-07-25T11:00:00.000Z");

    const error = await rejection(retryRun(fixture.dependencies, principal(), run.data.id));

    expect(error).toMatchObject({ code: "execution_binding_expired", status: 409 });
    expect(fixture.memory.transactions).toHaveLength(0);
  });
});
