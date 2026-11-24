import { createHmac, randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  APPS_API_ROUTES,
  PUBLIC_ID_PATTERN,
  decodePublicResponse,
  type AppsRouteName,
  type PublicApiPrincipal,
} from "@deployments-ai/api-contract";
import {
  AppPersistenceError,
  InvalidTenancyCursorError,
  PersistenceError,
  Ulid,
  makeAppPersistence,
  makeIdGenerator,
  type AppPersistence,
  type DynamoDatabaseService,
  type IdempotencyPersistence,
  type PersistenceInvocation,
  type TenancyPersistence,
} from "@deployments-ai/db";
import { credentialWildcardsCannotGrant } from "@deployments-ai/identity/scopes";
import { Option, Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import {
  lambdaAppDomainReconcile,
  type AppDomainReconcile,
} from "./app-domain-reconciler-client.ts";
import {
  APPS_RUNTIME_ENV,
  appsRuntimeFromEnvironment,
  lambdaAppsDatabase,
  type AppsDatabase,
} from "./apps-database-client.ts";
import { makeAppsOperations, type AppsEnvironment } from "./apps-operations.ts";
import { AppsProblem } from "./apps-problem.ts";
import { txtObserver, type ResolveTxt } from "./dns-txt.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { persistenceStatus } from "./persistence-error-status.ts";
import { routePattern } from "./route-request-parsing.ts";
import { identityPermits } from "./scope-permissions.ts";

export const APPS_API_ENV = {
  customDomainTarget: "APPS_CUSTOM_DOMAIN_TARGET",
  domain: "APPS_DOMAIN",
  domainReconciler: "APPS_DOMAIN_RECONCILER_FUNCTION_NAME",
  reservedHostnames: "APPS_RESERVED_HOSTNAMES",
} as const;

/** The API Lambda times out at 29 s, so the apps-database invoke ends first and answers 503. */
const APPS_DATABASE_DEADLINE_MS = 24_000;
/** Lambda queues an Event invoke at once; the deadline only bounds a stalled request. */
const DOMAIN_RECONCILE_DEADLINE_MS = 5_000;

export interface CreateAppsApiOptions {
  readonly appDomains: {
    readonly reconcile: AppDomainReconcile;
    readonly reservedHostnames: readonly string[];
    readonly resolveTxt: ResolveTxt;
    readonly routingEndpoint: string;
  };
  readonly apps: AppPersistence;
  readonly appsDatabase: Pick<AppsDatabase, "convergence" | "erase">;
  readonly appsDomain: string;
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
  readonly requestId?: () => string;
  readonly tenancy: Pick<TenancyPersistence, "authorize" | "environments">;
}

const matchers = APPS_API_ROUTES.map((route) => ({ route, ...routePattern(route.path) }));

const decodeUlid = Schema.decodeUnknownOption(Ulid);

const APP_FAILURES = {
  "app-domain-limit": [409, "app_domain_limit_reached"],
  conflict: [409, "concurrent_modification"],
  "domain-claimed": [409, "domain_claimed"],
  "illegal-state": [409, "app_state_conflict"],
  "not-found": [404, "resource_not_found"],
  "organization-domain-limit": [409, "organization_domain_limit_reached"],
  "slug-taken": [409, "app_slug_taken"],
  "still-provisioning": [409, "app_state_conflict"],
  "txt-not-found": [422, "txt_not_found"],
  unknown: [500, "internal_error"],
} as const satisfies Record<AppPersistenceError["reason"], readonly [number, string]>;

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
      headers: {
        "content-type": "application/problem+json",
        ...(status === 503 ? { "retry-after": "5" } : {}),
        "x-request-id": requestId,
      },
      status,
    },
  );
}

