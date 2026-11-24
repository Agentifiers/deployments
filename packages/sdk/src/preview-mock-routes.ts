import type { PlatformRequest } from "./index.ts";
import { MOCK_RUNTIME_FIXTURE_IDS } from "./mock-state.ts";

type PreviewMockResult =
  | { readonly matched: false }
  | { readonly data: unknown; readonly matched: true };

const PREVIEW_ITEM_PATH = /^\/v1\/previews\/([^/]+)$/u;
const PREVIEW_TURNS_PATH = /^\/v1\/previews\/([^/]+)\/turns$/u;

function requestBody(request: PlatformRequest): Record<string, unknown> {
  return request.body && typeof request.body === "object"
    ? (request.body as Record<string, unknown>)
    : {};
}

export function mockPreviewData(request: PlatformRequest, now: string): PreviewMockResult {
  const tenant = {
    environmentId: MOCK_RUNTIME_FIXTURE_IDS.environment,
    organizationId: MOCK_RUNTIME_FIXTURE_IDS.organization,
    projectId: MOCK_RUNTIME_FIXTURE_IDS.project,
  };
  const preview = (id: string, expired: boolean, body: Record<string, unknown> = {}) => {
    const manifest = body.manifest as { readonly name?: unknown } | undefined;
    const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : 3600;
    return {
      ...tenant,
      agentName: typeof manifest?.name === "string" ? manifest.name : "mock-agent",
      contentHash: "sha256:mock",
      createdAt: now,
      createdBy: { type: "service-account" },
      ...(expired ? { expiredAt: now } : {}),
      expiresAt: new Date(Date.parse(now) + ttlSeconds * 1000).toISOString(),
      id,
      object: "preview",
      ...(typeof body.fromAgentDeploymentId === "string"
        ? { runtimeConfigFromAgentDeploymentId: body.fromAgentDeploymentId }
        : {}),
      status: expired ? "expired" : "active",
      updatedAt: now,
      version: expired ? 1 : 0,
    };
  };
  if (request.path === "/v1/previews" && request.method === "POST") {
    return {
      data: preview(MOCK_RUNTIME_FIXTURE_IDS.preview, false, requestBody(request)),
      matched: true,
    };
  }
  const item = PREVIEW_ITEM_PATH.exec(request.path);
  if (item && (request.method === "GET" || request.method === "DELETE")) {
    return {
      data: preview(decodeURIComponent(item[1]!), request.method === "DELETE"),
      matched: true,
    };
  }
  const turns = PREVIEW_TURNS_PATH.exec(request.path);
  if (!turns || request.method !== "POST") return { matched: false };
  const body = requestBody(request);
  const executionBindingId = decodeURIComponent(turns[1]!);
  const threadId =
    typeof body.threadId === "string" ? body.threadId : MOCK_RUNTIME_FIXTURE_IDS.thread;
  const binding = { executionBindingId, executionPurpose: "preview" } as const;
  return {
    data: {
      created: true,
      message: {
        ...tenant,
        body: body.content,
        contentHash: "sha256:mock",
        createdAt: now,
        id: MOCK_RUNTIME_FIXTURE_IDS.message,
        object: "message",
        role: "user",
        runId: MOCK_RUNTIME_FIXTURE_IDS.run,
        sequence: 0,
        threadId,
      },
      run: {
        ...tenant,
        ...binding,
        attempt: 0,
        checkpointCount: 0,
        createdAt: now,
        executor: "mock",
        id: MOCK_RUNTIME_FIXTURE_IDS.run,
        object: "run",
        priority: 0,
        spanId: "0123456789abcdef",
        status: "queued",
        threadId,
        traceId: "0123456789abcdef0123456789abcdef",
        trigger: "user",
        updatedAt: now,
        version: 1,
      },
      thread: {
        ...tenant,
        ...binding,
        archived: false,
        channel: "api",
        createdAt: now,
        createdBy: { type: "service-account" },
        id: threadId,
        object: "thread",
        pinned: false,
        streamId: MOCK_RUNTIME_FIXTURE_IDS.stream,
        title: "Preview thread",
        updatedAt: now,
        version: 1,
      },
    },
    matched: true,
  };
}
