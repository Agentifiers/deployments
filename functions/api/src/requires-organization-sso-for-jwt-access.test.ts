import {
  OrganizationIdentityProviderRecord,
  OrganizationMemberRecord,
  Ulid,
  federatedGrantRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { openOperatorAccessRecord } from "@deployments-ai/db/operator-access-testing";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createApiLambdaHandler, makeApiFoundation } from "./api-lambda-foundation.ts";
import {
  databaseWithRecords,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  storageKey,
} from "./application-auth-test-support.ts";
import { createApplicationAuthenticator } from "./application-auth.ts";
import { createTenancyApi, type TenancyApiService } from "./index.ts";

const id = Schema.decodeUnknownSync(Ulid);
const NOW = new Date("2026-10-08T12:00:00.000Z");
const CONNECTION_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FC2");
const OLD_CONNECTION_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
const TOKEN_SESSION_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const OTHER_TOKEN_SESSION_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FB2");
const IDP_ISSUER = "https://acme.okta.example";
const TOKEN_SCOPES = "members:read projects:write";
const HOUR = 3_600_000;

const unusedService = new Proxy(
  {},
  {
    get: () =>
      new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error("Unexpected service operation.");
          },
        },
      ),
  },
) as TenancyApiService;

function member(role: "member" | "owner") {
  return Schema.decodeUnknownSync(OrganizationMemberRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: NOW.toISOString(),
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
        role,
        status: "active",
        updatedAt: NOW.toISOString(),
        version: 1,
      },
      itemType: "organization-member" as const,
    }),
  );
}

function provider(enforcement: "optional" | "required") {
  return Schema.decodeUnknownSync(OrganizationIdentityProviderRecord)(
    withCanonicalRecordKeys({
      data: {
        clientId: "api-client",
        clientSecret: {
          algorithm: "AES-256-GCM",
          authenticationTag: "tag",
          ciphertext: "ciphertext",
          encryptedDataKey: "key",
          encryptionContextHash: "hash",
          iv: "iv",
          schemaVersion: 1,
        },
        clientSecretSetAt: NOW.toISOString(),
        connectionId: CONNECTION_ID,
        createdAt: NOW.toISOString(),
        displayName: "Acme Okta",
        endpoints: {
          authorization: `${IDP_ISSUER}/authorize`,
          jwks: `${IDP_ISSUER}/keys`,
          token: `${IDP_ISSUER}/token`,
        },
        id: "oidc",
        issuer: IDP_ISSUER,
        jit: { kind: "disabled" },
        organizationId: ORGANIZATION_ID,
        signingAlgorithms: ["RS256"],
        state: { enforcement, kind: "active" },
        tokenEndpointAuthMethod: "client_secret_basic",
        updatedAt: NOW.toISOString(),
        version: 1,
      },
      itemType: "organization-identity-provider" as const,
    }),
  );
}

function grant(options: { readonly authenticatedAt: Date; readonly connectionId?: Ulid }) {
  return federatedGrantRecord({
    authentication: {
      authenticatedAt: options.authenticatedAt.toISOString(),
      connectionId: options.connectionId ?? CONNECTION_ID,
      issuer: IDP_ISSUER,
      method: "federated",
      organizationId: id(ORGANIZATION_ID),
      subject: "okta-user",
    },
    createdAt: options.authenticatedAt.toISOString(),
    principalId: id(PRINCIPAL_ID),
    tokenSessionExpiresAt: new Date(NOW.getTime() + HOUR).toISOString(),
    tokenSessionId: TOKEN_SESSION_ID,
  });
}

function platformAdministrator() {
  const principalKey = { pk: `PRINCIPAL#${PRINCIPAL_ID}`, sk: `PRINCIPAL#${PRINCIPAL_ID}` };
  return {
    ...principalKey,
    data: { id: PRINCIPAL_ID, kind: "human", platformRole: "administrator", status: "active" },
    itemType: "principal",
  } as unknown as PlatformRecord;
}

interface WhoamiResult {
  readonly body: Record<string, unknown>;
  readonly requestId: string | undefined;
  readonly status: number;
}

