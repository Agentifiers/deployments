import { describe, expect, test } from "bun:test";
import { PUBLIC_API_ROUTES, publicRouteContract } from "@deployments-ai/api-contract/product";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";
import {
  collectPages,
  createPlatformApiClient,
  PlatformRequestError,
  RAW_CONTENT_ROUTES,
  type RouteInput,
} from "./platform-api.ts";

const ORGANIZATION_ID = "01K0000000000000000000000A";
const PROJECT_ID = "01K0000000000000000000000B";
const ENVIRONMENT_ID = "01K0000000000000000000000C";

const environment = {
  createdAt: "2026-10-01T12:00:00.000Z",
  id: ENVIRONMENT_ID,
  name: "Production",
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  slug: "production",
  status: "active",
  type: "production",
  updatedAt: "2026-10-01T12:00:00.000Z",
  version: 1,
};

function recordingClient(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    }) as typeof globalThis.fetch,
  });
  return { client, requests };
}

describe("callRoute", () => {
  test("builds the request from the registry and decodes the response schema", async () => {
    const { client, requests } = recordingClient(() => Response.json(environment));
    const result = await client.callRoute(
      "getEnvironment",
      {
        path: { id: ENVIRONMENT_ID },
        scope: {
          environmentId: ENVIRONMENT_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
        },
      },
      "token-1",
    );
    expect(result.type).toBe("production");
    const [request] = requests;
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe(`https://api.example.test/v1/environments/${ENVIRONMENT_ID}`);
    expect(request?.headers.get("authorization")).toBe("Bearer token-1");
    expect(request?.headers.get("x-deployments-organization")).toBe(ORGANIZATION_ID);
    expect(request?.headers.get("x-deployments-project")).toBe(PROJECT_ID);
    expect(request?.headers.get("x-deployments-environment")).toBe(ENVIRONMENT_ID);
  });

  test("sends declared query parameters and rejects undeclared ones", async () => {
    const { client, requests } = recordingClient(() => Response.json({ items: [] }));
    await client.callRoute(
      "listProjects",
      { query: { cursor: undefined, limit: 100 }, scope: { organizationId: ORGANIZATION_ID } },
      "token-1",
    );
    expect(requests[0]?.url).toBe("https://api.example.test/v1/projects?limit=100");
    expect(
      client.callRoute(
        "listProjects",
        // @ts-expect-error -- `status` is not a query parameter of listProjects.
        { query: { status: "active" }, scope: { organizationId: ORGANIZATION_ID } },
        "token-1",
      ),
    ).rejects.toThrow('listProjects has no query parameter "status".');
  });

  test("requires and sends every tenant header on optional-tenant routes", async () => {
    const { client, requests } = recordingClient(() => Response.json({ items: [] }));
    const scope = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    await client.callRoute("listWorkflowExecutions", { scope }, "token-1");
    const headers = requests[0]?.headers;
    expect([
      headers?.get("x-deployments-organization"),
      headers?.get("x-deployments-project"),
      headers?.get("x-deployments-environment"),
    ]).toEqual([ORGANIZATION_ID, PROJECT_ID, ENVIRONMENT_ID]);
    const organizationOnly = {
      // @ts-expect-error -- without all three headers the runtime API answers 403 and Memory 401.
      scope: { organizationId: ORGANIZATION_ID },
    } satisfies RouteInput<"listWorkflowExecutions">;
    expect(organizationOnly.scope).toEqual({ organizationId: ORGANIZATION_ID });
  });

  test("decodes the problem envelope into PlatformApiError", async () => {
    const { client } = recordingClient(() =>
      Response.json(
        {
          code: "environment_scope_violation",
          detail: "The credential cannot access the requested environment.",
          requestId: "req-1",
          status: 403,
          title: "Forbidden",
        },
        { headers: { "content-type": "application/problem+json" }, status: 403 },
      ),
    );
    const error = await client
      .callRoute(
        "getOrganization",
        { path: { id: ORGANIZATION_ID }, scope: { organizationId: ORGANIZATION_ID } },
        "token-1",
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).operation).toBe("getOrganization");
    expect((error as PlatformApiError).problem).toEqual({
      code: "environment_scope_violation",
      detail: "The credential cannot access the requested environment.",
      requestId: "req-1",
      status: 403,
      title: "Forbidden",
    });
  });

  test("falls back to the HTTP status when the error body is not a problem", async () => {
    const { client } = recordingClient(
      () =>
        new Response("upstream timeout", {
          headers: { "x-request-id": "req-2" },
          status: 504,
          statusText: "Gateway Timeout",
        }),
    );
    const error = await client.callRoute("getIdentity", {}, "token-1").catch((caught) => caught);
    expect((error as PlatformApiError).problem).toEqual({
      requestId: "req-2",
      status: 504,
      title: "Gateway Timeout",
    });
  });

  test("treats 401 as a missing session", async () => {
    const { client } = recordingClient(() => new Response(null, { status: 401 }));
    expect(client.callRoute("getIdentity", {}, "expired")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  test("rejects responses outside the contract", async () => {
    const { client } = recordingClient(() => Response.json({ ...environment, type: "qa" }));
    expect(
      client.callRoute(
        "getEnvironment",
        {
          path: { id: ENVIRONMENT_ID },
          scope: {
            environmentId: ENVIRONMENT_ID,
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
          },
        },
        "token-1",
      ),
    ).rejects.toBeInstanceOf(PlatformRequestError);
  });

  test("sends raw content as the body with its own content type", async () => {
    const ticket = {
      brainId: "01K0000000000000000000000D",
      createdAt: "2026-10-01T12:00:00.000Z",
      expectedByteSize: 3,
      expectedContentHash: `sha256:${"a".repeat(64)}`,
      expiresAt: "2026-10-01T12:05:00.000Z",
      id: "01K0000000000000000000000F",
      mediaType: "text/markdown",
      organizationId: ORGANIZATION_ID,
      sourceId: "01K0000000000000000000000E",
      status: "completed",
      updatedAt: "2026-10-01T12:00:01.000Z",
      version: 2,
    };
    const { client, requests } = recordingClient(() => Response.json(ticket));
    const result = await client.callRoute(
      "uploadBrainContent",
      {
        content: { bytes: new TextEncoder().encode("# a"), contentType: "text/markdown" },
        idempotencyKey: "k1:content",
        path: { brainId: ticket.brainId, sourceId: ticket.sourceId, ticketId: ticket.id },
        scope: { organizationId: ORGANIZATION_ID },
      },
      "token-1",
    );
    expect(result.status).toBe("completed");
    const [request] = requests;
    expect(request?.method).toBe("PUT");
    expect(request?.headers.get("content-type")).toBe("text/markdown");
    expect(await request?.text()).toBe("# a");
    expect(
      client.callRoute(
        "createBrainSource",
        {
          body: { kind: "upload", name: "uploads" },
          // @ts-expect-error -- only RAW_CONTENT_ROUTES take raw content.
          content: { bytes: new Uint8Array([1]), contentType: "text/plain" },
          idempotencyKey: "k2",
          path: { brainId: ticket.brainId },
          scope: { organizationId: ORGANIZATION_ID },
        },
        "token-1",
      ),
    ).rejects.toThrow("createBrainSource takes a JSON body, not raw content.");
  });
});

describe("RAW_CONTENT_ROUTES", () => {
  test("names only PUT operations whose contract declares no JSON body", () => {
    const routes = PUBLIC_API_ROUTES.filter((route) =>
      Object.hasOwn(RAW_CONTENT_ROUTES, route.name),
    ).map((route) => {
      const { method, requestBody } = publicRouteContract(route.name);
      return { method, name: route.name, requestBody };
    });
    expect<unknown>(routes).toEqual(
      Object.keys(RAW_CONTENT_ROUTES).map((name) => ({
        method: "PUT",
        name,
        requestBody: undefined,
      })),
    );
  });
});

describe("collectPages", () => {
  test("follows cursors until the list ends", async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string | null }> = {
      start: { items: [1, 2], nextCursor: "b" },
      b: { items: [3], nextCursor: null },
    };
    expect(collectPages(async (cursor) => pages[cursor ?? "start"]!)).resolves.toEqual([1, 2, 3]);
  });

  test("stops on a repeated cursor", async () => {
    expect(collectPages(async () => ({ items: [1], nextCursor: "same" }))).rejects.toBeInstanceOf(
      PlatformRequestError,
    );
  });
});
