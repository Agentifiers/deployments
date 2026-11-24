import { type PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { openOperatorAccessRecord } from "@deployments-ai/db/operator-access-testing";
import {
  databaseWithRecords,
  environmentHierarchyRecords,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  storageKey,
} from "./application-auth-test-support.ts";
import { createApplicationAuthenticator } from "./application-auth.ts";
import { createTenancyApi, type ApiIdentity, type TenancyApiService } from "./index.ts";

const TOKEN_SCOPES =
  "governance:write invitations:write members:read members:write models:write projects:write tools:write";

/** whoami never reaches the tenancy service; every operation fails if it does. */
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

function humanAuthenticator(role: string | undefined, platformRole?: "administrator") {
  const records = environmentHierarchyRecords();
  const membershipKey = {
    pk: `ORG#${ORGANIZATION_ID}`,
    sk: `ORGANIZATION-MEMBER#${PRINCIPAL_ID}`,
  };
  // The hierarchy fixture seeds a membership; a platform administrator here is not a member.
  if (!role) records.delete(storageKey("control", membershipKey));
  if (role) {
    records.set(storageKey("control", membershipKey), {
      ...membershipKey,
      data: { organizationId: ORGANIZATION_ID, principalId: PRINCIPAL_ID, role, status: "active" },
      itemType: "organization-member",
    } as unknown as PlatformRecord);
  }
  if (platformRole) {
    const principalKey = { pk: `PRINCIPAL#${PRINCIPAL_ID}`, sk: `PRINCIPAL#${PRINCIPAL_ID}` };
    records.set(storageKey("control", principalKey), {
      ...principalKey,
      data: { id: PRINCIPAL_ID, kind: "human", platformRole, status: "active" },
      itemType: "principal",
    } as unknown as PlatformRecord);
    const access = openOperatorAccessRecord({
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });
    records.set(storageKey("control", access), access);
  }
  return createApplicationAuthenticator({
    database: databaseWithRecords(records),
    jwt: {
      audience: "api",
      claimProfile: "platform",
      issuer: "https://auth.deployments.ai",
      verify: async () => ({ scope: TOKEN_SCOPES, sub: PRINCIPAL_ID }),
    },
  });
}

async function whoami(
  authenticate: (request: Request) => Promise<ApiIdentity | null>,
  headers: Readonly<Record<string, string>>,
) {
  const fetch = createTenancyApi({
    authenticate,
    authorize: async () => undefined,
    idempotency: { execute: async (input) => input.operation() },
    service: unusedService,
  });
  const response = await fetch(new Request("https://api.example/v1/whoami", { headers }));
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

const organizationHeaders = {
  authorization: "Bearer a.b.c",
  "x-deployments-organization": ORGANIZATION_ID,
};

describe("whoami organization role", () => {
  test("returns each role with token scopes narrowed to what the role permits", async () => {
    const observed: Record<string, unknown> = {};
    for (const role of ["owner", "admin", "billing", "member", "viewer"]) {
      const body = await whoami(humanAuthenticator(role), organizationHeaders);
      observed[role] = { capabilities: body.capabilities, organizationRole: body.organizationRole };
    }
    const readOnly = ["members:read"];
    expect(observed).toEqual({
      admin: {
        capabilities: [
          "governance:write",
          "invitations:write",
          "members:read",
          "members:write",
          "models:write",
          "projects:write",
          "tools:write",
        ],
        organizationRole: "admin",
      },
      billing: { capabilities: readOnly, organizationRole: "billing" },
      member: { capabilities: readOnly, organizationRole: "member" },
      owner: { capabilities: TOKEN_SCOPES.split(" "), organizationRole: "owner" },
      viewer: { capabilities: readOnly, organizationRole: "viewer" },
    });
  });

  test("reports platform administrators without narrowing their capabilities", async () => {
    const body = await whoami(humanAuthenticator(undefined, "administrator"), organizationHeaders);
    expect(body).toMatchObject({
      capabilities: TOKEN_SCOPES.split(" "),
      platformRole: "administrator",
    });
    expect(body.organizationRole).toBeUndefined();
  });

  test("omits the role view when no organization is selected", async () => {
    const body = await whoami(humanAuthenticator("viewer"), { authorization: "Bearer a.b.c" });
    expect(body.organizationRole).toBeUndefined();
    expect(body.capabilities).toEqual(TOKEN_SCOPES.split(" "));
  });

  test("keeps the API-key response unchanged when an organization header is supplied", async () => {
    const body = await whoami(
      async () => ({
        apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        authentication: "api-credential",
        organizationIds: [ORGANIZATION_ID],
        principalId: PRINCIPAL_ID,
        scopes: ["projects:write"],
      }),
      { ...organizationHeaders, authorization: "Bearer dai_test_opaque_secret" },
    );
    expect(body).toEqual({
      authentication: "api-credential",
      capabilities: ["projects:write"],
      environmentIds: [],
      id: PRINCIPAL_ID,
      organizationId: ORGANIZATION_ID,
      organizationIds: [ORGANIZATION_ID],
      projectIds: [],
    });
  });
});
