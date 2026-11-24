import { describe, expect, it } from "bun:test";
import { Ulid, type OrganizationAccess } from "@deployments-ai/db";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import { Schema } from "effect";
import { authorize, authorizeRun, scope, type MemoryApiEvent } from "./api-support.ts";

const ids = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  tokenSessionId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
} as const;

const id = Schema.decodeUnknownSync(Ulid);
const tenant = {
  environmentId: id(ids.environmentId),
  organizationId: id(ids.organizationId),
  principalId: id(ids.principalId),
  projectId: id(ids.projectId),
};

const platformAdministrator = async (): Promise<OrganizationAccess> => ({
  kind: "platform-administrator",
  operatorAccess: operatorAccessGrant(ids.organizationId),
});
const memberAs =
  (role: "admin" | "billing" | "member" | "owner" | "viewer") =>
  async (): Promise<OrganizationAccess> => ({ kind: "member", role });

function platformEvent(
  headers: Readonly<Record<string, string>> = {},
  grantedScopes = "memory:admin memory:read memory:write",
  claims: Readonly<Record<string, string>> = {},
): MemoryApiEvent {
  return {
    headers: {
      "x-deployments-environment": ids.environmentId,
      "x-deployments-organization": ids.organizationId,
      "x-deployments-project": ids.projectId,
      ...headers,
    },
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            client_id: "deployments-cli",
            scope: grantedScopes,
            sub: ids.principalId,
            ...claims,
          },
        },
      },
    },
  };
}

describe("platform memory identity", () => {
  it("resolves unsigned tenant headers through live platform authorization", async () => {
    const calls: unknown[] = [];
    const authorizeScope = async (input: unknown): Promise<OrganizationAccess> => {
      calls.push(input);
      return { kind: "member", role: "member" };
    };
    expect(await scope(platformEvent(), authorizeScope)).toEqual({
      ...tenant,
      organizationRole: "member",
      platformAdministrator: false,
    });
    expect(calls).toEqual([tenant]);
  });

  it("carries the operator access grant of an administrator into the memory scope", async () => {
    expect(await scope(platformEvent(), platformAdministrator)).toEqual({
      ...tenant,
      operatorAccessGrantId: operatorAccessGrant(ids.organizationId).grantId,
      platformAdministrator: true,
    });
  });

  it("passes the access token sid and answers an SSO-required organization with 403", async () => {
    const calls: unknown[] = [];
    const ssoRequired = async (input: unknown): Promise<OrganizationAccess> => {
      calls.push(input);
      return { kind: "sso-required" };
    };
    expect(
      scope(platformEvent({}, undefined, { sid: ids.tokenSessionId }), ssoRequired),
    ).rejects.toMatchObject({ code: "organization_sso_required", statusCode: 403 });
    expect(
      scope(platformEvent({}, undefined, { sid: "not-a-session" }), ssoRequired),
    ).rejects.toMatchObject({ code: "organization_sso_required", statusCode: 403 });
    expect(calls).toEqual([{ ...tenant, tokenSessionId: ids.tokenSessionId }, tenant]);
  });

  it("fails closed when platform tenant context is missing or no longer authorized", async () => {
    const missing = platformEvent({ "x-deployments-environment": "" });
    expect(scope(missing, memberAs("member"))).rejects.toMatchObject({
      code: "unauthorized",
      statusCode: 401,
    });
    expect(scope(platformEvent(), async () => ({ kind: "denied" }) as const)).rejects.toMatchObject(
      { code: "tenant_forbidden", statusCode: 403 },
    );
  });

  it("rejects malformed platform tenant headers before live authorization", async () => {
    let called = false;
    expect(
      scope(platformEvent({ "x-deployments-environment": "not-an-id" }), async () => {
        called = true;
        return {
          kind: "platform-administrator",
          operatorAccess: operatorAccessGrant(ids.organizationId),
        } as const;
      }),
    ).rejects.toMatchObject({ code: "invalid_id", statusCode: 400 });
    expect(called).toBe(false);
  });

  it("lets only a live platform administrator use privileged execute scope without a run claim", async () => {
    const administrator = await scope(platformEvent(), platformAdministrator);
    expect(() => authorizeRun(platformEvent(), ids.runId, administrator)).not.toThrow();

    const member = await scope(platformEvent(), memberAs("member"));
    expect(() => authorizeRun(platformEvent(), ids.runId, member)).toThrow(
      "token bound to the requested run",
    );
  });

  it("does not let public memory admin scope imply privileged execution", async () => {
    const administrator = await scope(platformEvent(), platformAdministrator);
    expect(() =>
      authorize(platformEvent(), "/v1/memory/active-recall", "POST", administrator),
    ).toThrow("memory:execute capability is required");
    expect(() =>
      authorize(
        platformEvent({}, "memory:execute"),
        "/v1/memory/active-recall",
        "POST",
        administrator,
      ),
    ).not.toThrow();
  });

  it("requires owner or admin role for platform memory mutations", async () => {
    const viewer = await scope(platformEvent(), memberAs("viewer"));
    expect(() => authorize(platformEvent(), "/v1/memory/imports", "POST", viewer)).toThrow(
      "require an organization owner or administrator",
    );
    const owner = await scope(platformEvent(), memberAs("owner"));
    expect(() => authorize(platformEvent(), "/v1/memory/imports", "POST", owner)).not.toThrow();
  });
});

describe("platform memory organization role matrix", () => {
  const roles = ["owner", "admin", "billing", "member", "viewer"] as const;
  const operations = [
    ["read", "/v1/memory/search", "POST"],
    ["write", "/v1/memory/imports", "POST"],
    ["admin", "/v1/memory/exports", "POST"],
  ] as const;

  it("permits reads to every role and mutations only to owners, admins, and platform administrators", async () => {
    const observed: Record<string, Record<string, boolean>> = {};
    for (const role of [...roles, "platform-administrator"] as const) {
      const tenantScope = await scope(
        platformEvent(),
        role === "platform-administrator" ? platformAdministrator : memberAs(role),
      );
      observed[role] = Object.fromEntries(
        operations.map(([operation, path, method]) => {
          try {
            authorize(platformEvent(), path, method, tenantScope);
            return [operation, true];
          } catch {
            return [operation, false];
          }
        }),
      );
    }
    expect(observed).toEqual({
      admin: { admin: true, read: true, write: true },
      billing: { admin: false, read: true, write: false },
      member: { admin: false, read: true, write: false },
      owner: { admin: true, read: true, write: true },
      "platform-administrator": { admin: true, read: true, write: true },
      viewer: { admin: false, read: true, write: false },
    });
  });
});
