import { type PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  databaseWithRecords,
  ENVIRONMENT_ID as JWT_SOURCE_ENVIRONMENT_ID,
  environmentHierarchyRecords,
  PRINCIPAL_ID as JWT_PRINCIPAL_ID,
  storageKey,
} from "./application-auth-test-support.ts";
import { createApplicationAuthenticator } from "./application-auth.ts";
import {
  createTenancyApi,
  type AgentReleasePromotionResult,
  type ApiIdentity,
  type ApiInvocation,
  type TenancyApiService,
} from "./index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SOURCE_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const TARGET_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const SOURCE_RELEASE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const manifest = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "Agent",
  metadata: { key: "example.assistant", name: "Example Assistant", version: "1.0.0" },
  spec: {
    instructions: "Answer questions.",
    model: { id: "openrouter/default" },
    sandbox: { mode: "none" },
  },
} as const;

const targetRelease = {
  agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  contentHash: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-07-25T12:00:00.000Z",
  createdByPrincipalId: PRINCIPAL_ID,
  environmentId: TARGET_ENVIRONMENT_ID,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  manifest,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  releaseNumber: 1,
  status: "active",
  version: 0,
} as unknown as AgentReleasePromotionResult["release"];

function serviceWithPromote(
  promote: (invocation: ApiInvocation) => Promise<AgentReleasePromotionResult>,
): TenancyApiService {
  const unavailable = async () => {
    throw new Error("Unexpected service operation.");
  };
  const group = new Proxy({}, { get: () => unavailable });
  return new Proxy({} as TenancyApiService, {
    get: (_target, name) =>
      name === "agentReleases"
        ? new Proxy({ promote }, { get: (t, key) => (key === "promote" ? t.promote : unavailable) })
        : group,
  });
}

function promoteRequest(targetEnvironmentId = TARGET_ENVIRONMENT_ID) {
  return new Request(`https://api.example/v1/agent-releases/${SOURCE_RELEASE_ID}/promote`, {
    body: JSON.stringify({ targetEnvironmentId }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": "promote-release-test",
      "x-deployments-environment": SOURCE_ENVIRONMENT_ID,
    },
    method: "POST",
  });
}

function identity(environmentIds: readonly string[]): ApiIdentity {
  return {
    environmentIds,
    organizationIds: [ORGANIZATION_ID],
    principalId: PRINCIPAL_ID,
    scopes: ["agents:write"],
  };
}

describe("agent release promotion HTTP API", () => {
  test("answers 201 when the target release is created and 200 when it already exists", async () => {
    const authorized: (string | undefined)[] = [];
    let created = true;
    const fetch = createTenancyApi({
      authorize: async (invocation) => void authorized.push(invocation.scope.environmentId),
      authenticate: async () => identity([SOURCE_ENVIRONMENT_ID, TARGET_ENVIRONMENT_ID]),
      idempotency: { execute: async (input) => input.operation() },
      service: serviceWithPromote(async (invocation) => {
        expect(invocation.id).toBe(SOURCE_RELEASE_ID);
        expect(invocation.body).toEqual({ targetEnvironmentId: TARGET_ENVIRONMENT_ID });
        const result = { created, release: targetRelease };
        created = false;
        return result;
      }),
    });

    const first = await fetch(promoteRequest());
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ environmentId: TARGET_ENVIRONMENT_ID });
    const second = await fetch(promoteRequest());
    expect(second.status).toBe(200);
    expect(authorized).toEqual([
      SOURCE_ENVIRONMENT_ID,
      TARGET_ENVIRONMENT_ID,
      SOURCE_ENVIRONMENT_ID,
      TARGET_ENVIRONMENT_ID,
    ]);
  });

  test("rejects credentials without a grant on the target environment", async () => {
    let promoted = false;
    const fetch = createTenancyApi({
      authorize: async () => undefined,
      authenticate: async () => identity([SOURCE_ENVIRONMENT_ID]),
      idempotency: { execute: async (input) => input.operation() },
      service: serviceWithPromote(async () => {
        promoted = true;
        return { created: true, release: targetRelease };
      }),
    });

    const response = await fetch(promoteRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "environment_scope_violation" });
    expect(promoted).toBe(false);
  });

  describe("with tenant JWTs from the application authenticator", () => {
    const jwtTargetEnvironmentId = "01ARZ3NDEKTSV4RRFFQ69G5FC0";

    function jwtPromotionApi(claims: Readonly<Record<string, unknown>>) {
      const authorized: { readonly environmentIds: unknown; readonly scope: unknown }[] = [];
      const promotedWith: unknown[] = [];
      const records = environmentHierarchyRecords();
      const principalKey = {
        pk: `PRINCIPAL#${JWT_PRINCIPAL_ID}`,
        sk: `PRINCIPAL#${JWT_PRINCIPAL_ID}`,
      };
      records.set(storageKey("control", principalKey), {
        ...principalKey,
        data: { id: JWT_PRINCIPAL_ID, kind: "human", status: "active" },
        itemType: "principal",
      } as unknown as PlatformRecord);
      const fetch = createTenancyApi({
        // Device-flow platform tokens carry no tenant claims; the request header selects the scope.
        authenticate: createApplicationAuthenticator({
          database: databaseWithRecords(records),
          jwt: {
            audience: "api",
            claimProfile: "platform",
            issuer: "https://auth.deployments.ai",
            verify: async () => ({ scope: "agents:write", sub: JWT_PRINCIPAL_ID, ...claims }),
          },
        }),
        authorize: async (invocation) =>
          void authorized.push({
            environmentIds: invocation.identity.environmentIds,
            scope: invocation.scope.environmentId,
          }),
        idempotency: { execute: async (input) => input.operation() },
        service: serviceWithPromote(async (invocation) => {
          promotedWith.push(invocation.identity.environmentIds);
          return { created: true, release: targetRelease };
        }),
      });
      const request = new Request(
        `https://api.example/v1/agent-releases/${SOURCE_RELEASE_ID}/promote`,
        {
          body: JSON.stringify({ targetEnvironmentId: jwtTargetEnvironmentId }),
          headers: {
            authorization: "Bearer a.b.c",
            "content-type": "application/json",
            "idempotency-key": "promote-release-jwt-test",
            "x-deployments-environment": JWT_SOURCE_ENVIRONMENT_ID,
          },
          method: "POST",
        },
      );
      return { authorized, fetch: () => fetch(request), promotedWith };
    }

    test("lets a request-selected JWT promote after authorizing the target environment", async () => {
      const api = jwtPromotionApi({});

      const response = await api.fetch();

      expect(response.status).toBe(201);
      const both = [JWT_SOURCE_ENVIRONMENT_ID, jwtTargetEnvironmentId];
      expect(api.authorized).toEqual([
        { environmentIds: [JWT_SOURCE_ENVIRONMENT_ID], scope: JWT_SOURCE_ENVIRONMENT_ID },
        { environmentIds: both, scope: jwtTargetEnvironmentId },
      ]);
      expect(api.promotedWith).toEqual([both]);
    });

    test("keeps an environment-bound JWT confined to its claimed environment", async () => {
      const api = jwtPromotionApi({ environment_id: JWT_SOURCE_ENVIRONMENT_ID });

      const response = await api.fetch();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "environment_scope_violation" });
      expect(api.promotedWith).toEqual([]);
    });
  });
});
