import { type PlatformRequest } from "./index.ts";

export interface CreateMockPlatformSdkOptions {
  readonly now?: () => Date;
}

export const MOCK_RUNTIME_FIXTURE_IDS = {
  agentDeployment: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  agentRelease: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
  approval: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
  artifact: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  heartbeat: "01ARZ3NDEKTSV4RRFFQ69G5FBA",
  heartbeatRun: "01ARZ3NDEKTSV4RRFFQ69G5FBB",
  message: "01ARZ3NDEKTSV4RRFFQ69G5FBE",
  messagePublication: "01ARZ3NDEKTSV4RRFFQ69G5FBR",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  preview: "01ARZ3NDEKTSV4RRFFQ69G5FBS",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  run: "01ARZ3NDEKTSV4RRFFQ69G5FBF",
  schedule: "01ARZ3NDEKTSV4RRFFQ69G5FBC",
  scheduleFire: "01ARZ3NDEKTSV4RRFFQ69G5FBD",
  session: "01ARZ3NDEKTSV4RRFFQ69G5FBG",
  stream: "01ARZ3NDEKTSV4RRFFQ69G5FBH",
  thread: "01ARZ3NDEKTSV4RRFFQ69G5FBJ",
  toolCall: "01ARZ3NDEKTSV4RRFFQ69G5FBK",
  workflowApproval: "01ARZ3NDEKTSV4RRFFQ69G5FBL",
  workflowDefinition: "01ARZ3NDEKTSV4RRFFQ69G5FBM",
  workflowExecution: "01ARZ3NDEKTSV4RRFFQ69G5FBN",
  workflowRelease: "01ARZ3NDEKTSV4RRFFQ69G5FBP",
  workflowStepAttempt: "01ARZ3NDEKTSV4RRFFQ69G5FBQ",
} as const;

export function resourceName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? "resource";
}

export function mockId(resource: string, suffix: string): string {
  return `${resource.replaceAll(/[^a-z0-9]+/giu, "_").replace(/^_|_$/gu, "")}_${suffix}`;
}

export const MOCK_TARGET_ACTIONS = new Set([
  "access",
  "access-url",
  "approve",
  "cancel",
  "disable",
  "enable",
  "forward",
  "pause",
  "refresh",
  "reject",
  "remove",
  "replay",
  "reply",
  "reply-all",
  "reprocess",
  "result",
  "retry",
  "revoke",
  "resume",
  "review",
  "rollback",
  "rotate",
  "rotate-secret",
  "send",
  "submit",
  "test",
  "verify",
]);

export function mockRoute(request: PlatformRequest): { resource: string; targetId?: string } {
  const segments = request.path.split("/").filter(Boolean);
  const last = segments.at(-1) ?? "resource";
  const parentPath = `/${segments.slice(0, -1).join("/")}`;
  const nestedRawAction = segments.at(-2) === "raw" && ["access", "reprocess"].includes(last);
  const actionTarget = nestedRawAction
    ? segments.at(-3)
    : segments.length >= 4 && MOCK_TARGET_ACTIONS.has(last)
      ? segments.at(-2)
      : undefined;
  const directTarget = MOCK_LIST_PATHS.has(parentPath) ? last : undefined;
  const targetId = actionTarget ?? directTarget;
  if (targetId) {
    const resourceIndex = actionTarget ? (nestedRawAction ? -4 : -3) : -2;
    return {
      resource: segments.at(resourceIndex) ?? resourceName(request.path),
      targetId: decodeURIComponent(targetId),
    };
  }
  if (request.method === "GET" && mockResponseKind(request) === "detail" && segments.length === 2) {
    return { resource: last, targetId: decodeURIComponent(last) };
  }
  return { resource: last };
}

export function mockItem(
  request: PlatformRequest,
  suffix: string,
  now: string,
): Record<string, unknown> {
  const body =
    typeof request.body === "object" && request.body !== null
      ? (request.body as Record<string, unknown>)
      : {};
  const { resource, targetId } = mockRoute(request);
  return {
    id:
      typeof body.id === "string"
        ? body.id
        : targetId && mockResponseKind(request) === "detail"
          ? targetId
          : mockId(resource, suffix),
    name: typeof body.name === "string" ? body.name : `${resource.replaceAll("-", " ")} ${suffix}`,
    status: request.method === "DELETE" ? "archived" : "ready",
    ...request.context,
    ...body,
    createdAt: now,
    updatedAt: now,
  };
}

export const MOCK_LIST_PATHS = new Set([
  "/v1/agent-email/domains",
  "/v1/agent-email/inboxes",
  "/v1/agent-email/placements",
  "/v1/agent-email/suppressions",
  "/v1/agent-profiles",
  "/v1/agents",
  "/v1/api-key-usage",
  "/v1/api-keys",
  "/v1/approvals",
  "/v1/artifacts",
  "/v1/audit-events",
  "/v1/budgets",
  "/v1/connection-grants",
  "/v1/connections",
  "/v1/costs",
  "/v1/credential-references",
  "/v1/credentials",
  "/v1/deployments",
  "/v1/environments",
  "/v1/heartbeats",
  "/v1/inbox-domains",
  "/v1/inbox-drafts",
  "/v1/inboxes",
  "/v1/invitations",
  "/v1/members",
  "/v1/memory",
  "/v1/memory/policies",
  "/v1/memory/review-items",
  "/v1/memory-spaces",
  "/v1/messages",
  "/v1/mcp-connections",
  "/v1/mcp-servers",
  "/v1/oauth-apps",
  "/v1/organizations",
  "/v1/projects",
  "/v1/providers",
  "/v1/releases",
  "/v1/runs",
  "/v1/schedules",
  "/v1/service-accounts",
  "/v1/threads",
  "/v1/tool-calls",
  "/v1/extensions",
  "/v1/tool-policies",
  "/v1/tools",
  "/v1/spend",
  "/v1/usage",
  "/v1/webhook-deliveries",
  "/v1/webhooks",
  "/v1/workflow-executions",
]);

export function mockResponseKind(request: PlatformRequest): "detail" | "list" {
  if (
    request.path === "/v1/memory/search" ||
    request.path === "/v1/memory/evidence/strategy-search"
  )
    return "list";
  if (/^\/v1\/agent-email\/inboxes\/[^/]+\/(?:drafts|messages|threads)$/u.test(request.path))
    return "list";
  if (/^\/v1\/agent-email\/inboxes\/[^/]+\/(?:messages|threads)\/search$/u.test(request.path))
    return "list";
  if (/^\/v1\/inboxes\/[^/]+\/messages$/u.test(request.path)) return "list";
  if (/^\/v1\/connections\/[^/]+\/capabilities$/u.test(request.path)) return "list";
  if (/^\/v1\/budgets\/[^/]+\/periods$/u.test(request.path)) return "list";
  if (/^\/v1\/webhook-deliveries\/[^/]+\/attempts$/u.test(request.path)) return "list";
  return MOCK_LIST_PATHS.has(request.path) ? "list" : "detail";
}
