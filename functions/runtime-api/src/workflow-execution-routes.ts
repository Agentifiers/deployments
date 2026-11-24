import {
  WorkflowDefinitionDocumentV1,
  WorkflowExecutionResponse,
  WorkflowExecutionSummaryResponse,
  WorkflowApprovalResponse,
  WorkflowStepAttemptResponse,
} from "@deployments-ai/api-contract";
import {
  WorkflowExecutionRecord,
  key,
  makeOrganizationDataBoundaryReader,
  makeWorkflowExecutionPersistence,
  makeWorkflowApprovalPersistence,
  type WorkflowExecutionRecordValue,
  type WorkflowStepAttemptRecordValue,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import { recordActor } from "./runtime-principal.ts";
import { listEnvironmentRecords } from "./environment-record-pagination.ts";
import { listWorkflowStepAttempts, publicWorkflowStepPage } from "./workflow-step-pagination.ts";
import {
  runtimeListCursor,
  workflowApprovalResolutionRequest,
  workflowExecutionCancelRequest,
  workflowExecutionStartRequest,
} from "./request-validation.ts";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  id,
  requiredIdempotencyKey,
  requireScope,
  response,
  scoped,
} from "./runtime-support.ts";

function publicExecution(record: WorkflowExecutionRecordValue) {
  return Schema.decodeUnknownSync(WorkflowExecutionResponse)({
    ...record.data,
    object: "workflow-execution",
  });
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, canonicalJson(entry)]),
  );
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function publicExecutionSummary(record: WorkflowExecutionRecordValue) {
  const { error: _error, input: _input, output: _output, ...summary } = record.data;
  return Schema.decodeUnknownSync(WorkflowExecutionSummaryResponse)(summary);
}

function publicStepAttempt(record: WorkflowStepAttemptRecordValue) {
  return Schema.decodeUnknownSync(WorkflowStepAttemptResponse)({
    ...record.data,
    object: "workflow-step-attempt",
  });
}

function publicWorkflowApproval(
  record: Awaited<ReturnType<ReturnType<typeof makeWorkflowApprovalPersistence>["get"]>>,
) {
  return Schema.decodeUnknownSync(WorkflowApprovalResponse)({
    ...record.data,
    object: "workflow-approval",
  });
}

async function activeWorkflowRelease(context: RuntimeRouteContext, releaseId: string) {
  const release = scoped(
    assertRecord(
      await getRecord(context.dependencies.database, "control", {
        pk: key(
          "ORG",
          context.principal.scope.organizationId,
          "ENV",
          context.principal.scope.environmentId,
        ),
        sk: key("WORKFLOW-RELEASE", releaseId),
      }),
      "workflow-release",
      "Workflow release",
    ),
    context.principal,
  );
  if (release.data.status !== "active") {
    throw new RuntimeApiError(
      409,
      "workflow_release_unavailable",
      "Archived workflow releases cannot start new executions.",
    );
  }
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1)(
    release.data.definition,
  );
  return { definition, release };
}

async function assertActiveWorkspace(
  context: RuntimeRouteContext,
  workspaceId: string | undefined,
) {
  if (!workspaceId) return undefined;
  const workspace = scoped(
    assertRecord(
      await getRecord(context.dependencies.database, "control", {
        pk: key(
          "ORG",
          context.principal.scope.organizationId,
          "ENV",
          context.principal.scope.environmentId,
        ),
        sk: key("WORKSPACE", workspaceId),
      }),
      "workspace",
      "Workspace",
    ),
    context.principal,
  );
  if (workspace.data.status !== "active") {
    throw new RuntimeApiError(409, "workspace_unavailable", "Workspace is not active.");
  }
  return workspace;
}

