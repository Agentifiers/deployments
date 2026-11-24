import { TENANCY_API_SCHEMAS } from "@deployments-ai/api-contract";
import {
  HoldKey,
  makeDynamoDatabase,
  makeOrganizationStandingRepository,
  makeTenancyPersistence,
  StandingActor,
  tableNamesFromEnvironment,
  type HoldReason,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { createOrganizationGate } from "@deployments-ai/organization-admission";
import {
  makeInMemoryRequestRateStore,
  makeOrganizationRequestLimiter,
} from "@deployments-ai/tenant-limits";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createApiLambdaHandler, makeApiFoundation } from "./api-lambda-foundation.ts";
import type { ApiIdentity } from "./api-service-contracts.ts";
import { createTenancyApi, type TenancyApiService } from "./index.ts";
import { makeOrganizationStandingApiService } from "./organization-standing-api.ts";

const FOUNDER = "01ARZ3NDEKTSV4RRFFQ69G5FA0";
const MEMBER = "01ARZ3NDEKTSV4RRFFQ69G5FA1";
const SERVICE_ACCOUNT = "01ARZ3NDEKTSV4RRFFQ69G5FA3";
const API_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FA4";
const LIMITS = {
  activeSandboxes: 8,
  apiRequestBurst: 40,
  apiRequestsPerSecond: 20,
  concurrentRuns: 8,
};
const ENVIRONMENT = {
  DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: "5000000",
  DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
    active_sandboxes: 8,
    api_request_burst: 40,
    api_requests_per_second: 20,
    concurrent_runs: 8,
  }),
};
const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: FOUNDER,
});
const MESSAGES: Readonly<Record<"abuse" | "payment", string>> = {
  abuse: "Your organization is under review.",
  payment: "Update your payment method.",
};

const unrouted = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error("Unexpected service operation.");
    },
  },
);

async function installation() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(tables.control, humanPrincipalRecord(FOUNDER, "founder@example.com"));
  fake.put(tables.control, humanPrincipalRecord(MEMBER, "member@example.com"));
  const database = makeDynamoDatabase(fake.client, tables);
  const persistence = makeTenancyPersistence({ database });
  const founder = { principalId: FOUNDER, scopes: ["platform:*"] };
  const organization = await persistence.organizations.create({
    body: { name: "Standing" },
    identity: founder,
    idempotencyKey: "create-organization",
    query: {},
    scope: {},
  });
  await persistence.organizationMembers.add({
    body: { principalId: MEMBER, role: "viewer" },
    identity: founder,
    idempotencyKey: "add-member",
    query: {},
    scope: { organizationId: organization.id },
  });
  let clock = Date.UTC(2026, 9, 1);
  const standing = makeOrganizationStandingRepository({
    database,
    installDefaults: { operatorFundedModelSpendCeiling: "unlimited", tenantLimits: LIMITS },
    now: () => new Date(clock),
  });
  const callers: Readonly<Record<string, ApiIdentity>> = {
    "Bearer api-key": {
      apiCredentialId: API_KEY,
      authentication: "api-credential",
      opaqueCredential: true,
      organizationIds: [organization.id],
      principalId: SERVICE_ACCOUNT,
      scopes: ["projects:write", "api-keys:write"],
    },
    "Bearer member": {
      authentication: "tenant-jwt",
      organizationIds: [organization.id],
      principalId: MEMBER,
      scopes: ["organizations:read", "projects:write", "api-keys:write"],
    },
  };
  const authenticate = async (request: Request) =>
    callers[request.headers.get("authorization") ?? ""] ?? null;
  const tenancy = createTenancyApi({
    authenticate,
    authorize: (invocation, operationName, mutation) =>
      persistence.authorize(invocation, operationName, mutation),
    idempotency: { execute: async (input) => input.operation() },
    service: new Proxy(
      {
        organizationStanding: makeOrganizationStandingApiService({
          database,
          environment: ENVIRONMENT,
        }),
      },
      {
        get: (target, name) =>
          name === "organizationStanding" ? target.organizationStanding : unrouted,
      },
    ) as TenancyApiService,
  });
  const handler = createApiLambdaHandler(
    () => async (request) => {
      const { pathname } = new URL(request.url);
      return pathname.endsWith("/standing")
        ? tenancy(request)
        : new Response(`routed ${request.method} ${pathname}`);
    },
    {
      dependencies: () => ({
        foundation: {
          ...makeApiFoundation({
            DEPLOYMENTS_AI_API_JWT_AUDIENCE: "platform-api",
            DEPLOYMENTS_AI_API_JWT_ISSUER: "https://issuer.example.test",
          }),
          authenticate,
        },
        gate: createOrganizationGate({
          defaultLimits: LIMITS,
          limiter: makeOrganizationRequestLimiter({
            service: "tenancy-api",
            store: makeInMemoryRequestRateStore(),
            writeMetric: () => {},
          }),
          now: () => clock,
          service: "tenancy-api",
          standing,
          writeMetric: () => {},
        }),
      }),
    },
  );
  const send = async (caller: string, method: string, path: string) => {
    const result = await handler({
      headers: { authorization: caller, "x-deployments-organization": organization.id },
      rawPath: path,
      requestContext: { domainName: "api.example.test", http: { method } },
    });
    const body: unknown = result.headers["content-type"]?.includes("json")
      ? JSON.parse(result.body)
      : result.body;
    return { body, status: result.statusCode };
  };
  const holdKey = (reason: HoldReason) => Schema.decodeUnknownSync(HoldKey)(`${reason}-review`);
  return {
    organizationId: organization.id,
    placeHold: async (reason: "abuse" | "payment") => {
      await standing.placeHold({
        actor: OPERATOR,
        customerMessage: MESSAGES[reason],
        key: holdKey(reason),
        operatorNote: "ticket 4411",
        organizationId: organization.id,
        reason,
      });
      clock += 5_000;
    },
    releaseHold: async (reason: HoldReason) => {
      await standing.releaseHold({
        actor: OPERATOR,
        key: holdKey(reason),
        organizationId: organization.id,
      });
      clock += 5_000;
    },
    send,
    setDataBoundary: async () => {
      await standing.setDataBoundary({
        actor: OPERATOR,
        operatorNote: "BAA 2026-17",
        organizationId: organization.id,
        profile: "phi",
      });
      clock += 5_000;
    },
  };
}

