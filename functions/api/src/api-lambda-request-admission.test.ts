import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import {
  makeInMemoryRequestRateStore,
  makeOrganizationRequestLimiter,
} from "@deployments-ai/tenant-limits";
import { describe, expect, test } from "bun:test";
import { createApiLambdaHandler, makeApiFoundation } from "./api-lambda-foundation.ts";
import type { ApiIdentity } from "./api-service-contracts.ts";
import type { HttpApiV2Event } from "./lambda.ts";

const LIMITS = {
  activeSandboxes: 8,
  apiRequestBurst: 2,
  apiRequestsPerSecond: 1,
  concurrentRuns: 8,
};

function harness(identityFor: (token: string) => ApiIdentity | null) {
  const authentications: string[] = [];
  const consumed: string[] = [];
  const store = makeInMemoryRequestRateStore();
  const handler = createApiLambdaHandler(
    ({ authenticate }) =>
      async (request) => {
        const identity = await authenticate(request);
        if (!identity) return new Response("unauthorized", { status: 401 });
        return new Response(`routed ${identity.principalId}`);
      },
    {
      dependencies: () => ({
        foundation: {
          ...makeApiFoundation({
            DEPLOYMENTS_AI_API_JWT_AUDIENCE: "platform-api",
            DEPLOYMENTS_AI_API_JWT_ISSUER: "https://issuer.example.test",
          }),
          authenticate: async (request) => {
            const token = request.headers.get("authorization") ?? "";
            authentications.push(token);
            return identityFor(token);
          },
        },
        gate: standingInstallation({
          defaultLimits: LIMITS,
          limiter: makeOrganizationRequestLimiter({
            service: "tenancy-api",
            store: {
              consume: (organizationId, parameters, nowUs) => {
                consumed.push(organizationId);
                return store.consume(organizationId, parameters, nowUs);
              },
            },
            writeMetric: () => {},
          }),
        }).gate,
      }),
    },
  );
  const request = (token?: string): HttpApiV2Event => ({
    ...(token ? { headers: { authorization: token } } : {}),
    rawPath: "/v1/projects",
    requestContext: { domainName: "api.example.test", http: { method: "GET" } },
  });
  return { authentications, consumed, handler, request };
}

describe("API Lambda request admission", () => {
  test("answers an organization over its rate with the 429 problem before routing", async () => {
    const { authentications, handler, request } = harness((token) => ({
      organizationIds: ["01J9ZQ5Y5V7Q8R3X2K4M6N8P0A"],
      principalId: token,
      scopes: [],
    }));

    const first = await handler(request("member"));
    const second = await handler(request("member"));
    const limited = await handler(request("member"));

    expect([first.statusCode, first.body]).toEqual([200, "routed member"]);
    expect([second.statusCode, second.body]).toEqual([200, "routed member"]);
    const requestId = limited.headers["x-request-id"];
    expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/u);
    expect(limited).toEqual({
      body: JSON.stringify({
        type: "https://docs.deployments.ai/errors/organization-rate-limited",
        title: "The organization exceeded its API request rate limit.",
        status: 429,
        code: "organization_rate_limited",
        detail: "This organization is limited to 1 requests per second with a burst of 2.",
        requestId,
      }),
      headers: {
        "content-type": "application/problem+json",
        "retry-after": "1",
        "x-request-id": requestId!,
      },
      isBase64Encoded: false,
      statusCode: 429,
    });
    expect(authentications).toEqual(["member", "member", "member"]);
  });

  test("passes unauthenticated requests through to the route's 401 without charging anyone", async () => {
    const { consumed, handler, request } = harness(() => null);

    const results = [await handler(request()), await handler(request()), await handler(request())];

    expect(results.map((result) => result.statusCode)).toEqual([401, 401, 401]);
    expect(consumed).toEqual([]);
  });

  test("does not charge identities that span organizations", async () => {
    const { consumed, handler, request } = harness((token) => ({
      organizationIds:
        token === "admin" ? "*" : ["01J9ZQ5Y5V7Q8R3X2K4M6N8P0A", "01J9ZQ5Y5V7Q8R3X2K4M6N8P0B"],
      principalId: token,
      scopes: [],
    }));

    const results = [];
    for (const token of ["admin", "admin", "admin", "multi", "multi", "multi"]) {
      results.push(await handler(request(token)));
    }

    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(consumed).toEqual([]);
  });
});
