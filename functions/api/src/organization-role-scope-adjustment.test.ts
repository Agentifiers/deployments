import { type PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  databaseWithRecords,
  ENVIRONMENT_ID,
  environmentHierarchyRecords,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  storageKey,
} from "./application-auth-test-support.ts";
import { createApplicationAuthenticator } from "./application-auth.ts";

const TOKEN_SCOPES = "agent-email:* email:admin email:read governance:write projects:write";

async function admittedScopes(role: string) {
  const records = environmentHierarchyRecords();
  const membershipKey = {
    pk: `ORG#${ORGANIZATION_ID}`,
    sk: `ORGANIZATION-MEMBER#${PRINCIPAL_ID}`,
  };
  records.set(storageKey("control", membershipKey), {
    ...membershipKey,
    data: { organizationId: ORGANIZATION_ID, principalId: PRINCIPAL_ID, role, status: "active" },
    itemType: "organization-member",
  } as unknown as PlatformRecord);
  const authenticate = createApplicationAuthenticator({
    database: databaseWithRecords(records),
    jwt: {
      audience: "api",
      claimProfile: "platform",
      issuer: "https://auth.deployments.ai",
      verify: async () => ({ scope: TOKEN_SCOPES, sub: PRINCIPAL_ID }),
    },
  });
  const identity = await authenticate(
    new Request("https://api.example/v1/whoami", {
      headers: { authorization: "Bearer a.b.c", "x-deployments-environment": ENVIRONMENT_ID },
    }),
  );
  return identity ? [...identity.scopes].sort() : null;
}

describe("organization role scope adjustment at admission", () => {
  test("narrows email administration to owners and admins and leaves other scopes untouched", async () => {
    const roles = ["owner", "admin", "billing", "member", "viewer"] as const;
    const observed = Object.fromEntries(
      await Promise.all(roles.map(async (role) => [role, await admittedScopes(role)] as const)),
    );
    const unchanged = TOKEN_SCOPES.split(" ").sort();
    const narrowed = [
      "agent-email:read",
      "agent-email:write",
      "email:read",
      "governance:write",
      "projects:write",
    ];
    expect(observed).toEqual({
      admin: unchanged,
      billing: narrowed,
      member: narrowed,
      owner: unchanged,
      viewer: narrowed,
    });
  });
});
