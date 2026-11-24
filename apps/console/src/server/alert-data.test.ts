import { describe, expect, test } from "bun:test";
import { loadMonitorsRoute } from "./alert-data.ts";
import { createPlatformApiClient } from "./platform-api.ts";

const ORG = "01K000000000000000000000G1";

function platform(response: () => Response) {
  return createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async () => response()) as unknown as typeof globalThis.fetch,
  });
}

const problem = (status: number, code: string) => () =>
  Response.json({ code, status, title: "Request failed" }, { status });

describe("loadMonitorsRoute", () => {
  test("a path no function serves means the install has no monitors API", async () => {
    expect(await loadMonitorsRoute("token", ORG, platform(problem(404, "route_not_found")))).toBe(
      "not_deployed",
    );
  });

  test("a scope denial or an answer means the API is deployed", async () => {
    expect(
      await loadMonitorsRoute("token", ORG, platform(problem(403, "insufficient_scope"))),
    ).toBe("deployed");
    expect(
      await loadMonitorsRoute(
        "token",
        ORG,
        platform(() => Response.json({ items: [] })),
      ),
    ).toBe("deployed");
  });

  test("any other failure is not mistaken for either", async () => {
    expect(
      loadMonitorsRoute("token", ORG, platform(problem(503, "service_unavailable"))),
    ).rejects.toMatchObject({ problem: { status: 503 } });
  });
});
