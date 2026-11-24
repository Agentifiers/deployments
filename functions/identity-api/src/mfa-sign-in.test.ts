import { describe, expect, test } from "bun:test";
import {
  acquireUniqueClaim,
  bffFenceRecord,
  makeDynamoDatabase,
  makeIdentityRepository,
  makeUniqueClaimRecord,
  oauthClientRecord,
  passwordCredentialRecord,
  principalRecord,
  securityStateRecord,
  uniqueClaimRequirements,
  type ProtectedEnvelope,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  DEFAULT_PASSWORD_PROFILE,
  base32Decode,
  hashPassword,
  hotp,
  sha256,
  sha256Base64Url,
  totpStep,
} from "@deployments-ai/identity";
import { makeIdentityApplication } from "./application.ts";
import { makeOAuthApplication } from "./oauth-application.ts";
import { DEFAULT_IDENTITY_RATE_LIMIT_POLICIES } from "./rate-limits.ts";
import { sequentialIds } from "./session-management.fixture.ts";

/** The error a call rejects with; `undefined` when it resolves, so the assertion fails. */
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const EMAIL = "user@example.com";
const PASSWORD = "correct horse battery staple";
const CREATED_AT = "2026-07-28T00:00:00.000Z";

/** Seals values as readable JSON bound to their context, so tests can assert both. */
const plainSecrets = {
  decrypt: async <Value>(
    envelope: ProtectedEnvelope,
    binding: Readonly<Record<string, string>>,
  ) => {
    if (envelope.encryptionContextHash !== JSON.stringify(binding))
      throw new Error("wrong binding");
    return JSON.parse(Buffer.from(envelope.ciphertext, "base64").toString("utf8")) as Value;
  },
  encrypt: async (value: unknown, binding: Readonly<Record<string, string>>) => ({
    algorithm: "AES-256-GCM" as const,
    authenticationTag: "tag",
    ciphertext: Buffer.from(JSON.stringify(value)).toString("base64"),
    encryptedDataKey: "key",
    encryptionContextHash: JSON.stringify(binding),
    iv: "iv",
    schemaVersion: 1 as const,
  }),
};

async function harness() {
  const fake = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(fake.client);
  const principal = principalRecord({
    createdAt: CREATED_AT,
    id: PRINCIPAL_ID,
    primaryEmail: EMAIL,
  });
  await database.transactWrite([
    { kind: "put", record: principal },
    acquireUniqueClaim(
      makeUniqueClaimRecord(uniqueClaimRequirements(principal)[0]!, CREATED_AT) as Parameters<
        typeof acquireUniqueClaim
      >[0],
    ),
    {
      kind: "put",
      record: passwordCredentialRecord({
        createdAt: CREATED_AT,
        passwordHash: await hashPassword(PASSWORD, DEFAULT_PASSWORD_PROFILE),
        principalId: PRINCIPAL_ID,
        version: 1,
      }),
    },
    {
      kind: "put",
      record: securityStateRecord({
        createdAt: CREATED_AT,
        credentialVersion: 1,
        emailVerifiedAt: CREATED_AT,
        principalId: PRINCIPAL_ID,
        sessionEpoch: 0,
        version: 1,
      }),
    },
    {
      kind: "put",
      record: bffFenceRecord({
        createdAt: CREATED_AT,
        principalId: PRINCIPAL_ID,
        principalStatus: "active",
        sessionEpoch: 0,
        version: 1,
      }),
    },
  ]);
  let clock = new Date("2026-07-28T01:00:00.000Z");
  const generateId = sequentialIds();
  const repository = makeIdentityRepository(database);
  const application = makeIdentityApplication(
    {
      encryptEmailPayload: plainSecrets.encrypt,
      generateId,
      mfaSecrets: plainSecrets,
      now: () => clock,
      repository,
    },
    {
      actionLifetimeSeconds: 1_800,
      rateLimits: DEFAULT_IDENTITY_RATE_LIMIT_POLICIES,
      sessionAbsoluteLifetimeSeconds: 86_400,
      sessionIdleLifetimeSeconds: 3_600,
    },
  );
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1_000);
  };
  const codeAt = (secret: string, offsetSteps = 0) =>
    hotp(base32Decode(secret), totpStep(clock) + offsetSteps);
  async function enroll() {
    const { secret } = await application.mfa.beginEnrollment({
      password: PASSWORD,
      principalId: PRINCIPAL_ID,
    });
    const { recoveryCodes } = await application.mfa.confirmEnrollment({
      code: codeAt(secret),
      principalId: PRINCIPAL_ID,
    });
    advance(30);
    return { recoveryCodes, secret };
  }
  const passwordStep = () => application.signIn({ email: EMAIL, password: PASSWORD });
  async function challenge() {
    const outcome = await passwordStep();
    if (outcome.kind !== "mfa-required") throw new Error("expected the second step");
    return outcome.challengeToken;
  }
  const sessions = () =>
    fake.items("identity").filter((item) => item.itemType === "identity-session");
  const deliveries = () =>
    fake.items("identity-email-outbox").map((item) => (item.data as { purpose: string }).purpose);
  return {
    advance,
    application,
    challenge,
    codeAt,
    deliveries,
    enroll,
    fake,
    generateId,
    now: () => clock,
    passwordStep,
    repository,
    sessions,
  };
}

