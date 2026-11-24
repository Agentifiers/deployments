import { createHash, randomUUID } from "node:crypto";
import {
  BRAIN_API_ROUTES,
  decodePublicRequest,
  decodePublicResponse,
  PublicId,
  type BrainApiRouteName,
} from "@deployments-ai/api-contract";
import {
  DatabaseError,
  PersistenceError,
  type ApiCredentialUsageRecorder,
  type IdempotencyPersistence,
  recordApiCredentialUsageBestEffort,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { requestBody, routePattern } from "../route-request-parsing.ts";
import { permits } from "../scope-permissions.ts";
import { publicBrainResponse } from "./public-responses.ts";
import type { BrainApiInvocation, BrainApiService } from "./service-contracts.ts";

export interface CreateBrainApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly idempotency: IdempotencyPersistence;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  readonly service: BrainApiService;
}

const implementedRoutes = new Set<BrainApiRouteName>([
  "archiveBrain",
  "askBrains",
  "captureBrainDocument",
  "completeBrainUpload",
  "createBrain",
  "createBrainGrant",
  "createBrainMount",
  "createBrainSource",
  "createBrainUploadTicket",
  "eraseBrain",
  "getBrain",
  "getBrainErasure",
  "getBrainDocument",
  "getBrainEntity",
  "getBrainUploadTicket",
  "listBrainIndexHealth",
  "listBrainGrants",
  "listBrainMounts",
  "listBrainReviewItems",
  "listBrains",
  "listBrainSources",
  "recordBrainFeedback",
  "resolveBrainReviewItem",
  "revokeBrainGrant",
  "revokeBrainMount",
  "searchBrains",
  "updateBrain",
  "uploadBrainContent",
]);

const matchers = BRAIN_API_ROUTES.filter((route) => implementedRoutes.has(route.name)).map(
  (route) => ({ route, ...routePattern(route.path) }),
);

/**
 * API Gateway and the Brain Lambda stop every request at 29 s
 * (infrastructure/modules/platform-api/gateway.tf and governance-runtime.tf), so an unfinished
 * query older than its lease was abandoned. Running a query again repeats only its read.
 */
const ABANDONED_QUERY_LEASE_SECONDS: Partial<Record<BrainApiRouteName, number>> = {
  askBrains: 60,
  searchBrains: 60,
};

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
            : status === 404
              ? "Not found"
              : "Request failed",
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

function errorResponse(cause: unknown, requestId: string) {
  if (cause instanceof PersistenceError) {
    const status = {
      "invalid-input": 400,
      forbidden: 403,
      "not-found": 404,
      conflict: 409,
      unprocessable: 422,
      internal: 500,
    }[cause.kind];
    return problem(status, cause.code, cause.message, requestId);
  }
  if (cause && typeof cause === "object" && "status" in cause && "code" in cause) {
    const value = cause as {
      readonly code: unknown;
      readonly message?: unknown;
      readonly status: unknown;
    };
    if (typeof value.status === "number" && typeof value.code === "string") {
      return problem(
        value.status,
        value.code,
        typeof value.message === "string" ? value.message : value.code,
        requestId,
      );
    }
  }
  if (cause instanceof URIError) {
    return problem(400, "invalid_path_parameter", "A path parameter is malformed.", requestId);
  }
  if (
    cause instanceof Schema.SchemaError ||
    cause instanceof SyntaxError ||
    cause instanceof TypeError
  ) {
    return problem(
      422,
      "validation_failed",
      "The request did not match the Brain API contract.",
      requestId,
    );
  }
  return problem(500, "internal_error", "The Brain request failed.", requestId);
}

function boundedName(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 128) : undefined;
}

function errorName(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { readonly _tag?: unknown; readonly name?: unknown };
  return boundedName(candidate._tag) ?? boundedName(candidate.name);
}

// Only static identifiers: error messages, request bodies, and record keys may carry tenant content.
function unexpectedFailureLogContext(cause: unknown) {
  const value =
    cause && typeof cause === "object" ? (cause as Readonly<Record<string, unknown>>) : {};
  const errorCode = boundedName(value.code);
  const causeType = errorName(value.cause);
  return {
    errorType: errorName(cause) ?? typeof cause,
    ...(errorCode ? { errorCode } : {}),
    ...(causeType ? { causeType } : {}),
    ...(cause instanceof DatabaseError
      ? {
          databaseOperation: boundedName(cause.operation),
          databaseReason: cause.reason ?? "unknown",
        }
      : {}),
  };
}

function parseOrganization(request: Request) {
  const raw = request.headers.get("x-deployments-organization")?.trim();
  if (!raw) return undefined;
  return Schema.decodeUnknownSync(PublicId)(raw);
}

function parseTenantContext(request: Request, kind: "environment" | "project") {
  const raw = request.headers.get(`x-deployments-${kind}`)?.trim();
  if (!raw) return undefined;
  return Schema.decodeUnknownSync(PublicId)(raw);
}

function identityAllows(grants: readonly string[] | "*" | undefined, id: string) {
  return grants === undefined || grants === "*" || grants.includes(id);
}

