import { describe, expect, test } from "bun:test";
import { RUNTIME_API_ROUTES } from "@deployments-ai/api-contract/runtime";
import { createRuntimeApiHandler } from "./runtime-handler.ts";
import type { HttpApiEvent, RuntimeApiDependencies } from "./runtime-support.ts";

const publicId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function event(method: string, path: string): HttpApiEvent {
  return {
    headers: {},
    rawPath: path,
    requestContext: { http: { method } },
  };
}

describe("runtime handler route manifest", () => {
  test("recognizes every declared route before authentication", async () => {
    const handler = createRuntimeApiHandler({} as RuntimeApiDependencies);

    for (const route of RUNTIME_API_ROUTES) {
      const path = route.path.replaceAll(/:[^/]+/gu, publicId);
      const result = await handler(event(route.method, path));
      expect(JSON.parse(result.body ?? "{}")).toMatchObject({
        code: "unauthorized",
        status: 401,
      });
    }
  });

  test("rejects undeclared routes before authentication", async () => {
    const handler = createRuntimeApiHandler({} as RuntimeApiDependencies);
    const result = await handler(event("GET", "/v1/runtime-not-declared"));

    expect(JSON.parse(result.body ?? "{}")).toMatchObject({
      code: "route_not_found",
      status: 404,
    });
  });

  test("rejects empty route parameters before authentication", async () => {
    const handler = createRuntimeApiHandler({} as RuntimeApiDependencies);
    const result = await handler(event("GET", "/v1/threads//messages"));

    expect(JSON.parse(result.body ?? "{}")).toMatchObject({
      code: "route_not_found",
      status: 404,
    });
  });
});