describe("TOTP sign-in second step", () => {
  test("signs in with the password alone until a factor is confirmed", async () => {
    const h = await harness();
    await h.application.mfa.beginEnrollment({ password: PASSWORD, principalId: PRINCIPAL_ID });

    expect((await h.passwordStep()).kind).toBe("signed-in");
    expect(await h.application.mfa.accountSecurity(PRINCIPAL_ID)).toEqual({
      mfa: { state: "off" },
      passwordSignIn: true,
    });
  });

  test("requires a code after the password and issues the session only for a valid one", async () => {
    const h = await harness();
    const { secret } = await h.enroll();
    expect(h.deliveries()).toEqual(["mfa-enabled"]);
    const sessionsBefore = h.sessions().length;

    const challengeToken = await h.challenge();
    expect(h.sessions()).toHaveLength(sessionsBefore);
    expect(
      await refusal(h.application.mfa.completeSignIn({ challengeToken, code: "000000" })),
    ).toMatchObject({ code: "access_denied" });
    const signedIn = await h.application.mfa.completeSignIn({
      challengeToken,
      code: h.codeAt(secret),
    });

    expect(signedIn.kind).toBe("signed-in");
    expect(h.sessions()).toHaveLength(sessionsBefore + 1);
    expect(
      await refusal(
        h.application.mfa.completeSignIn({ challengeToken, code: h.codeAt(secret, 1) }),
      ),
    ).toMatchObject({ status: 401 });
  });

  test("refuses a code that was already accepted, even on a fresh challenge", async () => {
    const h = await harness();
    const { secret } = await h.enroll();
    const code = h.codeAt(secret);
    await h.application.mfa.completeSignIn({ challengeToken: await h.challenge(), code });

    expect(
      await refusal(
        h.application.mfa.completeSignIn({ challengeToken: await h.challenge(), code }),
      ),
    ).toMatchObject({ code: "access_denied" });
  });

  test("accepts each recovery code once", async () => {
    const h = await harness();
    const { recoveryCodes } = await h.enroll();
    const code = recoveryCodes[3]!;

    const first = await h.application.mfa.completeSignIn({
      challengeToken: await h.challenge(),
      code: code.toLowerCase(),
    });
    expect(first.kind).toBe("signed-in");
    expect(
      await refusal(
        h.application.mfa.completeSignIn({ challengeToken: await h.challenge(), code }),
      ),
    ).toMatchObject({ code: "access_denied" });
    expect(await h.application.mfa.accountSecurity(PRINCIPAL_ID)).toMatchObject({
      mfa: { recoveryCodesRemaining: 9, state: "on" },
    });
  });

  test("voids a pending challenge when every session is signed out", async () => {
    const h = await harness();
    const { secret } = await h.enroll();
    const challengeToken = await h.challenge();

    await h.application.signOutAll(PRINCIPAL_ID);

    expect(
      await refusal(h.application.mfa.completeSignIn({ challengeToken, code: h.codeAt(secret) })),
    ).toMatchObject({ status: 401 });
  });

  test("rate limits code attempts per principal", async () => {
    const h = await harness();
    await h.enroll();
    const challengeToken = await h.challenge();
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      outcomes.push(
        await h.application.mfa.completeSignIn({ challengeToken, code: "000000" }).then(
          () => "signed-in",
          (error: { code: string }) => error.code,
        ),
      );
    }
    expect(outcomes.filter((outcome) => outcome === "slow_down").length).toBeGreaterThan(0);
    expect(outcomes.indexOf("slow_down")).toBe(8);
  });

  test("turns off with a code, notifies, and returns to password-only sign-in", async () => {
    const h = await harness();
    const { secret } = await h.enroll();
    expect(
      await refusal(h.application.mfa.disable({ code: "123456", principalId: PRINCIPAL_ID })),
    ).toMatchObject({ code: "access_denied" });

    await h.application.mfa.disable({ code: h.codeAt(secret), principalId: PRINCIPAL_ID });

    expect(h.deliveries().sort()).toEqual(["mfa-disabled", "mfa-enabled"]);
    expect((await h.passwordStep()).kind).toBe("signed-in");
  });

  test("replaces every recovery code and spends the code that authorized it", async () => {
    const h = await harness();
    const { recoveryCodes } = await h.enroll();
    const { recoveryCodes: replaced } = await h.application.mfa.regenerateRecoveryCodes({
      code: recoveryCodes[0]!,
      principalId: PRINCIPAL_ID,
    });

    expect(replaced).toHaveLength(10);
    expect(
      await refusal(
        h.application.mfa.completeSignIn({
          challengeToken: await h.challenge(),
          code: recoveryCodes[1]!,
        }),
      ),
    ).toMatchObject({ code: "access_denied" });
    const signedIn = await h.application.mfa.completeSignIn({
      challengeToken: await h.challenge(),
      code: replaced[0]!,
    });
    expect(signedIn.kind).toBe("signed-in");
  });

  test("stores the secret sealed to the principal and recovery codes only as hashes", async () => {
    const h = await harness();
    const { recoveryCodes, secret } = await h.enroll();
    const factor = await h.repository.mfaFactorForPrincipal(PRINCIPAL_ID);
    const stored = JSON.stringify(factor);

    expect(stored).not.toContain(secret);
    for (const code of recoveryCodes) expect(stored).not.toContain(code);
    expect(
      factor?.data.state === "active" && factor.data.protectedSecret.encryptionContextHash,
    ).toBe(JSON.stringify({ principalId: PRINCIPAL_ID, purpose: "mfa-totp-secret" }));
  });
});

