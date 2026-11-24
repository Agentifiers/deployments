import type { HoldReason } from "@deployments-ai/db";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import { createApiLambdaHandler, makeApiFoundation } from "./api-lambda-foundation.ts";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { fixture, ORGANIZATION_ID, PRINCIPAL_ID } from "./governance-api.fixture.ts";

const OWNER: ApiIdentity = {
  authentication: "tenant-jwt",
  organizationIds: [ORGANIZATION_ID],
  organizationRole: "owner",
  principalId: PRINCIPAL_ID,
  scopes: ["governance:*"],
};

async function requestErasureWhileHeld(reason: HoldReason) {
  const installation = standingInstallation({ organizationId: ORGANIZATION_ID });
  await installation.placeHold(reason, "Held for review.");
  const api = fixture();
  const handler = createApiLambdaHandler(() => api.handler, {
    dependencies: () => ({
      foundation: {
        ...makeApiFoundation({
          DEPLOYMENTS_AI_API_JWT_AUDIENCE: "platform-api",
          DEPLOYMENTS_AI_API_JWT_ISSUER: "https://issuer.example.test",
        }),
        authenticate: async () => OWNER,
      },
      gate: installation.gate,
    }),
  });
  const result = await handler({
    body: JSON.stringify({ confirmation: "ERASE" }),
    headers: {
      authorization: "Bearer owner",
      "content-type": "application/json",
      "idempotency-key": "erase-held-organization",
      "x-deployments-organization": ORGANIZATION_ID,
    },
    rawPath: `/v1/organizations/${ORGANIZATION_ID}/erasures`,
    requestContext: { domainName: "api.example.test", http: { method: "POST" } },
  });
  return {
    body: JSON.parse(result.body) as unknown,
    operations: [...api.operations.values()].map(({ kind, status }) => ({ kind, status })),
    queued: api.queued.length,
    status: result.statusCode,
  };
}

describe("tenant erasure request on organization standing", () => {
  test("a manual hold admits the owner's signed erasure request", async () => {
    expect(await requestErasureWhileHeld("manual")).toEqual({
      body: {
        createdAt: "2026-07-25T00:00:00.000Z",
        id: "5KRHA9AWW4N6A2Q5Z61QHHYTFA",
        kind: "tenant-erasure",
        organizationId: ORGANIZATION_ID,
        status: "pending",
        updatedAt: "2026-07-25T00:00:00.000Z",
        version: 1,
      },
      operations: [{ kind: "tenant-erasure", status: "pending" }],
      queued: 1,
      status: 202,
    });
  });

  test("an abuse hold refuses the owner's signed erasure request", async () => {
    expect(await requestErasureWhileHeld("abuse")).toEqual({
      body: {
        type: "https://docs.deployments.ai/errors/organization-suspended",
        title: "The organization is suspended.",
        status: 403,
        code: "organization_suspended",
        detail:
          "This organization can read its data and reduce access or activity, but cannot make other changes until every hold is released.",
        holds: [
          {
            customerMessage: "Held for review.",
            reason: "abuse",
            since: "2026-10-01T00:00:00.000Z",
          },
        ],
        requestId: expect.stringMatching(/^req_[0-9a-f-]{36}$/u),
      },
      operations: [],
      queued: 0,
      status: 403,
    });
  });
});
