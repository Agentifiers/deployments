import { makePublicOpenApiSpec } from "@deployments-ai/api-contract";
import { describe, expect, test } from "bun:test";
import { createTenancyApi, type CreateTenancyApiOptions, type TenancyApiService } from "./index.ts";

const OPENAPI_URL = "https://api.example/v1/openapi.json";

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

const options = {
  authenticate: async () => null,
  authorize: async () => undefined,
  idempotency: { execute: async (input) => input.operation() },
  service: unusedService,
} satisfies CreateTenancyApiOptions;

describe("tenancy OpenAPI document", () => {
  test("builds the configured document on the first request and reuses it", async () => {
    let builds = 0;
    const fetch = createTenancyApi({
      ...options,
      openApiSpec: () => {
        builds += 1;
        return makePublicOpenApiSpec({ includeAgentEmail: false });
      },
    });
    expect(builds).toBe(0);

    const first = await fetch(new Request(OPENAPI_URL));
    const second = await fetch(new Request(OPENAPI_URL));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const expected = makePublicOpenApiSpec({ includeAgentEmail: false });
    expect(await first.json()).toEqual(expected);
    expect(await second.json()).toEqual(expected);
    expect(builds).toBe(1);
  });

  test("serves the full public document when no factory is configured", async () => {
    const response = await createTenancyApi(options)(new Request(OPENAPI_URL));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(makePublicOpenApiSpec());
  });
});
