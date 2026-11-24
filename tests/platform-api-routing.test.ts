import { describe, expect, test } from "bun:test";
import {
  AGENT_EMAIL_API_ROUTES,
  APPS_API_ROUTES,
  BRAIN_API_ROUTES,
  BUDGET_API_ROUTES,
  CREDENTIAL_REFERENCE_API_ROUTES,
  DIRECTORY_API_ROUTES,
  EGRESS_ALLOWLIST_API_ROUTES,
  EVALUATION_API_ROUTES,
  GOVERNANCE_API_ROUTES,
  IDENTITY_API_ROUTES,
  IDENTITY_FEDERATION_API_ROUTES,
  MEMORY_API_ROUTES,
  MODEL_API_ROUTES,
  MODEL_CREDENTIAL_API_ROUTES,
  OBSERVABILITY_API_ROUTES,
  OPERATIONS_API_ROUTES,
  ORGANIZATION_SPEND_API_ROUTES,
  PROVIDER_API_ROUTES,
  PUBLIC_API_ROUTES,
  RUNTIME_API_ROUTES,
  STREAM_GATEWAY_API_ROUTES,
  SYSTEM_OBSERVER_ROUTES,
  SYSTEM_OPERATOR_API_ROUTES,
  SYSTEM_SERVICE_OPERATION_GRANTS,
  systemServicePath,
  TENANCY_API_ROUTES,
  TOOL_CATALOG_API_ROUTES,
  TOOLING_API_ROUTES,
  WORKSPACE_SPEND_API_ROUTES,
  MONITOR_API_ROUTES,
} from "@deployments-ai/api-contract";
import { EMAIL_API_ROUTES } from "@deployments-ai/api-contract/email";
import { readTerraformFiles } from "./terraform-files.ts";

type Operation = { readonly method: string; readonly path: string };
type GatewayRoute = {
  readonly authorization: string;
  readonly integration: string;
  readonly key: string;
};

const OPERATION_OWNERS: Record<string, readonly Operation[]> = {
  administration: [
    ...PROVIDER_API_ROUTES,
    ...TOOLING_API_ROUTES,
    ...TOOL_CATALOG_API_ROUTES,
    ...MODEL_API_ROUTES,
    ...CREDENTIAL_REFERENCE_API_ROUTES,
  ],
  agent_email: [...AGENT_EMAIL_API_ROUTES, ...EMAIL_API_ROUTES],
  brain: [
    ...BRAIN_API_ROUTES,
    ...["DELETE", "GET", "POST"].map((method) => ({ method, path: "/v1/mcp/brain" })),
  ],
  budget: BUDGET_API_ROUTES,
  monitors: MONITOR_API_ROUTES,
  evaluations: EVALUATION_API_ROUTES,
  governance: GOVERNANCE_API_ROUTES,
  memory: MEMORY_API_ROUTES,
  observability: OBSERVABILITY_API_ROUTES,
  runtime: RUNTIME_API_ROUTES,
  system: [...SYSTEM_OPERATOR_API_ROUTES, ...SYSTEM_OBSERVER_ROUTES],
  tenancy: [
    ...TENANCY_API_ROUTES,
    ...IDENTITY_API_ROUTES,
    ...IDENTITY_FEDERATION_API_ROUTES,
    ...DIRECTORY_API_ROUTES,
    ...APPS_API_ROUTES,
    ...OPERATIONS_API_ROUTES,
    ...MODEL_CREDENTIAL_API_ROUTES,
    ...EGRESS_ALLOWLIST_API_ROUTES,
    ...ORGANIZATION_SPEND_API_ROUTES,
    ...WORKSPACE_SPEND_API_ROUTES,
    { method: "GET", path: "/health" },
    { method: "GET", path: "/v1/openapi.json" },
  ],
};

const platformApi = readTerraformFiles("infrastructure/modules/platform-api", "");