describe("API edge on organization standing", () => {
  for (const reason of ["payment", "abuse"] as const) {
    for (const caller of ["Bearer member", "Bearer api-key"]) {
      test(`a ${reason} hold refuses changes but not reads or remediation for ${caller}`, async () => {
        const { organizationId, placeHold, releaseHold, send } = await installation();
        const hold = {
          customerMessage: MESSAGES[reason],
          reason,
          since: "2026-10-01T00:00:00.000Z",
        };

        await placeHold(reason);
        const read = await send(caller, "GET", "/v1/projects");
        const write = await send(caller, "POST", "/v1/projects");
        const revoke = await send(caller, "DELETE", `/v1/api-keys/${API_KEY}`);
        const standing = await send(
          "Bearer member",
          "GET",
          `/v1/organizations/${organizationId}/standing`,
        );
        await releaseHold(reason);
        const afterRelease = await send(caller, "POST", "/v1/projects");

        expect(read).toEqual({ body: "routed GET /v1/projects", status: 200 });
        expect(write).toEqual({
          body: {
            type: "https://docs.deployments.ai/errors/organization-suspended",
            title: "The organization is suspended.",
            status: 403,
            code: "organization_suspended",
            detail:
              "This organization can read its data and reduce access or activity, but cannot make other changes until every hold is released.",
            holds: [hold],
            requestId: expect.stringMatching(/^req_[0-9a-f-]{36}$/u),
          },
          status: 403,
        });
        expect<unknown>(
          Schema.decodeUnknownSync(TENANCY_API_SCHEMAS.OrganizationSuspendedProblem)(write.body),
        ).toEqual(write.body);
        expect(revoke).toEqual({ body: `routed DELETE /v1/api-keys/${API_KEY}`, status: 200 });
        expect(standing).toEqual({
          body: {
            dataBoundary: null,
            effective: {
              features: { scim: true, sso: true },
              operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
              tenantLimits: LIMITS,
            },
            holds: [hold],
            organizationId,
            state: "suspended",
            suspendedAt: "2026-10-01T00:00:00.000Z",
          },
          status: 200,
        });
        expect(afterRelease).toEqual({ body: "routed POST /v1/projects", status: 200 });
      });
    }
  }

  test("a hold refuses directory and identity provider changes but not reads or token revocation", async () => {
    const { placeHold, send } = await installation();
    const token = "01ARZ3NDEKTSV4RRFFQ69G5FA5";

    await placeHold("payment");
    const outcomes = [];
    for (const [method, path] of [
      ["GET", "/v1/directory"],
      ["PUT", "/v1/directory"],
      ["POST", "/v1/directory/tokens"],
      ["DELETE", `/v1/directory/tokens/${token}`],
      ["GET", "/v1/identity-provider"],
      ["PUT", "/v1/identity-provider"],
    ] as const) {
      outcomes.push(`${method} ${path} ${(await send("Bearer member", method, path)).status}`);
    }

    expect(outcomes).toEqual([
      "GET /v1/directory 200",
      "PUT /v1/directory 403",
      "POST /v1/directory/tokens 403",
      `DELETE /v1/directory/tokens/${token} 200`,
      "GET /v1/identity-provider 200",
      "PUT /v1/identity-provider 403",
    ]);
  });

  test("an active organization's standing shows no holds and its effective entitlements", async () => {
    const { organizationId, send } = await installation();

    expect(
      await send("Bearer member", "GET", `/v1/organizations/${organizationId}/standing`),
    ).toEqual({
      body: {
        dataBoundary: null,
        effective: {
          features: { scim: true, sso: true },
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
          tenantLimits: LIMITS,
        },
        holds: [],
        organizationId,
        state: "active",
        suspendedAt: null,
      },
      status: 200,
    });
  });

  test("a member sees the organization's data boundary and since when, not the operator's note", async () => {
    const { organizationId, send, setDataBoundary } = await installation();

    await setDataBoundary();
    const { body, status } = await send(
      "Bearer member",
      "GET",
      `/v1/organizations/${organizationId}/standing`,
    );

    expect([status, body]).toMatchObject([
      200,
      {
        dataBoundary: { profile: "phi", since: "2026-10-01T00:00:00.000Z" },
        holds: [],
        state: "active",
      },
    ]);
    expect(Object.keys((body as { dataBoundary: object }).dataBoundary).toSorted()).toEqual([
      "profile",
      "since",
    ]);
    expect(JSON.stringify(body)).not.toContain("BAA 2026-17");
  });
});
