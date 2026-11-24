import { describe, expect, test } from "bun:test";
import type { IdentitySessionAuthentication } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  CONNECTION,
  EXISTING_PRINCIPAL,
  ISSUER,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  START,
  existingPrincipal,
  id,
  organizationRecord,
  providerRecord,
  verifiedDomainRecord,
  type SignInHarness,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import { AuthorizeContinuation } from "./authorize-continuation.ts";
import type { FederationApplication } from "./federation-application.ts";
import { CALLBACK_URL, federationFixture } from "./federation.fixture.ts";

const ALICE = { email: "alice@acme.com", subject: "00u-alice" };
const continuation = Schema.decodeUnknownSync(AuthorizeContinuation);
const RETURN_TO = continuation(
  `/oauth2/authorize?client_id=deployments-apps&organization_hint=${ORGANIZATION}`,
);
const SSO = {
  displayName: "Acme Okta",
  issuer: ISSUER,
  kind: "sso",
  organizationId: ORGANIZATION,
  protocol: "oidc",
} as const;

async function begin(
  federation: FederationApplication,
  returnTo: AuthorizeContinuation | undefined,
) {
  const started = await federation.start({ organizationId: ORGANIZATION, returnTo });
  if (!started) throw new Error("expected the organization's connection to be active");
  return started;
}

function transactionStatuses(harness: SignInHarness) {
  return harness.memory
    .of("identity-federation-transaction")
    .map((transaction) => transaction.data.status);
}