function errorResponse(cause: unknown, requestId: string) {
  if (cause instanceof AppsProblem)
    return problem(cause.status, cause.code, cause.message, requestId);
  if (cause instanceof AppPersistenceError) {
    const [status, code] = APP_FAILURES[cause.reason];
    return status === 500
      ? problem(status, code, "The app request failed.", requestId)
      : problem(status, code, cause.message, requestId);
  }
  if (cause instanceof PersistenceError) {
    return problem(persistenceStatus(cause), cause.code, cause.message, requestId);
  }
  if (cause instanceof InvalidTenancyCursorError) {
    return problem(400, "invalid_cursor", "The pagination cursor is invalid.", requestId);
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
  return problem(500, "internal_error", "The app request failed.", requestId);
}

function environmentHeader(request: Request) {
  const raw = request.headers.get("x-deployments-environment")?.trim();
  if (!raw) {
    throw new AppsProblem(
      400,
      "missing_environment_context",
      "x-deployments-environment is required.",
    );
  }
  const environmentId = decodeUlid(raw);
  if (!PUBLIC_ID_PATTERN.test(raw) || Option.isNone(environmentId)) {
    throw new AppsProblem(
      400,
      "invalid_environment_context",
      "x-deployments-environment must be a canonical public ID.",
    );
  }
  return environmentId.value;
}

function readQuery(url: URL) {
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  const slug = url.searchParams.get("slug");
  if (limit !== null && (!/^[1-9]\d*$/u.test(limit) || Number(limit) > 100)) {
    throw new AppsProblem(400, "invalid_limit", "limit must be an integer from 1 through 100.");
  }
  return {
    ...(cursor ? { cursor } : {}),
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(slug === null ? {} : { slug }),
  };
}

export function createAppsApi(options: CreateAppsApiOptions) {
  const { appDomains } = options;
  const operations = makeAppsOperations({
    ...options,
    appDomains: {
      installationHostnames: [options.appsDomain, ...appDomains.reservedHostnames],
      observeTxt: txtObserver(
        appDomains.resolveTxt,
        () => new AppsProblem(503, "dns_lookup_failed", "The DNS lookup failed; try again."),
      ),
      reconcile: appDomains.reconcile,
      routingEndpoint: appDomains.routingEndpoint,
    },
  });

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
      if (!identityPermits(identity, route.requiredAuthorization)) {
        throw new AppsProblem(
          403,
          "insufficient_scope",
          identity.authentication === "api-credential" &&
            credentialWildcardsCannotGrant(route.requiredAuthorization)
            ? `The API key does not name the ${route.requiredAuthorization} scope; wildcards do not grant it.`
            : `The credential does not have the required ${route.requiredAuthorization} capability.`,
        );
      }
      const principal: PublicApiPrincipal =
        identity.authentication === "api-credential" ? "service-account" : "human";
      const admitted: readonly PublicApiPrincipal[] = route.principals;
      if (!admitted.includes(principal)) {
        throw new AppsProblem(
          403,
          "human_principal_required",
          "Only organization members make this change; API keys read apps and, with apps:publish, change their publication and custom domains.",
        );
      }
      const environmentId = environmentHeader(request);
      const match = matcher.pattern.exec(url.pathname) ?? [];
      const params = Object.fromEntries(
        matcher.names.map((name, index) => [
          name,
          Option.getOrThrowWith(
            decodeUlid(decodeURIComponent(match[index + 1] ?? "")),
            () => new AppsProblem(404, "resource_not_found", "The resource was not found."),
          ),
        ]),
      );
      const invocation: PersistenceInvocation<undefined> = {
        body: undefined,
        identity,
        query: {},
        scope: { environmentId },
      };
      const responseInit = { headers: { "x-request-id": requestId }, status: route.successStatus };

      if (route.requiredAuthorization === "apps:read") {
        const query = readQuery(url);
        const { organizationId } = await options.tenancy.environments.get({
          ...invocation,
          id: environmentId,
        });
        const result = await operations.read[route.name]({
          environment: { environmentId, organizationId },
          params,
          query,
        });
        return Response.json(contractResponse(route.name, result), responseInit);
      }

      const principalId = decodeUlid(identity.principalId);
      if (Option.isNone(principalId)) {
        throw new AppsProblem(
          403,
          "human_principal_required",
          "Only organization members and service accounts change apps.",
        );
      }
      const idempotencyKey =
        route.idempotency === "none" ? undefined : request.headers.get("idempotency-key")?.trim();
      if (route.idempotency !== "none" && !idempotencyKey) {
        return problem(400, "missing_idempotency_key", "Idempotency-Key is required.", requestId);
      }
      await options.tenancy.authorize(
        { ...invocation, ...(idempotencyKey ? { idempotencyKey } : {}) },
        route.name,
        true,
      );
      const { organizationId } = await options.tenancy.environments.get({
        ...invocation,
        id: environmentId,
      });
      const environment: AppsEnvironment = { environmentId, organizationId };
      const text = "requestBody" in route ? await request.text() : "";
      const body: unknown = text ? JSON.parse(text) : undefined;
      const perform = async () =>
        contractResponse(
          route.name,
          route.requiredAuthorization === "apps:publish"
            ? await operations.publish[route.name]({
                actor: {
                  id: principalId.value,
                  type: principal === "human" ? "principal" : "service-account",
                },
                body,
                environment,
                params,
              })
            : await operations.write[route.name]({
                body,
                changedBy: principalId.value,
                environment,
                params,
              }),
        );
      if (!idempotencyKey) {
        return Response.json(await perform(), responseInit);
      }
      const result = await options.idempotency.execute({
        fingerprint: createHmac("sha256", JSON.stringify([identity.principalId, idempotencyKey]))
          .update(JSON.stringify({ body, environmentId, method, params, path: route.path }))
          .digest("hex"),
        key: `${environmentId}:${idempotencyKey}`,
        operation: perform,
        organizationId,
        principalId: identity.principalId,
      });
      return Response.json(result, responseInit);
    } catch (cause) {
      const response = errorResponse(cause, requestId);
      if (response.status === 500) {
        console.error("Apps API request failed.", {
          ...errorLogFields(cause),
          requestId,
          route: route.name,
        });
      }
      return response;
    }
  };
}

