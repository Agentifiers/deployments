import { describe, expect, test } from "bun:test";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { createBrainApi } from "./api.ts";
import { createHostedBrainMcp } from "./mcp.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const BRAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const QUERY_ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

function request(method: string, params?: Readonly<Record<string, unknown>>) {
  return new Request("https://api.example/v1/mcp/brain", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    headers: {
      authorization: "Bearer tenant-token",
      "content-type": "application/json",
      "x-deployments-environment": ENVIRONMENT_ID,
      "x-deployments-organization": ORGANIZATION_ID,
      "x-deployments-project": PROJECT_ID,
    },
    method: "POST",
  });
}

describe("hosted Brain MCP", () => {
  test("publishes native Brain tools only after platform authentication", async () => {
    const handler = createHostedBrainMcp(async (forwarded) => {
      expect(forwarded.headers.get("authorization")).toBe("Bearer tenant-token");
      return Response.json({ items: [] });
    });
    const response = await handler(request("tools/list"));
    const body = (await response?.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "brain.search",
      "brain.ask",
      "brain.get_document",
      "brain.get_entity",
      "brain.capture",
    ]);
  });

  test("routes search through the same public Brain authorization boundary", async () => {
    const calls: { body?: unknown; path: string }[] = [];
    const handler = createHostedBrainMcp(async (forwarded) => {
      const path = new URL(forwarded.url).pathname;
      calls.push({
        ...(forwarded.method === "POST" ? { body: await forwarded.json() } : {}),
        path,
      });
      return path === "/v1/brains/search"
        ? Response.json({ queryAttemptId: QUERY_ATTEMPT_ID, results: [] })
        : Response.json({ items: [] });
    });
    const response = await handler(
      request("tools/call", {
        arguments: { brainIds: ["brain-1"], query: "decision" },
        name: "brain.search",
      }),
    );
    expect(await response?.json()).toMatchObject({ result: { isError: false } });
    expect(calls).toEqual([
      { path: "/v1/brains" },
      { body: { brainIds: ["brain-1"], query: "decision" }, path: "/v1/brains/search" },
    ]);
  });

  test("forwards billable tenant scope through the real Brain API boundary", async () => {
    const identity = {
      authentication: "tenant-jwt",
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["brains:*"],
    } as const satisfies ApiIdentity;
    const brainApi = createBrainApi({
      authenticate: async () => identity,
      idempotency: { execute: async (input) => input.operation() },
      requestId: () => "request_mcp_test",
      service: {
        invoke: async (routeName, invocation) => {
          if (routeName === "searchBrains") {
            expect(invocation.identity.projectIds).toEqual([PROJECT_ID]);
            expect(invocation.identity.environmentIds).toEqual([ENVIRONMENT_ID]);
            return { queryAttemptId: QUERY_ATTEMPT_ID, results: [] };
          }
          if (routeName === "listBrains") return { items: [] };
          throw new Error(`Unexpected route ${routeName}.`);
        },
      },
    });
    const handler = createHostedBrainMcp(brainApi);

    const response = await handler(
      request("tools/call", {
        arguments: { brainIds: [BRAIN_ID], query: "decision" },
        name: "brain.search",
      }),
    );

    expect(await response?.json()).toMatchObject({ result: { isError: false } });
  });

  test("does not advertise tools when the platform credential is rejected", async () => {
    const handler = createHostedBrainMcp(async () =>
      Response.json({ code: "unauthorized" }, { status: 401 }),
    );
    expect((await handler(request("tools/list")))?.status).toBe(401);
  });
});
