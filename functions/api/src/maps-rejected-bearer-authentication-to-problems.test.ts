import { describe, expect, test } from "bun:test";
import { ApiProblem, createTenancyApi, type ApiIdentity, type TenancyApiService } from "./index.ts";

/** Authentication fails before any tenancy operation runs. */
const unusedService = new Proxy(
  {},
  {
    get: () =>
      new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error("Unexpected service operation.");
          },
        },
      ),
  },
) as TenancyApiService;

async function listOrganizations(authenticate: () => Promise<ApiIdentity | null>) {
  const fetch = createTenancyApi({
    authenticate,
    authorize: async () => undefined,
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "req_auth",
    service: unusedService,
  });
  const response = await fetch(
    new Request("https://api.example/v1/organizations", {
      headers: { authorization: "Bearer token" },
    }),
  );
  return {
    body: await response.json(),
    contentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-request-id"),
    status: response.status,
  };
}

describe("bearer authentication failures", () => {
  test("maps a rejected ApiProblem to its problem response", async () => {
    expect(
      await listOrganizations(async () => {
        throw new ApiProblem(401, "invalid_token", "Token expired.");
      }),
    ).toEqual({
      body: {
        code: "invalid_token",
        requestId: "req_auth",
        status: 401,
        title: "Token expired.",
        type: "https://docs.deployments.ai/errors/invalid-token",
      },
      contentType: "application/problem+json",
      requestId: "req_auth",
      status: 401,
    });
  });

  test("maps an unexpected authenticator failure to an internal error", async () => {
    expect(
      await listOrganizations(async () => {
        throw new Error("identity provider unavailable");
      }),
    ).toEqual({
      body: {
        code: "internal_error",
        requestId: "req_auth",
        status: 500,
        title: "Internal server error",
        type: "https://docs.deployments.ai/errors/internal-error",
      },
      contentType: "application/problem+json",
      requestId: "req_auth",
      status: 500,
    });
  });
});
