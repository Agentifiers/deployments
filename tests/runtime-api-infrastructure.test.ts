import { describe, expect, test } from "bun:test";
import { RUNTIME_API_ROUTES } from "@deployments-ai/api-contract/runtime";

function routeShape(routeKey: string): string {
  return routeKey.replaceAll(/\{[^}]+\}|:[^/]+/gu, "{}");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

const contractRouteShapes = sortedUnique(
  RUNTIME_API_ROUTES.map((route) => routeShape(`${route.method} ${route.path}`)),
);

function terraformRouteShapes(source: string, localName: string, path: string): string[] {
  const marker = `${localName} = toset([`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`OpenTofu local ${localName} was not found in ${path}.`);
  const end = source.indexOf("\n  ])", start);
  if (end < 0) throw new Error(`OpenTofu local ${localName} was not terminated in ${path}.`);

  return sortedUnique(
    [...source.slice(start, end).matchAll(/"([A-Z]+ \/v1\/[^"]+)"/gu)].map((match) =>
      routeShape(match[1] as string),
    ),
  );
}

describe("runtime API infrastructure", () => {
  test.each([
    ["infrastructure/modules/platform-api/main.tf", "runtime_routes"],
    ["infrastructure/modules/agent-runtime/main.tf", "runtime_api_routes"],
  ])("routes every runtime operation through the API gateway in %s", async (path, localName) => {
    const source = await Bun.file(path).text();
    expect(terraformRouteShapes(source, localName, path)).toEqual(contractRouteShapes);
  });
});
