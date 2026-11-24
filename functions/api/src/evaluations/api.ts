import { createHash, randomUUID } from "node:crypto";
import {
  decodePublicRequest,
  decodePublicResponse,
  EVALUATION_API_ROUTES,
  type EvaluationApiRouteName,
  type PublicApiQueryParameter,
} from "@deployments-ai/api-contract";
import {
  PersistenceError,
  recordApiCredentialUsageBestEffort,
  Ulid,
  type ApiCredentialUsageRecorder,
  type IdempotencyPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { routePattern } from "../route-request-parsing.ts";
import { actsUnderOperatorAccess, allowed, permits } from "../scope-permissions.ts";
import type {
  EvaluationApiInvocation,
  EvaluationApiService,
  EvaluationEnvironmentResolver,
} from "./service-contracts.ts";
import { EvaluationApiProblem } from "./service-support.ts";

export interface CreateEvaluationApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly idempotency: IdempotencyPersistence;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  readonly resolveEnvironment: EvaluationEnvironmentResolver;
  readonly service: EvaluationApiService;
}

const decodeUlid = Schema.decodeUnknownSync(Ulid);

const matchers = EVALUATION_API_ROUTES.map((route) => ({ route, ...routePattern(route.path) }));

const TITLES: Readonly<Record<number, string>> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  503: "Evaluations unavailable",
};

function problem(status: number, code: string, detail: string, requestId: string) {
  return Response.json(
    { code, detail, requestId, status, title: TITLES[status] ?? "Request failed" },
    {
      status,
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
    },
  );
}

/** A response that failed contract decoding is a server defect, not a client error. */
class EvaluationResponseContractError extends Error {}

const PERSISTENCE_STATUS = {
  "invalid-input": 400,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  unprocessable: 422,
  internal: 500,
} as const;

function errorResponse(cause: unknown, requestId: string) {
  if (cause instanceof PersistenceError) {
    return problem(PERSISTENCE_STATUS[cause.kind], cause.code, cause.message, requestId);
  }
  if (cause instanceof EvaluationApiProblem) {
    return problem(cause.status, cause.code, cause.message, requestId);
  }
  if (cause instanceof URIError) {
    return problem(400, "invalid_path_parameter", "A path parameter is malformed.", requestId);
  }
  if (cause instanceof Schema.SchemaError || cause instanceof SyntaxError) {
    return problem(
      422,
      "validation_failed",
      cause instanceof Schema.SchemaError
        ? cause.message
        : "The request did not match the Evaluations API contract.",
      requestId,
    );
  }
  console.error("Evaluation API request failed.", {
    error: cause instanceof Error ? cause.message : "Unknown error.",
    requestId,
  });
  return problem(500, "internal_error", "The evaluation request failed.", requestId);
}

function scopeHeader(request: Request, name: string) {
  const raw = request.headers.get(name)?.trim();
  return raw ? decodeUlid(raw) : undefined;
}