async function whoami(
  records: readonly PlatformRecord[],
  sid: string | undefined = TOKEN_SESSION_ID,
): Promise<WhoamiResult> {
  const database = databaseWithRecords(
    new Map(records.map((record) => [storageKey("control", record), record])),
  );
  const handler = createApiLambdaHandler(
    ({ authenticate }) =>
      createTenancyApi({
        authenticate,
        authorize: async () => undefined,
        idempotency: { execute: async (input) => input.operation() },
        service: unusedService,
      }),
    {
      dependencies: () => ({
        foundation: {
          ...makeApiFoundation({
            DEPLOYMENTS_AI_API_JWT_AUDIENCE: "api",
            DEPLOYMENTS_AI_API_JWT_ISSUER: "https://auth.deployments.ai",
          }),
          authenticate: createApplicationAuthenticator({
            database,
            jwt: {
              audience: "api",
              claimProfile: "platform",
              issuer: "https://auth.deployments.ai",
              verify: async () => ({
                scope: TOKEN_SCOPES,
                sub: PRINCIPAL_ID,
                ...(sid ? { sid } : {}),
              }),
            },
            now: () => NOW,
          }),
        },
        gate: standingInstallation({ organizationId: ORGANIZATION_ID }).gate,
      }),
    },
  );
  const result = await handler({
    headers: { authorization: "Bearer a.b.c", "x-deployments-organization": ORGANIZATION_ID },
    rawPath: "/v1/whoami",
    requestContext: { domainName: "api.example.test", http: { method: "GET" } },
  });
  const body = JSON.parse(result.body) as Record<string, unknown>;
  return { body, requestId: result.headers["x-request-id"], status: result.statusCode };
}

function ssoRequired(requestId: string | undefined) {
  return {
    body: {
      type: "https://docs.deployments.ai/errors/organization-sso-required",
      title: "The organization requires single sign-on.",
      status: 403,
      code: "organization_sso_required",
      organizationId: ORGANIZATION_ID,
      requestId,
    },
    requestId,
    status: 403,
  };
}

function roleView(result: WhoamiResult) {
  return {
    capabilities: result.body.capabilities,
    organizationRole: result.body.organizationRole,
    status: result.status,
  };
}

describe("organization SSO enforcement on platform JWT access", () => {
  test("answers 403 when the token session has no federated grant", async () => {
    const result = await whoami([member("member"), provider("required")]);
    expect(result).toEqual(ssoRequired(result.requestId));
    const sessionless = await whoami([member("member"), provider("required")], undefined);
    expect(sessionless).toEqual(ssoRequired(sessionless.requestId));
    const otherSession = await whoami(
      [
        member("member"),
        provider("required"),
        grant({ authenticatedAt: new Date(NOW.getTime() - HOUR) }),
      ],
      OTHER_TOKEN_SESSION_ID,
    );
    expect(otherSession).toEqual(ssoRequired(otherSession.requestId));
  });

  test("admits the member role with an unexpired grant from the current connection", async () => {
    const result = await whoami([
      member("member"),
      provider("required"),
      grant({ authenticatedAt: new Date(NOW.getTime() - HOUR) }),
    ]);
    expect(roleView(result)).toEqual({
      capabilities: ["members:read"],
      organizationRole: "member",
      status: 200,
    });
  });

  test("answers 403 for an expired grant", async () => {
    const result = await whoami([
      member("member"),
      provider("required"),
      grant({ authenticatedAt: new Date(NOW.getTime() - 13 * HOUR) }),
    ]);
    expect(result).toEqual(ssoRequired(result.requestId));
  });

  test("answers 403 for a grant issued through a replaced connection", async () => {
    const result = await whoami([
      member("member"),
      provider("required"),
      grant({
        authenticatedAt: new Date(NOW.getTime() - HOUR),
        connectionId: OLD_CONNECTION_ID,
      }),
    ]);
    expect(result).toEqual(ssoRequired(result.requestId));
  });

  test("lets an owner through without a grant", async () => {
    const result = await whoami([member("owner"), provider("required")]);
    expect(roleView(result)).toEqual({
      capabilities: ["members:read", "projects:write"],
      organizationRole: "owner",
      status: 200,
    });
  });

  test("lets a platform administrator with operator access through without membership or grant", async () => {
    const result = await whoami([
      platformAdministrator(),
      provider("required"),
      openOperatorAccessRecord({ organizationId: ORGANIZATION_ID, principalId: PRINCIPAL_ID }),
    ]);
    expect({ platformRole: result.body.platformRole, status: result.status }).toEqual({
      platformRole: "administrator",
      status: 200,
    });
  });

  test("refuses a platform administrator without operator access before SSO", async () => {
    const result = await whoami([platformAdministrator(), provider("required")]);
    expect({ code: result.body.code, status: result.status }).toEqual({
      code: "operator_access_required",
      status: 403,
    });
  });

  test("admits members of an organization that does not require SSO without a grant", async () => {
    const result = await whoami([member("member"), provider("optional")]);
    expect(roleView(result)).toEqual({
      capabilities: ["members:read"],
      organizationRole: "member",
      status: 200,
    });
  });
});
