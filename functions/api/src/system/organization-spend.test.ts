import {
  addScopeSpend,
  scopeSpendShardCandidates,
  type DynamoDatabaseService,
  type SpendFunding,
  type Ulid,
} from "@deployments-ai/db";
import { makeTenancyTestDatabase } from "@deployments-ai/db/memory-testing";
import { describe, expect, test } from "bun:test";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { requestFromHttpApiV2Event } from "../lambda.ts";
import { createSystemOperatorApi } from "./api.ts";
import { parseSystemServicePrincipals } from "./service-principals.ts";
import { fakeService, OPERATOR_ID } from "./system-operator.fixture.ts";

const ORGANIZATION_ID = "01J0000000000000000000000A" as Ulid;
const BILLING_SESSION = "arn:aws:sts::123456789012:assumed-role/billing-service/meter";
const HOLDER_SESSION = "arn:aws:sts::123456789012:assumed-role/abuse-desk/review";

const SERVICES = parseSystemServicePrincipals({
  DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
  DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS: JSON.stringify({
    "abuse-desk": {
      grants: ["organization-holds"],
      role_arn: "arn:aws:iam::123456789012:role/abuse-desk",
    },
    billing: {
      grants: ["organization-read"],
      role_arn: "arn:aws:iam::123456789012:role/hosted/billing-service",
    },
  }),
});

async function recordSpend(
  database: DynamoDatabaseService,
  input: {
    readonly funding: SpendFunding;
    readonly occurredAt: string;
    readonly shard: number;
    readonly spendUsdMicros: number;
  },
) {
  await database.transactWrite(
    scopeSpendShardCandidates({
      occurredAt: input.occurredAt,
      scope: {
        environmentId: "01J0000000000000000000000E" as Ulid,
        organizationId: ORGANIZATION_ID,
        projectId: "01J0000000000000000000000P" as Ulid,
        workspaceId: undefined,
      },
      shard: input.shard,
      updatedAt: input.occurredAt,
    }).map((candidate) => ({
      kind: "put" as const,
      record: addScopeSpend(candidate, undefined, input.spendUsdMicros, input.funding),
    })),
  );
}

async function install() {
  const { database } = makeTenancyTestDatabase();
  await recordSpend(database, {
    funding: "operator",
    occurredAt: "2026-09-12T08:00:00.000Z",
    shard: 1,
    spendUsdMicros: 4_000_000,
  });
  await recordSpend(database, {
    funding: "operator",
    occurredAt: "2026-10-01T03:00:00.000Z",
    shard: 2,
    spendUsdMicros: 1_250_000,
  });
  await recordSpend(database, {
    funding: "organization",
    occurredAt: "2026-10-01T04:00:00.000Z",
    shard: 3,
    spendUsdMicros: 300_000,
  });
  const fetch = createSystemOperatorApi({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer operator"
        ? ({
            authentication: "tenant-jwt",
            platformRole: "administrator",
            principalId: OPERATOR_ID,
            scopes: [],
          } satisfies ApiIdentity)
        : null,
    observers: [],
    requestId: () => "request-1",
    service: fakeService({ database }),
    services: SERVICES,
  });
  return async (caller: "operator" | { readonly session: string }, path: string) => {
    const service = typeof caller === "object";
    const [rawPath = "", rawQueryString] =
      `${service ? "/v1/system/services" : "/v1/system"}${path}`.split("?");
    const response = await fetch(
      requestFromHttpApiV2Event({
        ...(service ? {} : { headers: { authorization: "Bearer operator" } }),
        rawPath,
        ...(rawQueryString ? { rawQueryString } : {}),
        requestContext: {
          ...(service
            ? { authorizer: { iam: { accountId: "123456789012", userArn: caller.session } } }
            : {}),
          domainName: "api.example.test",
          http: { method: "GET" },
        },
      }),
    );
    if (!response) throw new Error(`GET ${rawPath} was not routed.`);
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  };
}

const spend = `/organizations/${ORGANIZATION_ID}/spend`;

describe("organization spend through the system API", () => {
  test("answers a service with organization-read the current month split by who paid", async () => {
    const send = await install();

    expect(await send({ session: BILLING_SESSION }, spend)).toEqual({
      body: {
        asOf: "2026-10-01T12:00:00.000Z",
        month: "2026-10",
        operatorFundedUsdMicros: 1_250_000,
        organizationFundedUsdMicros: 300_000,
        organizationId: ORGANIZATION_ID,
        periodStart: "2026-10-01T00:00:00.000Z",
        totalUsdMicros: 1_550_000,
      },
      status: 200,
    });
  });

  test("answers an administrator a closed month", async () => {
    const send = await install();

    expect(await send("operator", `${spend}?month=2026-09`)).toEqual({
      body: {
        asOf: "2026-10-01T12:00:00.000Z",
        month: "2026-09",
        operatorFundedUsdMicros: 4_000_000,
        organizationFundedUsdMicros: 0,
        organizationId: ORGANIZATION_ID,
        periodStart: "2026-09-01T00:00:00.000Z",
        totalUsdMicros: 4_000_000,
      },
      status: 200,
    });
  });

  test("refuses a service without organization-read", async () => {
    const send = await install();

    expect(await send({ session: HOLDER_SESSION }, spend)).toEqual({
      body: {
        code: "system_service_grant_required",
        detail: "Service abuse-desk needs the organization-read grant for this route.",
        grant: "organization-read",
        requestId: "request-1",
        status: 403,
        title: "Forbidden",
      },
      status: 403,
    });
  });

  test("refuses a malformed or future month", async () => {
    const send = await install();
    const refusals = await Promise.all(
      ["2026-11", "2026-9", "2026-13", "september"].map(async (month) => {
        const { body, status } = await send(
          { session: BILLING_SESSION },
          `${spend}?month=${month}`,
        );
        return [status, body.code];
      }),
    );

    expect(refusals).toEqual([
      [400, "invalid_month"],
      [400, "invalid_month"],
      [400, "invalid_month"],
      [400, "invalid_month"],
    ]);
  });
});