describe("federation application", () => {
  test("discovery answers by email domain, never by address", async () => {
    const fixture = await federationFixture([
      providerRecord(),
      verifiedDomainRecord(),
      ...existingPrincipal("bob@acme.com"),
    ]);

    expect(await fixture.federation.discover("bob@acme.com")).toEqual(SSO);
    expect(await fixture.federation.discover("Nobody@ACME.com")).toEqual(SSO);
    expect(await fixture.federation.discover("bob@example.com")).toEqual({ kind: "password" });
  });

  test("start sends the browser to the IdP and stores a transaction without secrets", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);
    const started = await fixture.federation.start({
      loginHint: "alice@acme.com",
      organizationId: ORGANIZATION,
      returnTo: RETURN_TO,
    });

    const location = new URL(started!.location);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://acme.okta.com/oauth2/v1/authorize",
    );
    expect(
      Object.fromEntries(
        [...location.searchParams].filter(
          ([name]) => !["code_challenge", "nonce", "state"].includes(name),
        ),
      ),
    ).toEqual({
      client_id: "0oa-client",
      code_challenge_method: "S256",
      login_hint: "alice@acme.com",
      redirect_uri: CALLBACK_URL,
      response_type: "code",
      scope: "openid email profile",
    });
    expect(started!.bindingMaxAgeSeconds).toBe(600);
    const [transaction] = fixture.harness.memory.of("identity-federation-transaction");
    expect(transaction?.data).toMatchObject({
      connectionId: CONNECTION,
      expiresAt: "2026-10-08T12:10:00.000Z",
      forceLogin: false,
      organizationId: ORGANIZATION,
      returnTo: RETURN_TO,
      status: "pending",
    });
    expect(JSON.stringify(transaction)).not.toContain(started!.bindingToken);
  });

  test("start lands outside authorize on the application and refuses inactive organizations", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);

    await begin(fixture.federation, undefined);
    expect(fixture.harness.memory.of("identity-federation-transaction")[0]?.data.returnTo).toBe(
      "https://app.deployments.ai",
    );
    expect(
      await fixture.federation.start({ organizationId: OTHER_ORGANIZATION, returnTo: RETURN_TO }),
    ).toBeUndefined();
    expect(
      await fixture.federation.start({ organizationId: "acme", returnTo: RETURN_TO }),
    ).toBeUndefined();
    expect(fixture.harness.memory.of("identity-federation-transaction")).toHaveLength(1);
  });

  test("a callback signs in once through the IdP and a replay is rejected", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);
    const started = await begin(fixture.federation, RETURN_TO);
    const { code, state } = fixture.identityProviderRedirect(started.location, ALICE);
    const callback = {
      bindingToken: started.bindingToken,
      organizationId: ORGANIZATION,
      query: { code, iss: ISSUER, state },
    };

    expect(await fixture.federation.callback(callback)).toEqual({
      kind: "signed-in",
      returnTo: RETURN_TO,
      sessionToken: "token-1",
    });
    expect(fixture.harness.memory.of("identity-session")[0]?.data.authentication).toEqual({
      authenticatedAt: START,
      connectionId: CONNECTION,
      issuer: ISSUER,
      method: "federated",
      organizationId: ORGANIZATION,
      subject: "00u-alice",
    });
    expect(await fixture.federation.callback(callback)).toEqual({
      kind: "rejected",
      reason: "transaction_invalid",
    });
    expect(fixture.tokenRequests).toEqual(["code-1"]);
  });

  test("a forged state or another organization's path leaves the transaction usable", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);
    const started = await begin(fixture.federation, RETURN_TO);
    const { code, state } = fixture.identityProviderRedirect(started.location, ALICE);
    const callback = (organizationId: string, query: Record<string, string>) =>
      fixture.federation.callback({ bindingToken: started.bindingToken, organizationId, query });

    expect(await callback(ORGANIZATION, { code, state: "forged-state" })).toEqual({
      kind: "rejected",
      reason: "state_mismatch",
    });
    expect(await callback(OTHER_ORGANIZATION, { code, state })).toEqual({
      kind: "rejected",
      reason: "transaction_invalid",
    });
    expect(await callback("../01ARZ3NDEKTSV4RRFFQ69G5FC0", { code, state })).toEqual({
      kind: "rejected",
      reason: "transaction_invalid",
    });
    expect(transactionStatuses(fixture.harness)).toEqual(["pending"]);
    expect(fixture.tokenRequests).toEqual([]);
    expect((await callback(ORGANIZATION, { code, state })).kind).toBe("signed-in");
  });

  test("a callback without the browser binding is rejected", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);
    const started = await begin(fixture.federation, RETURN_TO);
    const { code, state } = fixture.identityProviderRedirect(started.location, ALICE);

    expect(
      await fixture.federation.callback({
        bindingToken: undefined,
        organizationId: ORGANIZATION,
        query: { code, state },
      }),
    ).toEqual({ kind: "rejected", reason: "binding_missing" });
    expect(transactionStatuses(fixture.harness)).toEqual(["pending"]);
  });

  test("an IdP error spends the transaction and maps to a fixed reason", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);
    const denied = await begin(fixture.federation, RETURN_TO);
    const deniedState = fixture.identityProviderRedirect(denied.location, ALICE).state;
    const unknown = await begin(fixture.federation, RETURN_TO);
    const unknownState = fixture.identityProviderRedirect(unknown.location, ALICE).state;

    expect(
      await fixture.federation.callback({
        bindingToken: denied.bindingToken,
        organizationId: ORGANIZATION,
        query: { error: "access_denied", error_description: "<b>nope</b>", state: deniedState },
      }),
    ).toEqual({ kind: "rejected", reason: "provider_access_denied" });
    expect(
      await fixture.federation.callback({
        bindingToken: unknown.bindingToken,
        organizationId: ORGANIZATION,
        query: { error: "constructor", state: unknownState },
      }),
    ).toEqual({ kind: "rejected", reason: "provider_error" });
    expect(transactionStatuses(fixture.harness)).toEqual(["consumed", "consumed"]);
    expect(fixture.tokenRequests).toEqual([]);
  });

  test("an RFC 9207 issuer mismatch or a changed connection stops before the code exchange", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);
    const mismatched = await begin(fixture.federation, RETURN_TO);
    const first = fixture.identityProviderRedirect(mismatched.location, ALICE);
    const changed = await begin(fixture.federation, RETURN_TO);
    const second = fixture.identityProviderRedirect(changed.location, ALICE);

    expect(
      await fixture.federation.callback({
        bindingToken: mismatched.bindingToken,
        organizationId: ORGANIZATION,
        query: { ...first, iss: "https://attacker.example" },
      }),
    ).toEqual({ kind: "rejected", reason: "issuer_mismatch" });
    fixture.harness.memory.put(
      providerRecord({ connectionId: id("01ARZ3NDEKTSV4RRFFQ69G5FC9"), version: 2 }),
    );
    expect(
      await fixture.federation.callback({
        bindingToken: changed.bindingToken,
        organizationId: ORGANIZATION,
        query: second,
      }),
    ).toEqual({ kind: "rejected", reason: "connection_changed" });
    expect(fixture.tokenRequests).toEqual([]);
  });

  test("a forced reauthentication requires the IdP to authenticate again", async () => {
    const fixture = await federationFixture([providerRecord(), verifiedDomainRecord()]);
    const forced = continuation(`${RETURN_TO}&reauthentication_token=reauth`);
    const stale = await begin(fixture.federation, forced);
    const staleRedirect = fixture.identityProviderRedirect(stale.location, ALICE);
    const fresh = await begin(fixture.federation, forced);
    const freshRedirect = fixture.identityProviderRedirect(fresh.location, {
      ...ALICE,
      authTime: Date.parse(START) / 1_000,
    });

    const location = new URL(stale.location);
    expect([location.searchParams.get("prompt"), location.searchParams.get("max_age")]).toEqual([
      "login",
      "0",
    ]);
    expect(
      await fixture.federation.callback({
        bindingToken: stale.bindingToken,
        organizationId: ORGANIZATION,
        query: staleRedirect,
      }),
    ).toEqual({ code: "id_token_reauthentication_missing", kind: "provider-response-invalid" });
    expect(
      await fixture.federation.callback({
        bindingToken: fresh.bindingToken,
        organizationId: ORGANIZATION,
        query: freshRedirect,
      }),
    ).toEqual({ kind: "signed-in", returnTo: forced, sessionToken: "token-1" });
  });

  test("an existing account proves its mailbox from the signing-in browser before the IdP can sign it in", async () => {
    const fixture = await federationFixture([
      providerRecord(),
      verifiedDomainRecord(),
      organizationRecord(),
      ...existingPrincipal("bob@acme.com"),
    ]);
    const started = await begin(fixture.federation, RETURN_TO);
    const elsewhere = await begin(fixture.federation, RETURN_TO);
    const redirect = fixture.identityProviderRedirect(started.location, {
      email: "bob@acme.com",
      subject: "00u-bob",
    });

    expect(
      await fixture.federation.callback({
        bindingToken: started.bindingToken,
        organizationId: ORGANIZATION,
        query: redirect,
      }),
    ).toEqual({
      bindingMaxAgeSeconds: 1_800,
      bindingToken: started.bindingToken,
      kind: "mailbox-confirmation-sent",
      maskedEmail: "b***@acme.com",
    });
    expect(fixture.harness.memory.of("identity-session")).toEqual([]);
    expect(await fixture.federation.pendingLink("token-1")).toEqual({
      identityProvider: { displayName: "Acme Okta", issuer: ISSUER },
      organizationName: "Acme",
    });
    expect(
      await fixture.federation.confirmLink({
        bindingToken: elsewhere.bindingToken,
        token: "token-1",
      }),
    ).toEqual({ kind: "browser-mismatch" });
    expect(
      await fixture.federation.confirmLink({
        bindingToken: started.bindingToken,
        token: "token-1",
      }),
    ).toEqual({
      kind: "linked",
      provider: {
        displayName: "Acme Okta",
        issuer: ISSUER,
        organizationId: ORGANIZATION,
        protocol: "oidc",
      },
    });
    expect(
      await fixture.federation.confirmLink({
        bindingToken: started.bindingToken,
        token: "token-1",
      }),
    ).toEqual({ kind: "invalid" });
    expect(await fixture.federation.pendingLink("token-1")).toBeUndefined();
  });

  test("an organization hint routes through sign-in unless the session satisfies the organization", async () => {
    const federated = (authenticatedAt: string): IdentitySessionAuthentication => ({
      authenticatedAt,
      connectionId: CONNECTION,
      issuer: ISSUER,
      method: "federated",
      organizationId: ORGANIZATION,
      subject: "00u-alice",
    });
    const required = await federationFixture([
      providerRecord({ state: { enforcement: "required", kind: "active" } }),
    ]);
    const optional = await federationFixture([providerRecord()]);
    const disabled = await federationFixture([
      providerRecord({ state: { disabledAt: START, kind: "disabled" } }),
    ]);
    const route = (
      federation: FederationApplication,
      authentication: IdentitySessionAuthentication | undefined,
      hint: string | undefined,
    ) =>
      federation.organizationHint({
        browser: authentication && { authentication, principalId: EXISTING_PRINCIPAL },
        hint,
      });
    const signIn = { kind: "sign-in", organizationId: ORGANIZATION } as const;
    const satisfied = { kind: "satisfied", organizationId: ORGANIZATION } as const;
    required.advance(60 * 60 * 1_000);

    expect(await route(required.federation, federated(START), ORGANIZATION)).toEqual(satisfied);
    expect(await route(required.federation, { method: "password" }, ORGANIZATION)).toEqual(signIn);
    expect(
      await route(required.federation, federated("2026-10-07T12:00:00.000Z"), ORGANIZATION),
    ).toEqual(signIn);
    expect(await route(required.federation, undefined, ORGANIZATION)).toEqual(signIn);
    expect(await route(optional.federation, { method: "password" }, ORGANIZATION)).toEqual(
      satisfied,
    );
    expect(await route(optional.federation, undefined, ORGANIZATION)).toEqual(signIn);
    expect(await route(disabled.federation, undefined, ORGANIZATION)).toEqual({ kind: "ignored" });
    expect(await route(required.federation, undefined, "not-a-ulid")).toEqual({ kind: "ignored" });
    expect(await route(required.federation, undefined, undefined)).toEqual({ kind: "ignored" });
  });
});