function contractResponse(routeName: AppsRouteName, result: unknown) {
  try {
    return decodePublicResponse(routeName, result);
  } catch (cause) {
    throw new Error("An apps API response broke its contract.", { cause });
  }
}

export function appsApiFromEnvironment(input: {
  readonly authenticate: (request: Request) => Promise<ApiIdentity | null>;
  readonly database: DynamoDatabaseService;
  readonly environment: NodeJS.ProcessEnv;
  readonly idempotency: Pick<IdempotencyPersistence, "execute">;
  readonly tenancy: Pick<TenancyPersistence, "authorize" | "environments">;
}) {
  const appsDomain = input.environment[APPS_API_ENV.domain]?.trim();
  if (!appsDomain) return undefined;
  const runtime = appsRuntimeFromEnvironment(input.environment);
  const routingEndpoint = input.environment[APPS_API_ENV.customDomainTarget]?.trim();
  const domainReconciler = input.environment[APPS_API_ENV.domainReconciler]?.trim();
  const reservedHostnames = (input.environment[APPS_API_ENV.reservedHostnames] ?? "")
    .split(",")
    .flatMap((hostname) => {
      const trimmed = hostname.trim().toLowerCase();
      return trimmed ? [trimmed] : [];
    });
  if (!runtime || !routingEndpoint || !domainReconciler || reservedHostnames.length === 0) {
    throw new Error(
      `${APPS_RUNTIME_ENV.bucket}, ${APPS_RUNTIME_ENV.functionName}, ${APPS_API_ENV.customDomainTarget}, ${APPS_API_ENV.domainReconciler} and ${APPS_API_ENV.reservedHostnames} must be set with ${APPS_API_ENV.domain}.`,
    );
  }
  const lambda = new LambdaClient({});
  return createAppsApi({
    appDomains: {
      reconcile: lambdaAppDomainReconcile({
        client: lambda,
        deadlineMs: DOMAIN_RECONCILE_DEADLINE_MS,
        functionName: domainReconciler,
      }),
      reservedHostnames,
      resolveTxt,
      routingEndpoint,
    },
    apps: makeAppPersistence({
      database: input.database,
      generateId: makeIdGenerator().generate,
      now: () => new Date(),
    }),
    appsDatabase: lambdaAppsDatabase({
      client: lambda,
      deadlineMs: APPS_DATABASE_DEADLINE_MS,
      functionName: runtime.functionName,
    }),
    appsDomain,
    authenticate: input.authenticate,
    idempotency: input.idempotency,
    tenancy: input.tenancy,
  });
}
