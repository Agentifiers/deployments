import { randomUUID } from "node:crypto";
import {
  decodePublicResponse,
  SYSTEM_ALARM_STATES,
  SYSTEM_OBSERVER_ROUTES,
  SYSTEM_OPERATOR_API_ROUTES,
  SYSTEM_SERVICE_OPERATION_GRANTS,
  SYSTEM_SERVICE_PATH_PREFIX,
  type SystemServiceGrant,
} from "@deployments-ai/api-contract";
import { PersistenceError } from "@deployments-ai/db";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { httpApiV2IamUserArn } from "../lambda.ts";
import { isPlatformAdministrator } from "../scope-permissions.ts";
import type { IamRole } from "./iam-roles.ts";
import { isSystemObserver } from "./observer.ts";
import { resolveSystemService, type SystemServicePrincipals } from "./service-principals.ts";
import {
  SystemOperatorProblem,
  type SystemOperatorQuery,
  type SystemOperatorRequest,
  type SystemOperatorService,
} from "./service.ts";

export interface CreateSystemOperatorApiOptions {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly observers: readonly IamRole[];
  readonly requestId?: () => string;
  readonly service: SystemOperatorService;
  readonly services: SystemServicePrincipals;
}

type SystemOperatorRoute = (typeof SYSTEM_OPERATOR_API_ROUTES)[number];

const TITLES: Readonly<Record<number, string>> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  429: "Too many requests",
  503: "Service unavailable",
};

const PERSISTENCE_STATUS = {
  conflict: 409,
  forbidden: 403,
  internal: 500,
  "invalid-input": 400,
  "not-found": 404,
  unprocessable: 422,
} as const;

function problem(
  status: number,
  code: string,
  detail: string,
  requestId: string,
  extensions: Readonly<Record<string, string>> = {},
) {
  return Response.json(
    { ...extensions, code, detail, requestId, status, title: TITLES[status] ?? "Request failed" },
    {
      status,
      headers: { "content-type": "application/problem+json", "x-request-id": requestId },
    },
  );
}

const ROUTE_MATCHERS = SYSTEM_OPERATOR_API_ROUTES.map((route) => ({
  parameterPatterns: ("pathParameters" in route ? route.pathParameters : []).map(
    (parameter) => [parameter.name, new RegExp(parameter.schema.pattern, "u")] as const,
  ),
  path: new RegExp(`^${route.path.replaceAll(/:([A-Za-z0-9_]+)/gu, "(?<$1>[^/]+)")}$`, "u"),
  route,
}));

const OBSERVER_ROUTES: Readonly<Record<string, SystemOperatorRoute>> = Object.fromEntries(
  SYSTEM_OBSERVER_ROUTES.flatMap((observer) => {
    const route = SYSTEM_OPERATOR_API_ROUTES.find(({ name }) => name === observer.serves);
    return route ? [[`${observer.method} ${observer.path}`, route]] : [];
  }),
);

const OBSERVER_PATH = /^\/v1\/system\/observer(?:\/|$)/u;
const SERVICE_PATH = new RegExp(`^${SYSTEM_SERVICE_PATH_PREFIX}(?:/|$)`, "u");
const SERVICE_GRANTS: Readonly<Record<string, SystemServiceGrant>> =
  SYSTEM_SERVICE_OPERATION_GRANTS;

function matchRoute(method: string, pathname: string) {
  for (const matcher of ROUTE_MATCHERS) {
    if (matcher.route.method !== method) continue;
    const match = matcher.path.exec(pathname);
    if (match) return { ...matcher, params: { ...match.groups } };
  }
  return undefined;
}

type PathParameterName = (typeof ROUTE_MATCHERS)[number]["parameterPatterns"][number][0];

const PARAMETER_FORMATS: Readonly<Record<PathParameterName, string>> = {
  holdKey: "1 to 63 lowercase letters, digits, or hyphens, not starting with a hyphen",
  organizationId: "a canonical ULID",
  principalId: "a canonical ULID",
};

function checkParameters(
  parameterPatterns: (typeof ROUTE_MATCHERS)[number]["parameterPatterns"],
  params: Readonly<Record<string, string>>,
) {
  for (const [name, pattern] of parameterPatterns) {
    if (!pattern.test(params[name] ?? "")) {
      throw new SystemQueryError(`invalid_${name}`, `${name} must be ${PARAMETER_FORMATS[name]}.`);
    }
  }
  return params;
}

async function jsonBody(request: Request) {
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SystemQueryError("invalid_json", "The request body must be valid JSON.");
  }
}

/**
 * Install operators are humans signed in through platform identity who hold the platform
 * administrator role (or the `platform:admin` bypass scope). API keys never qualify, whatever
 * scopes they carry, because the system routes expose the whole install.
 */
export function isSystemOperator(identity: ApiIdentity) {
  return (
    identity.authentication === "tenant-jwt" &&
    identity.erasureReceiptOnly !== true &&
    isPlatformAdministrator(identity)
  );
}