function stringList(source: string, name: string): string[] {
  const list = new RegExp(`\\b${name}\\s+= [^\\[\\n]*\\[([^\\]]*)\\]`, "u").exec(source)?.[1];
  if (list === undefined) throw new Error(`OpenTofu list ${name} was not found.`);
  return [...list.matchAll(/"([^"]*)"/gu)].map((match) => match[1] as string);
}

function apiRoutes(): [string, string][] {
  const functions = /\n {2}api_functions = \{([\s\S]*?)\n {2}\}/u.exec(platformApi)?.[1];
  if (functions === undefined) throw new Error("OpenTofu local api_functions was not found.");
  return [...functions.matchAll(/\n {4}([a-z_]+) = \{([\s\S]*?)\n {4}\}/gu)].flatMap(
    ([, key = "", body = ""]) =>
      [
        ...stringList(body, "route_keys"),
        ...stringList(body, "route_prefixes").flatMap((prefix) => [
          `ANY ${prefix}`,
          `ANY ${prefix}/{proxy+}`,
        ]),
      ].map((routeKey): [string, string] => [routeKey, key]),
  );
}

function instances(body: string): Record<string, string>[] {
  const source = /for_each = local\.(\w+)/u.exec(body)?.[1];
  if (source === undefined) return [{}];
  const entries =
    source === "api_routes"
      ? apiRoutes()
      : stringList(platformApi, source).map((key): [string, string] => [key, key]);
  return entries.map(([key, value]) => ({ "each.key": key, "each.value": value }));
}

function gatewayRoutes(): GatewayRoute[] {
  const resources = platformApi.matchAll(
    /resource "aws_apigatewayv2_route" "\w+" \{([\s\S]*?)\n\}/gu,
  );
  return [...resources].flatMap(([, body = ""]) => {
    const routeKey = /route_key\s+= (each\.key|each\.value|"[^"]+")/u.exec(body)?.[1];
    const authorization = /authorization_type\s+= "(\w+)"/u.exec(body)?.[1];
    const target =
      /target\s+= "integrations\/\$\{aws_apigatewayv2_integration\.(\w+)(?:\[(each\.value|0|"\w+")\])?\.id\}"/u.exec(
        body,
      );
    if (routeKey === undefined || authorization === undefined || target === null) {
      throw new Error(`Unrecognized route resource:\n${body}`);
    }
    const [, integration = "", index] = target;
    return instances(body).map((scope) => ({
      authorization,
      integration:
        index === "each.value"
          ? (scope[index] as string)
          : index?.startsWith('"')
            ? index.slice(1, -1)
            : integration,
      key: scope[routeKey] ?? routeKey.slice(1, -1),
    }));
  });
}

function segmentRank(segment: string): number {
  if (segment.endsWith("+}")) return 0;
  return segment.startsWith("{") ? 1 : 2;
}

