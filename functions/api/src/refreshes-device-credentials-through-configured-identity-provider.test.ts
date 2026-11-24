import { environmentResponse, organizationResponse } from "@deployments-ai/api-contract";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import { PersistenceError } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  createTenancyApi,
  type AgentLifecycleApiService,
  type ApiInvocation,
  type OperationalReadInvocation,
  type TenancyApiService,
} from "./index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const CREDENTIAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

function agentService() {
  const unavailable = async (_invocation: ApiInvocation<unknown>): Promise<never> => {
    throw new Error("Unexpected service operation.");
  };
  return {
    agentDefinitions: {
      list: async () => ({ items: [], nextCursor: null }),
      create: unavailable,
      get: unavailable,
      update: unavailable,
      archive: unavailable,
    },
    agentReleases: {
      list: async () => ({ items: [], nextCursor: null }),
      publish: unavailable,
      get: unavailable,
      promote: unavailable,
      archive: unavailable,
    },
    agentDeployments: {
      list: async () => ({ items: [], nextCursor: null }),
      create: unavailable,
      get: unavailable,
      update: unavailable,
      stop: unavailable,
      startCanary: unavailable,
      promoteCanary: unavailable,
      abortCanary: unavailable,
    },
  } as AgentLifecycleApiService;
}

function tenancyService(
  createOrganization: TenancyApiService["organizations"]["create"],
  createEnvironment?: TenancyApiService["environments"]["create"],
): TenancyApiService {
  const unavailable = async (_invocation: ApiInvocation<unknown>): Promise<never> => {
    throw new Error("Unexpected service operation.");
  };
  return {
    ...agentService(),
    apiCredentials: {
      list: unavailable,
      create: unavailable,
      rotate: unavailable,
      revoke: unavailable,
    },
    environments: {
      list: unavailable,
      create: createEnvironment ?? unavailable,
      get: unavailable,
      update: unavailable,
      archive: unavailable,
    },
    organizations: {
      list: unavailable,
      create: createOrganization,
      get: unavailable,
      update: unavailable,
    },
    organizationMembers: {
      list: unavailable,
      add: unavailable,
      update: unavailable,
      remove: unavailable,
    },
    organizationInvitations: {
      list: unavailable,
      create: unavailable,
      revoke: unavailable,
      accept: unavailable,
    },
    projects: {
      list: unavailable,
      create: unavailable,
      get: unavailable,
      update: unavailable,
      archive: unavailable,
    },
    serviceAccounts: {
      list: unavailable,
      create: unavailable,
      get: unavailable,
      revoke: unavailable,
    },
    workspaces: {
      list: unavailable,
      create: unavailable,
      get: unavailable,
      update: unavailable,
      archive: unavailable,
    },
  } as TenancyApiService;
}
describe("tenancy HTTP API", () => {
  test("refreshes device credentials through the configured identity provider", async () => {
    let receivedRefreshToken: string | undefined;
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => null,
      deviceAuthorization: {
        exchange: async () => {
          throw new Error("Unexpected device-code exchange.");
        },
        refresh: async (refreshToken) => {
          receivedRefreshToken = refreshToken;
          return {
            bearerToken: "refreshed.payload.signature",
            expiresIn: 3600,
            refreshToken: "rotated-refresh-token",
            tokenType: "Bearer",
          };
        },
        revoke: async () => {
          throw new Error("Unexpected device credential revocation.");
        },
        start: async () => {
          throw new Error("Unexpected device authorization start.");
        },
      },
      idempotency: { execute: async (input) => input.operation() },
      service: tenancyService(async () => {
        throw new Error("Unexpected service operation.");
      }),
    });

    const response = await fetch(
      new Request("https://api.example/v1/device-authorizations/token", {
        body: JSON.stringify({ refreshToken: "refresh-token" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(receivedRefreshToken).toBe("refresh-token");
    expect(await response.json()).toEqual({
      bearerToken: "refreshed.payload.signature",
      expiresIn: 3600,
      refreshToken: "rotated-refresh-token",
      tokenType: "Bearer",
    });
  });

  test("revokes device credentials through the configured identity provider", async () => {
    let receivedRefreshToken: string | undefined;
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => null,
      deviceAuthorization: {
        exchange: async () => {
          throw new Error("Unexpected device-code exchange.");
        },
        refresh: async () => {
          throw new Error("Unexpected device credential refresh.");
        },
        revoke: async (refreshToken) => {
          receivedRefreshToken = refreshToken;
        },
        start: async () => {
          throw new Error("Unexpected device authorization start.");
        },
      },
      idempotency: { execute: async (input) => input.operation() },
      service: tenancyService(async () => {
        throw new Error("Unexpected service operation.");
      }),
    });

    const response = await fetch(
      new Request("https://api.example/v1/device-authorizations/revoke", {
        body: JSON.stringify({ refreshToken: "refresh-token" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(receivedRefreshToken).toBe("refresh-token");
    expect(await response.json()).toEqual({ revoked: true });
  });

  test("serves normalized identity for JWT and opaque platform bearers", async () => {
    const tokens = ["header.payload.signature", "dai_test_opaque_secret"] as const;
    for (const token of tokens) {
      const usage: unknown[] = [];
      const fetch = createTenancyApi({
        authorize: async () => undefined,
        authenticate: async () => ({
          ...(token.includes(".")
            ? { authentication: "tenant-jwt" as const }
            : {
                apiCredentialId: CREDENTIAL_ID,
                authentication: "api-credential" as const,
              }),
          environmentIds: [ENVIRONMENT_ID],
          organizationIds: [ORGANIZATION_ID],
          principalId: PRINCIPAL_ID,
          projectIds: [PROJECT_ID],
          scopes: ["organizations:read"],
        }),
        idempotency: { execute: async (input) => input.operation() },
        recordApiCredentialUsage: async (input) => {
          usage.push(input);
        },
        service: tenancyService(async () => {
          throw new Error("Unexpected service operation.");
        }),
      });

      const response = await fetch(
        new Request("https://api.example/v1/whoami", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        authentication: token.includes(".") ? "tenant-jwt" : "api-credential",
        capabilities: ["organizations:read"],
        environmentId: ENVIRONMENT_ID,
        environmentIds: [ENVIRONMENT_ID],
        id: PRINCIPAL_ID,
        organizationId: ORGANIZATION_ID,
        organizationIds: [ORGANIZATION_ID],
        projectId: PROJECT_ID,
        projectIds: [PROJECT_ID],
      });
      expect(usage).toEqual(
        token.includes(".")
          ? []
          : [
              {
                apiCredentialId: CREDENTIAL_ID,
                environmentId: ENVIRONMENT_ID,
                organizationId: ORGANIZATION_ID,
                outcome: "allowed",
                projectId: PROJECT_ID,
                requestMethod: "GET",
                requestPath: "/v1/whoami",
              },
            ],
      );
    }
  });

  test("keeps valid API-key requests available when usage recording fails", async () => {
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => ({
        apiCredentialId: CREDENTIAL_ID,
        authentication: "api-credential",
        environmentIds: [ENVIRONMENT_ID],
        organizationIds: [ORGANIZATION_ID],
        principalId: PRINCIPAL_ID,
        projectIds: [PROJECT_ID],
        scopes: ["organizations:read"],
      }),
      idempotency: { execute: async (input) => input.operation() },
      recordApiCredentialUsage: async () => {
        throw new Error("usage table unavailable");
      },
      service: tenancyService(async () => {
        throw new Error("Unexpected service operation.");
      }),
    });

    const response = await fetch(
      new Request("https://api.example/v1/whoami", {
        headers: { authorization: "Bearer dai_test_opaque_secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: PRINCIPAL_ID });
  });

  test("uses memory JWT fallback only for the identity endpoint", async () => {
    let memoryAuthenticationCalls = 0;
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => null,
      authenticateIdentity: async () => {
        memoryAuthenticationCalls += 1;
        return {
          authentication: "tenant-jwt",
          environmentIds: [ENVIRONMENT_ID],
          organizationIds: [ORGANIZATION_ID],
          principalId: PRINCIPAL_ID,
          projectIds: [PROJECT_ID],
          scopes: ["platform:admin"],
        };
      },
      idempotency: { execute: async (input) => input.operation() },
      service: tenancyService(async () => {
        throw new Error("Unexpected service operation.");
      }),
    });
    const request = (path: string) =>
      new Request(`https://api.example${path}`, {
        headers: { authorization: "Bearer header.payload.signature" },
      });

    expect((await fetch(request("/v1/whoami"))).status).toBe(200);
    expect((await fetch(request("/v1/organizations"))).status).toBe(401);
    expect(memoryAuthenticationCalls).toBe(1);
  });

  test("requires explicit environment grants on agent routes", async () => {
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => ({
        organizationIds: [ORGANIZATION_ID],
        principalId: PRINCIPAL_ID,
        scopes: ["agents:read"],
      }),
      idempotency: { execute: async (input) => input.operation() },
      service: tenancyService(async () => {
        throw new Error("Unexpected service operation.");
      }),
    });

    const response = await fetch(
      new Request("https://api.example/v1/agent-definitions", {
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "environment_scope_violation" });
  });

  test("holds platform administrators to the environment the authenticator resolved", async () => {
    let invocation: OperationalReadInvocation | undefined;
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected operational read.");
    };
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => ({
        environmentIds: [ENVIRONMENT_ID],
        operatorAccess: operatorAccessGrant(ORGANIZATION_ID),
        organizationIds: [ORGANIZATION_ID],
        platformRole: "administrator",
        principalId: PRINCIPAL_ID,
        scopes: ["platform:admin"],
      }),
      idempotency: { execute: async (input) => input.operation() },
      operationalReads: {
        getAuditEvent: unavailable,
        getCostSummary: unavailable,
        getUsageSummary: unavailable,
        getWorkspaceSpend: unavailable,
        listApiCredentialUsage: unavailable,
        listAuditEvents: unavailable,
        listCosts: unavailable,
        listOrganizationAuditEvents: unavailable,
        listSpend: unavailable,
        listUsage: async (received) => {
          invocation = received;
          return { items: [] };
        },
      },
      service: tenancyService(async () => {
        throw new Error("Unexpected service operation.");
      }),
    });

    const response = await fetch(
      new Request("https://api.example/v1/usage", {
        headers: { "x-deployments-environment": ENVIRONMENT_ID },
      }),
    );

    expect(response.status).toBe(200);
    expect(invocation).toMatchObject({
      identity: { scopes: ["platform:admin"] },
      scope: { environmentId: ENVIRONMENT_ID },
    });
  });

  test("gates organization audit reads on audit:read and the organization grant", async () => {
    const received: OperationalReadInvocation[] = [];
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected operational read.");
    };
    const api = (scopes: readonly string[], organizationIds: readonly string[]) =>
      createTenancyApi({
        authorize: async () => undefined,
        authenticate: async () => ({ organizationIds, principalId: PRINCIPAL_ID, scopes }),
        idempotency: { execute: async (input) => input.operation() },
        operationalReads: {
          getAuditEvent: unavailable,
          getCostSummary: unavailable,
          getUsageSummary: unavailable,
          getWorkspaceSpend: unavailable,
          listApiCredentialUsage: unavailable,
          listAuditEvents: unavailable,
          listCosts: unavailable,
          listOrganizationAuditEvents: async (invocation) => {
            received.push(invocation);
            return { items: [] };
          },
          listSpend: unavailable,
          listUsage: unavailable,
        },
        service: tenancyService(async () => {
          throw new Error("Unexpected service operation.");
        }),
      });
    const auditRequest = () =>
      new Request(`https://api.example/v1/organizations/${ORGANIZATION_ID}/audit-events?limit=5`, {
        headers: { "x-deployments-organization": ORGANIZATION_ID },
      });

    const allowed = await api(["audit:read"], [ORGANIZATION_ID])(auditRequest());
    expect(allowed.status).toBe(200);
    expect(received).toMatchObject([
      { id: ORGANIZATION_ID, query: { limit: "5" }, scope: { organizationId: ORGANIZATION_ID } },
    ]);

    const withoutCapability = await api(["organizations:read"], [ORGANIZATION_ID])(auditRequest());
    expect(withoutCapability.status).toBe(403);
    expect(await withoutCapability.json()).toMatchObject({ code: "insufficient_scope" });
    const foreignGrant = await api(["audit:read"], [PROJECT_ID])(auditRequest());
    expect(foreignGrant.status).toBe(403);
    expect(await foreignGrant.json()).toMatchObject({ code: "organization_scope_violation" });
    expect(received).toHaveLength(1);
  });

  test("authorizes tenancy access before looking up an idempotency replay", async () => {
    let idempotencyCalls = 0;
    const fetch = createTenancyApi({
      authorize: async () => {
        throw new PersistenceError(
          "forbidden",
          "project_scope_violation",
          "The credential cannot access the requested project.",
        );
      },
      authenticate: async () => ({
        principalId: PRINCIPAL_ID,
        scopes: ["environments:write"],
      }),
      idempotency: {
        execute: async () => {
          idempotencyCalls += 1;
          return { secret: "must-not-replay" };
        },
      },
      service: tenancyService(async () => {
        throw new Error("Unexpected service operation.");
      }),
    });

    const response = await fetch(
      new Request("https://api.example/v1/environments", {
        body: JSON.stringify({ name: "Production", type: "production" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "revoked-replay",
          "x-deployments-project": PROJECT_ID,
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "project_scope_violation" });
    expect(idempotencyCalls).toBe(0);
  });

  test("authorizes non-idempotent tenancy reads before invoking the service", async () => {
    let operationCalls = 0;
    const fetch = createTenancyApi({
      authorize: async () => {
        throw new PersistenceError(
          "forbidden",
          "organization_scope_violation",
          "The principal is not an active organization member.",
        );
      },
      authenticate: async () => ({
        organizationIds: [ORGANIZATION_ID],
        principalId: PRINCIPAL_ID,
        scopes: ["organizations:read"],
      }),
      idempotency: { execute: async (input) => input.operation() },
      service: tenancyService(async () => {
        operationCalls += 1;
        throw new Error("The read must not reach the service.");
      }),
    });

    const response = await fetch(
      new Request(`https://api.example/v1/organizations/${ORGANIZATION_ID}`, {
        headers: { "x-deployments-organization": ORGANIZATION_ID },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "organization_scope_violation" });
    expect(operationCalls).toBe(0);
  });

  test("keeps organization bootstrap idempotency principal-scoped after identity refresh", async () => {
    let authenticationCalls = 0;
    let operationCalls = 0;
    const organizations: Array<string | undefined> = [];
    const responses = new Map<string, unknown>();
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => ({
        principalId: PRINCIPAL_ID,
        scopes: ["organizations:write"],
        ...(authenticationCalls++ === 0 ? {} : { organizationIds: [ORGANIZATION_ID] }),
      }),
      idempotency: {
        execute: async (input) => {
          organizations.push(input.organizationId);
          const key = `${input.organizationId ?? `principal:${input.principalId}`}:${input.key}`;
          if (responses.has(key)) return responses.get(key);
          const response = await input.operation();
          responses.set(key, response);
          return response;
        },
      },
      service: tenancyService(async () => {
        operationCalls += 1;
        return organizationResponse({
          createdAt: "2026-07-24T12:00:00.000Z",
          id: ORGANIZATION_ID,
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: "2026-07-24T12:00:00.000Z",
          version: 1,
        });
      }),
    });
    const request = () =>
      new Request("https://api.example/v1/organizations", {
        body: JSON.stringify({ name: "Acme" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "bootstrap-organization",
        },
        method: "POST",
      });

    expect((await fetch(request())).status).toBe(201);
    expect((await fetch(request())).status).toBe(201);
    expect(operationCalls).toBe(1);
    expect(organizations).toEqual([undefined, undefined]);
  });

  test("keeps project-scoped tenancy idempotency stable across identity refresh", async () => {
    let authenticationCalls = 0;
    let operationCalls = 0;
    const organizations: Array<string | undefined> = [];
    const responses = new Map<string, unknown>();
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => ({
        principalId: PRINCIPAL_ID,
        projectIds: [PROJECT_ID],
        scopes: ["environments:write"],
        ...(authenticationCalls++ === 0 ? {} : { organizationIds: [ORGANIZATION_ID] }),
      }),
      idempotency: {
        execute: async (input) => {
          organizations.push(input.organizationId);
          const key = `${input.organizationId ?? `principal:${input.principalId}`}:${input.key}`;
          if (responses.has(key)) return responses.get(key);
          const response = await input.operation();
          responses.set(key, response);
          return response;
        },
      },
      service: tenancyService(
        async () => {
          throw new Error("Unexpected service operation.");
        },
        async () => {
          operationCalls += 1;
          return environmentResponse({
            createdAt: "2026-07-24T12:00:00.000Z",
            id: ENVIRONMENT_ID,
            kind: "production",
            name: "Production",
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            slug: "production",
            status: "active",
            updatedAt: "2026-07-24T12:00:00.000Z",
            version: 1,
          });
        },
      ),
    });
    const request = () =>
      new Request("https://api.example/v1/environments", {
        body: JSON.stringify({ name: "Production", type: "production" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-environment",
          "x-deployments-project": PROJECT_ID,
        },
        method: "POST",
      });

    expect((await fetch(request())).status).toBe(201);
    expect((await fetch(request())).status).toBe(201);
    expect(operationCalls).toBe(1);
    expect(organizations).toEqual([undefined, undefined]);
  });
});
