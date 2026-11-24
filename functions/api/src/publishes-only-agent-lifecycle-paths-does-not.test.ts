import { PersistenceError } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { createAgentApi, type AgentLifecycleApiService, type ApiInvocation } from "./index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

function agentService() {
  const unavailable = async (_invocation: ApiInvocation<unknown>): Promise<never> => {
    throw new Error("Unexpected service operation.");
  };
  return {
    agentDefinitions: {
      list: async () => ({ items: [], nextCursor: null }),
      create: unavailable,
      get: unavailable,
      update: unavailable,
      archive: unavailable,
    },
    agentReleases: {
      list: async () => ({ items: [], nextCursor: null }),
      publish: unavailable,
      get: unavailable,
      promote: unavailable,
      archive: unavailable,
    },
    agentDeployments: {
      list: async () => ({ items: [], nextCursor: null }),
      create: unavailable,
      get: unavailable,
      update: unavailable,
      stop: unavailable,
      startCanary: unavailable,
      promoteCanary: unavailable,
      abortCanary: unavailable,
    },
  } as AgentLifecycleApiService;
}

describe("agent-only HTTP API", () => {
  test("publishes only agent lifecycle paths and does not authenticate unsupported tenancy routes", async () => {
    let authenticationCalls = 0;
    const fetch = createAgentApi({
      authenticate: async () => {
        authenticationCalls += 1;
        return {
          principalId: PRINCIPAL_ID,
          scopes: ["agents:read"],
          organizationIds: [ORGANIZATION_ID],
          projectIds: [PROJECT_ID],
          environmentIds: [ENVIRONMENT_ID],
        };
      },
      idempotency: {
        execute: async (input) => input.operation(),
      },
      requestId: () => "req_test",
      service: agentService(),
    });

    const openApi = await fetch(new Request("https://api.example/v1/openapi.json"));
    const document = (await openApi.json()) as {
      readonly paths: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(document.paths)).toEqual([
      "/v1/agent-definitions",
      "/v1/agent-definitions/{id}",
      "/v1/agent-definitions/{id}/releases",
      "/v1/agent-releases/{id}",
      "/v1/agent-releases/{id}/promote",
      "/v1/agent-deployments",
      "/v1/agent-deployments/{id}",
      "/v1/agent-deployments/{id}/canary",
      "/v1/agent-deployments/{id}/canary/promote",
      "/v1/agent-deployments/{id}/canary/abort",
    ]);
    const unsupported = await fetch(new Request("https://api.example/v1/organizations"));
    expect(unsupported.status).toBe(404);
    expect(authenticationCalls).toBe(0);

    const listed = await fetch(
      new Request("https://api.example/v1/agent-definitions?limit=10", {
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
      }),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ items: [], nextCursor: null });
    expect(authenticationCalls).toBe(1);
  });

  test("rejects an agent route without a bearer identity", async () => {
    const fetch = createAgentApi({
      authenticate: async () => null,
      idempotency: { execute: async (input) => input.operation() },
      service: agentService(),
    });
    const response = await fetch(
      new Request("https://api.example/v1/agent-definitions", {
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
      }),
    );
    expect(response.status).toBe(401);
  });

  test("maps persistence failures from durable idempotency", async () => {
    const fetch = createAgentApi({
      authenticate: async () => ({
        environmentIds: [ENVIRONMENT_ID],
        organizationIds: [ORGANIZATION_ID],
        principalId: PRINCIPAL_ID,
        projectIds: [PROJECT_ID],
        scopes: ["agents:write"],
      }),
      idempotency: {
        execute: async () => {
          throw new PersistenceError(
            "conflict",
            "idempotency_conflict",
            "The idempotency key conflicts.",
          );
        },
      },
      requestId: () => "req_test",
      service: agentService(),
    });

    const response = await fetch(
      new Request(`https://api.example/v1/agent-definitions/${ENVIRONMENT_ID}`, {
        body: JSON.stringify({ expectedVersion: 0 }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "archive-definition",
          "x-deployments-environment": ENVIRONMENT_ID,
        },
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "idempotency_conflict",
      requestId: "req_test",
      status: 409,
    });
  });
});
