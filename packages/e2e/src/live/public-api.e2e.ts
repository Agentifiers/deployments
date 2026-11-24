import { expect, it } from "@effect/vitest";
import { makePublicOpenApiSpec } from "@deployments-ai/api-contract/openapi";
import { ListProvidersResponse, ProviderResponse } from "@deployments-ai/api-contract/providers";
import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import { SYSTEM_OBSERVER_ROUTES } from "@deployments-ai/api-contract/system";
import type { PublicApiRouteContract } from "@deployments-ai/api-contract/route-contract";
import { Effect, Schema } from "effect";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import { publicE2eConfig } from "../harness/live-config.ts";

const PUBLIC_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const AGENT_EMAIL_ROUTE = PUBLIC_API_ROUTES.find((route) => route.tag === "Agent Email");
const SCOPE_HEADER_BY_KIND = {
  environment: "x-deployments-environment",
  organization: "x-deployments-organization",
  project: "x-deployments-project",
} as const;

function materializePath(path: string): string {
  return path.replaceAll(/:([A-Za-z0-9_]+)/gu, (_match, name: string) => {
    if (name === "toolName") return "records.read";
    if (name === "provider" || name === "providerKey") return "github";
    return PUBLIC_ID;
  });
}

function preAuthenticationHeaders(route: PublicApiRouteContract): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (route.scopeHeaders === "tenant") {
    for (const header of Object.values(SCOPE_HEADER_BY_KIND)) headers[header] = PUBLIC_ID;
  } else if (route.scopeHeaders !== "none" && route.scopeHeaders !== "optional-tenant") {
    headers[SCOPE_HEADER_BY_KIND[route.scopeHeaders]] = PUBLIC_ID;
  }
  if (route.idempotency === "required") {
    headers["idempotency-key"] = `e2e-unauthenticated-${route.name}`;
  }
  return headers;
}

const config = publicE2eConfig();
const PublicApiLive = httpClientLayer(config.apiUrl);
const StreamGatewayLive = config.streamGatewayUrl
  ? httpClientLayer(config.streamGatewayUrl)
  : undefined;

function publicRoutesFor(document: unknown): readonly PublicApiRouteContract[] {
  const paths =
    document && typeof document === "object" && "paths" in document
      ? (document.paths as unknown)
      : undefined;
  const includesAgentEmail = Boolean(
    AGENT_EMAIL_ROUTE &&
    paths &&
    typeof paths === "object" &&
    Object.hasOwn(paths, AGENT_EMAIL_ROUTE.path.replaceAll(/:([^/]+)/gu, "{$1}")),
  );
  const expected = makePublicOpenApiSpec({ includeAgentEmail: includesAgentEmail });
  expect(document).toEqual(expected);
  return includesAgentEmail
    ? PUBLIC_API_ROUTES
    : PUBLIC_API_ROUTES.filter((route) => route.tag !== "Agent Email");
}

const deployedPublicRoutes = Effect.gen(function* () {
  const http = yield* E2eHttpClient;
  const openApi = yield* http.request({ method: "GET", path: "/v1/openapi.json" });
  expect(openApi.status).toBe(200);
  return publicRoutesFor(openApi.json);
});

it.effect("serves the exact local OpenAPI contract from the deployed public endpoint", () =>
  Effect.gen(function* () {
    const http = yield* E2eHttpClient;
    const health = yield* http.request({ method: "GET", path: "/health" });
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ service: "deployments-ai-api", status: "ok" });

    yield* deployedPublicRoutes;
  }).pipe(Effect.provide(PublicApiLive)),
);

/** Requests each route without credentials on the client's origin; 503s are retried. */
const unauthenticatedResponses = (routes: readonly PublicApiRouteContract[]) =>
  Effect.gen(function* () {
    const http = yield* E2eHttpClient;
    return yield* Effect.forEach(
      routes,
      (route) =>
        eventually(
          { label: `${route.name} authentication response`, timeoutMs: 15_000 },
          http
            .request({
              headers: preAuthenticationHeaders(route),
              method: route.method,
              path: materializePath(route.path),
              ...("requestBody" in route && route.requestBody ? { body: {} } : {}),
            })
            .pipe(
              Effect.map((response) => (response.status === 503 ? undefined : { response, route })),
            ),
        ),
      { concurrency: 4 },
    );
  });

it.effect(
  "requires authentication on every protected deployed route before mutation",
  () =>
    Effect.gen(function* () {
      const publicRoutes = yield* deployedPublicRoutes;
      const protectedRoutes = publicRoutes.filter((route) => route.authentication !== "none");
      const apiRoutes = protectedRoutes.filter((route) => route.server !== "stream-gateway");
      const gatewayRoutes = protectedRoutes.filter((route) => route.server === "stream-gateway");
      const observations = [
        ...(yield* unauthenticatedResponses(apiRoutes)),
        ...(StreamGatewayLive
          ? yield* unauthenticatedResponses(gatewayRoutes).pipe(Effect.provide(StreamGatewayLive))
          : []),
      ];

      const unexpected = observations.filter(({ response }) => response.status !== 401);
      expect(
        unexpected.map(({ response, route }) => ({
          body: response.body,
          operationId: route.name,
          status: response.status,
        })),
      ).toEqual([]);
      expect(observations).toHaveLength(
        apiRoutes.length + (StreamGatewayLive ? gatewayRoutes.length : 0),
      );
    }).pipe(Effect.provide(PublicApiLive)),
  120_000,
);

it.effect("leaves every unsigned observer request to API Gateway's IAM check", () =>
  Effect.gen(function* () {
    const http = yield* E2eHttpClient;
    const observations = yield* Effect.forEach(SYSTEM_OBSERVER_ROUTES, (route) =>
      http.request({ method: route.method, path: route.path }).pipe(
        Effect.map((response) => ({
          answeredByPlatform:
            response.headers["content-type"]?.startsWith("application/problem+json") === true,
          path: route.path,
          status: response.status,
        })),
      ),
    );
    expect(observations).toEqual(
      SYSTEM_OBSERVER_ROUTES.map((route) => ({
        answeredByPlatform: false,
        path: route.path,
        status: 403,
      })),
    );
  }).pipe(Effect.provide(PublicApiLive)),
);

it.effect("serves and validates both unauthenticated provider routes", () =>
  Effect.gen(function* () {
    const http = yield* E2eHttpClient;
    const list = yield* http.request({ method: "GET", path: "/v1/providers" });
    expect(list.status).toBe(200);
    const page = Schema.decodeUnknownSync(ListProvidersResponse)(list.json);
    expect(page.items.length).toBeGreaterThan(0);

    const get = yield* http.request({ method: "GET", path: "/v1/providers/github" });
    expect(get.status).toBe(200);
    const provider = Schema.decodeUnknownSync(ProviderResponse)(get.json);
    expect(provider.key).toBe("github");
  }).pipe(Effect.provide(PublicApiLive)),
);

it.effect("rejects malformed public device-authorization requests without side effects", () =>
  Effect.gen(function* () {
    const http = yield* E2eHttpClient;
    for (const path of ["/v1/device-authorizations", "/v1/device-authorizations/token"]) {
      const response = yield* http.request({ body: {}, method: "POST", path });
      expect([400, 503]).toContain(response.status);
    }
  }).pipe(Effect.provide(PublicApiLive)),
);
