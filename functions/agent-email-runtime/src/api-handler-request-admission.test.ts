import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import { createAgentEmailApiHandler, type AgentEmailHttpEvent } from "./api-handler.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
};

const listInboxes: AgentEmailHttpEvent = {
  headers: {
    authorization: "Bearer credential",
    "x-deployments-environment": scope.environmentId,
    "x-deployments-organization": scope.organizationId,
    "x-deployments-project": scope.projectId,
  },
  rawPath: "/v1/agent-email/inboxes",
  requestContext: { http: { method: "GET" }, requestId: "request_1" },
};

describe("agent email API request admission", () => {
  test("refuses a new inbox for a suspended organization but still lists inboxes", async () => {
    const executed: string[] = [];
    const { gate, placeHold } = standingInstallation({ organizationId: scope.organizationId });
    const handler = createAgentEmailApiHandler({
      authenticate: async () => ({
        authentication: "api-credential",
        permissions: ["agent-email:*"],
        principalId: "principal_1",
        scope,
      }),
      idempotency: { execute: (input) => input.operation() },
      organizationGate: gate,
      service: {
        execute: async (operation) => {
          executed.push(operation);
          return { items: [] };
        },
      },
    });
    await placeHold("abuse");

    const list = await handler(listInboxes);
    const create = await handler({
      ...listInboxes,
      body: JSON.stringify({ localPart: "support" }),
      requestContext: { http: { method: "POST" }, requestId: "request_2" },
    });

    expect(list.statusCode).toBe(200);
    expect([create.statusCode, JSON.parse(create.body).holds]).toEqual([
      403,
      [
        {
          customerMessage: "Update your payment method.",
          reason: "abuse",
          since: "2026-10-01T00:00:00.000Z",
        },
      ],
    ]);
    expect(executed).toEqual(["listInboxes"]);
  });

  test("answers an organization over its rate with the 429 problem before the operation runs", async () => {
    const executed: string[] = [];
    const handler = createAgentEmailApiHandler({
      authenticate: async () => ({
        permissions: ["agent-email:*"],
        principalId: "principal_1",
        scope,
      }),
      idempotency: { execute: (input) => input.operation() },
      organizationGate: standingInstallation({
        defaultLimits: { apiRequestBurst: 2, apiRequestsPerSecond: 1 },
        organizationId: scope.organizationId,
      }).gate,
      service: {
        execute: async (operation) => {
          executed.push(operation);
          return { items: [] };
        },
      },
    });

    const results = [
      await handler(listInboxes),
      await handler(listInboxes),
      await handler(listInboxes),
    ];

    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 429]);
    expect(executed).toEqual(["listInboxes", "listInboxes"]);
    expect(results[2]).toEqual({
      body: JSON.stringify({
        type: "https://docs.deployments.ai/errors/organization-rate-limited",
        title: "The organization exceeded its API request rate limit.",
        status: 429,
        code: "organization_rate_limited",
        detail: "This organization is limited to 1 requests per second with a burst of 2.",
        requestId: "request_1",
      }),
      headers: {
        "content-type": "application/problem+json",
        "retry-after": "1",
        "x-request-id": "request_1",
      },
      statusCode: 429,
    });
  });
});