// Mirrors API Gateway HTTP API route selection. A full match beats a greedy match, a literal
// segment beats a path variable, a method beats ANY, and $default serves whatever nothing matches.
function specificity(routeKey: string, method: string, request: readonly string[]) {
  const [routeMethod = "", routePath = ""] = routeKey.split(" ");
  if (routeMethod !== "ANY" && routeMethod !== method) return undefined;
  const segments = routePath.split("/").slice(1);
  const ranks = segments.map(segmentRank);
  const greedy = ranks.at(-1) === 0;
  if (greedy ? request.length < segments.length : request.length !== segments.length) {
    return undefined;
  }
  if (!segments.every((segment, index) => segment.startsWith("{") || segment === request[index])) {
    return undefined;
  }
  return [greedy ? 0 : 1, ...ranks, routeMethod === "ANY" ? 0 : 1];
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

function routeFor(
  routes: readonly GatewayRoute[],
  method: string,
  path: string,
): GatewayRoute | undefined {
  const request = path.split("/").slice(1);
  const [best, runnerUp] = routes
    .flatMap((route) => {
      const score = specificity(route.key, method, request);
      return score === undefined ? [] : [{ route, score }];
    })
    .toSorted((left, right) => compare(right.score, left.score));
  if (best && runnerUp && compare(best.score, runnerUp.score) === 0) {
    throw new Error(`${method} ${path} matches both ${best.route.key} and ${runnerUp.route.key}.`);
  }
  return best?.route ?? routes.find((route) => route.key === "$default");
}

function operationKey(operation: Operation): string {
  return `${operation.method} ${operation.path}`;
}

describe("platform API routing", () => {
  const routes = gatewayRoutes();

  test("routes every contract operation to the Lambda that owns it", () => {
    const owners = Object.fromEntries(
      Object.entries(OPERATION_OWNERS).flatMap(([owner, operations]) =>
        operations.map((operation) => [operationKey(operation), owner]),
      ),
    );
    const streamed = new Set(STREAM_GATEWAY_API_ROUTES.map(operationKey));
    const operations = [...PUBLIC_API_ROUTES, ...Object.values(OPERATION_OWNERS).flat()].filter(
      (operation) => !streamed.has(operationKey(operation)),
    );
    const expected = Object.fromEntries(
      operations.map((operation) => [
        operationKey(operation),
        owners[operationKey(operation)] ?? "unowned",
      ]),
    );
    const routed = Object.fromEntries(
      operations.map((operation) => [
        operationKey(operation),
        routeFor(routes, operation.method, operation.path.replaceAll(/:(\w+)/gu, "$1-value"))
          ?.integration ?? "Not Found",
      ]),
    );

    expect(routed).toEqual(expected);
  });

  test("sends unclaimed paths to the Lambda that owns their prefix", () => {
    expect(routeFor(routes, "GET", "/v1/unknown")?.integration).toBe("tenancy");
    expect(routeFor(routes, "GET", "/v1/organizations/org-1/unknown")?.integration).toBe("tenancy");
    expect(routeFor(routes, "PUT", "/v1/observability/unknown/path")?.integration).toBe(
      "observability",
    );
  });

  test("requires IAM on exactly the observer reads and the service proxy, which outrank the system prefix", () => {
    expect(
      routes
        .filter((route) => route.authorization !== "NONE")
        .map((route) => `${route.authorization} ${route.key}`),
    ).toEqual([
      "AWS_IAM GET /v1/system/observer/alarms",
      "AWS_IAM GET /v1/system/observer/components",
      "AWS_IAM GET /v1/system/observer/deployments",
      "AWS_IAM GET /v1/system/observer/installation",
      "AWS_IAM GET /v1/system/observer/model-providers",
      "AWS_IAM ANY /v1/system/services/{proxy+}",
    ]);
    for (const operation of SYSTEM_OBSERVER_ROUTES) {
      expect(routeFor(routes, operation.method, operation.path)).toEqual({
        authorization: "AWS_IAM",
        integration: "system",
        key: operationKey(operation),
      });
    }
    expect(routeFor(routes, "POST", "/v1/system/observer/installation")).toEqual({
      authorization: "NONE",
      integration: "system",
      key: "ANY /v1/system/{proxy+}",
    });
    const served = SYSTEM_OPERATOR_API_ROUTES.filter(
      ({ name }) => name in SYSTEM_SERVICE_OPERATION_GRANTS,
    ).map(({ method, path }) => {
      const concrete = path.replaceAll(/:(\w+)/gu, "$1-value");
      return [
        routeFor(routes, method, concrete)?.key,
        routeFor(routes, method, systemServicePath(concrete))?.key,
      ];
    });
    expect(new Set(served.map((keys) => keys.join(" | ")))).toEqual(
      new Set(["ANY /v1/system/{proxy+} | ANY /v1/system/services/{proxy+}"]),
    );
  });

  test("publishes unique route keys below the 300-route quota with every integration on", () => {
    const keys = routes.map((route) => route.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeLessThan(300);
  });
});
