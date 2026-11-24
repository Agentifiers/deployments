import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateAgent } from "./agent-queries.ts";
import { agentTargetsQuery } from "./managed-skill-queries.ts";

const SCOPE = {
  environmentId: "01M4CGZTV7TVHABD2TD30NADP2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};

describe("agentTargetsQuery", () => {
  test("an agent mutation refreshes the install targets", async () => {
    const queryClient = new QueryClient();
    const { queryKey } = agentTargetsQuery(SCOPE);
    queryClient.setQueryData(queryKey, { agents: [], complete: true });
    await invalidateAgent(queryClient, SCOPE, "01M4CK1GWJARA9NEF7WAEV8QA1");
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
  });
});
