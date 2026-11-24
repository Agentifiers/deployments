import { describe, expect, test } from "bun:test";
import {
  authorizationCodeRecord,
  oauthClientRecord,
  organizationAccess,
  principalRecord,
  securityStateRecord,
  sessionRecords,
  type IdentityRepository,
  type IdentitySessionAuthentication,
  type TransactionOperation,
} from "@deployments-ai/db";
import { sha256, sha256Base64Url } from "@deployments-ai/identity";
import {
  CONNECTION,
  ORGANIZATION,
  federationMemoryDatabase,
  memberRecord,
  providerRecord,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import { makeOAuthApplication } from "./oauth-application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const CODE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const GENERATED_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never;
const ORGANIZATION_ID = ORGANIZATION;
const CONNECTION_ID = CONNECTION;
const CREATED_AT = "2026-07-28T00:00:00.000Z";
const VERIFIER = "a".repeat(43);

const FEDERATED: IdentitySessionAuthentication = {
  authenticatedAt: CREATED_AT,
  connectionId: CONNECTION_ID,
  issuer: "https://acme.okta.com",
  method: "federated",
  organizationId: ORGANIZATION_ID,
  subject: "00u-alice",
};

async function exchange(
  authentication: IdentitySessionAuthentication,
  scopes: string[],
  sessionExpiresAt = "2026-07-29T00:00:00.000Z",
) {
  const principal = principalRecord({
    createdAt: CREATED_AT,
    displayName: "Alice",
    id: PRINCIPAL_ID,
    primaryEmail: "alice@acme.com",
  });
  const securityState = securityStateRecord({
    createdAt: CREATED_AT,
    credentialVersion: 0,
    emailVerifiedAt: CREATED_AT,
    principalId: PRINCIPAL_ID,
    sessionEpoch: 0,
    version: 1,
  });
  const { locator, session } = sessionRecords({
    authentication,
    authenticationTime: CREATED_AT,
    createdAt: CREATED_AT,
    expiresAt: sessionExpiresAt,
    id: SESSION_ID,
    idleExpiresAt: "2026-07-28T02:00:00.000Z",
    principalId: PRINCIPAL_ID,
    sessionEpoch: 0,
    tokenHash: "session-token-hash",
  });
  const code = authorizationCodeRecord({
    authenticationTime: CREATED_AT,
    authorizationRequestId: GENERATED_ID,
    browserSessionId: SESSION_ID,
    clientId: "deployments-web",
    codeChallenge: sha256Base64Url(VERIFIER),
    codeHash: sha256("raw-code"),
    createdAt: CREATED_AT,
    expiresAt: "2026-07-28T01:01:00.000Z",
    id: CODE_ID,
    nonce: "client-nonce",
    principalId: PRINCIPAL_ID,
    redirectUri: "https://app.deployments.ai/callback",
    scopes,
    sessionEpoch: 0,
  });
  const client = oauthClientRecord({
    allowedScopes: ["openid", "offline_access", "email", "profile"],
    clientId: "deployments-web",
    clientSecretHash: sha256("client-secret"),
    createdAt: CREATED_AT,
    grantTypes: ["authorization_code", "refresh_token"],
    name: "Deployments Web",
    redirectUris: ["https://app.deployments.ai/callback"],
    requiredScopes: ["openid"],
    tokenEndpointAuthMethod: "client_secret_basic",
    type: "confidential",
    version: 1,
  });
  const transactions: (readonly TransactionOperation[])[] = [];
  const signed: Record<string, unknown>[] = [];
  const repository = {
    authorizationCodeForHash: () => Promise.resolve(code),
    browserSessionVersionChecks: () => [],
    clientForId: () => Promise.resolve(client),
    loadLoginMaterial: () => Promise.resolve({ credential: undefined, principal, securityState }),
    loginMaterialVersionChecks: () => [],
    principalForId: () => Promise.resolve(principal),
    sessionForHash: () => Promise.resolve(session),
    sessionLocator: () => Promise.resolve(locator),
    transact: (operations: readonly TransactionOperation[]) => {
      transactions.push(operations);
      return Promise.resolve();
    },
  } as unknown as IdentityRepository;
  const application = makeOAuthApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("no email is sent during code exchange");
      },
      generateId: () => GENERATED_ID,
      now: () => new Date("2026-07-28T01:00:00.000Z"),
      repository,
      signer: {
        jwks: async () => ({ keys: [] }),
        sign: async (claims) => {
          signed.push(claims as Record<string, unknown>);
          return "signed";
        },
      },
    },
    {
      accessTokenSeconds: 300,
      authorizationCodeSeconds: 60,
      authorizationRequestSeconds: 300,
      idTokenSeconds: 300,
      issuer: "https://auth.deployments.ai",
      refreshTokenSeconds: 2_592_000,
      resourceAudience: "https://api.deployments.ai",
    },
  );
  await application.exchangeAuthorizationCode({
    clientId: "deployments-web",
    clientSecret: "client-secret",
    code: "raw-code",
    codeVerifier: VERIFIER,
    redirectUri: "https://app.deployments.ai/callback",
  });
  const grants = transactions
    .flat()
    .flatMap((operation) =>
      operation.kind === "put" && operation.record.itemType === "organization-federated-grant"
        ? [operation.record]
        : [],
    );
  return { grants, signed };
}

