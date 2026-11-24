import { randomUUID } from "node:crypto";
import {
  TENANCY_API_ROUTES,
  decodeTenancyIdempotencyKey,
  decodeTenancyQuery,
  makeTenancyOpenApiSpec,
  tenancyRouteContract,
} from "@deployments-ai/api-contract";
import { PersistenceError } from "@deployments-ai/db";
import {
  createAgentEndpointOperations,
  type AgentEndpointOperation,
  type AgentEndpointOperations,
} from "./agent-endpoint-operations.ts";
import { fingerprint } from "./idempotency-fingerprint.ts";
import {
  ApiProblem,
  type AgentLifecycleApiService,
  type ApiIdentity,
  type ApiInvocation,
  type IdempotencyStore,
} from "./index.ts";
import { persistenceStatus } from "./persistence-error-status.ts";
import { permits } from "./scope-permissions.ts";

const AGENT_ROUTE_NAMES: ReadonlySet<string> = new Set(
  TENANCY_API_ROUTES.filter((route) => "tag" in route && route.tag === "Agents").map(
    (route) => route.name,
  ),
);

function agentOpenApiSpec() {
  const spec = makeTenancyOpenApiSpec();
  return {
    ...spec,
    info: { ...spec.info, title: "Deployments.ai Agent Lifecycle API" },
    paths: Object.fromEntries(
      Object.entries(spec.paths).filter(([path]) => path.startsWith("/v1/agent-")),
    ),
  };
}

const capabilities: Readonly<Record<string, string>> = {
  listAgentDefinitions: "agents:read",
  createAgentDefinition: "agents:write",
  getAgentDefinition: "agents:read",
  updateAgentDefinition: "agents:write",
  archiveAgentDefinition: "agents:write",
  listAgentReleases: "agents:read",
  publishAgentRelease: "agents:write",
  getAgentRelease: "agents:read",
  archiveAgentRelease: "agents:write",
  promoteAgentRelease: "agents:write",
  listAgentDeployments: "agents:read",
  createAgentDeployment: "agents:write",
  getAgentDeployment: "agents:read",
  updateAgentDeployment: "agents:write",
  stopAgentDeployment: "agents:write",
  startAgentDeploymentCanary: "agents:write",
  promoteAgentDeploymentCanary: "agents:write",
  abortAgentDeploymentCanary: "agents:write",
};

interface MatchedRoute {
  readonly id?: string;
  readonly name: keyof AgentEndpointOperations;
}

export interface CreateAgentApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly idempotency: IdempotencyStore;
  readonly requestId?: () => string;
  readonly service: AgentLifecycleApiService;
}

function matchRoute(method: string, pathname: string): MatchedRoute | undefined {
  for (const route of TENANCY_API_ROUTES) {
    if (route.method !== method || !AGENT_ROUTE_NAMES.has(route.name)) {
      continue;
    }
    const names: string[] = [];
    const pattern = route.path
      .split("/")
      .map((part) => {
        if (!part.startsWith(":")) return part;
        names.push(part.slice(1));
        return "([^/]+)";
      })
      .join("/");
    const match = pathname.match(new RegExp(`^${pattern}/?$`, "u"));
    if (!match) continue;
    const parameters = Object.fromEntries(
      names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
    );
    return {
      ...(parameters.id ? { id: parameters.id } : {}),
      name: route.name as keyof AgentEndpointOperations,
    };
  }
  return undefined;
}

async function body(request: Request, required: boolean) {
  const text = await request.text();
  if (!text && !required) return undefined;
  if (!text) {
    throw new ApiProblem(400, "invalid_request", "A JSON request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiProblem(400, "invalid_json", "The request body must be valid JSON.");
  }
}

function json(status: number, value: unknown, requestId: string) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}

function problem(cause: unknown, requestId: string) {
  const api =
    cause instanceof ApiProblem
      ? cause
      : cause instanceof PersistenceError
        ? new ApiProblem(persistenceStatus(cause), cause.code, cause.message)
        : undefined;
  const validation =
    !api &&
    cause instanceof Error &&
    (cause.name.includes("ParseError") || cause.name.includes("SchemaError") || "issue" in cause);
  const status = api?.status ?? (validation ? 422 : 500);
  const code = api?.code ?? (validation ? "validation_failed" : "internal_error");
  return new Response(
    JSON.stringify({
      type: `https://docs.deployments.ai/errors/${code.replaceAll("_", "-")}`,
      title:
        status === 500
          ? "Internal server error"
          : cause instanceof Error
            ? cause.message
            : "Request failed",
      status,
      code,
      requestId,
    }),
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/problem+json",
        "x-request-id": requestId,
      },
    },
  );
}

