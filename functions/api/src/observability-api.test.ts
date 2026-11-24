import { describe, expect, test } from "bun:test";
import { createObservabilityApi, createUnavailableObservabilityApi } from "./observability-api.ts";

const identity = {
  authentication: "tenant-jwt" as const,
  environmentIds: ["environment-1"],
  organizationIds: ["organization-1"],
  principalId: "principal-1",
  projectIds: ["project-1"],
  scopes: ["observability:read"],
};

describe("public observability API proxy", () => {
  test("authenticates published routes when the hot plane is disabled", async () => {
    const handler = createUnavailableObservabilityApi({
      authenticate: async (request) => (request.headers.has("authorization") ? identity : null),
      requestId: () => "request-disabled",
    });
    const request = (authorization?: string) =>
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          ...(authorization ? { authorization } : {}),
          "x-deployments-organization": "organization-1",
        },
      });
    expect((await handler(request()))?.status).toBe(401);
    const unavailable = await handler(request("Bearer user-token"));
    expect(unavailable?.status).toBe(503);
    expect(await unavailable?.json()).toMatchObject({
      code: "observability_unavailable",
      requestId: "request-disabled",
    });
  });

  test("derives tenant scope from authenticated grants and headers", async () => {
    let forwarded: Request | undefined;
    const handler = createObservabilityApi({
      authenticate: async () => identity,
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async (request, init) => {
        forwarded =
          request instanceof Request
            ? new Request(request, init)
            : new Request(request.toString(), init);
        return Response.json({ items: [] });
      },
      serviceToken: async () => "service-secret",
    });
    const response = await handler(
      new Request("https://api.example.test/v1/observability/traces?limit=10", {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-environment": "environment-1",
          "x-deployments-organization": "organization-1",
          "x-deployments-project": "project-1",
        },
      }),
    );
    expect(response?.status).toBe(200);
    expect(forwarded?.url).toBe("http://hot-plane.observability.internal:3000/traces?limit=10");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer service-secret");
    expect(forwarded?.headers.get("x-deployments-organization")).toBe("organization-1");
  });

  test("reads the service token once, and only after authentication succeeds", async () => {
    let reads = 0;
    const forwardedAuthorizations: (string | null)[] = [];
    const handler = createObservabilityApi({
      authenticate: async (request) => (request.headers.get("authorization") ? identity : null),
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async (_target, init) => {
        forwardedAuthorizations.push(new Headers(init?.headers).get("authorization"));
        return Response.json({ items: [] });
      },
      serviceToken: async () => {
        reads += 1;
        return "service-secret";
      },
    });
    const request = (authorization?: string) =>
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          ...(authorization ? { authorization } : {}),
          "x-deployments-organization": "organization-1",
        },
      });

    expect((await handler(request()))?.status).toBe(401);
    expect(reads).toBe(0);
    expect((await handler(request("Bearer user-token")))?.status).toBe(200);
    expect((await handler(request("Bearer user-token")))?.status).toBe(200);
    expect(reads).toBe(1);
    expect(forwardedAuthorizations).toEqual(["Bearer service-secret", "Bearer service-secret"]);
  });

  test("answers 503 when the service token read fails and reads it again next time", async () => {
    let reads = 0;
    const handler = createObservabilityApi({
      authenticate: async () => identity,
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async (_target, init) =>
        Response.json({ authorization: new Headers(init?.headers).get("authorization") }),
      serviceToken: async () => {
        reads += 1;
        if (reads === 1) throw new Error("Secrets Manager is unavailable.");
        return "service-secret";
      },
    });
    const request = () =>
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-organization": "organization-1",
        },
      });

    const failed = await handler(request());
    expect(failed?.status).toBe(503);
    expect(await failed?.json()).toMatchObject({ code: "observability_unavailable", status: 503 });
    expect(await (await handler(request()))?.json()).toEqual({
      authorization: "Bearer service-secret",
    });
    expect(reads).toBe(2);
  });

  test("records authenticated API-credential usage", async () => {
    const recorded: unknown[] = [];
    const handler = createObservabilityApi({
      authenticate: async () => ({
        ...identity,
        apiCredentialId: "credential-1",
        authentication: "api-credential",
      }),
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async () => Response.json({ items: [] }),
      recordApiCredentialUsage: async (input) => void recorded.push(input),
      serviceToken: async () => "service-secret",
    });
    const response = await handler(
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          authorization: "Bearer api-key",
          "x-deployments-organization": "organization-1",
        },
      }),
    );
    expect(response?.status).toBe(200);
    expect(recorded).toEqual([
      {
        apiCredentialId: "credential-1",
        environmentId: "environment-1",
        organizationId: "organization-1",
        outcome: "allowed",
        projectId: "project-1",
        requestMethod: "GET",
        requestPath: "/v1/observability/traces",
      },
    ]);
  });

  test("rejects a project outside the authenticated grant", async () => {
    const handler = createObservabilityApi({
      authenticate: async () => identity,
      baseUrl: "http://hot-plane.observability.internal:3000",
      serviceToken: async () => "service-secret",
    });
    const response = await handler(
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-organization": "organization-1",
          "x-deployments-project": "project-2",
        },
      }),
    );
    expect(response?.status).toBe(403);
  });

  test("preserves single-project and environment credential scope when headers are omitted", async () => {
    let forwarded: Request | undefined;
    const handler = createObservabilityApi({
      authenticate: async () => identity,
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async (request, init) => {
        forwarded =
          request instanceof Request
            ? new Request(request, init)
            : new Request(request.toString(), init);
        return Response.json({ items: [] });
      },
      serviceToken: async () => "service-secret",
    });
    const response = await handler(
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-organization": "organization-1",
        },
      }),
    );
    expect(response?.status).toBe(200);
    expect(forwarded?.headers.get("x-deployments-project")).toBe("project-1");
    expect(forwarded?.headers.get("x-deployments-environment")).toBe("environment-1");
  });

  test("requires an explicit project when a credential grants multiple projects", async () => {
    let fetchCalls = 0;
    const handler = createObservabilityApi({
      authenticate: async () => ({
        ...identity,
        projectIds: ["project-1", "project-2"],
      }),
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({ items: [] });
      },
      serviceToken: async () => "service-secret",
    });
    const response = await handler(
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-organization": "organization-1",
        },
      }),
    );
    expect(response?.status).toBe(400);
    expect(fetchCalls).toBe(0);
  });

  test("forwards and enforces an authenticated workspace boundary", async () => {
    let forwarded: Request | undefined;
    const handler = createObservabilityApi({
      authenticate: async () => ({ ...identity, workspaceId: "workspace-1" }),
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async (request, init) => {
        forwarded =
          request instanceof Request
            ? new Request(request, init)
            : new Request(request.toString(), init);
        return Response.json({ items: [] });
      },
      serviceToken: async () => "service-secret",
    });
    const allowed = await handler(
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-organization": "organization-1",
        },
      }),
    );
    expect(allowed?.status).toBe(200);
    expect(forwarded?.headers.get("x-deployments-workspace")).toBe("workspace-1");

    const denied = await handler(
      new Request("https://api.example.test/v1/observability/traces", {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-organization": "organization-1",
          "x-deployments-workspace": "workspace-2",
        },
      }),
    );
    expect(denied?.status).toBe(403);
  });

  test("forwards metric, tool, and trace filter parameters with the caller's scope", async () => {
    const forwarded: Request[] = [];
    const handler = createObservabilityApi({
      authenticate: async () => ({ ...identity, workspaceId: "workspace-1" }),
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async (request, init) => {
        forwarded.push(
          new Request(request instanceof Request ? request.url : String(request), init),
        );
        return Response.json({ items: [] });
      },
      serviceToken: async () => "service-secret",
    });
    const queries = [
      "/metrics?from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00Z&interval=day&groupBy=agentReleaseId",
      "/tools?from=2026-08-01T00:00:00.000Z&agentDeploymentId=01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "/traces?agentDefinitionId=01ARZ3NDEKTSV4RRFFQ69G5FAV&executionPurpose=preview&errorClass=RateLimitError",
      "/sessions/session-1/traces?agentReleaseId=01ARZ3NDEKTSV4RRFFQ69G5FAV&limit=5",
    ];
    for (const query of queries) {
      const response = await handler(
        new Request(`https://api.example.test/v1/observability${query}`, {
          headers: {
            authorization: "Bearer user-token",
            "x-deployments-environment": "environment-1",
            "x-deployments-organization": "organization-1",
            "x-deployments-project": "project-1",
          },
        }),
      );
      expect(response?.status).toBe(200);
    }
    expect(forwarded.map((request) => request.url)).toEqual(
      queries.map((query) => `http://hot-plane.observability.internal:3000${query}`),
    );
    for (const request of forwarded) {
      expect(request.headers.get("x-deployments-project")).toBe("project-1");
      expect(request.headers.get("x-deployments-environment")).toBe("environment-1");
      expect(request.headers.get("x-deployments-workspace")).toBe("workspace-1");
    }
  });

  test.each([
    "/metrics?interval=week",
    "/metrics?groupBy=tool",
    "/metrics?from=yesterday",
    "/metrics?interval=hour&interval=day",
    "/metrics?status=error",
    "/tools?agentDeploymentId=bad%20id",
    "/traces?executionPurpose=production",
    "/traces?errorClass=",
    "/traces?limit=101",
  ])("rejects invalid query parameters before calling the hot plane: %s", async (query) => {
    let upstreamCalls = 0;
    const handler = createObservabilityApi({
      authenticate: async () => identity,
      baseUrl: "http://hot-plane.observability.internal:3000",
      fetch: async () => {
        upstreamCalls += 1;
        return Response.json({ items: [] });
      },
      serviceToken: async () => "service-secret",
    });
    const response = await handler(
      new Request(`https://api.example.test/v1/observability${query}`, {
        headers: {
          authorization: "Bearer user-token",
          "x-deployments-organization": "organization-1",
        },
      }),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ code: "invalid_query_parameter" });
    expect(upstreamCalls).toBe(0);
  });
});
