import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import type { PublicApiRouteContract } from "@deployments-ai/api-contract/route-contract";
import { customCommandRoutes } from "@agentifiers/deployments-cli/custom-command-routes";
import type { CliCommand, CliTree } from "./cli-tree.ts";
import { apiOperationUrl } from "./urls.ts";

export type NonEmpty<T> = readonly [T, ...T[]];

export interface DocumentedOperation {
  readonly route: PublicApiRouteContract;
  readonly endpoint: string;
  readonly summary: string;
  readonly url: string;
  readonly cli: NonEmpty<CliCommand>;
}

type RouteKey = `${PublicApiRouteContract["method"]} ${string}`;

function routeKey(method: PublicApiRouteContract["method"], path: string): RouteKey {
  return `${method} ${path.replaceAll(/:[^/]+/gu, "{}")}`;
}

function sentenceCase(operationName: string): string {
  const words = operationName.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function buildOperations(tree: CliTree): readonly DocumentedOperation[] {
  const commandsByRoute = new Map<RouteKey, CliCommand[]>();
  const attach = (key: RouteKey, command: CliCommand) => {
    const commands = commandsByRoute.get(key) ?? [];
    commands.push(command);
    commandsByRoute.set(key, commands);
  };
  for (const command of tree.commands) {
    if (command.action) attach(routeKey(command.action.method, command.action.path), command);
  }
  const publicRouteKeys = new Set(
    PUBLIC_API_ROUTES.map((route) => routeKey(route.method, route.path)),
  );
  for (const [commandPath, routes] of Object.entries(customCommandRoutes)) {
    const command = tree.commands.find((candidate) => candidate.path.join(" ") === commandPath);
    if (!command) throw new Error(`Custom CLI command "${commandPath}" is not in the CLI tree.`);
    for (const { method, path } of routes) {
      const key = routeKey(method, path);
      if (!publicRouteKeys.has(key)) {
        throw new Error(`Custom CLI command "${commandPath}" maps to non-public route ${key}.`);
      }
      attach(key, command);
    }
  }

  const operations = PUBLIC_API_ROUTES.map((route): DocumentedOperation => {
    const [first, ...rest] = commandsByRoute.get(routeKey(route.method, route.path)) ?? [];
    if (!first) {
      throw new Error(
        `Public operation ${route.name} (${route.method} ${route.path}) has no CLI command.`,
      );
    }
    const catalogCommand = [first, ...rest].find((command) => command.action);
    return {
      route,
      endpoint: `${route.method} ${route.path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}")}`,
      summary: catalogCommand?.summary ?? sentenceCase(route.name),
      url: apiOperationUrl(route),
      cli: [first, ...rest],
    };
  });

  const urls = new Set(operations.map((operation) => operation.url));
  if (urls.size !== operations.length) {
    throw new Error("Two public operations map to the same API reference URL.");
  }
  return operations;
}
