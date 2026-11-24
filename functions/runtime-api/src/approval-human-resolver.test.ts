import {
  OrganizationStandingRecord,
  RunRecord,
  ThreadRecord,
  WorkflowApprovalRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  pausedToolCallRecord,
  pendingApprovalRecord,
  runLookupRecord,
} from "@deployments-ai/worker";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { handleApprovalArtifactRoutes } from "./approval-artifact-routes.ts";
import type { RuntimeHumanPrincipal } from "./runtime-principal.ts";
import { runtimeApiErrorFromCause, type RuntimeApiDependencies } from "./runtime-support.ts";
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
import { handleWorkflowExecutionRoutes } from "./workflow-execution-routes.ts";

type RunRecordValue = Extract<PlatformRecord, { readonly itemType: "run" }>;

const approvalId = ids[21]!;
const toolCallId = ids[22]!;
const workflowExecutionId = ids[23]!;
const workflowApprovalId = ids[24]!;
const destination = "https://labs.example.org/results?patient=Jane%20Doe&dob=1980-02-03";
const AT = now.toISOString();

const phiStanding = Schema.decodeUnknownSync(OrganizationStandingRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: AT,
      dataBoundary: {
        operatorNote: "BAA-2026-17",
        profile: "phi",
        setAt: AT,
        setBy: { kind: "operator", principalId: ids[25]! },
      },
      grants: {},
      organizationId,
      updatedAt: AT,
      version: 1,
    },
    itemType: "organization-standing" as const,
  }),
);

const human: RuntimeHumanPrincipal = {
  kind: "human",
  organizationRole: "admin",
  platformAdministrator: false,
  principalId: ids[26]!,
  scope: { environmentId, organizationId, projectId },
  scopes: ["platform:*"],
};

function waitingRun(): RunRecordValue {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...runRecord("queued").data,
        status: "waiting-for-approval",
        toolContinuation: {
          completedToolCallIds: [],
          pendingAction: { kind: "approval", toolCallId },
          version: 2,
        },
      },
      itemType: "run" as const,
    }),
  );
}

function thread(run: RunRecordValue) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        archived: false,
        channel: "api",
        createdAt: AT,
        createdBy: { id: serviceAccountId, type: "service-account" as const },
        environmentId,
        id: run.data.threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Lab results",
        updatedAt: AT,
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
}

const workflowApproval = Schema.decodeUnknownSync(WorkflowApprovalRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: AT,
      environmentId,
      id: workflowApprovalId,
      organizationId,
      projectId,
      prompt: "Send the summary?",
      requestedBy: { type: "system" },
      status: "pending",
      stepAttemptId: workflowApprovalId,
      updatedAt: AT,
      version: 0,
      workflowExecutionId,
    },
    itemType: "workflow-approval" as const,
  }),
);

