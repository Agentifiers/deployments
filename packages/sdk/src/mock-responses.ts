import {
  makePublicOpenApiSpec,
  type PublicOpenApiSpec,
} from "@deployments-ai/api-contract/openapi";
import { mockAgentEmailData } from "./agent-email-mock.ts";
import { mockHostedCodeData } from "./hosted-code-mock.ts";
import { mockPreviewData } from "./preview-mock-routes.ts";
import { mockEvaluationData } from "./evaluation-mock-routes.ts";
import type { EvaluationMockState } from "./evaluation-mock-state.ts";
import { PlatformRequestError, type PlatformRequest } from "./index.ts";
import { createTenancyMockState, mockTenancyData } from "./tenancy-mock.ts";
import { mockModelData } from "./model-mock-routes.ts";
import { mockMemoryData } from "./memory-mock-routes.ts";
import { mockObservabilityData, mockRequestTenant } from "./observability-mock-routes.ts";

import { MOCK_RUNTIME_FIXTURE_IDS, mockItem, mockResponseKind } from "./mock-state.ts";

let publicOpenApiSpec: PublicOpenApiSpec | undefined;

export async function mockData(
  request: PlatformRequest,
  now: string,
  tenancyState: ReturnType<typeof createTenancyMockState>,
  evaluationState: EvaluationMockState,
): Promise<unknown> {
  const evaluation = mockEvaluationData(request, now, evaluationState);
  if (evaluation.matched) return evaluation.data;
  const path = request.path;
  const memory = mockMemoryData(request, now);
  if (memory.matched) return memory.data;
  const observability = mockObservabilityData(request, now);
  if (observability.matched) return observability.data;
  const { environmentId, organizationId, projectId } = mockRequestTenant(request);
  if (path === "/v1/whoami") {
    return {
      id: "usr_mock_operator",
      authentication: "api-credential",
      capabilities: ["platform:*"],
      environmentId,
      environmentIds: [environmentId],
      organizationId,
      organizationIds: [organizationId],
      projectId,
      projectIds: [projectId],
    };
  }
  if (path === "/health") {
    return { service: "deployments-ai-api", status: "ok" };
  }
  if (path === "/v1/openapi.json") {
    return (publicOpenApiSpec ??= makePublicOpenApiSpec());
  }
  const runtimeTenant = {
    environmentId: MOCK_RUNTIME_FIXTURE_IDS.environment,
    organizationId: MOCK_RUNTIME_FIXTURE_IDS.organization,
    projectId: MOCK_RUNTIME_FIXTURE_IDS.project,
  };
  const workflowExecution = {
    ...runtimeTenant,
    createdAt: now,
    currentStepAttempt: 0,
    currentStepId: "start",
    id: MOCK_RUNTIME_FIXTURE_IDS.workflowExecution,
    input:
      request.body &&
      typeof request.body === "object" &&
      "input" in request.body &&
      request.body.input &&
      typeof request.body.input === "object"
        ? request.body.input
        : {},
    object: "workflow-execution",
    status: path.endsWith("/cancel") ? "canceling" : "queued",
    updatedAt: now,
    version: path.endsWith("/cancel") ? 1 : 0,
    workflowContentHash: `sha256:${"a".repeat(64)}`,
    workflowDefinitionId: MOCK_RUNTIME_FIXTURE_IDS.workflowDefinition,
    workflowReleaseId: MOCK_RUNTIME_FIXTURE_IDS.workflowRelease,
    workflowReleaseNumber: 1,
  } as const;
  if (path === "/v1/workflow-executions" && request.method === "GET") {
    const { input: _input, object: _object, ...summary } = workflowExecution;
    return { items: [summary], nextCursor: null };
  }
  if (/^\/v1\/workflow-releases\/[^/]+\/executions$/u.test(path)) {
    return workflowExecution;
  }
  if (/^\/v1\/workflow-executions\/[^/]+(?:\/cancel)?$/u.test(path)) {
    return {
      ...workflowExecution,
      id: decodeURIComponent(path.split("/")[3] ?? workflowExecution.id),
    };
  }
  if (/^\/v1\/workflow-executions\/[^/]+\/steps$/u.test(path)) {
    return {
      items: [
        {
          ...runtimeTenant,
          attempt: 0,
          createdAt: now,
          id: MOCK_RUNTIME_FIXTURE_IDS.workflowStepAttempt,
          input: {},
          object: "workflow-step-attempt",
          status: "queued",
          stepId: "start",
          stepType: "agent",
          updatedAt: now,
          version: 0,
          workflowExecutionId: MOCK_RUNTIME_FIXTURE_IDS.workflowExecution,
        },
      ],
      nextCursor: null,
    };
  }
  if (/^\/v1\/workflow-executions\/[^/]+\/approvals\/[^/]+(?:\/resolve)?$/u.test(path)) {
    const body = request.body && typeof request.body === "object" ? request.body : {};
    const decision = "decision" in body ? body.decision : undefined;
    return {
      ...runtimeTenant,
      createdAt: now,
      id: decodeURIComponent(path.split("/")[5] ?? MOCK_RUNTIME_FIXTURE_IDS.workflowApproval),
      object: "workflow-approval",
      prompt: "Approve mock workflow step",
      ...(decision ? { resolvedAt: now, resolvedBy: { type: "service-account" } } : {}),
      status: decision ?? "pending",
      stepAttemptId: MOCK_RUNTIME_FIXTURE_IDS.workflowStepAttempt,
      updatedAt: now,
      version: decision ? 1 : 0,
      workflowExecutionId: decodeURIComponent(
        path.split("/")[3] ?? MOCK_RUNTIME_FIXTURE_IDS.workflowExecution,
      ),
    };
  }
  const runtimeRun = {
    ...runtimeTenant,
    agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
    agentReleaseId: MOCK_RUNTIME_FIXTURE_IDS.agentRelease,
    attempt: 0,
    checkpointCount: 0,
    createdAt: now,
    executionPurpose: "customer",
    executor: "mock",
    id: MOCK_RUNTIME_FIXTURE_IDS.run,
    object: "run",
    priority: 0,
    releaseSelection: "primary",
    spanId: "0123456789abcdef",
    status: "queued",
    threadId: MOCK_RUNTIME_FIXTURE_IDS.thread,
    traceId: "0123456789abcdef0123456789abcdef",
    trigger: "user",
    updatedAt: now,
    version: 1,
  } as const;
  const runtimeThread = {
    ...runtimeTenant,
    agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
    archived: false,
    channel: "api",
    createdAt: now,
    createdBy: { type: "service-account" },
    executionPurpose: "customer",
    id: MOCK_RUNTIME_FIXTURE_IDS.thread,
    object: "thread",
    pinned: false,
    streamId: MOCK_RUNTIME_FIXTURE_IDS.stream,
    title: "Mock thread",
    updatedAt: now,
    version: 1,
  } as const;
  const runtimeMessage = {
    ...runtimeTenant,
    agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
    body: "Mock message",
    contentHash: "sha256:mock",
    createdAt: now,
    id: MOCK_RUNTIME_FIXTURE_IDS.message,
    object: "message",
    role: "user",
    runId: MOCK_RUNTIME_FIXTURE_IDS.run,
    sequence: 0,
    threadId: MOCK_RUNTIME_FIXTURE_IDS.thread,
  } as const;
  const runtimeMessagePublication = {
    ...runtimeTenant,
    agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
    createdAt: now,
    id: MOCK_RUNTIME_FIXTURE_IDS.messagePublication,
    messageId: MOCK_RUNTIME_FIXTURE_IDS.message,
    messageSequence: 1,
    object: "message-publication",
    runId: MOCK_RUNTIME_FIXTURE_IDS.run,
    sourceMessageId: MOCK_RUNTIME_FIXTURE_IDS.message,
    sourceMessageSequence: 0,
    status: "reserved",
    streamEventId: MOCK_RUNTIME_FIXTURE_IDS.stream,
    threadId: MOCK_RUNTIME_FIXTURE_IDS.thread,
    updatedAt: now,
    version: 0,
  } as const;
  const runtimeToolCall = {
    ...runtimeTenant,
    createdAt: now,
    effect: "execute",
    id: MOCK_RUNTIME_FIXTURE_IDS.toolCall,
    inputSummary: "Mock input",
    object: "tool-call",
    requiredScopes: [],
    runId: MOCK_RUNTIME_FIXTURE_IDS.run,
    status: "succeeded",
    toolName: "mock.tool",
    updatedAt: now,
    version: 1,
  } as const;
  const runtimeSchedule = {
    ...runtimeTenant,
    agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
    createdAt: now,
    id: MOCK_RUNTIME_FIXTURE_IDS.schedule,
    name: "Mock schedule",
    object: "schedule",
    prompt: "Run the mock schedule",
    schedule: { expression: "rate(1 hour)" },
    status: "active",
    updatedAt: now,
    version: 1,
  } as const;
  const runtimeHeartbeat = {
    ...runtimeTenant,
    agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
    createdAt: now,
    id: MOCK_RUNTIME_FIXTURE_IDS.heartbeat,
    object: "heartbeat",
    schedule: {
      instructions: "Check the mock deployment",
      intervalMs: 60_000,
      skipWhenBusy: true,
    },
    status: "active",
    updatedAt: now,
    version: 1,
  } as const;
  const runtimeArtifact = {
    agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
    artifactId: MOCK_RUNTIME_FIXTURE_IDS.artifact,
    byteSize: 4,
    contentType: "text/plain",
    createdAt: now,
    fileName: "mock.txt",
    name: "mock.txt",
    object: "artifact",
    runId: MOCK_RUNTIME_FIXTURE_IDS.run,
    status: "available",
    type: "file",
    updatedAt: now,
    version: 0,
    visibility: "private",
  } as const;
  const threadErasure = /^\/v1\/threads\/([^/]+)\/erasures(?:\/[^/]+)?$/u.exec(path);
  if (threadErasure || /^\/v1\/end-users\/erasures(?:\/[^/]+)?$/u.test(path)) {
    return {
      erasure: {
        completedAt: now,
        counts: {
          automationsArchived: 0,
          ingressRecordsDeleted: 0,
          memoriesErased: 0,
          objectsStaged: 0,
          recordsDeleted: 0,
          runsCanceled: 0,
          streamsDeleted: 0,
          threadsErased: 1,
          threadsPlanned: 1,
        },
        createdAt: now,
        environmentId,
        id: MOCK_RUNTIME_FIXTURE_IDS.run,
        kind: threadErasure ? "thread" : "end-user",
        phase: "finalizing",
        status: "completed",
        ...(threadErasure ? { threadId: decodeURIComponent(threadErasure[1]!) } : {}),
        updatedAt: now,
      },
    };
  }
  if (/^\/v1\/threads\/[^/]+$/u.test(path) && request.method === "GET") {
    return runtimeThread;
  }
  if (/^\/v1\/threads\/[^/]+\/messages$/u.test(path) && request.method === "GET") {
    return { messages: [runtimeMessage] };
  }
  if (/^\/v1\/threads\/[^/]+\/runs\/[^/]+$/u.test(path) && request.method === "GET") {
    return runtimeRun;
  }
  if (/^\/v1\/threads\/[^/]+\/runs\/[^/]+\/message$/u.test(path) && request.method === "GET") {
    return runtimeMessage;
  }
  if (path.endsWith("/message/publication-reservations") && request.method === "POST") {
    return runtimeMessagePublication;
  }
  if (path.endsWith("/message/publication-releases") && request.method === "POST") {
    return {
      ...runtimeMessagePublication,
      releasedAt: now,
      status: "released",
      version: 1,
    };
  }
  if (path.endsWith("/message/publications") && request.method === "POST") {
    return {
      ...runtimeMessage,
      body: (request.body as { readonly content?: unknown } | undefined)?.content,
      role: "assistant",
      sequence: runtimeMessagePublication.messageSequence,
    };
  }
  if (/^\/v1\/runs\/[^/]+\/approvals\/[^/]+\/resolve$/u.test(path)) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const decision = body.decision === "rejected" ? "rejected" : "approved";
    return {
      approval: {
        ...runtimeTenant,
        createdAt: now,
        escalationCount: 0,
        executionPurpose: "customer",
        id: MOCK_RUNTIME_FIXTURE_IDS.approval,
        object: "approval",
        request: {},
        requestedByAgentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
        resolvedAt: now,
        runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        status: decision,
        updatedAt: now,
        version: 2,
      },
      decision,
      run: runtimeRun,
      toolCall: runtimeToolCall,
    };
  }
  if (/^\/v1\/runs\/[^/]+\/tool-calls\/[^/]+\/results$/u.test(path)) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const failed = body.outcome === "failed";
    const output = body.output;
    return {
      outcome: failed ? "failed" : "completed",
      run: runtimeRun,
      toolCall:
        output && typeof output === "object"
          ? {
              ...runtimeToolCall,
              executionType: "client",
              input: {},
              output,
              status: failed ? "failed" : "succeeded",
            }
          : runtimeToolCall,
    };
  }
  if (path === "/v1/artifacts" && request.method === "GET") {
    return { artifacts: [runtimeArtifact] };
  }
  if (path === "/v1/artifacts" && request.method === "POST") {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      artifact: {
        ...runtimeArtifact,
        byteSize: body.byteSize,
        contentType: body.contentType,
        fileName: body.fileName,
        name: body.name,
        status: "pending",
        type: body.type,
      },
      upload: {
        expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
        headers: {
          "content-length": String(body.byteSize),
          "content-type": String(body.contentType),
          "if-none-match": "*",
          "x-amz-checksum-sha256": "mock-checksum",
          "x-amz-server-side-encryption": "aws:kms",
          "x-amz-server-side-encryption-aws-kms-key-id": "mock-artifact-kms-key",
        },
        method: "PUT",
        url: "https://mock.deployments.ai/artifacts/upload",
      },
    };
  }
  if (/^\/v1\/artifacts\/[^/]+$/u.test(path) && request.method === "GET") {
    return runtimeArtifact;
  }
  if (/^\/v1\/artifacts\/[^/]+$/u.test(path) && request.method === "DELETE") {
    return {
      ...runtimeArtifact,
      retentionExpiresAt: now,
      status: "deleted",
      version: runtimeArtifact.version + 1,
    };
  }
  if (/^\/v1\/artifacts\/[^/]+\/complete$/u.test(path)) {
    return runtimeArtifact;
  }
  if (/^\/v1\/artifacts\/[^/]+\/retention$/u.test(path)) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      ...runtimeArtifact,
      ...(typeof body.retentionExpiresAt === "string"
        ? { retentionExpiresAt: body.retentionExpiresAt }
        : {}),
      version:
        typeof body.expectedVersion === "number"
          ? body.expectedVersion + 1
          : runtimeArtifact.version + 1,
    };
  }
  if (/^\/v1\/artifacts\/[^/]+\/access-urls$/u.test(path)) {
    return {
      expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
      url: "https://mock.deployments.ai/artifacts/mock",
    };
  }
  if (path === "/v1/schedules") {
    return request.method === "GET" ? { schedules: [runtimeSchedule] } : runtimeSchedule;
  }
  if (/^\/v1\/schedules\/[^/]+\/fire$/u.test(path)) {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return {
      duplicate: false,
      fire: {
        ...runtimeTenant,
        createdAt: now,
        fireKey: typeof body.fireKey === "string" ? body.fireKey : "mock-fire",
        firedAt: now,
        id: MOCK_RUNTIME_FIXTURE_IDS.scheduleFire,
        object: "schedule-fire",
        runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        scheduleId: MOCK_RUNTIME_FIXTURE_IDS.schedule,
        status: "accepted",
        threadId: MOCK_RUNTIME_FIXTURE_IDS.thread,
      },
      run: { runId: MOCK_RUNTIME_FIXTURE_IDS.run, threadId: MOCK_RUNTIME_FIXTURE_IDS.thread },
    };
  }
  if (path === "/v1/heartbeats") {
    return request.method === "GET" ? { heartbeats: [runtimeHeartbeat] } : runtimeHeartbeat;
  }
  if (/^\/v1\/heartbeats\/[^/]+\/fire$/u.test(path)) {
    return {
      duplicate: false,
      heartbeatRun: {
        ...runtimeTenant,
        createdAt: now,
        heartbeatId: MOCK_RUNTIME_FIXTURE_IDS.heartbeat,
        id: MOCK_RUNTIME_FIXTURE_IDS.heartbeatRun,
        object: "heartbeat-run",
        runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        status: "accepted",
        threadId: MOCK_RUNTIME_FIXTURE_IDS.thread,
        version: 1,
      },
      run: { runId: MOCK_RUNTIME_FIXTURE_IDS.run, threadId: MOCK_RUNTIME_FIXTURE_IDS.thread },
    };
  }
  if (/^\/v1\/threads\/[^/]+\/stream-sessions$/u.test(path) && request.method === "POST") {
    const streamUrl = `https://streams.mock.deployments.ai${path.replace(/-sessions$/u, "")}`;
    return {
      accessToken: "mock-thread-stream-session",
      history: [],
      session: {
        environmentId: MOCK_RUNTIME_FIXTURE_IDS.environment,
        expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
        offset: "0",
        organizationId: MOCK_RUNTIME_FIXTURE_IDS.organization,
        permissions: ["read"],
        projectId: MOCK_RUNTIME_FIXTURE_IDS.project,
        readUrl: `${streamUrl}?offset=0`,
        replayState: { canonicalMessageIds: [], finalizedMessageIds: [] },
        sessionId: MOCK_RUNTIME_FIXTURE_IDS.session,
        threadId: MOCK_RUNTIME_FIXTURE_IDS.thread,
      },
      streamUrl,
    };
  }
  if (/^\/v1\/threads\/[^/]+\/stream$/u.test(path) && request.method === "GET") {
    return {
      items: [
        {
          eventId: "event_1",
          eventType: "run.started",
          occurredAt: now,
          runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        },
        {
          eventId: "event_2",
          eventType: "assistant-message.finalized",
          occurredAt: now,
          runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        },
        {
          eventId: "event_3",
          eventType: "run.completed",
          occurredAt: now,
          runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        },
      ],
    };
  }
  if (/^\/v1\/agent-deployments\/[^/]+\/runs$/u.test(path) && request.method === "POST") {
    const body =
      request.body && typeof request.body === "object"
        ? (request.body as Record<string, unknown>)
        : {};
    const submittedThreadId =
      typeof body.threadId === "string" ? body.threadId : MOCK_RUNTIME_FIXTURE_IDS.thread;
    return {
      created: true,
      message: {
        agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
        body: body.content,
        contentHash: "sha256:mock",
        createdAt: now,
        environmentId: MOCK_RUNTIME_FIXTURE_IDS.environment,
        id: MOCK_RUNTIME_FIXTURE_IDS.message,
        ...(Array.isArray(body.inputArtifacts) ? { inputArtifacts: body.inputArtifacts } : {}),
        object: "message",
        organizationId: MOCK_RUNTIME_FIXTURE_IDS.organization,
        projectId: MOCK_RUNTIME_FIXTURE_IDS.project,
        role: "user",
        runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        sequence: 0,
        threadId: submittedThreadId,
      },
      run: {
        agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
        agentReleaseId: MOCK_RUNTIME_FIXTURE_IDS.agentRelease,
        attempt: 0,
        checkpointCount: 0,
        createdAt: now,
        environmentId: MOCK_RUNTIME_FIXTURE_IDS.environment,
        executionPurpose: "customer",
        executor: "mock",
        id: MOCK_RUNTIME_FIXTURE_IDS.run,
        object: "run",
        organizationId: MOCK_RUNTIME_FIXTURE_IDS.organization,
        priority: 0,
        projectId: MOCK_RUNTIME_FIXTURE_IDS.project,
        releaseSelection: "primary",
        spanId: "0123456789abcdef",
        status: "queued",
        threadId: submittedThreadId,
        traceId: "0123456789abcdef0123456789abcdef",
        trigger: "user",
        updatedAt: now,
        version: 1,
      },
      thread: {
        agentDeploymentId: MOCK_RUNTIME_FIXTURE_IDS.agentDeployment,
        archived: false,
        channel: "api",
        createdAt: now,
        createdBy: { type: "service-account" },
        environmentId: MOCK_RUNTIME_FIXTURE_IDS.environment,
        executionPurpose: "customer",
        id: submittedThreadId,
        object: "thread",
        organizationId: MOCK_RUNTIME_FIXTURE_IDS.organization,
        pinned: false,
        projectId: MOCK_RUNTIME_FIXTURE_IDS.project,
        streamId: MOCK_RUNTIME_FIXTURE_IDS.stream,
        title: typeof body.title === "string" ? body.title : "Mock thread",
        updatedAt: now,
        version: 1,
      },
    };
  }
  const preview = mockPreviewData(request, now);
  if (preview.matched) return preview.data;
  const agentEmail = mockAgentEmailData(request, now);
  if (agentEmail.matched) return agentEmail.data;
  const models = mockModelData(request, now, tenancyState);
  if (models.matched) return models.data;
  const hostedCode = mockHostedCodeData(request, now);
  if (hostedCode.matched) return hostedCode.data;
  const tenancy = await mockTenancyData(request, now, tenancyState);
  if (tenancy.matched) {
    if ("error" in tenancy) throw new PlatformRequestError(tenancy.error);
    return tenancy.data;
  }
  if (request.method === "GET" && mockResponseKind(request) === "list") {
    return {
      items: [mockItem(request, "alpha", now), mockItem(request, "beta", now)],
      nextCursor: null,
    };
  }
  const item = mockItem(request, "mock", now);
  if (
    request.method === "POST" &&
    (/^\/v1\/(?:api-keys|credentials|oauth-apps)$/u.test(path) ||
      /^\/v1\/(?:api-keys|credentials|oauth-apps)\/[^/]+\/rotate$/u.test(path))
  ) {
    return {
      ...item,
      secret: "dpl_mock_secret_value",
      secretVisibleOnce: true,
    };
  }
  return item;
}
