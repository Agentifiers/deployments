import { randomUUID } from "node:crypto";
import { OBSERVABILITY_API_ROUTES } from "@deployments-ai/api-contract";
import {
  recordApiCredentialUsageBestEffort,
  type ApiCredentialUsageRecorder,
} from "@deployments-ai/db";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { queryParameterProblem } from "./observability-query-parameters.ts";
import { routePattern } from "./route-request-parsing.ts";
import { allowed, permits } from "./scope-permissions.ts";

export interface CreateObservabilityApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly available?: boolean;
  readonly baseUrl: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  readonly serviceToken: () => Promise<string>;
}

const matchers = OBSERVABILITY_API_ROUTES.map((route) => ({
  pattern: routePattern(route.path).pattern,
  route,
}));

function problem(status: number, code: string, detail: string, requestId: string) {
  return Response.json(
    {
      code,
      detail,
      requestId,
      status,
      title:
        status === 401
          ? "Unauthorized"
          : status === 403
            ? "Forbidden"
            : status === 503
              ? "Observability unavailable"
              : "Invalid observability request",
    },
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": requestId,
      },
    },
  );
}

function scopeHeader(request: Request, name: string) {
  const value = request.headers.get(name)?.trim();
  return value || undefined;
}

function boundedScope(
  requested: string | undefined,
  grants: readonly string[] | "*" | undefined,
  kind: "project" | "environment",
  requestId: string,
): string | Response | undefined {
  if (requested) {
    return allowed(grants, requested)
      ? requested
      : problem(
          403,
          `${kind}_scope_violation`,
          `The credential cannot access this ${kind}.`,
          requestId,
        );
  }
  if (grants === "*" || grants === undefined) return undefined;
  if (grants.length === 1) return grants[0];
  return problem(
    400,
    `missing_${kind}_context`,
    `x-deployments-${kind} is required when the credential does not identify exactly one ${kind}.`,
    requestId,
  );
}

export function createObservabilityApi(options: CreateObservabilityApiOptions) {
  const fetch = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  let serviceToken: Promise<string> | undefined;
  const recordAuthenticatedUsage = async (identity: ApiIdentity, request: Request) => {
    if (
      identity.authentication !== "api-credential" ||
      !identity.apiCredentialId ||
      identity.organizationIds === "*" ||
      identity.organizationIds?.length !== 1 ||
      identity.projectIds === "*" ||
      identity.projectIds?.length !== 1 ||
      identity.environmentIds === "*" ||
      identity.environmentIds?.length !== 1
    ) {
      return;
    }
    await recordApiCredentialUsageBestEffort(
      options.recordApiCredentialUsage,
      {
        apiCredentialId: identity.apiCredentialId,
        environmentId: identity.environmentIds[0]!,
        organizationId: identity.organizationIds[0]!,
        outcome: "allowed",
        projectId: identity.projectIds[0]!,
        requestMethod: request.method,
        requestPath: new URL(request.url).pathname,
      },
      (error) => {
        console.error("Observability API credential usage recording failed.", {
          error: error instanceof Error ? error.message : "Unknown recorder error.",
        });
      },
    );
  };
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const matcher = matchers.find(
      ({ pattern, route }) => route.method === request.method && pattern.test(url.pathname),
    );
    if (!matcher) return undefined;
    const requestId = options.requestId?.() ?? randomUUID();
    const organizationId = scopeHeader(request, "x-deployments-organization");
    if (!organizationId) {
      return problem(
        400,
        "missing_organization_context",
        "x-deployments-organization is required.",
        requestId,
      );
    }
    const identity = await options.authenticate(request);
    if (!identity)
      return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
    if (!permits(identity.scopes, matcher.route.requiredAuthorization)) {
      return problem(
        403,
        "insufficient_scope",
        "The credential lacks observability:read.",
        requestId,
      );
    }
    if (!allowed(identity.organizationIds, organizationId)) {
      return problem(
        403,
        "organization_scope_violation",
        "The credential cannot access this organization.",
        requestId,
      );
    }
    const projectId = boundedScope(
      scopeHeader(request, "x-deployments-project"),
      identity.projectIds,
      "project",
      requestId,
    );
    if (projectId instanceof Response) return projectId;
    const environmentId = boundedScope(
      scopeHeader(request, "x-deployments-environment"),
      identity.environmentIds,
      "environment",
      requestId,
    );
    if (environmentId instanceof Response) return environmentId;
    const requestedWorkspaceId = scopeHeader(request, "x-deployments-workspace");
    if (
      identity.workspaceId &&
      requestedWorkspaceId &&
      identity.workspaceId !== requestedWorkspaceId
    ) {
      return problem(
        403,
        "workspace_scope_violation",
        "The credential cannot access this workspace.",
        requestId,
      );
    }
    const workspaceId = identity.workspaceId ?? requestedWorkspaceId;
    const invalidQuery = queryParameterProblem(
      url.searchParams,
      "queryParameters" in matcher.route ? matcher.route.queryParameters : undefined,
    );
    if (invalidQuery) return problem(400, "invalid_query_parameter", invalidQuery, requestId);

    await recordAuthenticatedUsage(identity, request);

    if (options.available === false) {
      return problem(
        503,
        "observability_unavailable",
        "The observability hot plane is not enabled.",
        requestId,
      );
    }

    const targetPath = url.pathname.replace(/^\/v1\/observability/u, "") || "/";
    const target = new URL(`${baseUrl}${targetPath}`);
    target.search = url.search;
    try {
      serviceToken ??= options.serviceToken().catch((cause: unknown) => {
        serviceToken = undefined;
        throw cause;
      });
      const headers = new Headers({
        authorization: `Bearer ${await serviceToken}`,
        "x-deployments-organization": organizationId,
        "x-request-id": requestId,
      });
      if (projectId) headers.set("x-deployments-project", projectId);
      if (environmentId) headers.set("x-deployments-environment", environmentId);
      if (workspaceId) headers.set("x-deployments-workspace", workspaceId);
      if (request.headers.get("content-type")) {
        headers.set("content-type", request.headers.get("content-type")!);
      }
      const upstream = await fetch(target, {
        body: request.method === "GET" ? undefined : await request.arrayBuffer(),
        headers,
        method: request.method,
        signal: AbortSignal.timeout(27_000),
      });
      const responseHeaders = new Headers({
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "x-request-id": requestId,
      });
      return new Response(await upstream.arrayBuffer(), {
        headers: responseHeaders,
        status: upstream.status,
      });
    } catch (cause) {
      console.error("Observability hot-plane request failed.", {
        cause: cause instanceof Error ? cause.message : "unknown",
        requestId,
      });
      return problem(
        503,
        "observability_unavailable",
        "The observability hot plane is unavailable.",
        requestId,
      );
    }
  };
}

export function createUnavailableObservabilityApi(
  options: Pick<
    CreateObservabilityApiOptions,
    "authenticate" | "recordApiCredentialUsage" | "requestId"
  >,
) {
  return createObservabilityApi({
    ...options,
    available: false,
    baseUrl: "http://observability-disabled.invalid",
    serviceToken: async () => "disabled",
  });
}
