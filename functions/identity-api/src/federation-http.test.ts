import { describe, expect, test } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import {
  EXISTING_PRINCIPAL,
  ISSUER,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  existingPrincipal,
  id,
  memberRecord,
  organizationRecord,
  providerRecord,
  verifiedDomainRecord,
  type SignInHarness,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import type { DeviceApplication } from "./device-application.ts";
import { fakeBrowser } from "./fake-browser.fixture.ts";
import {
  APPLICATION_ORIGIN,
  IDENTITY_ISSUER,
  federationFixture,
  type ClaimRelease,
} from "./federation.fixture.ts";
import { makeIdentityHttpHandler, type RestApiEvent, type RestApiResponse } from "./http.ts";
import type { OAuthApplication } from "./oauth-application.ts";
import type { JwtSigner } from "./signer.ts";

const CSRF = "csrf-value";
const CLEAR_BINDING = "__Host-dpl_federation=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly";
const ALICE = { email: "alice@acme.com", subject: "00u-alice" };
const REQUIRED = { state: { enforcement: "required", kind: "active" } } as const;
const AUTHORIZE = {
  client_id: "deployments-apps",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  nonce: "app-nonce",
  organization_hint: ORGANIZATION,
  redirect_uri: "https://apps.deployments.ai/callback",
  response_type: "code",
  scope: "openid",
  state: "app-state",
};
const CODE_ISSUED = "https://apps.deployments.ai/callback?code=issued";

async function federatedHandler(
  records: readonly PlatformRecord[],
  options: { readonly release?: ClaimRelease } = {},
) {
  const fixture = await federationFixture(records, options);
  const codesIssuedTo: string[] = [];
  const oauth = {
    authorize: async (input: { readonly browserSession: { readonly principalId: string } }) => {
      codesIssuedTo.push(input.browserSession.principalId);
      return CODE_ISSUED;
    },
    beginReauthentication: async () => "reauthentication-token",
    client: async () => ({
      data: {
        allowedScopes: ["openid"],
        clientId: "deployments-apps",
        grantTypes: ["authorization_code"],
        name: "Deployments apps",
        redirectUris: ["https://apps.deployments.ai/callback"],
        requiredScopes: [],
        requirePkce: true,
        responseTypes: ["code"],
        status: "active",
        tokenEndpointAuthMethod: "client_secret_basic",
        type: "confidential",
      },
    }),
  } as unknown as OAuthApplication;
  const handle = makeIdentityHttpHandler(
    fixture.identity,
    {
      applicationOrigin: APPLICATION_ORIGIN,
      issuer: IDENTITY_ISSUER,
      publicResponseMinimumMs: 0,
      queuePublicEmailRequest: async () => undefined,
      registrationEnabled: false,
      secureCookies: true,
      uiOrigin: IDENTITY_ISSUER,
    },
    { device: {} as DeviceApplication, oauth, signer: {} as JwtSigner },
    fixture.federation,
  );
  return { codesIssuedTo, fixture, handle };
}

function post(
  path: string,
  body: unknown,
  options: { readonly csrf: boolean } = { csrf: true },
): RestApiEvent {
  return {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: IDENTITY_ISSUER,
      ...(options.csrf ? { cookie: `__Host-dpl_csrf=${CSRF}`, "x-csrf-token": CSRF } : {}),
    },
    httpMethod: "POST",
    path,
  };
}

function get(path: string, query: Record<string, string>, cookie?: string): RestApiEvent {
  return {
    ...(cookie ? { headers: { cookie } } : {}),
    httpMethod: "GET",
    path,
    queryStringParameters: query,
  };
}

function bindingToken(setCookie: readonly string[] | undefined) {
  const token = /^__Host-dpl_federation=([^;]+);/u.exec(setCookie?.[0] ?? "")?.[1];
  if (!token) throw new Error("expected the start response to set the binding cookie");
  return token;
}