export async function handleWorkflowExecutionRoutes(context: RuntimeRouteContext) {
  const { body, dependencies, event, method, path, principal } = context;
  const persistence = makeWorkflowExecutionPersistence(dependencies);
  const approvals = makeWorkflowApprovalPersistence(dependencies);
  let match: RegExpExecArray | null;

  if (method === "GET" && path === "/v1/workflow-executions") {
    requireScope(principal, "workflows:read");
    const status = event.queryStringParameters?.status;
    const statuses = new Set([
      "queued",
      "running",
      "waiting-for-agent",
      "waiting-for-tool",
      "waiting-for-approval",
      "waiting-for-delivery",
      "completed",
      "failed",
      "canceling",
      "canceled",
    ]);
    if (status !== undefined && !statuses.has(status)) {
      throw new RuntimeApiError(400, "invalid_status", "Workflow execution status is invalid.");
    }
    const page = await listEnvironmentRecords(
      dependencies.database,
      "execution",
      principal.scope.environmentId,
      "workflow-execution",
      {
        ...(event.queryStringParameters?.cursor !== undefined
          ? { cursor: runtimeListCursor(event.queryStringParameters.cursor) }
          : {}),
        ...(event.queryStringParameters?.limit
          ? { limit: Number(event.queryStringParameters.limit) }
          : {}),
        ...(status ? { status } : {}),
      },
    );
    return response(200, {
      items: page.items
        .filter(
          (record): record is WorkflowExecutionRecordValue =>
            record.itemType === "workflow-execution" &&
            record.data.organizationId === principal.scope.organizationId &&
            record.data.projectId === principal.scope.projectId,
        )
        .map(publicExecutionSummary),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  if (method === "POST" && (match = /^\/v1\/workflow-releases\/([^/]+)\/executions$/u.exec(path))) {
    requireScope(principal, "workflows:execute");
    const workflowReleaseId = id(match[1], "workflowReleaseId");
    const request = workflowExecutionStartRequest(body);
    const idempotencyKey = requiredIdempotencyKey(event);
    const requestedWorkspaceId = request.workspaceId
      ? id(request.workspaceId, "workspaceId")
      : undefined;
    const replay = await persistence.getByIdempotencyKey({
      ...principal.scope,
      idempotencyKey,
    });
    if (replay) {
      const execution = scoped(replay, principal);
      if (
        execution.data.workflowReleaseId !== workflowReleaseId ||
        execution.data.workspaceId !== requestedWorkspaceId ||
        !sameJson(execution.data.input, request.input ?? {})
      ) {
        throw new RuntimeApiError(
          409,
          "workflow_execution_idempotency_conflict",
          "The workflow execution idempotency key belongs to a different request.",
        );
      }
      return response(202, publicExecution(execution));
    }
    const workspace = await assertActiveWorkspace(context, requestedWorkspaceId);
    const workspaceId = workspace?.data.id;
    const { definition, release } = await activeWorkflowRelease(context, workflowReleaseId);
    const result = await persistence.create(
      {
        ...principal.scope,
        entryStepId: definition.entryStepId,
        idempotencyKey,
        initiatedBy: recordActor(principal),
        input: request.input ?? {},
        workflowContentHash: release.data.contentHash,
        workflowDefinitionId: release.data.workflowDefinitionId,
        workflowReleaseId: release.data.id,
        workflowReleaseNumber: release.data.releaseNumber,
        ...(workspaceId ? { workspaceId } : {}),
      },
      {
        prerequisites: [
          { pk: release.pk, sk: release.sk, version: release.data.version },
          ...(workspace
            ? [{ pk: workspace.pk, sk: workspace.sk, version: workspace.data.version }]
            : []),
        ],
      },
    );
    return response(202, publicExecution(result.execution));
  }

  if (method === "GET" && (match = /^\/v1\/workflow-executions\/([^/]+)\/steps$/u.exec(path))) {
    requireScope(principal, "workflows:read");
    const executionId = id(match[1], "workflowExecutionId");
    scoped(await persistence.get(principal.scope.organizationId, executionId), principal);
    const page = await listWorkflowStepAttempts(
      dependencies.database,
      principal.scope.organizationId,
      executionId,
      {
        ...(event.queryStringParameters?.cursor !== undefined
          ? { cursor: runtimeListCursor(event.queryStringParameters.cursor) }
          : {}),
        ...(event.queryStringParameters?.limit
          ? { limit: Number(event.queryStringParameters.limit) }
          : {}),
      },
    );
    return response(200, publicWorkflowStepPage(page.items, publicStepAttempt, page.nextCursor));
  }

  if (
    method === "POST" &&
    (match = /^\/v1\/workflow-executions\/([^/]+)\/approvals\/([^/]+)\/resolve$/u.exec(path))
  ) {
    requireScope(principal, "approvals:write");
    const request = workflowApprovalResolutionRequest(body);
    const executionId = id(match[1], "workflowExecutionId");
    const workflowApprovalId = id(match[2], "workflowApprovalId");
    scoped(
      await approvals.getStored(principal.scope.organizationId, executionId, workflowApprovalId),
      principal,
    );
    if (principal.kind !== "human") {
      // A failed boundary read propagates, so an API key is never admitted on an unknown boundary.
      const boundary = await makeOrganizationDataBoundaryReader(dependencies.database).read(
        principal.scope.organizationId,
      );
      if (boundary.profile !== "open") {
        throw new RuntimeApiError(
          403,
          "approval_requires_human",
          `Only a person can resolve approvals inside this organization's ${boundary.profile} data boundary; an API key cannot.`,
        );
      }
    }
    const approval = scoped(
      await approvals.resolve({
        decision: request.decision,
        organizationId: principal.scope.organizationId,
        resolvedBy: recordActor(principal),
        workflowApprovalId,
        workflowExecutionId: executionId,
      }),
      principal,
    );
    return response(200, publicWorkflowApproval(approval));
  }

  if (
    method === "GET" &&
    (match = /^\/v1\/workflow-executions\/([^/]+)\/approvals\/([^/]+)$/u.exec(path))
  ) {
    requireScope(principal, "approvals:read");
    const executionId = id(match[1], "workflowExecutionId");
    const workflowApprovalId = id(match[2], "workflowApprovalId");
    scoped(
      await approvals.getStored(principal.scope.organizationId, executionId, workflowApprovalId),
      principal,
    );
    const approval = scoped(
      await approvals.get(principal.scope.organizationId, executionId, workflowApprovalId),
      principal,
    );
    return response(200, publicWorkflowApproval(approval));
  }

  if (method === "POST" && (match = /^\/v1\/workflow-executions\/([^/]+)\/cancel$/u.exec(path))) {
    requireScope(principal, "workflows:execute");
    const executionId = id(match[1], "workflowExecutionId");
    const request = workflowExecutionCancelRequest(body);
    const previous = scoped(
      await persistence.get(principal.scope.organizationId, executionId),
      principal,
    );
    if (["canceled", "completed", "failed"].includes(previous.data.status)) {
      return response(200, publicExecution(previous));
    }
    if (previous.data.version !== request.expectedVersion) {
      throw new RuntimeApiError(
        409,
        "workflow_execution_version_conflict",
        "Workflow execution version does not match expectedVersion.",
      );
    }
    if (previous.data.status === "canceling") return response(200, publicExecution(previous));
    const timestamp = (dependencies.now?.() ?? new Date()).toISOString();
    const next = Schema.decodeUnknownSync(WorkflowExecutionRecord)(
      withCanonicalRecordKeys({
        ...previous,
        data: {
          ...previous.data,
          cancelRequestedAt: timestamp,
          status: "canceling" as const,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
      }),
    );
    await persistence.commitTransition({
      actor: recordActor(principal),
      eventType: "workflow-execution.cancel-requested",
      nextExecution: next,
      previousExecution: previous,
    });
    return response(200, publicExecution(next));
  }

  if (method === "GET" && (match = /^\/v1\/workflow-executions\/([^/]+)$/u.exec(path))) {
    requireScope(principal, "workflows:read");
    const execution = scoped(
      await persistence.get(principal.scope.organizationId, id(match[1], "workflowExecutionId")),
      principal,
    );
    return response(200, publicExecution(execution));
  }

  return undefined;
}
