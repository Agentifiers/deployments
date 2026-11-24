import { describe, expect, test } from "bun:test";
import {
  makeDynamoDatabase,
  makeIdentitySecurityEventRecord,
  makeUniqueClaimRecord,
  tableForItemType,
  tableNamesFromEnvironment,
  uniqueClaimRequirements,
  type PlatformRecord,
  type Ulid,
  type VerificationReissue,
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

const PERSON_EMAIL = `${PERSON_ID.toLowerCase()}@example.test`;
const SEEDED_AT = "2026-07-25T12:00:00.000Z";
const SERVICE_SESSION = "arn:aws:sts::123456789012:assumed-role/trust-and-safety/desk";

function harness(
  options: {
    readonly platformIdentity: boolean;
    readonly reissueVerification?: Parameters<typeof principalStatusFunction>[1];
  } = { platformIdentity: true },
) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  const administrator = signedUpPerson(OPERATOR_ID).map((record) =>
    record.itemType === "principal"
      ? { ...record, data: { ...record.data, platformRole: "administrator" as const } }
      : record,
  );
  const tokenEvent = makeIdentitySecurityEventRecord({
    aggregateId: PERSON_ID as Ulid,
    aggregateType: "oauth-refresh-family",
    aggregateVersion: 2,
    eventId: "01J00000000000000000000E01" as Ulid,
    eventType: "identity.refresh-token-rotated",
    occurredAt: "2026-09-02T00:00:00.000Z",
    payload: {
      clientId: "deployments-cli",
      generation: 2,
      ipPrefixHash: "a".repeat(64),
      tokenHash: "b".repeat(64),
    },
    principalId: PERSON_ID as Ulid,
  });
  const seed: PlatformRecord[] = [...administrator, ...signedUpPerson(PERSON_ID), tokenEvent];
  for (const record of seed) {
    fake.put(tableForItemType(record.itemType), record);
    for (const requirement of uniqueClaimRequirements(record)) {
      fake.put(tables.control, makeUniqueClaimRecord(requirement, SEEDED_AT));
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
    lambda: principalStatusFunction(database, options.reissueVerification),
  });
  const call = async (caller: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(
      new Request(`https://api.example${path}`, {
        headers: { authorization: `Bearer ${caller}.signed.token` },
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return {
      body: (await response?.json()) as Record<string, unknown>,
      status: response?.status,
    };
  };
  return { call, fetch };
}

describe("system principal routes", () => {
  test("find a person by exact email and read who they are", async () => {
    const { call } = harness();

    const found = await call(
      OPERATOR_ID,
      "GET",
      `/v1/system/principals?email=${PERSON_EMAIL.toUpperCase()}`,
    );
    const prefix = await call(
      OPERATOR_ID,
      "GET",
      `/v1/system/principals?email=${PERSON_EMAIL.slice(0, -1)}`,
    );
    const invalid = await call(OPERATOR_ID, "GET", "/v1/system/principals?email=not-an-email");
    const detail = await call(OPERATOR_ID, "GET", `/v1/system/principals/${PERSON_ID}`);

    expect(found).toMatchObject({
      body: {
        kind: "person",
        person: { id: PERSON_ID, primaryEmail: PERSON_EMAIL, status: "active" },
      },
      status: 200,
    });
    expect(prefix).toMatchObject({ body: { code: "principal_not_found" }, status: 404 });
    expect(invalid).toMatchObject({ body: { code: "invalid_email" }, status: 400 });
    expect(detail).toEqual({
      body: {
        createdAt: "2026-07-25T12:00:00.000Z",
        displayName: null,
        id: PERSON_ID,
        kind: "human",
        organizations: { capped: false, items: [] },
        platformRole: null,
        primaryEmail: PERSON_EMAIL,
        signIn: {
          emailVerifiedAt: "2026-09-01T00:00:00.000Z",
          mfa: { state: "none" },
          sessions: { browser: 0, capped: false, refreshTokenFamilies: 0 },
        },
        status: "active",
        updatedAt: "2026-07-25T12:00:00.000Z",
      },
      status: 200,
    });
  });

  test("security events show allowlisted fields and name the withheld ones", async () => {
    const { call } = harness();

    const events = await call(
      OPERATOR_ID,
      "GET",
      `/v1/system/principals/${PERSON_ID}/security-events`,
    );

    expect(events).toEqual({
      body: {
        items: [
          {
            actor: null,
            details: { clientId: "deployments-cli", generation: 2 },
            eventType: "identity.refresh-token-rotated",
            id: "01J00000000000000000000E01",
            occurredAt: "2026-09-02T00:00:00.000Z",
            withheldFields: ["ipPrefixHash", "tokenHash"],
          },
        ],
        nextCursor: null,
      },
      status: 200,
    });
  });

  test("revoking sessions repeats safely and records the operator and reason each time", async () => {
    const { call } = harness();
    const revoke = () =>
      call(OPERATOR_ID, "POST", `/v1/system/principals/${PERSON_ID}/sessions/revoke`, {
        reason: "Account takeover report",
      });

    const first = await revoke();
    const second = await revoke();
    const events = await call(
      OPERATOR_ID,
      "GET",
      `/v1/system/principals/${PERSON_ID}/security-events`,
    );

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body).toEqual({
      principalId: PERSON_ID,
      sessionsEndedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(
      (
        events.body.items as {
          readonly actor: unknown;
          readonly details: unknown;
          readonly eventType: string;
        }[]
      )
        .filter((event) => event.eventType === "identity.sessions-invalidated")
        .map((event) => [event.actor, event.details]),
    ).toEqual([
      [{ id: OPERATOR_ID, type: "principal" }, { reason: "Account takeover report" }],
      [{ id: OPERATOR_ID, type: "principal" }, { reason: "Account takeover report" }],
    ]);
    expect(
      await call(OPERATOR_ID, "POST", `/v1/system/principals/${PERSON_ID}/sessions/revoke`, {
        reason: " ",
      }),
    ).toMatchObject({ body: { code: "invalid_request" }, status: 400 });
  });

  test("resend answers with platform identity's outcome", async () => {
    const outcomes: VerificationReissue[] = [
      { emailVerified: true, outcome: "principal-exists" },
      { outcome: "rate-limited", reason: "recently-sent" },
      { outcome: "sign-up-not-found" },
      {
        email: "pending@example.test",
        outcome: "sent",
        principalId: PERSON_ID as Ulid,
        sentAt: "2026-10-01T12:00:00.000Z",
      },
    ];
    const commands: unknown[] = [];
    const { call } = harness({
      platformIdentity: true,
      reissueVerification: async (command) => {
        commands.push(command);
        return outcomes[commands.length - 1] ?? { outcome: "registration-closed" };
      },
    });
    const resend = () =>
      call(OPERATOR_ID, "POST", `/v1/system/principals/${PERSON_ID}/verification-email`, {
        email: "Pending@Example.test",
        reason: "Asked twice",
      });

    const answers = [await resend(), await resend(), await resend(), await resend()];

    expect(answers.map(({ body, status }) => [status, body.code ?? body.email])).toEqual([
      [409, "email_already_verified"],
      [429, "verification_email_rate_limited"],
      [404, "sign_up_not_found"],
      [200, "pending@example.test"],
    ]);
    expect(commands[0]).toEqual({
      actorPrincipalId: OPERATOR_ID,
      email: "pending@example.test",
      kind: "reissue-verification",
      principalId: PERSON_ID,
      reason: "Asked twice",
    });
  });

  test("is not offered to people without the administrator role or to machine services", async () => {
    const { call, fetch } = harness();
    const signed = async (method: string, rawPath: string) =>
      (
        await fetch(
          requestFromHttpApiV2Event({
            rawPath,
            requestContext: { authorizer: { iam: { userArn: SERVICE_SESSION } }, http: { method } },
          }),
        )
      )?.status;

    expect((await call(PERSON_ID, "GET", `/v1/system/principals/${OPERATOR_ID}`)).status).toBe(403);
    expect([
      await signed("GET", `/v1/system/services/principals/${PERSON_ID}`),
      await signed("POST", `/v1/system/services/principals/${PERSON_ID}/sessions/revoke`),
    ]).toEqual([undefined, undefined]);
  });

  test("refuses identity actions where platform identity does not hold sign-in state", async () => {
    const { call } = harness({ platformIdentity: false });

    const detail = await call(OPERATOR_ID, "GET", `/v1/system/principals/${PERSON_ID}`);
    const revoke = await call(
      OPERATOR_ID,
      "POST",
      `/v1/system/principals/${PERSON_ID}/sessions/revoke`,
      {
        reason: "Report",
      },
    );

    expect([detail.status, detail.body.signIn]).toEqual([200, null]);
    expect(revoke).toMatchObject({ body: { code: "principal_status_unmanaged" }, status: 409 });
  });
});