describe("code exchange for a federated browser session", () => {
  test("tokens match a password session's except that the ID token reports fed", async () => {
    const scopes = ["openid", "offline_access", "email", "profile"];
    const password = await exchange({ method: "password" }, scopes);
    const federated = await exchange(FEDERATED, scopes);
    const keySets = (claims: readonly Record<string, unknown>[]) =>
      claims.map((entry) => Object.keys(entry).sort());
    const withoutAmr = (claims: readonly Record<string, unknown>[]) =>
      claims.map(({ amr: _amr, ...rest }) => rest);
    expect(keySets(federated.signed)).toEqual(keySets(password.signed));
    expect(withoutAmr(federated.signed)).toEqual(withoutAmr(password.signed));
    expect(federated.signed.map((claims) => claims.amr)).toEqual([undefined, ["fed"]]);
    expect(password.signed.map((claims) => claims.amr)).toEqual([undefined, ["pwd"]]);
  });

  test("writes a grant keyed by the refresh family sid, capped 12 hours after federation", async () => {
    const { grants } = await exchange(FEDERATED, ["openid", "offline_access"]);
    expect(grants.map((grant) => grant.data)).toEqual([
      {
        authenticatedAt: CREATED_AT,
        connectionId: CONNECTION_ID,
        createdAt: "2026-07-28T01:00:00.000Z",
        expiresAt: "2026-07-28T12:00:00.000Z",
        id: GENERATED_ID,
        issuer: "https://acme.okta.com",
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
        subject: "00u-alice",
      },
    ]);
  });

  test("a code-only token session keeps its grant past the access token's lifetime", async () => {
    const { grants } = await exchange(FEDERATED, ["openid"]);
    const { database } = federationMemoryDatabase([
      providerRecord({ state: { enforcement: "required", kind: "active" } }),
      memberRecord(PRINCIPAL_ID, "active", "member"),
      ...grants,
    ]);
    const caller = {
      organizationId: ORGANIZATION_ID,
      platformAdministrator: false,
      principalId: PRINCIPAL_ID,
      tokenSessionId: CODE_ID,
    };
    expect(
      await organizationAccess(database, { ...caller, now: new Date("2026-07-28T01:11:00.000Z") }),
    ).toEqual({ kind: "member", role: "member" });
    expect(
      await organizationAccess(database, { ...caller, now: new Date("2026-07-28T12:00:00.000Z") }),
    ).toEqual({ kind: "sso-required" });
  });

  test("a code-only grant ends with its browser session when that ends first", async () => {
    const { grants } = await exchange(FEDERATED, ["openid"], "2026-07-28T08:00:00.000Z");
    expect(grants.map((grant) => [grant.data.id, grant.data.expiresAt])).toEqual([
      [CODE_ID, "2026-07-28T08:00:00.000Z"],
    ]);
  });

  test("a password session writes no grant", async () => {
    expect((await exchange({ method: "password" }, ["openid", "offline_access"])).grants).toEqual(
      [],
    );
  });
});
