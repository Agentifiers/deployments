import type { DynamoDatabaseService } from "@deployments-ai/db";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import { createApiLambdaHandler, makeApiFoundation } from "./api-lambda-foundation.ts";
import { databaseWithRecords } from "./application-auth-test-support.ts";
import { createApplicationAuthenticator } from "./application-auth.ts";
import { createTenancyApi, type TenancyApiService } from "./index.ts";

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

/** A store that fails every read, so any credential lookup surfaces in the response. */
const unreachableStore: DynamoDatabaseService = {
  ...databaseWithRecords(new Map()),
  getRecord: async () => {
    throw new Error("The control table is unreachable.");
  },
};

async function whoami(token: string) {
  const handler = createApiLambdaHandler(
    ({ authenticate }) =>
      createTenancyApi({
        authenticate,
        authorize: async () => undefined,
        idempotency: { execute: async (input) => input.operation() },
        service: unusedService,
      }),
    {
      dependencies: () => ({
        foundation: {
          ...makeApiFoundation({
            DEPLOYMENTS_AI_API_JWT_AUDIENCE: "api",
            DEPLOYMENTS_AI_API_JWT_ISSUER: "https://auth.deployments.ai",
          }),
          authenticate: createApplicationAuthenticator({
            database: unreachableStore,
            jwt: { audience: "api", issuer: "https://auth.deployments.ai" },
          }),
        },
        gate: standingInstallation().gate,
      }),
    },
  );
  const result = await handler({
    headers: { authorization: `Bearer ${token}` },
    rawPath: "/v1/whoami",
    requestContext: { domainName: "api.example.test", http: { method: "GET" } },
  });
  const body: unknown = JSON.parse(result.body);
  return { body, status: result.statusCode };
}

describe("platform API authentication of directory tokens", () => {
  test("answers a SCIM token on a /v1 route as unauthenticated without looking up an API key", async () => {
    expect(await whoami("dpl_scim_unknown-directory-secret")).toMatchObject({
      body: { code: "unauthorized" },
      status: 401,
    });
    expect(await whoami("dpl_live_unknown-api-key")).toMatchObject({
      body: { code: "internal_error" },
      status: 500,
    });
  });
});
