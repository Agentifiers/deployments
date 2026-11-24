import { describe, expect, test } from "bun:test";
import type { OidcIdentityClaims } from "./linking.ts";
import {
  SAML_ASSERTION_ID,
  SAML_ISSUE_INSTANT,
  SAML_ISSUER,
  samlClaims,
  samlProviderRecord,
} from "./saml-test-support.ts";
import {
  CONNECTION,
  EXISTING_PRINCIPAL,
  ORGANIZATION,
  existingPrincipal,
  organizationRecord,
  providerRecord,
  signInHarness,
  verifiedDomainRecord,
  type SignInHarness,
} from "./test-support.ts";

const DANA = samlClaims({ email: "dana@acme.com" });
const RETURN_TO = "https://app.example.test/dashboard";

async function consumedTransaction(harness: SignInHarness) {
  await harness.store.beginTransaction({
    connectionId: CONNECTION,
    forceLogin: false,
    lookupHash: "h1",
    organizationId: ORGANIZATION,
    returnTo: "/oauth2/authorize",
  });
  const transaction = await harness.store.consumeTransaction({
    lookupHash: "h1",
    organizationId: ORGANIZATION,
  });
  if (!transaction) throw new Error("expected a pending transaction");
  return transaction;
}

function record(harness: SignInHarness, assertionId = SAML_ASSERTION_ID, claims = DANA) {
  return harness.store.recordUnsolicitedSignIn({
    assertionId,
    claims,
    connectionId: CONNECTION,
    issueInstant: SAML_ISSUE_INSTANT,
    organizationId: ORGANIZATION,
    returnTo: RETURN_TO,
  });
}

async function recordedToken(harness: SignInHarness, assertionId?: string, claims = DANA) {
  const recorded = await record(harness, assertionId, claims);
  if (recorded.kind !== "recorded") throw new Error(`unexpected ${recorded.kind}`);
  return recorded.token;
}

const unsolicitedStatuses = (harness: SignInHarness) =>
  harness.memory
    .of("identity-federation-unsolicited-sign-in")
    .map((pending) => pending.data.status);

describe("solicited SAML sign-in", () => {
  test("a first login creates the principal on the asserted email alone", async () => {
    const harness = signInHarness([samlProviderRecord(), verifiedDomainRecord()]);
    const outcome = await harness.store.completeSignIn({
      claims: DANA,
      transaction: await consumedTransaction(harness),
    });
    expect(outcome.kind).toBe("signed-in");
    expect(harness.memory.of("principal").map((principal) => principal.data)).toEqual([
      expect.objectContaining({ displayName: "Dana Example", primaryEmail: "dana@acme.com" }),
    ]);
    expect(harness.memory.of("principal-identity").map((link) => link.data)).toEqual([
      expect.objectContaining({ issuer: SAML_ISSUER, subject: "dana-subject" }),
    ]);
  });

  test("an unverified domain with an existing principal is denied, never sent to the mailbox", async () => {
    const harness = signInHarness([
      samlProviderRecord(),
      verifiedDomainRecord("other.com"),
      ...existingPrincipal("dana@acme.com"),
    ]);
    expect(
      await harness.store.completeSignIn({
        claims: DANA,
        transaction: await consumedTransaction(harness),
      }),
    ).toEqual({ kind: "denied", reason: "email_domain_not_verified" });
    expect(harness.memory.of("identity-federation-link-request")).toHaveLength(0);
    expect(harness.sentEmails).toEqual([]);
  });

  test("claims of another protocol or issuer than the provider's are denied", async () => {
    const oidcClaims: OidcIdentityClaims = {
      email: "dana@acme.com",
      emailVerified: true,
      issuer: SAML_ISSUER,
      protocol: "oidc",
      subject: "dana-subject",
    };
    const saml = signInHarness([samlProviderRecord(), verifiedDomainRecord()]);
    const oidc = signInHarness([providerRecord(), verifiedDomainRecord()]);
    const renamed = signInHarness([
      samlProviderRecord({ issuer: "urn:acme:other-idp" }),
      verifiedDomainRecord(),
    ]);
    const denied = { kind: "denied", reason: "connection_inactive" } as const;
    expect(
      await saml.store.completeSignIn({
        claims: oidcClaims,
        transaction: await consumedTransaction(saml),
      }),
    ).toEqual(denied);
    expect(
      await oidc.store.completeSignIn({
        claims: DANA,
        transaction: await consumedTransaction(oidc),
      }),
    ).toEqual(denied);
    expect(
      await renamed.store.completeSignIn({
        claims: DANA,
        transaction: await consumedTransaction(renamed),
      }),
    ).toEqual(denied);
    expect(
      [saml, oidc, renamed].flatMap((harness) => harness.memory.of("identity-session")),
    ).toEqual([]);
  });
});

