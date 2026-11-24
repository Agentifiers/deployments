import {
  OrganizationRecord,
  ServiceName,
  Ulid,
  makeOrganizationEgressAllowlistRepository,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { requestFromHttpApiV2Event } from "../lambda.ts";
import { createSystemOperatorApi } from "./api.ts";
import { parseSystemServicePrincipals } from "./service-principals.ts";
import { fakeService, OPERATOR_ID, operatorRequest } from "./system-operator.fixture.ts";

const ORGANIZATION_ID = "01J0000000000000000000000A";
const NOW = "2026-10-01T12:00:00.000Z";
const BILLING_SESSION = "arn:aws:sts::123456789012:assumed-role/billing-service/reconciler";
const AUDITOR_SESSION = "arn:aws:sts::123456789012:assumed-role/standing-auditor/nightly";

const ADMINISTRATOR = {
  authentication: "tenant-jwt",
  platformRole: "administrator",
  principalId: OPERATOR_ID,
  scopes: [],
} as const satisfies ApiIdentity;

const SERVICES = parseSystemServicePrincipals({
  DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
  DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS: JSON.stringify({
    auditor: {
      grants: ["organization-read"],
      role_arn: "arn:aws:iam::123456789012:role/standing-auditor",
    },
    billing: {
      grants: ["organization-read", "organization-holds", "organization-entitlements"],
      role_arn: "arn:aws:iam::123456789012:role/hosted/billing-service",
    },
  }),
});

const DEFAULT_ENTITLEMENTS = {
  features: { scim: true, sso: true },
  operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
  tenantLimits: {
    activeSandboxes: 8,
    apiRequestBurst: 40,
    apiRequestsPerSecond: 20,
    concurrentRuns: 8,
  },
};

type Caller = "operator" | { readonly session: string } | "unsigned";

function organizationMemory() {
  return evaluationMemoryDatabase([
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-01-01T00:00:00.000Z",
          id: ORGANIZATION_ID,
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: "2026-01-02T00:00:00.000Z",
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
  ]).database;
}

function install(services = SERVICES, database = organizationMemory()) {
  const fetch = createSystemOperatorApi({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer operator" ? ADMINISTRATOR : null,
    observers: [],
    requestId: () => "request-1",
    service: fakeService({ database }),
    services,
  });
  return async (caller: Caller, method: string, path: string, body?: unknown) => {
    const service = typeof caller === "object";
    const [rawPath = "", rawQueryString] =
      `${service ? "/v1/system/services" : "/v1/system"}${path}`.split("?");
    const response = await fetch(
      requestFromHttpApiV2Event({
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(caller === "operator" ? { headers: { authorization: "Bearer operator" } } : {}),
        rawPath,
        ...(rawQueryString ? { rawQueryString } : {}),
        requestContext: {
          ...(service
            ? { authorizer: { iam: { accountId: "123456789012", userArn: caller.session } } }
            : {}),
          domainName: "api.example.test",
          http: { method },
        },
      }),
    );
    if (!response) throw new Error(`${method} ${rawPath} was not routed.`);
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  };
}

describe("egress allowlist in the system standing", () => {
  test("shows operators the organization's allowlist with its notes", async () => {
    const database = organizationMemory();
    const send = install(SERVICES, database);
    await makeOrganizationEgressAllowlistRepository(database).replace({
      entries: [{ note: "Claims clearinghouse", origin: "https://claims.example.com" }],
      organizationId: Schema.decodeUnknownSync(Ulid)(ORGANIZATION_ID),
      principalId: Schema.decodeUnknownSync(Ulid)(OPERATOR_ID),
    });

    const standing = await send("operator", "GET", `/organizations/${ORGANIZATION_ID}/standing`);

    expect(standing.body.egressAllowlist).toEqual([
      { note: "Claims clearinghouse", origin: "https://claims.example.com" },
    ]);
  });
});

const organization = `/organizations/${ORGANIZATION_ID}`;
const billing = { session: BILLING_SESSION };
const tosReview = {
  customerMessage: "Your organization is under review.",
  operatorNote: "ticket 4411",
  reason: "policy",
};
const paymentOverdue = { customerMessage: "Update your payment method.", reason: "payment" };

describe("organization standing through the system API", () => {
  test("reports install defaults alone for an organization with no standing record", async () => {
    const send = install();

    expect(await send({ session: AUDITOR_SESSION }, "GET", `${organization}/standing`)).toEqual({
      body: {
        dataBoundary: null,
        defaults: DEFAULT_ENTITLEMENTS,
        effective: DEFAULT_ENTITLEMENTS,
        egressAllowlist: [],
        grants: { operator: null, service: null },
        holds: [],
        organizationId: ORGANIZATION_ID,
        state: "active",
        suspendedAt: null,
        version: 0,
      },
      status: 200,
    });
  });

  test("refuses a service's release of the operator's hold and names the owner", async () => {
    const send = install();

    const placed = await send("operator", "PUT", `${organization}/holds/tos-review`, tosReview);
    const released = await send(billing, "DELETE", `${organization}/holds/tos-review`);

    expect(placed).toEqual({
      body: {
        changed: true,
        standing: {
          dataBoundary: null,
          defaults: DEFAULT_ENTITLEMENTS,
          effective: DEFAULT_ENTITLEMENTS,
          egressAllowlist: [],
          grants: { operator: null, service: null },
          holds: [
            {
              customerMessage: "Your organization is under review.",
              key: "tos-review",
              operatorNote: "ticket 4411",
              placedAt: NOW,
              placedBy: { kind: "operator", principalId: OPERATOR_ID },
              reason: "policy",
              source: "operator",
            },
          ],
          organizationId: ORGANIZATION_ID,
          state: "suspended",
          suspendedAt: NOW,
          version: 1,
        },
      },
      status: 200,
    });
    expect(released).toEqual({
      body: {
        code: "standing_owned_by_another_source",
        detail: "Hold tos-review belongs to operator; only that source can change it.",
        owner: "operator",
        requestId: "request-1",
        status: 409,
        title: "Conflict",
      },
      status: 409,
    });
  });

  test("places and releases a service's own hold once, reporting no change on a repeat", async () => {
    const send = install();
    const hold = `${organization}/holds/payment-overdue`;

    const outcomes = [
      await send(billing, "PUT", hold, paymentOverdue),
      await send(billing, "PUT", hold, paymentOverdue),
      await send(billing, "DELETE", hold, { releaseNote: "Invoice paid." }),
      await send(billing, "DELETE", hold),
    ];

    expect(
      outcomes.map(({ body, status }) => {
        const standing = body.standing as { holds: { source: string }[]; state: string };
        return [status, body.changed, standing.state, standing.holds.map(({ source }) => source)];
      }),
    ).toEqual([
      [200, true, "suspended", ["service:billing"]],
      [200, false, "suspended", ["service:billing"]],
      [200, true, "active", []],
      [200, false, "active", []],
    ]);
    expect(await send("operator", "GET", `${organization}/standing/history`)).toEqual({
      body: {
        items: [
          {
            actor: { kind: "service", service: "billing" },
            change: {
              hold: {
                customerMessage: "Update your payment method.",
                key: "payment-overdue",
                operatorNote: null,
                placedAt: NOW,
                placedBy: { kind: "service", service: "billing" },
                reason: "payment",
                source: "service:billing",
              },
              kind: "hold-released",
              releaseNote: "Invoice paid.",
            },
            occurredAt: NOW,
            state: "active",
            version: 2,
          },
          {
            actor: { kind: "service", service: "billing" },
            change: {
              hold: {
                customerMessage: "Update your payment method.",
                key: "payment-overdue",
                operatorNote: null,
                placedAt: NOW,
                placedBy: { kind: "service", service: "billing" },
                reason: "payment",
                source: "service:billing",
              },
              kind: "hold-placed",
            },
            occurredAt: NOW,
            state: "suspended",
            version: 1,
          },
        ],
        nextCursor: null,
      },
      status: 200,
    });
  });

  test("merges the service grant below the operator grant on the same field", async () => {
    const send = install();

    await send(billing, "PUT", `${organization}/entitlements`, {
      operatorFundedModelSpendCeiling: { monthlyUsdMicros: 100_000_000 },
      tenantLimits: { activeSandboxes: 4, concurrentRuns: 16 },
    });
    await send("operator", "PUT", `${organization}/entitlements`, {
      tenantLimits: { concurrentRuns: 64 },
    });
    const standing = await send(billing, "GET", `${organization}/standing`);

    expect(standing).toEqual({
      body: {
        dataBoundary: null,
        defaults: DEFAULT_ENTITLEMENTS,
        effective: {
          features: { scim: true, sso: true },
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 100_000_000 },
          tenantLimits: {
            activeSandboxes: 4,
            apiRequestBurst: 40,
            apiRequestsPerSecond: 20,
            concurrentRuns: 64,
          },
        },
        egressAllowlist: [],
        grants: {
          operator: {
            entitlements: { tenantLimits: { concurrentRuns: 64 } },
            grantedAt: NOW,
            grantedBy: { kind: "operator", principalId: OPERATOR_ID },
          },
          service: {
            entitlements: {
              operatorFundedModelSpendCeiling: { monthlyUsdMicros: 100_000_000 },
              tenantLimits: { activeSandboxes: 4, concurrentRuns: 16 },
            },
            grantedAt: NOW,
            grantedBy: { kind: "service", service: "billing" },
          },
        },
        holds: [],
        organizationId: ORGANIZATION_ID,
        state: "active",
        suspendedAt: null,
        version: 2,
      },
      status: 200,
    });
    const cleared = await send(billing, "DELETE", `${organization}/entitlements`);
    expect([cleared.body.changed, cleared.body.standing]).toMatchObject([
      true,
      { grants: { operator: { grantedAt: NOW }, service: null } },
    ]);
  });

  test("pages the history newest first through the returned cursor", async () => {
    const send = install();
    await send("operator", "PUT", `${organization}/holds/tos-review`, tosReview);
    await send("operator", "PUT", `${organization}/entitlements`, {
      operatorFundedModelSpendCeiling: "unlimited",
    });
    await send("operator", "DELETE", `${organization}/holds/tos-review`);

    const pages = [];
    let cursor: unknown = "";
    while (typeof cursor === "string") {
      const page = await send(
        "operator",
        "GET",
        `${organization}/standing/history?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      const items = page.body.items as { change: { kind: string }; version: number }[];
      pages.push(items.map(({ change, version }) => [version, change.kind]));
      cursor = page.body.nextCursor;
    }

    expect(pages).toEqual([
      [
        [3, "hold-released"],
        [2, "grant-set"],
      ],
      [[1, "hold-placed"]],
    ]);
    expect(
      await send("operator", "GET", `${organization}/standing/history?cursor=latest`),
    ).toMatchObject({ body: { code: "invalid_cursor" }, status: 400 });
  });

  test("refuses a request body that names a source", async () => {
    const send = install();

    expect(
      await send(billing, "PUT", `${organization}/holds/tos-review`, {
        ...paymentOverdue,
        source: "operator",
      }),
    ).toMatchObject({ body: { code: "invalid_request" }, status: 400 });
    expect((await send(billing, "GET", `${organization}/standing`)).body.state).toBe("active");
  });

  test("records the signed service as the source when the query names the operator", async () => {
    const send = install();

    expect(
      await send(
        billing,
        "PUT",
        `${organization}/holds/payment-overdue?source=operator`,
        paymentOverdue,
      ),
    ).toMatchObject({
      body: {
        standing: {
          holds: [
            {
              customerMessage: "Update your payment method.",
              key: "payment-overdue",
              operatorNote: null,
              placedAt: NOW,
              placedBy: { kind: "service", service: "billing" },
              reason: "payment",
              source: "service:billing",
            },
          ],
        },
      },
      status: 200,
    });
  });
});

describe("organization data boundary through the system API", () => {
  const boundary = `${organization}/data-boundary`;
  const operator = { kind: "operator", principalId: OPERATOR_ID };

  test("sets and clears the boundary once, recording each change in the history", async () => {
    const send = install();

    const outcomes = [
      await send("operator", "PUT", boundary, { operatorNote: "BAA 2026-17", profile: "phi" }),
      await send("operator", "PUT", boundary, { operatorNote: "again", profile: "phi" }),
      await send("operator", "DELETE", boundary, { operatorNote: "BAA ended" }),
      await send("operator", "DELETE", boundary, { operatorNote: "again" }),
    ];

    expect(
      outcomes.map(({ body, status }) => [
        status,
        body.changed,
        (body.standing as { dataBoundary: unknown }).dataBoundary,
      ]),
    ).toEqual([
      [200, true, { operatorNote: "BAA 2026-17", profile: "phi", setAt: NOW, setBy: operator }],
      [200, false, { operatorNote: "BAA 2026-17", profile: "phi", setAt: NOW, setBy: operator }],
      [200, true, null],
      [200, false, null],
    ]);
    expect((await send("operator", "GET", `${organization}/standing/history`)).body.items).toEqual([
      {
        actor: operator,
        change: { kind: "data-boundary-cleared", operatorNote: "BAA ended", profile: "phi" },
        occurredAt: NOW,
        state: "active",
        version: 2,
      },
      {
        actor: operator,
        change: {
          dataBoundary: {
            operatorNote: "BAA 2026-17",
            profile: "phi",
            setAt: NOW,
            setBy: operator,
          },
          kind: "data-boundary-set",
        },
        occurredAt: NOW,
        state: "active",
        version: 1,
      },
    ]);
  });

  test("requires a non-blank note and a known profile", async () => {
    const send = install();

    expect([
      (await send("operator", "PUT", boundary, { profile: "phi" })).body.code,
      (await send("operator", "PUT", boundary, { operatorNote: " ", profile: "phi" })).body.code,
      (await send("operator", "PUT", boundary, { operatorNote: "BAA", profile: "hipaa" })).body
        .code,
      (await send("operator", "DELETE", boundary)).body.code,
    ]).toEqual(["invalid_request", "invalid_request", "invalid_request", "invalid_request"]);
  });

  test("leaves the boundary out of every machine service's reach", async () => {
    const send = install();
    const service = fakeService();
    const asBilling = operatorRequest({
      body: { operatorNote: "BAA 2026-17", profile: "phi" },
      caller: { kind: "service", service: Schema.decodeUnknownSync(ServiceName)("billing") },
      params: { organizationId: ORGANIZATION_ID },
    });

    const refusal = (attempt: Promise<unknown>) =>
      attempt.then(
        () => "accepted",
        (cause: unknown) => cause,
      );

    expect(
      await refusal(send(billing, "PUT", boundary, { operatorNote: "BAA", profile: "phi" })),
    ).toMatchObject({ message: expect.stringContaining("was not routed") });
    expect([
      await refusal(service("setSystemOrganizationDataBoundary", asBilling)),
      await refusal(
        service("clearSystemOrganizationDataBoundary", {
          ...asBilling,
          body: { operatorNote: "x" },
        }),
      ),
    ]).toMatchObject([
      { code: "standing_owned_by_another_source", extensions: { owner: "operator" }, status: 409 },
      { code: "standing_owned_by_another_source", extensions: { owner: "operator" }, status: 409 },
    ]);
  });
});

describe("system service authorization", () => {
  test("refuses a role that is not a configured service", async () => {
    const send = install();

    expect(
      await send(
        { session: "arn:aws:sts::123456789012:assumed-role/platform-observer/install-observer" },
        "GET",
        `${organization}/standing`,
      ),
    ).toEqual({
      body: {
        code: "system_service_required",
        detail:
          "Service routes require an assumed-role session of a role in system_service_principals in this install's account.",
        requestId: "request-1",
        status: 403,
        title: "Forbidden",
      },
      status: 403,
    });
  });

  test("refuses a service whose grants do not cover the route", async () => {
    const send = install();

    expect(
      await send(
        { session: AUDITOR_SESSION },
        "PUT",
        `${organization}/holds/audit`,
        paymentOverdue,
      ),
    ).toEqual({
      body: {
        code: "system_service_grant_required",
        detail: "Service auditor needs the organization-holds grant for this route.",
        grant: "organization-holds",
        requestId: "request-1",
        status: 403,
        title: "Forbidden",
      },
      status: 403,
    });
  });

  test("serves only the standing operations, and only to signed requests", async () => {
    const fetch = createSystemOperatorApi({
      authenticate: async () => ADMINISTRATOR,
      observers: [],
      requestId: () => "request-1",
      service: fakeService(),
      services: SERVICES,
    });
    const status = async (rawPath: string, userArn?: string) =>
      (
        await fetch(
          requestFromHttpApiV2Event({
            headers: { authorization: "Bearer operator" },
            rawPath,
            requestContext: {
              ...(userArn ? { authorizer: { iam: { userArn } } } : {}),
              http: { method: "GET" },
            },
          }),
        )
      )?.status;

    expect([
      await status(`/v1/system/services${organization}/standing`, BILLING_SESSION),
      await status(`/v1/system/services${organization}/standing`),
      await status(`/v1/system/services${organization}/limits`, BILLING_SESSION),
      await status("/v1/system/services/organizations", BILLING_SESSION),
      await status("/v1/system/services/installation", BILLING_SESSION),
    ]).toEqual([200, 403, undefined, undefined, undefined]);
  });

  test("answers 503 on every service route while the principals are misconfigured", async () => {
    const send = install(
      parseSystemServicePrincipals({
        DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
        DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS: "{",
      }),
    );

    expect(await send(billing, "GET", `${organization}/standing`)).toMatchObject({
      body: { code: "system_services_misconfigured" },
      status: 503,
    });
    expect((await send("operator", "GET", `${organization}/standing`)).status).toBe(200);
  });
});
