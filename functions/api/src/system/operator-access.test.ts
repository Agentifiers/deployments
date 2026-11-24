import { OrganizationRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { requestFromHttpApiV2Event } from "../lambda.ts";
import { createSystemOperatorApi } from "./api.ts";
import { parseSystemServicePrincipals } from "./service-principals.ts";
import { fakeService, OPERATOR_ID } from "./system-operator.fixture.ts";

const ORGANIZATION_ID = "01J0000000000000000000000A";
const ARCHIVED_ID = "01J0000000000000000000000B";
const BILLING_SESSION = "arn:aws:sts::123456789012:assumed-role/billing-service/reconciler";

const ADMINISTRATOR = {
  authentication: "tenant-jwt",
  platformRole: "administrator",
  principalId: OPERATOR_ID,
  scopes: [],
} as const satisfies ApiIdentity;

function organization(id: string, status: "active" | "archived") {
  return Schema.decodeUnknownSync(OrganizationRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-01-01T00:00:00.000Z",
        id,
        name: id === ORGANIZATION_ID ? "Acme" : "Gone",
        slug: id === ORGANIZATION_ID ? "acme" : "gone",
        status,
        updatedAt: "2026-01-02T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
}

function install() {
  const memory = evaluationMemoryDatabase([
    organization(ORGANIZATION_ID, "active"),
    organization(ARCHIVED_ID, "archived"),
  ]);
  const fetch = createSystemOperatorApi({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer operator" ? ADMINISTRATOR : null,
    observers: [],
    requestId: () => "request-1",
    service: fakeService({ database: memory.database }),
    services: parseSystemServicePrincipals({
      DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
      DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS: JSON.stringify({
        billing: {
          grants: ["organization-read", "organization-holds", "organization-entitlements"],
          role_arn: "arn:aws:iam::123456789012:role/hosted/billing-service",
        },
      }),
    }),
  });
  const send = async (method: string, path: string, body?: unknown, service = false) => {
    const [rawPath = "", rawQueryString] =
      `${service ? "/v1/system/services" : "/v1/system"}${path}`.split("?");
    const response = await fetch(
      requestFromHttpApiV2Event({
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(service ? {} : { headers: { authorization: "Bearer operator" } }),
        rawPath,
        ...(rawQueryString ? { rawQueryString } : {}),
        requestContext: {
          ...(service
            ? { authorizer: { iam: { accountId: "123456789012", userArn: BILLING_SESSION } } }
            : {}),
          domainName: "api.example.test",
          http: { method },
        },
      }),
    );
    if (!response) return { status: undefined };
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  };
  const audit = () =>
    memory
      .all()
      .flatMap((record) =>
        record.itemType === "audit-event"
          ? [`${record.data.action} by ${record.data.actor.type} ${record.data.actor.id}`]
          : [],
      );
  return { audit, send };
}

const access = `/organizations/${ORGANIZATION_ID}/operator-access`;
const ACME = { id: ORGANIZATION_ID, name: "Acme", slug: "acme", status: "active" };
const OPEN_ACCESS = {
  closedAt: null,
  expiresAt: "2026-10-01T12:30:00.000Z",
  grantId: expect.any(String),
  openedAt: "2026-10-01T12:00:00.000Z",
  organizationId: ORGANIZATION_ID,
  principalId: OPERATOR_ID,
  reason: "Customer asked for help",
  status: "open",
  ticket: "SUP-7",
};

describe("operator access through the system API", () => {
  test("opens, renews, reads, lists, and closes the caller's access, each in the customer's audit log", async () => {
    const { audit, send } = install();
    const open = { durationMinutes: 30, reason: "Customer asked for help", ticket: "SUP-7" };

    const before = await send("GET", access);
    const opened = await send("PUT", access, open);
    const renewed = await send("PUT", access, open);
    const read = await send("GET", access);
    const listed = await send("GET", `/operator-access?organizationId=${ORGANIZATION_ID}`);
    const closed = await send("DELETE", access);
    const closedAgain = await send("DELETE", access);
    const listedAfter = await send("GET", "/operator-access");

    expect(before).toEqual({ body: { access: null, organization: ACME }, status: 200 });
    expect(opened).toEqual({ body: { access: OPEN_ACCESS, renewed: false }, status: 200 });
    expect(renewed).toEqual({ body: { access: OPEN_ACCESS, renewed: true }, status: 200 });
    expect(renewed.body?.access).toEqual(opened.body?.access);
    expect(read).toEqual({ body: { access: OPEN_ACCESS, organization: ACME }, status: 200 });
    expect(listed).toEqual({ body: { items: [OPEN_ACCESS], nextCursor: null }, status: 200 });
    expect(closed).toEqual({
      body: {
        access: { ...OPEN_ACCESS, closedAt: "2026-10-01T12:00:00.000Z", status: "closed" },
        changed: true,
      },
      status: 200,
    });
    expect(closedAgain.body?.changed).toBe(false);
    expect(listedAfter).toEqual({ body: { items: [], nextCursor: null }, status: 200 });
    expect(audit().sort()).toEqual([
      `organization.operator-access-closed by principal ${OPERATOR_ID}`,
      `organization.operator-access-opened by principal ${OPERATOR_ID}`,
      `organization.operator-access-renewed by principal ${OPERATOR_ID}`,
    ]);
  });

  test("refuses missing and archived organizations, blank reasons, and too long a duration", async () => {
    const { audit, send } = install();

    const responses = await Promise.all([
      send("GET", "/organizations/01J0000000000000000000000C/operator-access"),
      send("PUT", `/organizations/${ARCHIVED_ID}/operator-access`, { reason: "Late" }),
      send("PUT", access, { reason: "  " }),
      send("PUT", access, { durationMinutes: 481, reason: "Long case" }),
      send("PUT", "/organizations/not-a-ulid/operator-access", { reason: "Typo" }),
    ]);

    expect(responses.map((response) => [response.status, response.body?.code])).toEqual([
      [404, "organization_not_found"],
      [409, "organization_archived"],
      [400, "invalid_request"],
      [400, "invalid_request"],
      [400, "invalid_organizationId"],
    ]);
    expect(audit()).toEqual([]);
  });

  test("is not offered to machine services", async () => {
    const { send } = install();

    expect([
      (await send("GET", access, undefined, true)).status,
      (await send("PUT", access, { reason: "Service" }, true)).status,
      (await send("GET", "/operator-access", undefined, true)).status,
    ]).toEqual([undefined, undefined, undefined]);
  });
});