/** Validates the route's declared query parameters against their contract schemas. */
function parseQuery(
  url: URL,
  parameters: readonly PublicApiQueryParameter[],
): EvaluationApiInvocation["query"] {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && (!/^[1-9]\d{0,2}$/u.test(rawLimit) || Number(rawLimit) > 100)) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_limit",
      "limit must be an integer from 1 through 100.",
    );
  }
  const filters: Record<string, string> = {};
  for (const { name, schema } of parameters) {
    const value = url.searchParams.get(name) || undefined;
    if (value === undefined || name === "limit") continue;
    const code = `invalid_${name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new PersistenceError(
        "invalid-input",
        code,
        `${name} must be one of ${schema.enum.join(", ")}.`,
      );
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      throw new PersistenceError("invalid-input", code, `${name} must be a public ID.`);
    }
    filters[name] = value;
  }
  return {
    ...(filters as Omit<EvaluationApiInvocation["query"], "limit">),
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
  };
}

async function requestBody(request: Request) {
  const text = await request.text();
  return text ? JSON.parse(text) : undefined;
}

/**
 * Environment-scoped Evaluations API: tenant headers, observability read/write scopes, tenant
 * grants, an active environment, and Idempotency-Key replay for every mutation.
 */
export function createEvaluationApi(options: CreateEvaluationApiOptions) {
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
        console.error("Evaluation API credential usage recording failed.", {
          error: error instanceof Error ? error.message : "Unknown recorder error.",
        });
      },
    );
  };

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const matcher = matchers.find(
      (candidate) => candidate.route.method === method && candidate.pattern.test(url.pathname),
    );
    if (!matcher) return undefined;
    const requestId = options.requestId?.() ?? randomUUID();
    const { route } = matcher;
    const routeName: EvaluationApiRouteName = route.name;
    try {
      const organizationId = scopeHeader(request, "x-deployments-organization");
      if (!organizationId) {
        return problem(
          400,
          "missing_organization_context",
          "x-deployments-organization is required.",
          requestId,
        );
      }
      const projectId = scopeHeader(request, "x-deployments-project");
      if (!projectId) {
        return problem(
          400,
          "missing_project_context",
          "x-deployments-project is required.",
          requestId,
        );
      }
      const environmentId = scopeHeader(request, "x-deployments-environment");
      if (!environmentId) {
        return problem(
          400,
          "missing_environment_context",
          "x-deployments-environment is required.",
          requestId,
        );
      }
      const identity = await options.authenticate(request);
      if (!identity) {
        return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
      }
      await recordAuthenticatedUsage(identity, request);
      const requiredAuthorization = route.requiredAuthorization ?? "platform:admin";
      if (!permits(identity.scopes, requiredAuthorization)) {
        return problem(
          403,
          "insufficient_scope",
          `The credential does not have the required ${requiredAuthorization} capability.`,
          requestId,
        );
      }
      const platformAdministrator = actsUnderOperatorAccess(identity, organizationId);
      const violations = [
        ["organization", identity.organizationIds, organizationId],
        ["project", identity.projectIds, projectId],
        ["environment", identity.environmentIds, environmentId],
      ] as const;
      for (const [kind, grants, id] of violations) {
        if (!platformAdministrator && !allowed(grants, id)) {
          return problem(
            403,
            `${kind}_scope_violation`,
            `The credential cannot access the requested ${kind}.`,
            requestId,
          );
        }
      }
      const environment = await options.resolveEnvironment({
        environmentId,
        identity,
        organizationId,
        projectId,
      });
      if (
        !environment ||
        environment.id !== environmentId ||
        environment.organizationId !== organizationId ||
        environment.projectId !== projectId
      ) {
        return problem(404, "environment_not_found", "Environment was not found.", requestId);
      }
      if (environment.status !== "active") {
        return problem(409, "environment_archived", "The environment is not active.", requestId);
      }
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (route.idempotency === "required" && !idempotencyKey) {
        return problem(400, "missing_idempotency_key", "Idempotency-Key is required.", requestId);
      }
      const params = Object.fromEntries(
        matcher.names.map((name, index) => [
          name,
          decodeURIComponent(matcher.pattern.exec(url.pathname)![index + 1]!),
        ]),
      );
      const body =
        "requestBody" in route && route.requestBody
          ? decodePublicRequest(routeName, await requestBody(request))
          : undefined;
      const scope = { environmentId, organizationId, projectId };
      const invocation: EvaluationApiInvocation = {
        body,
        identity: { ...identity, environmentIds: [environmentId], projectIds: [projectId] },
        ...(idempotencyKey ? { idempotencyKey } : {}),
        params,
        query: parseQuery(url, "queryParameters" in route ? route.queryParameters : []),
        scope,
      };
      const operation = async () => {
        const result = await options.service.invoke(routeName, invocation);
        try {
          return decodePublicResponse(routeName, result);
        } catch (cause) {
          throw new EvaluationResponseContractError(
            cause instanceof Error ? cause.message : "Invalid evaluation response.",
          );
        }
      };
      const result =
        route.idempotency === "required" && idempotencyKey
          ? await options.idempotency.execute({
              fingerprint: createHash("sha256")
                .update(JSON.stringify({ body, method, params, path: route.path, scope }))
                .digest("hex"),
              key: `${organizationId}:${projectId}:${environmentId}:${idempotencyKey}`,
              operation,
              organizationId,
              principalId: identity.principalId,
            })
          : await operation();
      return Response.json(result, {
        status: route.successStatus,
        headers: { "x-request-id": requestId },
      });
    } catch (cause) {
      return errorResponse(cause, requestId);
    }
  };
}