const CLIENT_ID = "operator-tools";
const CLIENT_SECRET = "operator-tools-secret";
const REDIRECT_URI = "https://tools.example.com/callback";
const VERIFIER = "v".repeat(43);

/** Claims of an unsigned test token: the signer below only base64url-encodes them. */
const claims = (token: string | undefined) =>
  JSON.parse(Buffer.from(token ?? "", "base64url").toString("utf8")) as {
    readonly amr?: readonly string[];
    readonly auth_time: number;
  };

/** Signs a confidential client in through the browser session, then refreshes once. */
async function idTokens(h: Awaited<ReturnType<typeof harness>>, sessionToken: string) {
  await h.repository.transact([
    {
      kind: "put",
      record: {
        ...oauthClientRecord({
          allowedScopes: ["offline_access", "openid"],
          clientId: CLIENT_ID,
          clientSecretHash: sha256(CLIENT_SECRET),
          createdAt: CREATED_AT,
          grantTypes: ["authorization_code", "refresh_token"],
          name: "Operator tools",
          redirectUris: [REDIRECT_URI],
          requiredScopes: ["openid"],
          tokenEndpointAuthMethod: "client_secret_basic",
          type: "confidential",
          version: 1,
        }),
      },
    },
  ]);
  const oauth = makeOAuthApplication(
    {
      encryptEmailPayload: plainSecrets.encrypt,
      generateId: h.generateId,
      now: h.now,
      repository: h.repository,
      signer: {
        jwks: async () => ({ keys: [] }),
        sign: async (value) => Buffer.from(JSON.stringify(value)).toString("base64url"),
      },
    },
    {
      accessTokenSeconds: 300,
      authorizationCodeSeconds: 60,
      authorizationRequestSeconds: 300,
      idTokenSeconds: 300,
      issuer: "https://auth.example.com",
      refreshTokenSeconds: 86_400,
      resourceAudience: "https://api.example.com",
    },
  );
  const session = await h.application.session(sessionToken);
  if (!session) throw new Error("expected an active browser session");
  const redirect = await oauth.authorize({
    browserSession: {
      authenticationTime: session.authenticationTime,
      principalId: PRINCIPAL_ID,
      sessionId: session.sessionId,
    },
    clientId: CLIENT_ID,
    codeChallenge: sha256Base64Url(VERIFIER),
    codeChallengeMethod: "S256",
    confirmed: true,
    nonce: "nonce",
    redirectUri: REDIRECT_URI,
    responseType: "code",
    scopes: ["offline_access", "openid"],
  });
  const signedIn = await oauth.exchangeAuthorizationCode({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    code: new URL(redirect).searchParams.get("code") ?? "",
    codeVerifier: VERIFIER,
    redirectUri: REDIRECT_URI,
  });
  h.advance(600);
  const refreshed = await oauth.exchangeRefreshToken({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: signedIn.refresh_token ?? "",
  });
  return {
    authenticationTime: Math.floor(Date.parse(session.authenticationTime) / 1_000),
    refreshed: claims(refreshed.id_token),
    signedIn: claims(signedIn.id_token),
  };
}

