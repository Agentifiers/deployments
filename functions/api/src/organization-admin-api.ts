import { createHmac, randomUUID } from "node:crypto";
import {
  FEATURE_NOT_IN_PLAN_TYPE,
  PUBLIC_ID_PATTERN,
  decodePublicResponse,
  planFeatureOfRoute,
  type PlanFeature,
  type PublicApiRouteContract,
  type PublicRouteName,
} from "@deployments-ai/api-contract";
import {
  PersistenceError,
  Ulid,
  organizationRoleAllows,
  organizationRolesAllowing,
  type FederationPageQuery,
  type IdempotencyPersistence,
  type OrganizationRoleAction,
} from "@deployments-ai/db";
import { Option, Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { persistenceStatus } from "./persistence-error-status.ts";
import { routePattern } from "./route-request-parsing.ts";
import { actsUnderOperatorAccess, permits, selectedOrganization } from "./scope-permissions.ts";

export class OrganizationAdminProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extensions: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "OrganizationAdminProblem";
  }
}

export interface OrganizationAdministrator {
  readonly operatorAccessGrantId?: Ulid;
  readonly organizationId: Ulid;
  readonly principalId: Ulid;
  readonly tokenSessionId?: Ulid;
}

export interface OrganizationAdminInvocation {
  readonly administrator: OrganizationAdministrator;
  readonly body: unknown;
  readonly id?: Ulid;
  readonly identity: ApiIdentity;
  /** The origin the caller reached, for URLs a response hands back to it. */
  readonly origin: string;
  readonly query: FederationPageQuery;
}

export interface OrganizationAdminApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
  /** The organization's plan features; omitted, every feature is enabled. */
  readonly features?: (organizationId: Ulid) => Promise<Readonly<Record<PlanFeature, boolean>>>;
  readonly requestId?: () => string;
}

type OrganizationAdminRoute = PublicApiRouteContract & {
  readonly name: PublicRouteName;
  readonly requiredAuthorization: string;
};

export interface OrganizationAdminFamily<Route extends OrganizationAdminRoute> {
  /** Names the family in problems and logs, such as "Identity federation". */
  readonly label: string;
  readonly operate: (
    routeName: Route["name"],
    invocation: OrganizationAdminInvocation,
  ) => Promise<unknown>;
  readonly routes: readonly Route[];
}

export function requireOrganizationRole(
  identity: ApiIdentity,
  action: OrganizationRoleAction,
  description: string,
) {
  if (
    !actsUnderOperatorAccess(identity, selectedOrganization(identity)) &&
    !organizationRoleAllows(identity.organizationRole, action)
  ) {
    throw new OrganizationAdminProblem(
      403,
      "insufficient_role",
      `${description} requires one of these organization roles: ${organizationRolesAllowing(action).join(", ")}.`,
    );
  }
}

export function requiredId(invocation: OrganizationAdminInvocation) {
  if (!invocation.id) {
    throw new OrganizationAdminProblem(404, "resource_not_found", "The resource was not found.");
  }
  return invocation.id;
}

const decodeUlid = Schema.decodeUnknownOption(Ulid);

function problem(
  status: number,
  code: string,
  detail: string,
  requestId: string,
  extensions: Readonly<Record<string, string>> = {},
) {
  return Response.json(
    {
      ...extensions,
      code,
      detail,
      requestId,
      status,
      title: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Request failed",
    },
    {
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
      status,
    },
  );
}

function errorResponse(cause: unknown, requestId: string, noun: string) {
  if (cause instanceof OrganizationAdminProblem) {
    return problem(cause.status, cause.code, cause.message, requestId, cause.extensions);
  }
  if (cause instanceof PersistenceError) {
    return problem(persistenceStatus(cause), cause.code, cause.message, requestId);
  }
  if (cause instanceof Schema.SchemaError || cause instanceof SyntaxError) {
    return problem(
      422,
      "validation_failed",
      "The request did not match the API contract.",
      requestId,
    );
  }
  if (cause instanceof URIError) {
    return problem(400, "invalid_path_parameter", "A path parameter is malformed.", requestId);
  }
  return problem(500, "internal_error", `The ${noun} request failed.`, requestId);
}

function organizationContext(request: Request, identity: ApiIdentity) {
  const raw = request.headers.get("x-deployments-organization")?.trim();
  if (!raw) {
    throw new OrganizationAdminProblem(
      400,
      "missing_organization_context",
      "x-deployments-organization is required.",
    );
  }
  const organizationId = decodeUlid(raw);
  if (!PUBLIC_ID_PATTERN.test(raw) || Option.isNone(organizationId)) {
    throw new OrganizationAdminProblem(
      400,
      "invalid_organization_context",
      "x-deployments-organization must be a canonical public ID.",
    );
  }
  const granted = identity.organizationIds;
  if (
    !actsUnderOperatorAccess(identity, organizationId.value) &&
    granted !== "*" &&
    !granted?.includes(organizationId.value)
  ) {
    throw new OrganizationAdminProblem(
      403,
      "organization_scope_violation",
      "The credential cannot access the requested organization.",
    );
  }
  return organizationId.value;
}

