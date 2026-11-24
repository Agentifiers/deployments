import type { MemoryPlatform } from "@deployments-ai/memory";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import { handleMemoryApi } from "./api.ts";
import { event, ids } from "./api-test-support.ts";

const GRANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB9";

describe("memory API request admission", () => {
  for (const reason of ["payment", "abuse"] as const) {
    test(`an agent token for an organization under a ${reason} hold reads and revokes but cannot create`, async () => {
      const { advance, gate, placeHold, releaseHold } = standingInstallation({
        organizationId: ids.organization,
      });
      const dependencies = {
        organizationGate: gate,
        platform: {
          createMemorySpace: async (_tenant: unknown, input: { readonly name: string }) => ({
            name: input.name,
          }),
          listMemorySpacesPage: async () => ({ items: [] }),
          revokeMemorySpaceGrant: async (_tenant: unknown, grantId: string) => ({ id: grantId }),
        } as unknown as MemoryPlatform,
      };
      const create = event("/v1/memory-spaces", "POST", { name: "notes" });
      await placeHold(reason);

      const results = [
        await handleMemoryApi(event("/v1/memory-spaces", "GET"), dependencies),
        await handleMemoryApi(create, dependencies),
        await handleMemoryApi(event(`/v1/memory-space-grants/${GRANT_ID}`, "DELETE"), dependencies),
      ];
      await releaseHold(reason);
      advance(5_000);
      results.push(await handleMemoryApi(create, dependencies));

      expect(
        results.map((result) => [result.statusCode, JSON.parse(result.body ?? "{}").code ?? "ok"]),
      ).toEqual([
        [200, "ok"],
        [403, "organization_suspended"],
        [200, "ok"],
        [201, "ok"],
      ]);
    });
  }

  test("answers an organization over its rate with the 429 problem before routing", async () => {
    const listed: string[] = [];
    const dependencies = {
      organizationGate: standingInstallation({
        defaultLimits: { apiRequestBurst: 2, apiRequestsPerSecond: 1 },
        organizationId: ids.organization,
      }).gate,
      platform: {
        listMemorySpacesPage: async (tenant: { readonly organizationId: string }) => {
          listed.push(tenant.organizationId);
          return { items: [] };
        },
      } as unknown as MemoryPlatform,
    };
    const request = event("/v1/memory-spaces", "GET");

    const results = [
      await handleMemoryApi(request, dependencies),
      await handleMemoryApi(request, dependencies),
      await handleMemoryApi(request, dependencies),
    ];

    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 429]);
    expect(listed).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FA5", "01ARZ3NDEKTSV4RRFFQ69G5FA5"]);
    expect<unknown>(results[2]).toEqual({
      body: JSON.stringify({
        type: "https://docs.deployments.ai/errors/organization-rate-limited",
        title: "The organization exceeded its API request rate limit.",
        status: 429,
        code: "organization_rate_limited",
        detail: "This organization is limited to 1 requests per second with a burst of 2.",
        requestId: "request-1",
      }),
      headers: {
        "content-type": "application/problem+json",
        "retry-after": "1",
        "x-request-id": "request-1",
      },
      statusCode: 429,
    });
  });
});
