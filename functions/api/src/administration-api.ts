import { createHmac, randomUUID } from "node:crypto";
import {
  CREDENTIAL_REFERENCE_API_ROUTES,
  MODEL_API_ROUTES,
  PROVIDER_API_ROUTES,
  PublicId,
  TOOL_CATALOG_API_ROUTES,
  TOOLING_API_ROUTES,
  decodePublicRequest,
  decodePublicResponse,
  type CredentialReferenceApiRouteName,
  type ModelApiRouteName,
  type ProviderApiRouteName,
  type ToolCatalogApiRouteName,
  type ToolingApiRouteName,
} from "@deployments-ai/api-contract";
import {
  PersistenceError,
  recordApiCredentialUsageBestEffort,
  type ApiCredentialUsageRecorder,
  type CredentialReferenceOwnerType,
  type IdempotencyPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { parseCredentialReferenceOwnerType } from "./credential-reference-administration.ts";
import { errorLogFields } from "./error-log-fields.ts";
import type { ApiIdentity } from "./index.ts";
import { parseModelListFilters, type ModelListFilters } from "./model-catalog-listing.ts";
import { requestBody, routePattern } from "./route-request-parsing.ts";
import { permits } from "./scope-permissions.ts";
import { parseToolListFilters, type ToolListFilters } from "./tool-catalog-listing.ts";

export type AdministrationRouteName =
  | CredentialReferenceApiRouteName
  | ModelApiRouteName
  | ProviderApiRouteName
  | ToolCatalogApiRouteName
  | ToolingApiRouteName;

export interface AdministrationInvocation {
  readonly body: unknown;
  readonly id?: string;
  readonly identity?: ApiIdentity;
  readonly idempotencyKey?: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly modelFilters?: ModelListFilters;
    readonly ownerType?: CredentialReferenceOwnerType;
    readonly toolFilters?: ToolListFilters;
  };
  readonly scope: { readonly environmentId?: string };
}

export interface AdministrationApiService {
  readonly invoke: (
    routeName: AdministrationRouteName,
    invocation: AdministrationInvocation,
  ) => Promise<unknown>;
}

export interface CreateAdministrationApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly authorize: (
    invocation: AdministrationInvocation,
    routeName: AdministrationRouteName,
    mutation: boolean,
  ) => Promise<void>;
  readonly idempotency: IdempotencyPersistence;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly requestId?: () => string;
  readonly service: AdministrationApiService;
}

export const ADMINISTRATION_API_ROUTES = [
  ...PROVIDER_API_ROUTES,
  ...TOOLING_API_ROUTES,
  ...TOOL_CATALOG_API_ROUTES,
  ...MODEL_API_ROUTES,
  ...CREDENTIAL_REFERENCE_API_ROUTES,
];

type AdministrationRoute = (typeof ADMINISTRATION_API_ROUTES)[number];

export function administrationRequiredScope(route: AdministrationRoute): string {
  const group = route.tag === "Providers" ? "providers" : "tools";
  return (
    ("requiredAuthorization" in route && route.requiredAuthorization) ||
    `${group}:${route.method === "GET" ? "read" : "write"}`
  );
}

export function isAdministrationMutation(route: AdministrationRoute): boolean {
  return route.method !== "GET" && route.idempotency !== "none";
}

const matchers = ADMINISTRATION_API_ROUTES.map((route) => ({
  route,
  ...routePattern(route.path),
}));

