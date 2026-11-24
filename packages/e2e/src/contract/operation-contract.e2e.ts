import { expect, it } from "@effect/vitest";
import { makePublicOpenApiSpec } from "@deployments-ai/api-contract/openapi";
import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import { commandCatalog } from "@agentifiers/deployments-cli/catalog";
import { Effect } from "effect";

type OpenApiOperation = {
  readonly operationId?: unknown;
  readonly parameters?: readonly {
    readonly in?: unknown;
    readonly name?: unknown;
    readonly required?: unknown;
  }[];
  readonly requestBody?: unknown;
  readonly responses?: Readonly<Record<string, unknown>>;
  readonly security?: unknown;
  readonly tags?: readonly unknown[];
};

const HTTP_METHODS = new Set(["delete", "get", "patch", "post", "put"]);
function normalizedRoute(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replaceAll(/:[^/]+/gu, "{}").replaceAll(/\{[^/]+\}/gu, "{}")}`;
}

function openApiOperations(): ReadonlyMap<string, OpenApiOperation> {
  const operations = new Map<string, OpenApiOperation>();
  for (const [path, pathItem] of Object.entries(makePublicOpenApiSpec().paths)) {
    for (const [method, value] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      operations.set(normalizedRoute(method, path), value as OpenApiOperation);
    }
  }
  return operations;
}

function requiredParameter(operation: OpenApiOperation, location: string, name: string): boolean {
  return Boolean(
    operation.parameters?.some(
      (parameter) =>
        parameter.in === location && parameter.name === name && parameter.required === true,
    ),
  );
}

it.effect(
  "keeps every local route represented exactly once in OpenAPI with its contract traits",
  () =>
    Effect.sync(() => {
      const operations = openApiOperations();
      expect(operations.size).toBe(PUBLIC_API_ROUTES.length);

      for (const route of PUBLIC_API_ROUTES) {
        const operation = operations.get(normalizedRoute(route.method, route.path));
        expect(operation, `${route.name} is missing from OpenAPI`).toBeDefined();
        expect(operation?.operationId).toBe(route.name);
        expect(operation?.tags).toEqual([route.tag]);
        expect(operation?.responses).toHaveProperty(String(route.successStatus));
        expect(Boolean(operation?.requestBody)).toBe(
          "requestBody" in route && Boolean(route.requestBody),
        );
        expect(requiredParameter(operation!, "header", "idempotency-key")).toBe(
          route.idempotency === "required",
        );
        for (const parameter of route.path.matchAll(/:([A-Za-z0-9_]+)/gu)) {
          expect(requiredParameter(operation!, "path", parameter[1]!)).toBe(true);
        }
      }
    }),
);

it.effect(
  "maps every public operation to the executable CLI without exposing non-public routes",
  () =>
    Effect.sync(() => {
      const customRoutes = [
        ["GET", "/v1/whoami"],
        ["POST", "/v1/device-authorizations"],
        ["POST", "/v1/device-authorizations/revoke"],
        ["POST", "/v1/device-authorizations/token"],
        ["POST", "/v1/agent-deployments/:agentDeploymentId/runs"],
        ["GET", "/health"],
      ] as const;
      const catalogRoutes = Object.values(commandCatalog).flatMap((resource) =>
        Object.values(resource.actions).map((action) =>
          normalizedRoute(action.method, action.path),
        ),
      );
      const cliRoutes = new Set([
        ...catalogRoutes,
        ...customRoutes.map(([method, path]) => normalizedRoute(method, path)),
      ]);
      const publicRoutes = new Set(
        PUBLIC_API_ROUTES.map((route) => normalizedRoute(route.method, route.path)),
      );

      expect(
        PUBLIC_API_ROUTES.filter(
          (route) => !cliRoutes.has(normalizedRoute(route.method, route.path)),
        ).map((route) => route.name),
      ).toEqual([]);
      expect(catalogRoutes.filter((route) => !publicRoutes.has(route))).toEqual([]);
    }),
);
