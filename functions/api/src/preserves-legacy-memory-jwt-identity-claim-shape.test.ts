import { Keys, type PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createApplicationAuthenticator,
  createMemoryJwtIdentityAuthenticator,
  OperatorAccessRequiredError,
} from "./index.ts";
import {
  databaseWithRecords,
  ENVIRONMENT_ID,
  environmentHierarchyRecords,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  PROJECT_ID,
  storageKey,
} from "./application-auth-test-support.ts";

describe("application authentication", () => {
  test("preserves the legacy memory JWT identity claim shape", async () => {
    const authenticate = createMemoryJwtIdentityAuthenticator({
      jwt: {
        audience: ["memory"],
        issuer: "https://memory-issuer.example",
        verify: async () => ({
          environment_id: ENVIRONMENT_ID,
          organization_id: ORGANIZATION_ID,
          project_id: PROJECT_ID,
          sub: "oidc-user@example.test",
        }),
      },
    });

    expect(
      authenticate(
        new Request("https://api.example/v1/whoami", {
          headers: { authorization: "Bearer header.payload.signature" },
        }),
      ),
    ).resolves.toEqual({
      authentication: "tenant-jwt",
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: "oidc-user@example.test",
      projectIds: [PROJECT_ID],
      scopes: [],
    });
  });

  test("revalidates fully specified legacy JWT membership on existing agent routes", async () => {
    const records = environmentHierarchyRecords();
    const database = databaseWithRecords(records);
    records.delete(
      storageKey("control", {
        pk: `PRINCIPAL#${PRINCIPAL_ID}`,
        sk: `PRINCIPAL#${PRINCIPAL_ID}`,
      }),
    );
    const authenticate = createApplicationAuthenticator({
      database,
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          environment_id: ENVIRONMENT_ID,
          organization_id: ORGANIZATION_ID,
          sub: PRINCIPAL_ID,
          project_id: PROJECT_ID,
          scope: "agents:read",
        }),
      },
    });

    expect(
      await authenticate(
        new Request("https://api.example/v1/agent-definitions", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).toEqual({
      authentication: "tenant-jwt",
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["agents:read"],
    });
  });

  test("preserves configured legacy principal and scope claim aliases before cutover", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(environmentHierarchyRecords()),
      jwt: {
        audience: "api",
        claimProfile: "legacy",
        issuer: "https://legacy-issuer.example",
        verify: async () => ({
          environment_id: ENVIRONMENT_ID,
          organization_id: ORGANIZATION_ID,
          principal_id: PRINCIPAL_ID,
          project_id: PROJECT_ID,
          scp: ["agents:read"],
        }),
      },
    });

    expect(
      authenticate(
        new Request("https://api.example/v1/agent-definitions", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).resolves.toMatchObject({ principalId: PRINCIPAL_ID, scopes: ["agents:read"] });
  });

  test.each(["agent-email", "email"])(
    "retains %s administration only for live organization administrators",
    async (namespace) => {
      const records = environmentHierarchyRecords();
      const membershipKey = {
        pk: `ORG#${ORGANIZATION_ID}`,
        sk: `ORGANIZATION-MEMBER#${PRINCIPAL_ID}`,
      };
      const authenticator = () =>
        createApplicationAuthenticator({
          database: databaseWithRecords(records),
          jwt: {
            audience: "api",
            claimProfile: "platform",
            issuer: "https://auth.deployments.ai",
            verify: async () => ({
              environment_id: ENVIRONMENT_ID,
              organization_id: ORGANIZATION_ID,
              project_id: PROJECT_ID,
              scope: `${namespace}:* ${namespace}:admin ${namespace}:read ${namespace}:write`,
              sub: PRINCIPAL_ID,
            }),
          },
        });
      expect(
        authenticator()(
          new Request(
            `https://api.example/v1/${namespace}/${namespace === "email" ? "tenants" : "inboxes"}`,
            {
              headers: { authorization: "Bearer a.b.c" },
            },
          ),
        ),
      ).resolves.toMatchObject({ scopes: [`${namespace}:read`, `${namespace}:write`] });

      const membership = records.get(storageKey("control", membershipKey))!;
      records.set(storageKey("control", membershipKey), {
        ...membership,
        data: { ...membership.data, role: "admin" },
      } as PlatformRecord);
      expect(
        authenticator()(
          new Request(`https://api.example/v1/${namespace}/domains`, {
            headers: { authorization: "Bearer a.b.c" },
          }),
        ),
      ).resolves.toMatchObject({
        scopes: [`${namespace}:*`, `${namespace}:admin`, `${namespace}:read`, `${namespace}:write`],
      });
    },
  );

  test("validates hierarchy and active membership for agent-email JWTs", async () => {
    const records = environmentHierarchyRecords();
    records.delete(
      storageKey("control", {
        pk: `ORG#${ORGANIZATION_ID}`,
        sk: `ORGANIZATION-MEMBER#${PRINCIPAL_ID}`,
      }),
    );
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(records),
      jwt: {
        audience: "api",
        claimProfile: "platform",
        issuer: "https://issuer.example",
        verify: async () => ({
          environment_id: ENVIRONMENT_ID,
          organization_id: ORGANIZATION_ID,
          sub: PRINCIPAL_ID,
          project_id: PROJECT_ID,
          scope: "agent-email:admin",
        }),
      },
    });

    expect(
      await authenticate(
        new Request("https://api.example/v1/agent-email/inboxes", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).toBeNull();
  });

  test("maps verified JWT tenant and capability claims", async () => {
    const database = databaseWithRecords(environmentHierarchyRecords());
    const authenticate = createApplicationAuthenticator({
      database,
      jwt: {
        audience: ["api"],
        issuer: "https://issuer.example",
        verify: async () => ({
          sub: PRINCIPAL_ID,
          organization_id: ORGANIZATION_ID,
          project_id: PROJECT_ID,
          environment_id: ENVIRONMENT_ID,
          scope: "agents:read agents:write",
        }),
      },
    });
    const identity = await authenticate(
      new Request("https://api.example", {
        headers: { authorization: "Bearer a.b.c" },
      }),
    );
    expect(identity).toEqual({
      authentication: "tenant-jwt",
      principalId: PRINCIPAL_ID,
      scopes: ["agents:read", "agents:write"],
      organizationIds: [ORGANIZATION_ID],
      projectIds: [PROJECT_ID],
      environmentIds: [ENVIRONMENT_ID],
    });
  });

  test("accepts a tenantless verified JWT for first-organization bootstrap", async () => {
    const database = databaseWithRecords(new Map());
    const authenticate = createApplicationAuthenticator({
      database,
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          sub: PRINCIPAL_ID,
          scope: "organizations:read organizations:write",
        }),
      },
    });
    const identity = await authenticate(
      new Request("https://api.example", {
        headers: { authorization: "Bearer a.b.c" },
      }),
    );
    expect(identity).toEqual({
      authentication: "tenant-jwt",
      principalId: PRINCIPAL_ID,
      scopes: ["organizations:read", "organizations:write"],
    });
  });

  test("resolves tenantless JWT scope headers through the live hierarchy and membership", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(environmentHierarchyRecords()),
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          sub: PRINCIPAL_ID,
          scope: "agents:read",
        }),
      },
    });

    expect(
      authenticate(
        new Request("https://api.example/v1/agent-definitions", {
          headers: {
            authorization: "Bearer a.b.c",
            "x-deployments-environment": ENVIRONMENT_ID,
          },
        }),
      ),
    ).resolves.toEqual({
      authentication: "tenant-jwt",
      environmentIds: [ENVIRONMENT_ID],
      environmentSelection: "request",
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["agents:read"],
    });
  });

  test("rejects tenantless JWT scope headers without live membership", async () => {
    const records = environmentHierarchyRecords();
    records.delete(
      storageKey("control", {
        pk: `ORG#${ORGANIZATION_ID}`,
        sk: `ORGANIZATION-MEMBER#${PRINCIPAL_ID}`,
      }),
    );
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(records),
      jwt: {
        audience: "api",
        claimProfile: "platform",
        issuer: "https://auth.deployments.ai",
        verify: async () => ({ sub: PRINCIPAL_ID, scope: "agents:read" }),
      },
    });

    expect(
      authenticate(
        new Request("https://api.example/v1/agent-definitions", {
          headers: {
            authorization: "Bearer a.b.c",
            "x-deployments-environment": ENVIRONMENT_ID,
          },
        }),
      ),
    ).resolves.toBeNull();
  });

  test("rejects Cognito custom claims after the platform issuer cutover", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(environmentHierarchyRecords()),
      jwt: {
        audience: "api",
        claimProfile: "platform",
        issuer: "https://issuer.example",
        verify: async () => ({
          "custom:environment_id": ENVIRONMENT_ID,
          "custom:organization_id": ORGANIZATION_ID,
          "custom:principal_id": PRINCIPAL_ID,
          "custom:project_id": PROJECT_ID,
          "custom:scope": "organizations:read organizations:write",
          sub: "cognito-uuid",
        }),
      },
    });

    expect(
      await authenticate(
        new Request("https://api.example", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).toBeNull();
  });

  test("accepts Cognito custom claims while the configured issuer is Cognito", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(environmentHierarchyRecords()),
      jwt: {
        audience: "api",
        issuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_example",
        verify: async () => ({
          "custom:environment_id": ENVIRONMENT_ID,
          "custom:organization_id": ORGANIZATION_ID,
          "custom:principal_id": PRINCIPAL_ID,
          "custom:project_id": PROJECT_ID,
          "custom:scope": "organizations:read organizations:write",
          sub: "cognito-uuid",
        }),
      },
    });

    expect(
      authenticate(
        new Request("https://api.example", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).resolves.toEqual({
      authentication: "tenant-jwt",
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["organizations:read", "organizations:write"],
    });
  });

  test("holds a platform-wide JWT scope to operator access in the organization it selects", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(new Map()),
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          organization_id: ORGANIZATION_ID,
          sub: PRINCIPAL_ID,
          scope: "platform:admin",
        }),
      },
    });

    expect(
      authenticate(
        new Request("https://api.example", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).rejects.toBeInstanceOf(OperatorAccessRequiredError);
  });

  test("preserves tenantless platform administrators for cross-organization governance", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(new Map()),
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          sub: PRINCIPAL_ID,
          scope: "platform:admin",
        }),
      },
    });

    expect(
      authenticate(
        new Request(`https://api.example/v1/organizations/${ORGANIZATION_ID}/retention-policy`, {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).resolves.toEqual({
      authentication: "tenant-jwt",
      principalId: PRINCIPAL_ID,
      scopes: ["platform:admin"],
    });
  });

  test("loads the authoritative platform role independently of OAuth scopes", async () => {
    const principalKey = {
      pk: `PRINCIPAL#${PRINCIPAL_ID}`,
      sk: `PRINCIPAL#${PRINCIPAL_ID}`,
    };
    const records = new Map<string, PlatformRecord>();
    records.set(storageKey("control", principalKey), {
      ...principalKey,
      data: {
        id: PRINCIPAL_ID,
        kind: "human",
        platformRole: "administrator",
        status: "active",
      },
      itemType: "principal",
    } as unknown as PlatformRecord);
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(records),
      jwt: {
        audience: "api",
        claimProfile: "platform",
        issuer: "https://auth.deployments.ai",
        verify: async () => ({
          sub: PRINCIPAL_ID,
          scope: "managed-skills:admin",
        }),
      },
    });

    expect(
      authenticate(
        new Request("https://api.example/v1/managed-skill-sources", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).resolves.toEqual({
      authentication: "tenant-jwt",
      platformRole: "administrator",
      principalId: PRINCIPAL_ID,
      scopes: ["managed-skills:admin"],
    });
  });

  test("allows a signed tenant identity to access only its erasure receipt after membership removal", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(new Map()),
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          organization_id: ORGANIZATION_ID,
          sub: PRINCIPAL_ID,
          scope: "governance:read governance:write",
        }),
      },
    });
    const headers = { authorization: "Bearer a.b.c" };

    expect(
      authenticate(
        new Request(
          `https://api.example/v1/organizations/${ORGANIZATION_ID}/erasures/${ENVIRONMENT_ID}`,
          { headers },
        ),
      ),
    ).resolves.toEqual({
      authentication: "tenant-jwt",
      erasureReceiptOnly: true,
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      scopes: ["governance:read", "governance:write"],
    });
    expect(
      authenticate(
        new Request(`https://api.example/v1/organizations/${ORGANIZATION_ID}/data-exports`, {
          headers,
          method: "POST",
        }),
      ),
    ).resolves.toBeNull();
  });

  test("resolves a missing project claim from an organization/environment grant", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(environmentHierarchyRecords()),
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          environment_id: ENVIRONMENT_ID,
          organization_id: ORGANIZATION_ID,
          sub: PRINCIPAL_ID,
          scope: "agents:write",
        }),
      },
    });

    expect(
      await authenticate(
        new Request("https://api.example", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).toEqual({
      authentication: "tenant-jwt",
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["agents:write"],
    });
  });

  test("rejects unresolved JWT hierarchy claims", async () => {
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(new Map()),
      jwt: {
        audience: "api",
        issuer: "https://issuer.example",
        verify: async () => ({
          environment_id: ENVIRONMENT_ID,
          sub: PRINCIPAL_ID,
          scope: "agents:read",
        }),
      },
    });

    expect(
      await authenticate(
        new Request("https://api.example", {
          headers: { authorization: "Bearer a.b.c" },
        }),
      ),
    ).toBeNull();
  });

  async function opaqueKeyIdentity(input: {
    readonly accountScopes: readonly string[];
    readonly credentialScopes: readonly string[];
  }) {
    const token = "dai_test_opaque_secret";
    const hash = createHash("sha256").update(token).digest("hex");
    const credentialKey = { pk: "credential-pk", sk: "credential-sk" };
    const accountKey = {
      pk: `ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`,
      sk: `SERVICE-ACCOUNT#${PRINCIPAL_ID}`,
    };
    const claimKey = Keys.control.uniqueClaim("api-credential-hash", hash);
    const account = {
      ...accountKey,
      data: {
        environmentId: ENVIRONMENT_ID,
        id: PRINCIPAL_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        scopes: input.accountScopes,
        status: "active",
      },
      itemType: "service-account",
    } as unknown as PlatformRecord;
    const map = new Map<string, PlatformRecord>();
    map.set(storageKey("control", claimKey), {
      ...claimKey,
      data: {
        namespace: "api-credential-hash",
        ownerItemType: "api-credential",
        ownerPk: credentialKey.pk,
        ownerSk: credentialKey.sk,
        value: hash,
      },
      itemType: "unique-claim",
    } as unknown as PlatformRecord);
    map.set(storageKey("control", credentialKey), {
      ...credentialKey,
      data: {
        credentialHash: hash,
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        scopes: input.credentialScopes,
        serviceAccountId: PRINCIPAL_ID,
        status: "active",
      },
      itemType: "api-credential",
    } as unknown as PlatformRecord);
    map.set(storageKey("control", accountKey), account);
    const authenticate = createApplicationAuthenticator({
      database: databaseWithRecords(map),
      jwt: { audience: "api", issuer: "https://issuer.example" },
    });
    return authenticate(
      new Request("https://api.example", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  }

  test("resolves an opaque key through its hash claim and intersects account scopes", async () => {
    const identity = await opaqueKeyIdentity({
      accountScopes: ["agents:read"],
      credentialScopes: ["agents:*"],
    });
    expect(identity?.scopes).toEqual(["agents:read"]);
    expect(identity?.principalId).toBe(PRINCIPAL_ID);
    expect(identity?.opaqueCredential).toBe(true);
  });

  test("gives a key apps:publish only when the key and its account both name it", async () => {
    const scopesOf = async (
      accountScopes: readonly string[],
      credentialScopes: readonly string[],
    ) => (await opaqueKeyIdentity({ accountScopes, credentialScopes }))?.scopes;

    expect({
      "account names it, key holds apps:*": await scopesOf(["apps:*", "apps:publish"], ["apps:*"]),
      "both name it": await scopesOf(["apps:read", "apps:publish"], ["apps:publish"]),
      "key names it, account holds apps:*": await scopesOf(["apps:*"], ["apps:publish"]),
      "key names it, account holds platform:*": await scopesOf(["platform:*"], ["apps:publish"]),
    }).toEqual({
      "account names it, key holds apps:*": ["apps:*"],
      "both name it": ["apps:publish"],
      "key names it, account holds apps:*": [],
      "key names it, account holds platform:*": [],
    });
  });
});