function harness(options: { readonly phi: boolean; readonly standingReadFails?: boolean }) {
  const run = waitingRun();
  const action = {
    approvalId,
    destinations: [destination],
    effect: "read" as const,
    idempotencyKey: "tool/scrape-1",
    input: { url: destination },
    inputSummary: "Scrape lab results.",
    kind: "approval" as const,
    policyReason: "The phi data boundary needs a person to approve these destinations.",
    requiredScopes: [],
    toolCallId,
    toolName: "web.scrape",
  };
  const memory = memoryDatabase([
    run,
    runLocator(run),
    runLookupRecord(run),
    thread(run),
    deployment(),
    release(),
    pausedToolCallRecord({ action, now, run }),
    pendingApprovalRecord({ action, now, run }),
    workflowApproval,
    ...(options.phi ? [phiStanding] : []),
  ]);
  const standingReads: string[] = [];
  const database = {
    ...memory.database,
    getRecord: (...args: Parameters<DynamoDatabaseService["getRecord"]>) => {
      if (args[1].sk.startsWith("ORGANIZATION-STANDING")) {
        standingReads.push(args[1].pk);
        if (options.standingReadFails) return Promise.reject(new Error("standing read throttled"));
      }
      return memory.database.getRecord(...args);
    },
  } as DynamoDatabaseService;
  let nextId = 100;
  const dependencies = {
    database,
    durableTransport: { append: async () => ({}), currentOffset: async () => "0" },
    enqueueRun: async () => undefined,
    generateId: async () => `01ARZ3NDEKTSV4RRFFQ69G${String(nextId++).padStart(4, "0")}` as Ulid,
    now: () => now,
  } as unknown as RuntimeApiDependencies;
  const resolveRun = (resolver: typeof human | ReturnType<typeof principal>) =>
    handleApprovalArtifactRoutes({
      body: { decision: "approved", threadId: run.data.threadId },
      dependencies,
      event: { rawPath: "" },
      method: "POST",
      path: `/v1/runs/${run.data.id}/approvals/${approvalId}/resolve`,
      principal: resolver,
    });
  const resolveWorkflow = (resolver: typeof human | ReturnType<typeof principal>) =>
    handleWorkflowExecutionRoutes({
      body: { decision: "approved" },
      dependencies,
      event: { rawPath: "" },
      method: "POST",
      path: `/v1/workflow-executions/${workflowExecutionId}/approvals/${workflowApprovalId}/resolve`,
      principal: resolver,
    });
  const getApproval = () =>
    handleApprovalArtifactRoutes({
      body: {},
      dependencies,
      event: { rawPath: "" },
      method: "GET",
      path: `/v1/runs/${run.data.id}/approvals/${approvalId}`,
      principal: human,
    });
  return { getApproval, memory, resolveRun, resolveWorkflow, standingReads };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (cause) {
    return runtimeApiErrorFromCause(cause);
  }
  throw new Error("Expected the request to be rejected.");
}

const approvalStatus = (memory: ReturnType<typeof memoryDatabase>) =>
  [...memory.records.values()].find(
    (record) => record.itemType === "approval" && record.data.id === approvalId,
  )?.data;

describe("approval resolution inside a phi data boundary", () => {
  test("projects the approval request's destinations in full", async () => {
    const { getApproval } = harness({ phi: true });

    const approval = JSON.parse((await getApproval())!.body!);

    expect(approval.request.destinations).toEqual([destination]);
  });

  test("refuses an API key with 403 approval_requires_human and lets a person resolve it", async () => {
    const { memory, resolveRun } = harness({ phi: true });

    expect(await rejection(resolveRun(principal()))).toMatchObject({
      code: "approval_requires_human",
      status: 403,
    });
    expect(approvalStatus(memory)).toMatchObject({ status: "pending" });

    const resolved = await resolveRun(human);
    expect(resolved?.statusCode).toBe(200);
    expect(approvalStatus(memory)).toMatchObject({
      resolvedByPrincipalId: human.principalId,
      status: "approved",
    });
  });

  test("refuses an API key resolving a workflow approval step", async () => {
    const { resolveWorkflow } = harness({ phi: true });

    expect(await rejection(resolveWorkflow(principal()))).toMatchObject({
      code: "approval_requires_human",
      status: 403,
    });
    const resolved = await resolveWorkflow(human);
    expect(JSON.parse(resolved!.body!)).toMatchObject({ status: "approved" });
  });

  test("refuses an API key when the boundary cannot be read", async () => {
    const { memory, resolveRun, resolveWorkflow } = harness({
      phi: false,
      standingReadFails: true,
    });

    expect(await rejection(resolveRun(principal()))).toMatchObject({ status: 500 });
    expect(await rejection(resolveWorkflow(principal()))).toMatchObject({ status: 500 });
    expect(approvalStatus(memory)).toMatchObject({ status: "pending" });
  });
});

describe("approval resolution in an open organization", () => {
  test("an API key still resolves approvals", async () => {
    const { memory, resolveRun, resolveWorkflow } = harness({ phi: false });

    expect((await resolveRun(principal()))?.statusCode).toBe(200);
    expect(approvalStatus(memory)).toMatchObject({ status: "approved" });
    expect(JSON.parse((await resolveWorkflow(principal()))!.body!)).toMatchObject({
      status: "approved",
    });
  });

  test("a person's resolution does not read the boundary", async () => {
    const { resolveRun, standingReads } = harness({ phi: false });

    expect((await resolveRun(human))?.statusCode).toBe(200);
    expect(standingReads).toEqual([]);
  });
});