describe("authentication methods in ID tokens", () => {
  test("a password and TOTP sign-in reports otp and mfa, also after refresh", async () => {
    const h = await harness();
    const { secret } = await h.enroll();
    const signedIn = await h.application.mfa.completeSignIn({
      challengeToken: await h.challenge(),
      code: h.codeAt(secret),
    });
    if (signedIn.kind !== "signed-in") throw new Error("expected a session");

    const tokens = await idTokens(h, signedIn.sessionToken);

    expect(tokens.signedIn).toMatchObject({
      amr: ["mfa", "otp", "pwd"],
      auth_time: tokens.authenticationTime,
    });
    expect(tokens.refreshed).toMatchObject({
      amr: ["mfa", "otp", "pwd"],
      auth_time: tokens.authenticationTime,
    });
  });

  test("a recovery code counts as a second factor but not as a one-time password", async () => {
    const h = await harness();
    const { recoveryCodes } = await h.enroll();
    const signedIn = await h.application.mfa.completeSignIn({
      challengeToken: await h.challenge(),
      code: recoveryCodes[0]!,
    });
    if (signedIn.kind !== "signed-in") throw new Error("expected a session");

    expect((await idTokens(h, signedIn.sessionToken)).signedIn.amr).toEqual(["mfa", "pwd"]);
  });

  test("a password-only sign-in reports the password and no second factor", async () => {
    const h = await harness();
    const signedIn = await h.passwordStep();
    if (signedIn.kind !== "signed-in") throw new Error("expected a session");

    const tokens = await idTokens(h, signedIn.sessionToken);

    expect(tokens.signedIn).toMatchObject({ amr: ["pwd"], auth_time: tokens.authenticationTime });
    expect(tokens.refreshed.amr).toEqual(["pwd"]);
  });
});