function pageQuery(url: URL) {
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  if (limit !== null && (!/^[1-9]\d*$/u.test(limit) || Number(limit) > 100)) {
    throw new OrganizationAdminProblem(
      400,
      "invalid_limit",
      "limit must be an integer from 1 through 100.",
    );
  }
  return {
    ...(cursor ? { cursor } : {}),
    ...(limit === null ? {} : { limit: Number(limit) }),
  };
}

/**
 * Serves organization administration routes that the owner and admin roles hold through
 * `identity.administer`, from authentication through the idempotent, contract-checked response.
 */
export function createOrganizationAdminApi<const Route extends OrganizationAdminRoute>(
  family: OrganizationAdminFamily<Route>,
  options: OrganizationAdminApiOptions,
) {
  const noun = family.label.toLowerCase();
  const matchers = family.routes.map((route) => ({ route, ...routePattern(route.path) }));

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const matcher = matchers.find(
      (candidate) => candidate.route.method === method && candidate.pattern.test(url.pathname),
    );
    if (!matcher) return undefined;
    const { route } = matcher;
    const requestId = options.requestId?.() ?? randomUUID();
    try {
      const identity = await options.authenticate(request);
      if (!identity) {
        return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
      }
      const organizationId = organizationContext(request, identity);
      if (!permits(identity.scopes, route.requiredAuthorization)) {
        throw new OrganizationAdminProblem(
          403,
          "insufficient_scope",
          `The credential does not have the required ${route.requiredAuthorization} capability.`,
        );
      }
      requireOrganizationRole(identity, "identity.administer", `${family.label} administration`);
      const feature = planFeatureOfRoute(route.name);
      if (feature && options.features && !(await options.features(organizationId))[feature]) {
        throw new OrganizationAdminProblem(
          403,
          "feature_not_in_plan",
          `${family.label} is not included in the organization's plan.`,
          { feature, type: FEATURE_NOT_IN_PLAN_TYPE },
        );
      }
      const principalId = Option.getOrThrowWith(
        decodeUlid(identity.principalId),
        () =>
          new OrganizationAdminProblem(
            403,
            "insufficient_role",
            `Only organization members administer ${noun}.`,
          ),
      );
      const rawId = matcher.pattern.exec(url.pathname)?.[1];
      const id =
        rawId === undefined
          ? undefined
          : Option.getOrThrowWith(
              decodeUlid(decodeURIComponent(rawId)),
              () =>
                new OrganizationAdminProblem(
                  404,
                  "resource_not_found",
                  "The resource was not found.",
                ),
            );
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (route.idempotency === "required" && !idempotencyKey) {
        return problem(400, "missing_idempotency_key", "Idempotency-Key is required.", requestId);
      }
      const text = route.method === "GET" ? "" : await request.text();
      const body: unknown = text ? JSON.parse(text) : undefined;
      const invocation: OrganizationAdminInvocation = {
        administrator: {
          ...(identity.operatorAccess
            ? { operatorAccessGrantId: identity.operatorAccess.grantId }
            : {}),
          organizationId,
          principalId,
          ...(identity.tokenSessionId ? { tokenSessionId: identity.tokenSessionId } : {}),
        },
        body,
        ...(id ? { id } : {}),
        identity,
        origin: url.origin,
        query: route.method === "GET" ? pageQuery(url) : {},
      };
      const operation = async () => {
        const result = await family.operate(route.name, invocation);
        try {
          return decodePublicResponse(route.name, result);
        } catch (cause) {
          throw new Error(`The ${noun} response broke its contract.`, { cause });
        }
      };
      const result =
        route.idempotency === "required" && idempotencyKey
          ? await options.idempotency.execute({
              fingerprint: createHmac(
                "sha256",
                JSON.stringify([identity.principalId, idempotencyKey]),
              )
                .update(
                  JSON.stringify({
                    body,
                    id: invocation.id,
                    method,
                    organizationId,
                    path: route.path,
                  }),
                )
                .digest("hex"),
              key: `${organizationId}:${idempotencyKey}`,
              operation,
              organizationId,
              principalId: identity.principalId,
            })
          : await operation();
      return Response.json(result, {
        headers: { "x-request-id": requestId },
        status: route.successStatus,
      });
    } catch (cause) {
      const response = errorResponse(cause, requestId, noun);
      if (response.status === 500) {
        console.error(`${family.label} API request failed.`, {
          ...errorLogFields(cause),
          requestId,
          route: route.name,
        });
      }
      return response;
    }
  };
}