describe("unsolicited SAML sign-in", () => {
  test("a confirmed sign-in creates the session and returns to the relay target", async () => {
    const harness = signInHarness([
      samlProviderRecord(),
      verifiedDomainRecord(),
      organizationRecord(),
    ]);
    const token = await recordedToken(harness);
    expect(await harness.store.describeUnsolicitedSignIn(token)).toEqual({
      email: "dana@acme.com",
      issuer: SAML_ISSUER,
      organizationName: "Acme",
      providerDisplayName: "Acme SAML",
    });
    const outcome = await harness.store.completeUnsolicitedSignIn({
      consent: { bindingHash: "browser-1", kind: "confirmed" },
      token,
    });
    expect(outcome).toMatchObject({ kind: "signed-in", returnTo: RETURN_TO });
    expect(unsolicitedStatuses(harness)).toEqual(["consumed"]);
    expect(
      harness.memory.of("identity-federation-unsolicited-sign-in").map((row) => row.data),
    ).toEqual([expect.not.objectContaining({ claims: expect.anything() })]);
    expect(await harness.store.describeUnsolicitedSignIn(token)).toBeUndefined();
    expect(
      await harness.store.completeUnsolicitedSignIn({
        consent: { bindingHash: "browser-1", kind: "confirmed" },
        token,
      }),
    ).toEqual({ kind: "invalid" });
  });

  test("the confirmation names the account a linked subject signs in to, not the asserted email", async () => {
    const harness = signInHarness([
      samlProviderRecord(),
      verifiedDomainRecord(),
      organizationRecord(),
    ]);
    const linked = await recordedToken(harness);
    await harness.store.completeUnsolicitedSignIn({
      consent: { bindingHash: "browser-1", kind: "confirmed" },
      token: linked,
    });
    const token = await recordedToken(
      harness,
      "_second-assertion",
      samlClaims({ email: "someone.else@acme.com" }),
    );
    expect(await harness.store.describeUnsolicitedSignIn(token)).toEqual({
      email: "dana@acme.com",
      issuer: SAML_ISSUER,
      organizationName: "Acme",
      providerDisplayName: "Acme SAML",
    });
  });

  test("the same assertion is recorded once, even after its first sign-in completed", async () => {
    const harness = signInHarness([samlProviderRecord(), verifiedDomainRecord()]);
    const token = await recordedToken(harness);
    expect(await record(harness)).toEqual({ kind: "replayed" });
    await harness.store.completeUnsolicitedSignIn({
      consent: { bindingHash: "browser-1", kind: "confirmed" },
      token,
    });
    expect(await record(harness)).toEqual({ kind: "replayed" });
    expect((await record(harness, "_another-assertion")).kind).toBe("recorded");
  });

  test("a replay at the last accepted instant is still refused as a replay", async () => {
    const harness = signInHarness([samlProviderRecord(), verifiedDomainRecord()]);
    await recordedToken(harness);
    harness.advance(360_000);
    expect(await record(harness)).toEqual({ kind: "replayed" });
  });

  test("an assertion past the window is refused as stale, even once its replay claim lapsed", async () => {
    const harness = signInHarness([samlProviderRecord(), verifiedDomainRecord()]);
    await recordedToken(harness);
    harness.advance(360_001);
    expect(await record(harness, "_unseen-assertion")).toEqual({ kind: "stale" });
    harness.advance(119_999);
    expect(await record(harness)).toEqual({ kind: "stale" });
  });

  test("a pending sign-in can be confirmed for 300 s after it arrived, however old its IssueInstant", async () => {
    const harness = signInHarness([
      samlProviderRecord(),
      verifiedDomainRecord(),
      organizationRecord(),
    ]);
    const recorded = await harness.store.recordUnsolicitedSignIn({
      assertionId: SAML_ASSERTION_ID,
      claims: DANA,
      connectionId: CONNECTION,
      issueInstant: "2026-10-08T11:54:10.000Z",
      organizationId: ORGANIZATION,
      returnTo: RETURN_TO,
    });
    if (recorded.kind !== "recorded") throw new Error(`unexpected ${recorded.kind}`);
    harness.advance(299_000);
    expect(await harness.store.describeUnsolicitedSignIn(recorded.token)).toEqual({
      email: "dana@acme.com",
      issuer: SAML_ISSUER,
      organizationName: "Acme",
      providerDisplayName: "Acme SAML",
    });
    harness.advance(1_000);
    expect(await harness.store.describeUnsolicitedSignIn(recorded.token)).toBeUndefined();
    expect(
      await harness.store.completeUnsolicitedSignIn({
        consent: { bindingHash: "browser-1", kind: "confirmed" },
        token: recorded.token,
      }),
    ).toEqual({ kind: "invalid" });
    expect(harness.memory.of("identity-session")).toHaveLength(0);
  });

  test("two racing completions produce one session", async () => {
    const harness = signInHarness([samlProviderRecord(), verifiedDomainRecord()]);
    const token = await recordedToken(harness);
    const outcomes = await Promise.all(
      ["browser-1", "browser-2"].map((bindingHash) =>
        harness.store.completeUnsolicitedSignIn({
          consent: { bindingHash, kind: "confirmed" },
          token,
        }),
      ),
    );
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["invalid", "signed-in"]);
    expect(harness.memory.of("identity-session")).toHaveLength(1);
  });

  test("a browser session counts as consent only for the linked principal", async () => {
    const harness = signInHarness([samlProviderRecord(), verifiedDomainRecord()]);
    const first = await harness.store.completeUnsolicitedSignIn({
      consent: { bindingHash: "browser-1", kind: "confirmed" },
      token: await recordedToken(harness),
    });
    if (first.kind !== "signed-in") throw new Error(`unexpected ${first.kind}`);
    const token = await recordedToken(harness, "_second-assertion");

    expect(
      await harness.store.completeUnsolicitedSignIn({
        consent: {
          bindingHash: "browser-2",
          kind: "browser-session",
          principalId: EXISTING_PRINCIPAL,
        },
        token,
      }),
    ).toEqual({ kind: "confirmation-required" });
    expect(unsolicitedStatuses(harness)).toEqual(["consumed", "pending"]);
    expect(harness.memory.of("identity-session")).toHaveLength(1);

    const second = await harness.store.completeUnsolicitedSignIn({
      consent: {
        bindingHash: "browser-2",
        kind: "browser-session",
        principalId: first.principalId,
      },
      token,
    });
    expect(second).toMatchObject({ kind: "signed-in", principalId: first.principalId });
    expect(harness.memory.of("identity-session")).toHaveLength(2);
  });

  test("an existing unlinked principal confirms through the mailbox bound to the new browser", async () => {
    const harness = signInHarness([
      samlProviderRecord(),
      verifiedDomainRecord(),
      ...existingPrincipal("dana@acme.com"),
    ]);
    const token = await recordedToken(harness);
    expect(
      await harness.store.completeUnsolicitedSignIn({
        consent: {
          bindingHash: "browser-1",
          kind: "browser-session",
          principalId: EXISTING_PRINCIPAL,
        },
        token,
      }),
    ).toEqual({ kind: "confirmation-required" });
    expect(
      await harness.store.completeUnsolicitedSignIn({
        consent: { bindingHash: "browser-1", kind: "confirmed" },
        token,
      }),
    ).toEqual({
      expiresAt: "2026-10-08T12:30:00.000Z",
      kind: "mailbox-confirmation-sent",
      maskedEmail: "d***@acme.com",
    });
    expect(
      harness.memory
        .of("identity-federation-link-request")
        .map((request) => [request.data.bindingHash, request.data.issuer]),
    ).toEqual([["browser-1", SAML_ISSUER]]);
    expect(unsolicitedStatuses(harness)).toEqual(["consumed"]);
  });

  test("turning unsolicited sign-in off denies a sign-in already waiting for confirmation", async () => {
    const enabled = samlProviderRecord();
    const harness = signInHarness([enabled, verifiedDomainRecord()]);
    const token = await recordedToken(harness);
    harness.memory.put(
      samlProviderRecord({ unsolicitedSignIn: "disabled", version: enabled.data.version + 1 }),
    );
    expect(
      await harness.store.completeUnsolicitedSignIn({
        consent: { bindingHash: "browser-1", kind: "confirmed" },
        token,
      }),
    ).toEqual({ kind: "denied", reason: "connection_inactive" });
    expect(unsolicitedStatuses(harness)).toEqual(["pending"]);
    expect(harness.memory.of("identity-session")).toHaveLength(0);
  });
});