function problem(status: number, code: string, detail: string, requestId: string) {
  return Response.json(
    {
      code,
      detail,
      requestId,
      status,
      title: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Request failed",
    },
    {
      status,
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
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
      readonly status: unknown;
      readonly code: unknown;
      readonly message?: unknown;
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
  return problem(500, "internal_error", "The administration request failed.", requestId);
}

export function createAdministrationApi(options: CreateAdministrationApiOptions) {
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
        console.error("API credential usage recording failed.", {
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
    const routeName = matcher.route.name as AdministrationRouteName;
    const match = matcher.pattern.exec(url.pathname)!;
    try {
      const params = Object.fromEntries(
        matcher.names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
      );
      const identity =
        matcher.route.authentication === "none" ? undefined : await options.authenticate(request);
      if (matcher.route.authentication !== "none" && !identity) {
        return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
      }
      if (identity && matcher.route.authentication !== "none") {
        await recordAuthenticatedUsage(identity, request);
        const required = administrationRequiredScope(matcher.route);
        if (!permits(identity.scopes, required)) {
          return problem(
            403,
            "insufficient_scope",
            `The credential does not have the required ${required} capability.`,
            requestId,
          );
        }
      }
      const rawEnvironmentId = request.headers.get("x-deployments-environment")?.trim();
      if (matcher.route.scopeHeaders === "environment" && !rawEnvironmentId) {
        return problem(
          400,
          "missing_environment_context",
          "x-deployments-environment is required.",
          requestId,
        );
      }
      let environmentId: string | undefined;
      if (rawEnvironmentId) {
        try {
          environmentId = Schema.decodeUnknownSync(PublicId)(rawEnvironmentId);
        } catch (cause) {
          if (cause instanceof Schema.SchemaError) {
            return problem(
              400,
              "invalid_environment_context",
              "x-deployments-environment must be a canonical public ID.",
              requestId,
            );
          }
          throw cause;
        }
      }
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
      const query = {
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        ...(routeName === "listModels"
          ? { modelFilters: parseModelListFilters(url.searchParams) }
          : {}),
        ...(routeName === "listCredentialReferences" && url.searchParams.has("ownerType")
          ? { ownerType: parseCredentialReferenceOwnerType(url.searchParams.get("ownerType")!) }
          : {}),
        ...(routeName === "listTools"
          ? { toolFilters: parseToolListFilters(url.searchParams) }
          : {}),
      };
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (matcher.route.idempotency === "required" && !idempotencyKey) {
        return problem(400, "missing_idempotency_key", "Idempotency-Key is required.", requestId);
      }
      let body: unknown;
      if ("requestBody" in matcher.route && matcher.route.requestBody) {
        try {
          const rawBody = await requestBody(request);
          body = decodePublicRequest(
            routeName,
            rawBody === undefined &&
              "requestBodyRequired" in matcher.route &&
              matcher.route.requestBodyRequired === false
              ? {}
              : rawBody,
          );
        } catch (cause) {
          if (
            cause instanceof Schema.SchemaError ||
            cause instanceof SyntaxError ||
            cause instanceof TypeError
          ) {
            return problem(
              422,
              "validation_failed",
              "The request did not match the API contract.",
              requestId,
            );
          }
          throw cause;
        }
      }
      const invocation: AdministrationInvocation = {
        body,
        ...(identity ? { identity } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...((params.id ?? params.providerKey ?? params.toolName)
          ? { id: params.id ?? params.providerKey ?? params.toolName }
          : {}),
        params,
        query,
        scope: environmentId ? { environmentId } : {},
      };
      const mutation = isAdministrationMutation(matcher.route);
      if (identity) await options.authorize(invocation, routeName, mutation);
      const operation = async () => {
        const result = await options.service.invoke(routeName, invocation);
        return decodePublicResponse(routeName, result);
      };
      const result =
        matcher.route.idempotency === "required" && idempotencyKey && identity
          ? await options.idempotency.execute({
              fingerprint: createHmac(
                "sha256",
                JSON.stringify([identity.principalId, idempotencyKey]),
              )
                .update(
                  JSON.stringify({
                    body,
                    environmentId,
                    method,
                    params,
                    path: matcher.route.path,
                  }),
                )
                .digest("hex"),
              key: environmentId ? `${environmentId}:${idempotencyKey}` : idempotencyKey,
              operation,
              principalId: identity.principalId,
            })
          : await operation();
      return Response.json(result, {
        status: matcher.route.successStatus,
        headers: { "x-request-id": requestId },
      });
    } catch (cause) {
      const response = errorResponse(cause, requestId);
      if (response.status === 500) {
        console.error("Administration API request failed.", {
          ...errorLogFields(cause),
          requestId,
          route: routeName,
        });
      }
      return response;
    }
  };
}