function parseQuery(url: URL): BrainApiInvocation["query"] {
  const rawLimit = url.searchParams.get("limit");
  if (
    rawLimit !== null &&
    (!/^[1-9]\d*$/u.test(rawLimit) ||
      !Number.isSafeInteger(Number(rawLimit)) ||
      Number(rawLimit) > 100)
  ) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_limit",
      "limit must be an integer from 1 through 100.",
    );
  }
  const rawStatus = url.searchParams.get("status");
  if (rawStatus && rawStatus !== "active" && rawStatus !== "archived" && rawStatus !== "erasing") {
    throw new PersistenceError(
      "invalid-input",
      "invalid_brain_status",
      "status must be active, archived, or erasing.",
    );
  }
  const status =
    rawStatus === "active" || rawStatus === "archived" || rawStatus === "erasing"
      ? rawStatus
      : undefined;
  return {
    ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
    ...(status ? { status } : {}),
  };
}

export function createBrainApi(options: CreateBrainApiOptions) {
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
        console.error("Brain API credential usage recording failed.", {
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
    const match = matcher.pattern.exec(url.pathname)!;

    try {
      const routeName = matcher.route.name;
      const organizationId = parseOrganization(request);
      if (!organizationId) {
        return problem(
          400,
          "missing_organization_context",
          "x-deployments-organization is required.",
          requestId,
        );
      }
      const requiresTenantContext = matcher.route.scopeHeaders === "tenant";
      const projectId = requiresTenantContext ? parseTenantContext(request, "project") : undefined;
      if (requiresTenantContext && !projectId) {
        return problem(
          400,
          "missing_project_context",
          "x-deployments-project is required.",
          requestId,
        );
      }
      const environmentId = requiresTenantContext
        ? parseTenantContext(request, "environment")
        : undefined;
      if (requiresTenantContext && !environmentId) {
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
      if (!permits(identity.scopes, matcher.route.requiredAuthorization)) {
        return problem(
          403,
          "insufficient_scope",
          `The credential does not have the required ${matcher.route.requiredAuthorization} capability.`,
          requestId,
        );
      }
      if (projectId && !identityAllows(identity.projectIds, projectId)) {
        return problem(
          403,
          "project_scope_violation",
          "The credential cannot access the requested project.",
          requestId,
        );
      }
      if (environmentId && !identityAllows(identity.environmentIds, environmentId)) {
        return problem(
          403,
          "environment_scope_violation",
          "The credential cannot access the requested environment.",
          requestId,
        );
      }
      const scopedIdentity =
        projectId && environmentId
          ? { ...identity, environmentIds: [environmentId], projectIds: [projectId] }
          : identity;
      if (
        identity.organizationIds !== undefined &&
        identity.organizationIds !== "*" &&
        !identity.organizationIds.includes(organizationId)
      ) {
        return problem(
          403,
          "organization_scope_violation",
          "The credential cannot access the requested organization.",
          requestId,
        );
      }
      const params = Object.fromEntries(
        matcher.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
      );
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (matcher.route.idempotency === "required" && !idempotencyKey) {
        return problem(400, "missing_idempotency_key", "Idempotency-Key is required.", requestId);
      }
      const body =
        "requestBody" in matcher.route && matcher.route.requestBody
          ? decodePublicRequest(routeName, await requestBody(request))
          : undefined;
      const invocation: BrainApiInvocation = {
        body,
        identity: scopedIdentity,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        organizationId,
        params,
        query: parseQuery(url),
        ...(routeName === "uploadBrainContent" ? { rawRequest: request } : {}),
      };
      const operation = async () =>
        decodePublicResponse(
          routeName,
          publicBrainResponse(routeName, await options.service.invoke(routeName, invocation)),
        );
      const result =
        matcher.route.idempotency === "required" && idempotencyKey
          ? await options.idempotency.execute({
              fingerprint: createHash("sha256")
                .update(
                  JSON.stringify({
                    body,
                    ...(routeName === "uploadBrainContent"
                      ? {
                          contentLength: request.headers.get("content-length"),
                          contentType: request.headers.get("content-type"),
                        }
                      : {}),
                    method,
                    organizationId,
                    ...(projectId && environmentId ? { environmentId, projectId } : {}),
                    params,
                    path: matcher.route.path,
                  }),
                )
                .digest("hex"),
              key:
                projectId && environmentId
                  ? `${organizationId}:${projectId}:${environmentId}:${idempotencyKey}`
                  : `${organizationId}:${idempotencyKey}`,
              operation,
              ...(ABANDONED_QUERY_LEASE_SECONDS[routeName]
                ? { inProgressLeaseSeconds: ABANDONED_QUERY_LEASE_SECONDS[routeName] }
                : {}),
              organizationId,
              principalId: scopedIdentity.principalId,
            })
          : await operation();
      return Response.json(result, {
        status: matcher.route.successStatus,
        headers: { "x-request-id": requestId },
      });
    } catch (cause) {
      const response = errorResponse(cause, requestId);
      if (response.status >= 500) {
        console.error("Brain API request failed.", {
          requestId,
          route: matcher.route.name,
          status: response.status,
          ...unexpectedFailureLogContext(cause),
        });
      }
      return response;
    }
  };
}
