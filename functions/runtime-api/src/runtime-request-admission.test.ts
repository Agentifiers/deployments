import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import { createRuntimeApiHandler } from "./runtime-handler.ts";
import { environmentId, ids, organizationId, projectId } from "./runtime-lifecycle.fixture.ts";
import type { HttpApiEvent, RuntimeApiDependencies } from "./runtime-support.ts";

const cancelRun: HttpApiEvent = {
  headers: { authorization: "Bearer header.payload.signature", "x-request-id": "req_runtime" },
  rawPath: `/v1/runs/${ids[10]}/cancel`,
  requestContext: { http: { method: "POST" } },
};

const viewer = async () => ({
  kind: "human",
  organizationRole: "viewer",
  platformAdministrator: false,
  principalId: ids[20]!,
  scope: { environmentId, organizationId, projectId },
  scopes: ["runs:write"],
});

describe("runtime API request admission", () => {
  test("refuses a run retry for a suspended organization but still lets it cancel runs", async () => {
    const { gate, placeHold } = standingInstallation({ organizationId });
    const handler = createRuntimeApiHandler({
      authenticateHuman: viewer,
      organizationGate: gate,
    } as unknown as RuntimeApiDependencies);
    await placeHold("payment");

    const retry = await handler({ ...cancelRun, rawPath: `/v1/runs/${ids[10]}/retry` });
    const cancel = await handler(cancelRun);

    expect([retry.statusCode, JSON.parse(retry.body).code]).toEqual([
      403,
      "organization_suspended",
    ]);
    expect([cancel.statusCode, JSON.parse(cancel.body).code]).toEqual([403, "insufficient_role"]);
  });

  test("refuses an artifact access link under an abuse hold but not under a payment hold", async () => {
    const accessUrl: HttpApiEvent = {
      ...cancelRun,
      body: JSON.stringify({ expiresInSeconds: 60 }),
      rawPath: `/v1/artifacts/${ids[11]}/access-urls`,
    };
    const outcome = async (reason: "abuse" | "payment") => {
      const { gate, placeHold } = standingInstallation({ organizationId });
      const handler = createRuntimeApiHandler({
        authenticateHuman: viewer,
        organizationGate: gate,
      } as unknown as RuntimeApiDependencies);
      await placeHold(reason);
      const result = await handler(accessUrl);
      return [result.statusCode, JSON.parse(result.body).code];
    };

    expect(await outcome("abuse")).toEqual([403, "organization_suspended"]);
    expect(await outcome("payment")).toEqual([403, "insufficient_scope"]);
  });

  test("answers an organization over its rate with the 429 problem right after authentication", async () => {
    const handler = createRuntimeApiHandler({
      authenticateHuman: viewer,
      organizationGate: standingInstallation({
        defaultLimits: { apiRequestBurst: 2, apiRequestsPerSecond: 1 },
        organizationId,
      }).gate,
    } as unknown as RuntimeApiDependencies);

    const results = [await handler(cancelRun), await handler(cancelRun), await handler(cancelRun)];

    expect(results.map((result) => result.statusCode)).toEqual([403, 403, 429]);
    expect(results[2]).toEqual({
      body: JSON.stringify({
        type: "https://docs.deployments.ai/errors/organization-rate-limited",
        title: "The organization exceeded its API request rate limit.",
        status: 429,
        code: "organization_rate_limited",
        detail: "This organization is limited to 1 requests per second with a burst of 2.",
        requestId: "req_runtime",
      }),
      headers: {
        "content-type": "application/problem+json",
        "retry-after": "1",
        "x-request-id": "req_runtime",
      },
      statusCode: 429,
    });
  });
});
