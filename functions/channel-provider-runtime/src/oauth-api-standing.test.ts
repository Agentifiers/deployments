import { describe, expect, test } from "bun:test";
import { makeOrganizationHoldReader } from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";

import { handleOAuthApi } from "./oauth-callbacks.ts";
import type { OAuthEvent } from "./oauth-validation.ts";
import {
  CONNECTION_ID,
  jsonResponse,
  oauthHarness,
  SCOPE,
  seedVendorConnection,
  storedConnection,
  ulid,
} from "./oauth-test-support.ts";

function apiEvent(method: string, path: string): OAuthEvent {
  return {
    body: "{}",
    pathParameters: {
      applicationId: ulid(30),
      connectionId: CONNECTION_ID,
      environmentId: SCOPE.environmentId,
    },
    requestContext: {
      authorizer: {
        jwt: {
          claims: { organization_id: SCOPE.organizationId, project_id: SCOPE.projectId },
        },
      },
      http: { method, path: `/v1/environments/${SCOPE.environmentId}${path}` },
    },
  };
}

const AUTHORIZE = apiEvent("POST", `/provider-applications/${ulid(30)}/oauth/authorize`);
const REFRESH = apiEvent("POST", `/provider-connections/${CONNECTION_ID}/oauth/refresh`);
const REVOKE = apiEvent("DELETE", `/provider-connections/${CONNECTION_ID}/oauth`);

function heldHarness() {
  const memory = evaluationMemoryDatabase([]);
  const harness = oauthHarness();
  seedVendorConnection(harness, { generation: 3, refreshToken: "refresh-3" });
  harness.respond = async () =>
    jsonResponse({ access_token: "access-4", expires_in: 600, refresh_token: "refresh-4" });
  return {
    dependencies: {
      ...harness.dependencies,
      standing: makeOrganizationHoldReader(memory.database),
    },
    harness,
    holds: organizationHolds(memory.database, SCOPE.organizationId),
  };
}

describe("OAuth API under organization holds", () => {
  test("refuses authorize and refresh while held and refreshes after release", async () => {
    const { dependencies, harness, holds } = heldHarness();

    await holds.hold("payment");
    const authorized = await handleOAuthApi(AUTHORIZE, dependencies);
    const refused = await handleOAuthApi(REFRESH, dependencies);
    const fetchesWhileHeld = harness.fetches.length;
    await holds.release("payment");
    const refreshed = await handleOAuthApi(REFRESH, dependencies);

    expect([authorized.statusCode, refused.statusCode, refreshed.statusCode]).toEqual([
      403, 403, 200,
    ]);
    expect(JSON.parse(refused.body ?? "{}")).toMatchObject({
      code: "organization_suspended",
      holds: [{ customerMessage: "Update your payment method.", reason: "payment" }],
    });
    expect(fetchesWhileHeld).toBe(0);
    expect(JSON.parse(refreshed.body ?? "{}")).toMatchObject({ reference: { generation: 4 } });
  });

  test("revokes a connection while held", async () => {
    const { dependencies, harness, holds } = heldHarness();

    await holds.hold("abuse");
    const revoked = await handleOAuthApi(REVOKE, dependencies);

    expect(revoked.statusCode).toBe(204);
    expect(storedConnection(harness).data.status).toBe("disconnected");
  });
});