function singleScope(values: readonly string[] | "*" | undefined, label: string) {
  if (values === "*" || values?.length !== 1) {
    throw new ApiProblem(
      403,
      "ambiguous_tenant_scope",
      `The authenticated identity must resolve exactly one ${label}.`,
    );
  }
  return values[0]!;
}

async function execute(
  request: Request,
  identity: ApiIdentity,
  matched: MatchedRoute,
  operation: AgentEndpointOperation,
  idempotency: IdempotencyStore,
) {
  const contract = tenancyRouteContract(operation.routeName);
  const requiredCapability = capabilities[operation.routeName];
  if (!requiredCapability || !permits(identity.scopes, requiredCapability)) {
    throw new ApiProblem(
      403,
      "insufficient_scope",
      "The credential does not have the required capability scope.",
    );
  }
  const environmentId = request.headers.get("x-deployments-environment")?.trim() || undefined;
  if (!environmentId) {
    throw new ApiProblem(400, "missing_scope", "The environment scope header is required.");
  }
  if (identity.environmentIds !== "*" && !identity.environmentIds?.includes(environmentId)) {
    throw new ApiProblem(
      403,
      "environment_scope_violation",
      "The credential cannot access the requested environment.",
    );
  }

  const url = new URL(request.url);
  const query = contract.name.startsWith("list")
    ? (decodeTenancyQuery(
        operation.routeName,
        Object.fromEntries(url.searchParams),
      ) as ApiInvocation["query"])
    : {};
  const decodedBody = operation.decodeBody(
    contract.requestBody ? await body(request, contract.requestBodyRequired !== false) : undefined,
  );
  const idempotencyKey = contract.idempotent
    ? (decodeTenancyIdempotencyKey(
        operation.routeName,
        request.headers.get("idempotency-key") ?? undefined,
      ) as string)
    : undefined;
  const invocation: ApiInvocation = {
    body: decodedBody,
    identity,
    ...(matched.id ? { id: matched.id } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    query,
    scope: { environmentId },
  };
  const targetEnvironmentId = operation.targetEnvironmentId?.(decodedBody as never);
  if (
    targetEnvironmentId !== undefined &&
    identity.environmentIds !== "*" &&
    !identity.environmentIds?.includes(targetEnvironmentId)
  ) {
    throw new ApiProblem(
      403,
      "environment_scope_violation",
      "The credential cannot access the target environment.",
    );
  }
  const invoke = () => operation.operation(invocation);
  const result = idempotencyKey
    ? await idempotency.execute({
        fingerprint: fingerprint(operation.routeName, invocation),
        key: idempotencyKey,
        operation: invoke,
        organizationId: singleScope(identity.organizationIds, "organization"),
        principalId: identity.principalId,
      })
    : await invoke();
  return {
    result: operation.decodeResponse(result),
    status: operation.successStatus?.(result) ?? contract.successStatus,
  };
}

export function createAgentApi(options: CreateAgentApiOptions) {
  const operations = createAgentEndpointOperations(options.service);
  const nextRequestId = () => options.requestId?.() ?? `req_${randomUUID().replaceAll("-", "")}`;
  let openApiSpec: object | undefined;

  return async (request: Request): Promise<Response> => {
    const requestId = nextRequestId();
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(200, { service: "deployments-ai-api", status: "ok" }, requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/openapi.json") {
        return json(200, (openApiSpec ??= agentOpenApiSpec()), requestId);
      }
      const matched = matchRoute(request.method, url.pathname);
      if (!matched) {
        throw new ApiProblem(404, "route_not_found", "The requested API route does not exist.");
      }
      const identity = await options.authenticate(request);
      if (!identity) {
        throw new ApiProblem(401, "unauthorized", "A valid bearer credential is required.");
      }
      const result = await execute(
        request,
        identity,
        matched,
        operations[matched.name],
        options.idempotency,
      );
      return json(result.status, result.result, requestId);
    } catch (cause) {
      return problem(cause, requestId);
    }
  };
}