function startLocation(response: RestApiResponse) {
  const body: unknown = JSON.parse(response.body);
  if (typeof body !== "object" || body === null || !("location" in body)) {
    throw new Error("expected the start response to name the IdP location");
  }
  return String(body.location);
}

function transactionStatuses(harness: SignInHarness): string[] {
  return harness.memory
    .of("identity-federation-transaction")
    .map((transaction) => transaction.data.status);
}

describe("federation HTTP", () => {
  test("an enforced organization signs in through its IdP and the federated session gets a code", async () => {
    const { codesIssuedTo, fixture, handle } = await federatedHandler([
      providerRecord(REQUIRED),
      verifiedDomainRecord(),
    ]);

    const toSignIn = await handle(get("/oauth2/authorize", AUTHORIZE));
    expect(toSignIn.statusCode).toBe(302);
    const signIn = new URL(toSignIn.headers.Location!);
    expect(`${signIn.origin}${signIn.pathname}`).toBe(`${IDENTITY_ISSUER}/sign-in`);
    expect(signIn.searchParams.get("organization")).toBe(ORGANIZATION);
    const returnTo = signIn.searchParams.get("return_to")!;
    expect(returnTo).toBe(`/oauth2/authorize?${new URLSearchParams(AUTHORIZE).toString()}`);

    const page = await handle(get("/sign-in", { organization: ORGANIZATION, return_to: returnTo }));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(
      `const organization={"displayName":"Acme Okta","issuer":"${ISSUER}","organizationId":"${ORGANIZATION}","protocol":"oidc"}`,
    );

    const started = await handle(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION, returnTo }),
    );
    expect(started.statusCode).toBe(200);
    const location = startLocation(started);
    expect(location).toStartWith("https://acme.okta.com/oauth2/v1/authorize?");
    const token = bindingToken(started.multiValueHeaders?.["Set-Cookie"]);
    expect(started.multiValueHeaders?.["Set-Cookie"]).toEqual([
      `__Host-dpl_federation=${token}; Path=/; Max-Age=600; SameSite=Lax; Secure; HttpOnly`,
    ]);

    const callback = get(
      `/oauth2/federation/callback/${ORGANIZATION}`,
      { ...fixture.identityProviderRedirect(location, ALICE), iss: ISSUER },
      `__Host-dpl_federation=${token}`,
    );
    const signedIn = await handle(callback);
    expect(signedIn.statusCode).toBe(302);
    expect(signedIn.headers.Location).toBe(returnTo);
    expect(signedIn.multiValueHeaders?.["Set-Cookie"]).toEqual([
      CLEAR_BINDING,
      "__Host-dpl_identity=token-1; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly",
    ]);

    const continued = await handle(
      get(
        "/oauth2/authorize",
        Object.fromEntries(new URLSearchParams(returnTo.split("?")[1])),
        "__Host-dpl_identity=token-1",
      ),
    );
    expect(continued.statusCode).toBe(302);
    expect(continued.headers.Location).toBe(CODE_ISSUED);
    expect(codesIssuedTo).toEqual(fixture.harness.memory.of("principal").map((p) => p.data.id));
    expect(codesIssuedTo).toHaveLength(1);

    const replayed = await handle(callback);
    expect(replayed.statusCode).toBe(400);
    expect(replayed.body).toContain(
      "This sign-in expired or was already used. Start again from the sign-in page.",
    );
    expect(replayed.multiValueHeaders?.["Set-Cookie"]).toEqual([CLEAR_BINDING]);
  });

  test("an enforced-organization hint sends a password session to the organization sign-in", async () => {
    const { codesIssuedTo, fixture, handle } = await federatedHandler([
      providerRecord(REQUIRED),
      verifiedDomainRecord(),
      ...existingPrincipal("bob@acme.com"),
    ]);
    const session = `__Host-dpl_identity=${fixture.passwordSession(id("01ARZ3NDEKTSV4RRFFQ69G5FD0"))}`;

    const hinted = await handle(get("/oauth2/authorize", AUTHORIZE, session));
    expect(hinted.statusCode).toBe(302);
    expect(new URL(hinted.headers.Location!).searchParams.get("organization")).toBe(ORGANIZATION);
    const silent = await handle(
      get("/oauth2/authorize", { ...AUTHORIZE, prompt: "none" }, session),
    );
    expect(new URL(silent.headers.Location!).searchParams.get("error")).toBe("login_required");
    expect(codesIssuedTo).toEqual([]);

    const { organization_hint: _hint, ...unhinted } = AUTHORIZE;
    const plain = await handle(get("/oauth2/authorize", unhinted, session));
    expect(plain.headers.Location).toBe(CODE_ISSUED);
    expect(codesIssuedTo).toEqual([EXISTING_PRINCIPAL]);
  });

  test("an owner's password session passes an enforced-organization hint, so a broken IdP cannot lock owners out", async () => {
    const { codesIssuedTo, fixture, handle } = await federatedHandler([
      providerRecord(REQUIRED),
      verifiedDomainRecord(),
      ...existingPrincipal("bob@acme.com"),
      memberRecord(EXISTING_PRINCIPAL, "active", "owner"),
    ]);
    const session = `__Host-dpl_identity=${fixture.passwordSession(id("01ARZ3NDEKTSV4RRFFQ69G5FD0"))}`;

    const hinted = await handle(get("/oauth2/authorize", AUTHORIZE, session));
    expect([hinted.statusCode, hinted.headers.Location]).toEqual([302, CODE_ISSUED]);
    expect(codesIssuedTo).toEqual([EXISTING_PRINCIPAL]);
  });

  test("start and discover sit behind the origin and CSRF guard", async () => {
    const { fixture, handle } = await federatedHandler([providerRecord(), verifiedDomainRecord()]);

    const start = await handle(
      post(
        "/v1/auth/federation/start",
        { organizationId: ORGANIZATION, returnTo: "/oauth2/authorize" },
        { csrf: false },
      ),
    );
    const discover = await handle(
      post("/v1/auth/federation/discover", { email: "alice@acme.com" }, { csrf: false }),
    );
    expect([start.statusCode, start.body]).toEqual([403, '{"error":"invalid_request"}']);
    expect([discover.statusCode, discover.body]).toEqual([403, '{"error":"invalid_request"}']);
    expect(fixture.harness.memory.of("identity-federation-transaction")).toEqual([]);
  });

  test("discovery answers by email domain and start refuses organizations without SSO", async () => {
    const { handle } = await federatedHandler([
      providerRecord(),
      verifiedDomainRecord(),
      ...existingPrincipal("bob@acme.com"),
    ]);
    const sso = `{"kind":"sso","displayName":"Acme Okta","issuer":"${ISSUER}","organizationId":"${ORGANIZATION}","protocol":"oidc"}`;

    const discovered = await Promise.all(
      ["bob@acme.com", "nobody@acme.com", "bob@example.com"].map(async (email) => {
        const response = await handle(post("/v1/auth/federation/discover", { email }));
        return [response.statusCode, response.body];
      }),
    );
    expect(discovered).toEqual([
      [200, sso],
      [200, sso],
      [200, '{"kind":"password"}'],
    ]);
    const refused = await handle(
      post("/v1/auth/federation/start", { organizationId: OTHER_ORGANIZATION }),
    );
    expect([refused.statusCode, JSON.parse(refused.body)]).toEqual([
      404,
      {
        error: "invalid_request",
        error_description: "Single sign-on is not available for this organization.",
      },
    ]);
  });

  test("a callback without the cookie, with a forged state, or on another organization's path is rejected", async () => {
    const { fixture, handle } = await federatedHandler([providerRecord(), verifiedDomainRecord()]);
    const started = await handle(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION }),
    );
    const location = startLocation(started);
    const binding = `__Host-dpl_federation=${bindingToken(started.multiValueHeaders?.["Set-Cookie"])}`;
    const redirect = fixture.identityProviderRedirect(location, ALICE);
    const callbackPath = `/oauth2/federation/callback/${ORGANIZATION}`;

    const rejected = await Promise.all(
      [
        get(callbackPath, redirect),
        get(callbackPath, { ...redirect, state: "forged" }, binding),
        get(`/oauth2/federation/callback/${OTHER_ORGANIZATION}`, redirect, binding),
      ].map(handle),
    );
    expect(
      rejected.map((response) => [
        response.statusCode,
        /<p>([^<]+)<\/p>/u.exec(response.body)?.[1],
        response.multiValueHeaders?.["Set-Cookie"],
      ]),
    ).toEqual([
      [
        400,
        "This sign-in expired or was started in another browser. Start again from the sign-in page.",
        [CLEAR_BINDING],
      ],
      [
        400,
        "This sign-in response does not match the sign-in you started. Start again from the sign-in page.",
        [CLEAR_BINDING],
      ],
      [
        400,
        "This sign-in expired or was already used. Start again from the sign-in page.",
        [CLEAR_BINDING],
      ],
    ]);
    expect(transactionStatuses(fixture.harness)).toEqual(["pending"]);
    expect(fixture.tokenRequests).toEqual([]);
  });

  test("an IdP error shows fixed text and never the IdP's description", async () => {
    const { fixture, handle } = await federatedHandler([providerRecord(), verifiedDomainRecord()]);
    const started = await handle(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION }),
    );
    const location = startLocation(started);
    const { state } = fixture.identityProviderRedirect(location, ALICE);

    const response = await handle(
      get(
        `/oauth2/federation/callback/${ORGANIZATION}`,
        { error: "access_denied", error_description: "<script>alert(1)</script>", state },
        `__Host-dpl_federation=${bindingToken(started.multiValueHeaders?.["Set-Cookie"])}`,
      ),
    );
    expect(response.statusCode).toBe(403);
    expect(/<p>([^<]+)<\/p>/u.exec(response.body)?.[1]).toBe(
      "Your identity provider did not allow this sign-in.",
    );
    expect(response.body).not.toContain("alert(1)");
    expect(transactionStatuses(fixture.harness)).toEqual(["consumed"]);
  });

  test("an Okta provider that releases email through userinfo signs in through the browser", async () => {
    const callbackFrom = async (release: ClaimRelease) => {
      const { fixture, handle } = await federatedHandler(
        [providerRecord(), verifiedDomainRecord()],
        { release },
      );
      const started = await handle(
        post("/v1/auth/federation/start", { organizationId: ORGANIZATION }),
      );
      return handle(
        get(
          `/oauth2/federation/callback/${ORGANIZATION}`,
          { ...fixture.identityProviderRedirect(startLocation(started), ALICE), iss: ISSUER },
          `__Host-dpl_federation=${bindingToken(started.multiValueHeaders?.["Set-Cookie"])}`,
        ),
      );
    };
    const signedIn = await callbackFrom({
      accessToken: "bearer",
      kind: "okta-code-flow",
      userinfo: { emailVerified: true, kind: "claims" },
    });
    const mismatched = await callbackFrom({
      accessToken: "bearer",
      kind: "okta-code-flow",
      userinfo: { kind: "other-subject" },
    });

    expect([
      signedIn.statusCode,
      signedIn.headers.Location,
      signedIn.multiValueHeaders?.["Set-Cookie"],
    ]).toEqual([
      302,
      APPLICATION_ORIGIN,
      [
        CLEAR_BINDING,
        "__Host-dpl_identity=token-1; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly",
      ],
    ]);
    expect(mismatched.statusCode).toBe(502);
    expect(mismatched.body).toContain("(userinfo_subject_mismatch)");
  });

  test("an SSO-required organization's sign-in page keeps the password form beside its IdP", async () => {
    const { handle } = await federatedHandler([providerRecord(REQUIRED), verifiedDomainRecord()]);
    const page = await fakeBrowser(handle, IDENTITY_ISSUER).open(
      `/sign-in?organization=${ORGANIZATION}`,
    );
    expect(
      ["#sign-in", "#password-field", "#sso"].map((selector) => page.element(selector).hidden),
    ).toEqual([false, false, false]);
    expect(page.element("#sso-continue").textContent).toBe(
      "Continue with Acme Okta (acme.okta.com)",
    );
  });

  test("the emailed link names the organization and IdP and connects only on a click in the signing-in browser", async () => {
    const { fixture, handle } = await federatedHandler([
      providerRecord(),
      verifiedDomainRecord(),
      organizationRecord(),
      ...existingPrincipal("bob@acme.com"),
    ]);
    const linkStatuses = () =>
      fixture.harness.memory
        .of("identity-federation-link-request")
        .map((request) => request.data.status);
    const signingIn = fakeBrowser(handle, IDENTITY_ISSUER);
    const started = await signingIn.request(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION }),
    );
    const binding = bindingToken(started.multiValueHeaders?.["Set-Cookie"]);
    const sent = await signingIn.request(
      get(
        `/oauth2/federation/callback/${ORGANIZATION}`,
        fixture.identityProviderRedirect(startLocation(started), {
          email: "bob@acme.com",
          subject: "00u-bob",
        }),
      ),
    );
    expect([sent.statusCode, /<p>([^<]+)<\/p>/u.exec(sent.body)?.[1]]).toEqual([
      200,
      "We sent a confirmation link to b***@acme.com. Open it in this browser to connect your account, then sign in again.",
    ]);
    expect(sent.multiValueHeaders?.["Set-Cookie"]).toEqual([
      `__Host-dpl_federation=${binding}; Path=/; Max-Age=1800; SameSite=Lax; Secure; HttpOnly`,
    ]);

    const page = await signingIn.open("/federation/confirm-link#token=token-1");
    expect(signingIn.requests).toEqual(["POST /v1/auth/federation/link-request"]);
    expect(page.location.hash).toBe("");
    expect([
      page.element("#link-provider").textContent,
      page.element("#link-organization").textContent,
    ]).toEqual(["Acme Okta (acme.okta.com)", "Acme"]);
    expect(linkStatuses()).toEqual(["pending"]);

    const elsewhere = await fakeBrowser(handle, IDENTITY_ISSUER).open(
      "/federation/confirm-link#token=token-1",
    );
    await elsewhere.click("#link-confirm");
    expect(elsewhere.element(".message").textContent).toBe(
      "Open this link in the browser where you signed in with your identity provider.",
    );
    expect(linkStatuses()).toEqual(["pending"]);
    expect(fixture.harness.memory.of("principal-identity")).toEqual([]);

    await page.click("#link-confirm");
    expect(signingIn.requests).toEqual([
      "POST /v1/auth/federation/link-request",
      "POST /v1/auth/federation/confirm-link",
    ]);
    expect([page.element(".message").textContent, page.element("#link-continue").href]).toEqual([
      "Your account is connected. Sign in to continue.",
      `/sign-in?organization=${ORGANIZATION}`,
    ]);
    expect(linkStatuses()).toEqual(["consumed"]);
    expect(
      fixture.harness.memory.of("principal-identity").map((link) => link.data.subject),
    ).toEqual(["00u-bob"]);
    expect(signingIn.cookies.has("__Host-dpl_federation")).toBe(false);

    const reused = await signingIn.request(
      post("/v1/auth/federation/confirm-link", { token: "token-1" }),
    );
    expect([reused.statusCode, JSON.parse(reused.body)]).toEqual([
      400,
      {
        error: "invalid_request",
        error_description: "This confirmation link is invalid or has expired.",
      },
    ]);
  });
});
