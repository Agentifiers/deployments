import { describe, expect, test } from "bun:test";
import {
  makeDynamoDatabase,
  makeUniqueClaimRecord,
  tableForItemType,
  tableNamesFromEnvironment,
  uniqueClaimRequirements,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { createApplicationAuthenticator } from "../application-auth.ts";
import { requestFromHttpApiV2Event } from "../lambda.ts";
import { makeSystemOperatorFetch } from "./runtime.ts";
import {
  OPERATOR_ID,
  PERSON_ID,
  PRINCIPAL_STATUS_ENVIRONMENT,
  principalStatusFunction,
  signedUpPerson,
} from "./system-operator.fixture.ts";

const TRUST_AND_SAFETY_SESSION = "arn:aws:sts::123456789012:assumed-role/trust-and-safety/desk";

async function harness(
  options: { readonly platformIdentity: boolean } = { platformIdentity: true },
) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  const administrator = signedUpPerson(OPERATOR_ID).map((record) =>
    record.itemType === "principal"
      ? { ...record, data: { ...record.data, platformRole: "administrator" as const } }
      : record,
  );
  for (const record of [...administrator, ...signedUpPerson(PERSON_ID)]) {
    fake.put(tableForItemType(record.itemType), record);
    for (const requirement of uniqueClaimRequirements(record)) {
      fake.put(tables.control, makeUniqueClaimRecord(requirement, record.data.createdAt));
    }
  }
  const database = makeDynamoDatabase(fake.client, tables);
  const fetch = makeSystemOperatorFetch({
    authenticate: createApplicationAuthenticator({
      database,
      jwt: {
        audience: "api",
        claimProfile: "platform",
        issuer: "https://auth.example.test",
        verify: async (token) => ({ scope: "organizations:read", sub: token.split(".")[0] ?? "" }),
      },
    }),
    database,
    environment: {
      ...(options.platformIdentity ? PRINCIPAL_STATUS_ENVIRONMENT : {}),
      DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
      DEPLOYMENTS_AI_SYSTEM_SERVICE_PRINCIPALS: JSON.stringify({
        "trust-and-safety": {
          grants: ["organization-read", "organization-holds", "organization-entitlements"],
          role_arn: "arn:aws:iam::123456789012:role/trust-and-safety",
        },
      }),
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
        active_sandboxes: 8,
        api_request_burst: 40,
        api_requests_per_second: 20,
        concurrent_runs: 8,
      }),
    },
    lambda: principalStatusFunction(database),
  });
  const call = async (caller: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(
      new Request(`https://api.example${path}`, {
        headers: { authorization: `Bearer ${caller}.signed.token` },
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const payload = (await response?.json()) as Record<string, unknown> | undefined;
    return { code: payload?.code ?? payload?.changed, status: response?.status };
  };
  const setStatus = (caller: string, principalId: string, body: unknown) =>
    call(caller, "PUT", `/v1/system/principals/${principalId}/status`, body);
  return { call, fetch, setStatus };
}

describe("PUT /v1/system/principals/:principalId/status", () => {
  test("a disabled person's next request is unauthorized, and disabling again changes nothing", async () => {
    const { call, setStatus } = await harness();
    const disable = { reason: "Payment fraud", status: "disabled" };

    const before = await call(PERSON_ID, "GET", "/v1/system/installation");
    const disabled = await setStatus(OPERATOR_ID, PERSON_ID, disable);
    const after = await call(PERSON_ID, "GET", "/v1/system/installation");
    const repeated = await setStatus(OPERATOR_ID, PERSON_ID, disable);
    const restored = await setStatus(OPERATOR_ID, PERSON_ID, {
      reason: "Appeal",
      status: "active",
    });

    expect([before, disabled, after, repeated, restored]).toEqual([
      { code: "platform_administrator_required", status: 403 },
      { code: true, status: 200 },
      { code: "unauthorized", status: 401 },
      { code: false, status: 200 },
      { code: true, status: 200 },
    ]);
    expect(await call(PERSON_ID, "GET", "/v1/system/installation")).toEqual({
      code: "platform_administrator_required",
      status: 403,
    });
  });

  test("refuses an administrator disabling themselves and a malformed request", async () => {
    const { setStatus } = await harness();

    expect(
      await Promise.all([
        setStatus(OPERATOR_ID, OPERATOR_ID, { reason: "Oops", status: "disabled" }),
        setStatus(OPERATOR_ID, PERSON_ID, { reason: " ", status: "disabled" }),
        setStatus(OPERATOR_ID, PERSON_ID, { reason: "Archive", status: "archived" }),
        setStatus(OPERATOR_ID, "not-a-ulid", { reason: "Typo", status: "disabled" }),
      ]),
    ).toEqual([
      { code: "cannot_disable_self", status: 403 },
      { code: "invalid_request", status: 400 },
      { code: "invalid_request", status: 400 },
      { code: "invalid_principalId", status: 400 },
    ]);
  });

  test("is not offered to machine services, whatever grants they hold", async () => {
    const { fetch } = await harness();
    const signed = async (method: string, rawPath: string, body?: unknown) =>
      (
        await fetch(
          requestFromHttpApiV2Event({
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            rawPath,
            requestContext: {
              authorizer: { iam: { userArn: TRUST_AND_SAFETY_SESSION } },
              http: { method },
            },
          }),
        )
      )?.status;

    expect([
      await signed("GET", `/v1/system/services/organizations/${PERSON_ID}/standing`),
      await signed("PUT", `/v1/system/services/principals/${PERSON_ID}/status`, {
        reason: "Service",
        status: "disabled",
      }),
    ]).toEqual([200, undefined]);
  });

  test("refuses where platform identity does not hold people's sign-in state", async () => {
    const { setStatus } = await harness({ platformIdentity: false });

    expect(
      await setStatus(OPERATOR_ID, PERSON_ID, { reason: "Fraud", status: "disabled" }),
    ).toEqual({ code: "principal_status_unmanaged", status: 409 });
  });
});
