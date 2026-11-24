import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { invalidateAgent } from "./agent-queries.ts";
import { invalidateConnections } from "./connection-queries.ts";
import { cappedDeploymentsQuery, cappedGrantsQuery } from "./mcp-queries.ts";

const scope = { environmentId: "env1", organizationId: "org1", projectId: "prj1" };

function cachedPins() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(cappedGrantsQuery(scope).queryKey, { complete: true, items: [] });
  queryClient.setQueryData(cappedDeploymentsQuery(scope).queryKey, { complete: true, items: [] });
  return queryClient;
}

const invalidated = (queryClient: QueryClient) => [
  queryClient.getQueryState(cappedGrantsQuery(scope).queryKey)?.isInvalidated,
  queryClient.getQueryState(cappedDeploymentsQuery(scope).queryKey)?.isInvalidated,
];

describe("MCP server page pin reads", () => {
  test("a connection or grant mutation refreshes the grants", async () => {
    const queryClient = cachedPins();
    await invalidateConnections(queryClient, scope);
    expect(invalidated(queryClient)).toEqual([true, false]);
  });

  test("an agent or deployment mutation refreshes the deployments", async () => {
    const queryClient = cachedPins();
    await invalidateAgent(queryClient, scope, "def1");
    expect(invalidated(queryClient)).toEqual([false, true]);
  });
});