function parseQuery(url: URL): SystemOperatorQuery {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && (!/^[1-9]\d{0,2}$/u.test(rawLimit) || Number(rawLimit) > 100)) {
    throw new SystemQueryError("invalid_limit", "limit must be an integer from 1 through 100.");
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4_096)) {
    throw new SystemQueryError("invalid_cursor", "cursor must contain 1 to 4096 characters.");
  }
  const state = url.searchParams.get("state") ?? undefined;
  if (state !== undefined && !(SYSTEM_ALARM_STATES as readonly string[]).includes(state)) {
    throw new SystemQueryError(
      "invalid_state",
      `state must be one of ${SYSTEM_ALARM_STATES.join(", ")}.`,
    );
  }
  const month = url.searchParams.get("month") ?? undefined;
  const organizationId = url.searchParams.get("organizationId") ?? undefined;
  const email = url.searchParams.get("email") ?? undefined;
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(email === undefined ? {} : { email }),
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
    ...(month === undefined ? {} : { month }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(state === undefined ? {} : { state: state as NonNullable<SystemOperatorQuery["state"]> }),
  };
}

class SystemQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createSystemOperatorApi(options: CreateSystemOperatorApiOptions) {
  async function serve(
    route: SystemOperatorRoute,
    requestId: string,
    input: SystemOperatorRequest,
  ) {
    const result = await options.service(route.name, input);
    return Response.json(decodePublicResponse(route.name, result), {
      status: route.successStatus,
      headers: { "x-request-id": requestId },
    });
  }

  function failure(cause: unknown, route: SystemOperatorRoute, requestId: string) {
    if (cause instanceof SystemQueryError) {
      return problem(400, cause.code, cause.message, requestId);
    }
    if (cause instanceof SystemOperatorProblem) {
      return problem(cause.status, cause.code, cause.message, requestId, cause.extensions);
    }
    if (cause instanceof PersistenceError) {
      return problem(PERSISTENCE_STATUS[cause.kind], cause.code, cause.message, requestId);
    }
    console.error("System operator request failed.", {
      error: cause instanceof Error ? cause.message : "Unknown error.",
      requestId,
      route: route.name,
    });
    return problem(500, "internal_error", "The system request failed.", requestId);
  }

  async function operate(request: Request, url: URL, method: string) {
    const matched = matchRoute(method, url.pathname);
    if (!matched) return undefined;
    const { route } = matched;
    const requestId = options.requestId?.() ?? randomUUID();
    try {
      const identity = await options.authenticate(request);
      if (!identity) {
        return problem(401, "unauthorized", "A valid bearer credential is required.", requestId);
      }
      if (!isSystemOperator(identity)) {
        return problem(
          403,
          "platform_administrator_required",
          "System routes require a platform administrator signed in through platform identity.",
          requestId,
        );
      }
      return await serve(route, requestId, {
        body: "requestBody" in route ? await jsonBody(request) : undefined,
        caller: { kind: "operator", principalId: identity.principalId },
        params: checkParameters(matched.parameterPatterns, matched.params),
        query: parseQuery(url),
      });
    } catch (cause) {
      return failure(cause, route, requestId);
    }
  }

  async function observe(url: URL, method: string, iamUserArn: string | undefined) {
    const requestId = options.requestId?.() ?? randomUUID();
    if (!isSystemObserver(options.observers, iamUserArn)) {
      return problem(
        403,
        "system_observer_required",
        "Observer routes require an assumed-role session of a role in system_observer_role_arns in this install's account.",
        requestId,
      );
    }
    const route = OBSERVER_ROUTES[`${method} ${url.pathname}`];
    if (!route) return undefined;
    try {
      return await serve(route, requestId, {
        body: undefined,
        caller: { kind: "observer" },
        params: {},
        query: parseQuery(url),
      });
    } catch (cause) {
      return failure(cause, route, requestId);
    }
  }

  /**
   * API Gateway verified the SigV4 signature; the assumed role must belong to a configured
   * service whose grants cover the operator route the rest of the path names.
   */
  async function serveService(
    request: Request,
    url: URL,
    method: string,
    iamUserArn: string | undefined,
  ) {
    const requestId = options.requestId?.() ?? randomUUID();
    if (options.services.kind === "invalid") {
      return problem(503, "system_services_misconfigured", options.services.error, requestId);
    }
    const principal = resolveSystemService(options.services.principals, iamUserArn);
    if (!principal) {
      return problem(
        403,
        "system_service_required",
        "Service routes require an assumed-role session of a role in system_service_principals in this install's account.",
        requestId,
      );
    }
    const operatorPath = `/v1/system${url.pathname.slice(SYSTEM_SERVICE_PATH_PREFIX.length)}`;
    const matched = matchRoute(method, operatorPath);
    const grant = matched && SERVICE_GRANTS[matched.route.name];
    if (!matched || !grant) return undefined;
    if (!principal.grants.has(grant)) {
      return problem(
        403,
        "system_service_grant_required",
        `Service ${principal.name} needs the ${grant} grant for this route.`,
        requestId,
        { grant },
      );
    }
    try {
      return await serve(matched.route, requestId, {
        body: "requestBody" in matched.route ? await jsonBody(request) : undefined,
        caller: { kind: "service", service: principal.name },
        params: checkParameters(matched.parameterPatterns, matched.params),
        query: parseQuery(url),
      });
    } catch (cause) {
      return failure(cause, matched.route, requestId);
    }
  }

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const iamUserArn = httpApiV2IamUserArn(request);
    if (SERVICE_PATH.test(url.pathname)) return serveService(request, url, method, iamUserArn);
    if (iamUserArn !== undefined) return observe(url, method, iamUserArn);
    if (OBSERVER_PATH.test(url.pathname)) return observe(url, method, undefined);
    return operate(request, url, method);
  };
}
