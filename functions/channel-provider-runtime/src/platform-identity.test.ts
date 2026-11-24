import { describe, expect, it } from "bun:test";
import type { OrganizationAccess } from "@deployments-ai/db";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import { handleCredentialApi } from "./credentials.ts";
import { channelProviderScope } from "./platform-identity.ts";

const ids = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
} as const;
const TOKEN_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

const access = (result: OrganizationAccess) => async (): Promise<OrganizationAccess> => result;

function event(scope = "providers:write", claims: Readonly<Record<string, string>> = {}) {
  return {
    headers: {
      "x-deployments-environment": ids.environmentId,
      "x-deployments-organization": ids.organizationId,
      "x-deployments-project": ids.projectId,
    },
    pathParameters: { credentialId: "credential-1", environmentId: ids.environmentId },
    requestContext: {
      authorizer: {
        jwt: {
          claims: { client_id: "deployments-cli", scope, sub: ids.principalId, ...claims },
        },
      },
    },
  };
}

describe("channel-provider platform identity", () => {
  it("uses live platform authorization for standard access-token claims", async () => {
    const calls: unknown[] = [];
    expect(
      await channelProviderScope(event(), async (input) => {
        calls.push(input);
        return { kind: "member", role: "owner" };
      }),
    ).toEqual(ids);
    expect(calls).toEqual([ids]);
  });

  it("passes the access token sid and answers an SSO-required organization with 403", async () => {
    const calls: unknown[] = [];
    const response = await handleCredentialApi(
      event("providers:write", { sid: TOKEN_SESSION_ID }),
      {
        authorizePlatformScope: async (input) => {
          calls.push(input);
          return { kind: "sso-required" };
        },
      },
    );
    expect(response).toEqual({
      body: JSON.stringify({ error: "organization_sso_required" }),
      headers: { "content-type": "application/json" },
      statusCode: 403,
    });
    expect(calls).toEqual([{ ...ids, tokenSessionId: TOKEN_SESSION_ID }]);
  });

  it("rejects missing capability and inactive tenant authorization", async () => {
    const owner = access({ kind: "member", role: "owner" });
    expect(channelProviderScope(event("providers:read"), owner)).rejects.toThrow(
      "providers:write scope is required",
    );
    expect(channelProviderScope(event(), access({ kind: "denied" }))).rejects.toThrow(
      "requested tenant is not authorized",
    );
    expect(
      channelProviderScope(event(), access({ kind: "member", role: "viewer" })),
    ).rejects.toThrow("require an organization owner or administrator");
  });

  it("rejects a tenant header that disagrees with the environment path", async () => {
    const base = event();
    const mismatched = {
      ...base,
      headers: {
        ...base.headers,
        "x-deployments-environment": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      },
    };
    expect(
      channelProviderScope(mismatched, access({ kind: "member", role: "owner" })),
    ).rejects.toThrow("does not match the requested environment");
  });
});

describe("channel-provider operator access", () => {
  it("audits credential writes an administrator makes under operator access as that grant", async () => {
    const grant = operatorAccessGrant(ids.organizationId);
    const committed: unknown[] = [];
    const response = await handleCredentialApi(
      {
        ...event(),
        body: JSON.stringify({
          ownerId: ids.principalId,
          ownerType: "provider-connection",
          purpose: "provider-api",
          values: { clientSecret: "secret" },
        }),
        requestContext: {
          ...event().requestContext,
          http: { method: "POST" },
        },
      },
      {
        authorizePlatformScope: access({ kind: "platform-administrator", operatorAccess: grant }),
        commit: async (mutation) => {
          committed.push(mutation.actor);
        },
        standing: { read: async () => ({ state: "active" }) },
        vault: {
          prepareWrite: async () => ({
            operation: { kind: "put", record: {} as never },
            reference: { credentialId: ids.principalId, generation: 0, store: "dynamodb-kms" },
          }),
        } as never,
      },
    );

    expect(response.statusCode).toBe(201);
    expect(committed).toEqual([
      { id: ids.principalId, operatorAccessGrantId: grant.grantId, type: "principal" },
    ]);
  });
});

describe("channel-provider organization role matrix", () => {
  it("admits provider mutations only for owners, admins, and platform administrators", async () => {
    const observed: Record<string, boolean> = {};
    for (const role of ["owner", "admin", "billing", "member", "viewer", "platform"] as const) {
      observed[role] = await channelProviderScope(
        event(),
        access(
          role === "platform"
            ? {
                kind: "platform-administrator",
                operatorAccess: operatorAccessGrant(ids.organizationId),
              }
            : { kind: "member", role },
        ),
      ).then(
        () => true,
        () => false,
      );
    }
    expect(observed).toEqual({
      admin: true,
      billing: false,
      member: false,
      owner: true,
      platform: true,
      viewer: false,
    });
  });
});
