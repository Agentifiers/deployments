import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import type { PlatformRecord } from "@deployments-ai/db";
import { samlServiceProvider } from "@deployments-ai/identity/saml";
import { NOW, responseXml, type ResponseOptions } from "@deployments-ai/identity/saml-testing";
import { samlProviderRecord } from "../../../packages/db/src/identity-federation/saml-test-support.ts";
import {
  ORGANIZATION,
  START,
  existingPrincipal,
  organizationRecord,
  providerRecord,
  verifiedDomainRecord,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import { fakeBrowser } from "./fake-browser.fixture.ts";
import { APPLICATION_ORIGIN, IDENTITY_ISSUER, federationFixture } from "./federation.fixture.ts";
import { makeIdentityHttpHandler, type RestApiEvent, type RestApiResponse } from "./http.ts";

const CSRF = "csrf-value";
const ACS = `/saml/${ORGANIZATION}/acs`;
const RESUME = "/v1/auth/federation/unsolicited/resume";
const CONFIRM = "/v1/auth/federation/unsolicited/confirm";
const SERVICE_PROVIDER = samlServiceProvider({
  issuer: IDENTITY_ISSUER,
  organizationId: ORGANIZATION,
});
const CLEAR_BINDING = "__Host-dpl_federation=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly";
const CONTINUATION = "/oauth2/authorize?client_id=deployments-apps&state=app-state";

async function samlHandler(records: readonly PlatformRecord[]) {
  const fixture = await federationFixture(records);
  fixture.advance(NOW.getTime() - Date.parse(START));
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
    undefined,
    fixture.federation,
  );
  return { fixture, handle };
}

function post(path: string, body: unknown, options = { csrf: true }): RestApiEvent {
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

/** What the IdP signs for this organization's SP; Alice by default. */
function idpResponse(options: ResponseOptions = {}) {
  return responseXml({
    audience: SERVICE_PROVIDER.entityId,
    destination: SERVICE_PROVIDER.acsUrl,
    nameId: "alice@acme.com",
    recipient: SERVICE_PROVIDER.acsUrl,
    ...options,
  });
}

/** The IdP's auto-submitted HTTP-POST form, landing on the ACS. */
function acsPost(xml: string, form: { relayState?: string; cookie?: string } = {}): RestApiEvent {
  return {
    body: new URLSearchParams({
      SAMLResponse: Buffer.from(xml).toString("base64"),
      ...(form.relayState === undefined ? {} : { RelayState: form.relayState }),
    }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(form.cookie ? { cookie: form.cookie } : {}),
    },
    httpMethod: "POST",
    path: ACS,
  };
}

/** Reads the HTTP-Redirect AuthnRequest the way an IdP does: inflate, then take its ID. */
function authnRequest(started: RestApiResponse) {
  const body: unknown = JSON.parse(started.body);
  if (typeof body !== "object" || body === null || !("location" in body)) {
    throw new Error("expected the start response to name the IdP location");
  }
  const location = new URL(String(body.location));
  const xml = inflateRawSync(
    Buffer.from(location.searchParams.get("SAMLRequest") ?? "", "base64"),
  ).toString("utf8");
  return {
    id: /\bID="([^"]+)"/u.exec(xml)?.[1] ?? "",
    relayState: location.searchParams.get("RelayState") ?? "",
    singleSignOn: `${location.origin}${location.pathname}`,
  };
}

function messageOf(response: RestApiResponse) {
  return [response.statusCode, /<p>([^<]+)<\/p>/u.exec(response.body)?.[1]];
}

function errorOf(response: RestApiResponse) {
  return [response.statusCode, JSON.parse(response.body)];
}

function setCookies(response: RestApiResponse) {
  return response.multiValueHeaders?.["Set-Cookie"];
}

const ALICE_RECORDS = [samlProviderRecord(), verifiedDomainRecord(), organizationRecord()];

describe("SAML HTTP", () => {
  test("a sign-in started here completes at the ACS with a 303 to where it began", async () => {
    const { fixture, handle } = await samlHandler(ALICE_RECORDS);
    const browser = fakeBrowser(handle, IDENTITY_ISSUER);

    const started = await browser.request(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION, returnTo: CONTINUATION }),
    );
    const request = authnRequest(started);
    const binding = browser.cookies.get("__Host-dpl_federation");
    expect([request.singleSignOn, setCookies(started)]).toEqual([
      "https://idp.example.test/sso",
      [`__Host-dpl_federation=${binding}; Path=/; Max-Age=600; SameSite=None; Secure; HttpOnly`],
    ]);

    const posted = acsPost(idpResponse({ inResponseTo: request.id }), {
      relayState: request.relayState,
    });
    const signedIn = await browser.request(posted);
    expect([signedIn.statusCode, signedIn.headers.Location, setCookies(signedIn)]).toEqual([
      303,
      CONTINUATION,
      [
        CLEAR_BINDING,
        "__Host-dpl_identity=token-1; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly",
      ],
    ]);
    expect(browser.cookies.has("__Host-dpl_federation")).toBe(false);
    expect(fixture.harness.memory.of("principal").map((p) => p.data.primaryEmail)).toEqual([
      "alice@acme.com",
    ]);

    const replayed = await handle(
      acsPost(idpResponse({ inResponseTo: request.id }), {
        cookie: `__Host-dpl_federation=${binding}`,
      }),
    );
    expect(messageOf(replayed)).toEqual([
      400,
      "This sign-in expired or was already used. Start again from the sign-in page.",
    ]);
  });

  test("a response to a request is never treated as IdP-initiated when the binding cookie is missing", async () => {
    const { fixture, handle } = await samlHandler(ALICE_RECORDS);
    const started = await handle(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION }),
    );

    const response = await handle(acsPost(idpResponse({ inResponseTo: authnRequest(started).id })));
    expect(messageOf(response)).toEqual([
      400,
      "This sign-in expired or was started in another browser. Start again from the sign-in page.",
    ]);
    expect(fixture.harness.memory.of("identity-federation-unsolicited-sign-in")).toEqual([]);
    expect(
      fixture.harness.memory.of("identity-federation-transaction").map((t) => t.data.status),
    ).toEqual(["pending"]);
  });

  test("a forged or refused ACS post leaves the binding of a sign-in in progress", async () => {
    const { handle } = await samlHandler(ALICE_RECORDS);
    const browser = fakeBrowser(handle, IDENTITY_ISSUER);
    const started = await browser.request(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION, returnTo: CONTINUATION }),
    );
    const request = authnRequest(started);

    const refused = [
      await browser.request(acsPost("<not-a-saml-response/>")),
      await browser.request({ ...acsPost(idpResponse()), path: "/saml/not-an-id/acs" }),
      await browser.request(
        acsPost(idpResponse({ assertionId: "_stale", issueInstantOffsetMs: -361_000 })),
      ),
    ];
    expect(refused.map((response) => [response.statusCode, setCookies(response)])).toEqual([
      [502, undefined],
      [403, undefined],
      [400, undefined],
    ]);

    const signedIn = await browser.request(acsPost(idpResponse({ inResponseTo: request.id })));
    expect([signedIn.statusCode, signedIn.headers.Location]).toEqual([303, CONTINUATION]);
  });

  test("a forced login accepts a fresh AuthnInstant and refuses one older than the start minus 60 s", async () => {
    const { fixture, handle } = await samlHandler(ALICE_RECORDS);
    const returnTo = `${CONTINUATION}&prompt=login`;
    const forcedSignIn = async (assertionId: string) => {
      const browser = fakeBrowser(handle, IDENTITY_ISSUER);
      const started = await browser.request(
        post("/v1/auth/federation/start", { organizationId: ORGANIZATION, returnTo }),
      );
      return browser.request(
        acsPost(idpResponse({ assertionId, inResponseTo: authnRequest(started).id })),
      );
    };

    const fresh = await forcedSignIn("_authenticated-just-now");
    fixture.advance(120_000);
    const stale = await forcedSignIn("_authenticated-before-start");
    expect([fresh.statusCode, fresh.headers.Location]).toEqual([303, returnTo]);
    expect(messageOf(stale)).toEqual([
      400,
      "Your identity provider did not ask you to sign in again as required. Start again from the sign-in page.",
    ]);
  });

  test("an IdP-initiated response is refused when disabled, stale or replayed", async () => {
    const disabled = await samlHandler([
      samlProviderRecord({ unsolicitedSignIn: "disabled" }),
      verifiedDomainRecord(),
    ]);
    const { fixture, handle } = await samlHandler(ALICE_RECORDS);

    const refused = [
      await disabled.handle(acsPost(idpResponse())),
      await handle(acsPost(idpResponse({ assertionId: "_stale", issueInstantOffsetMs: -361_000 }))),
      await handle(acsPost(idpResponse({ assertionId: "_once" }))),
      await handle(acsPost(idpResponse({ assertionId: "_once" }))),
    ];
    expect(refused.map(messageOf)).toEqual([
      [
        403,
        "Your organization does not allow signing in from the identity provider&#39;s app list. Start from the sign-in page.",
      ],
      [400, "This sign-in response is too old. Start again from your identity provider."],
      [303, undefined],
      [400, "This sign-in response was already used. Start again from your identity provider."],
    ]);
    expect(refused[2]?.headers.Location).toBe("/federation/confirm-sign-in#token=token-1");
    expect(
      fixture.harness.memory
        .of("identity-federation-unsolicited-sign-in")
        .map((pending) => pending.data.status),
    ).toEqual(["pending"]);
  });

  test("the confirmation page signs in silently when the browser is already the linked user", async () => {
    const { handle } = await samlHandler(ALICE_RECORDS);
    const browser = fakeBrowser(handle, IDENTITY_ISSUER);
    const started = await browser.request(
      post("/v1/auth/federation/start", { organizationId: ORGANIZATION }),
    );
    await browser.request(acsPost(idpResponse({ inResponseTo: authnRequest(started).id })));
    expect(browser.cookies.get("__Host-dpl_identity")).toBe("token-1");

    const unsolicited = await browser.request(
      acsPost(idpResponse({ assertionId: "_from-app-list" }), { relayState: CONTINUATION }),
    );
    const page = await browser.open(unsolicited.headers.Location!);
    expect([browser.requests, page.location.hash, page.location.href]).toEqual([
      [`POST ${RESUME}`],
      "",
      CONTINUATION,
    ]);
    expect(page.element("#confirm").hidden).toBe(true);
    expect(browser.cookies.get("__Host-dpl_identity")).toBe("token-3");
  });

  test("another browser is shown who is signing in and signs in only on Continue", async () => {
    const { fixture, handle } = await samlHandler(ALICE_RECORDS);
    const browser = fakeBrowser(handle, IDENTITY_ISSUER);
    const unsolicited = await browser.request(acsPost(idpResponse()));
    expect([unsolicited.statusCode, setCookies(unsolicited)]).toEqual([303, undefined]);

    const page = await browser.open(unsolicited.headers.Location!);
    expect([
      page.element("#confirm").hidden,
      page.element("#confirm-organization").textContent,
      page.element("#confirm-provider").textContent,
      page.element("#confirm-email").textContent,
    ]).toEqual([false, "Acme", "Acme SAML (idp.example.test)", "alice@acme.com"]);
    expect(fixture.harness.memory.of("principal")).toEqual([]);

    await page.click("#confirm-continue");
    expect([browser.requests, page.location.href]).toEqual([
      [`POST ${RESUME}`, `POST ${CONFIRM}`],
      APPLICATION_ORIGIN,
    ]);
    expect(browser.cookies.get("__Host-dpl_identity")).toBe("token-2");
    expect(fixture.harness.memory.of("principal").map((p) => p.data.primaryEmail)).toEqual([
      "alice@acme.com",
    ]);
  });

  test("resume and confirm sit behind the origin and CSRF guard", async () => {
    const { fixture, handle } = await samlHandler(ALICE_RECORDS);
    await handle(acsPost(idpResponse()));

    const guarded = await Promise.all(
      [RESUME, CONFIRM].map((path) => handle(post(path, { token: "token-1" }, { csrf: false }))),
    );
    expect(guarded.map(errorOf)).toEqual([
      [403, { error: "invalid_request" }],
      [403, { error: "invalid_request" }],
    ]);
    const unknown = await handle(post(CONFIRM, { token: "token-404" }));
    expect(errorOf(unknown)).toEqual([
      400,
      {
        error: "invalid_request",
        error_description: "This sign-in link is invalid or has expired.",
      },
    ]);
    expect(
      fixture.harness.memory
        .of("identity-federation-unsolicited-sign-in")
        .map((pending) => pending.data.status),
    ).toEqual(["pending"]);
  });

  test("an IdP-initiated RelayState is honored only as an /oauth2/authorize continuation", async () => {
    const { handle } = await samlHandler(ALICE_RECORDS);
    const confirmedLocation = async (assertionId: string, relayState: string) => {
      const posted = await handle(acsPost(idpResponse({ assertionId }), { relayState }));
      const token = posted.headers.Location!.split("#token=")[1];
      const confirmed = await handle(post(CONFIRM, { token }));
      return JSON.parse(confirmed.body).location;
    };

    expect([
      await confirmedLocation("_unsafe", "https://evil.example/steal"),
      await confirmedLocation("_safe", CONTINUATION),
    ]).toEqual([APPLICATION_ORIGIN, CONTINUATION]);
  });

  test("only the SAML start binding is sent cross-site; OIDC and mailbox bindings stay Lax", async () => {
    const mailboxRecords = [...ALICE_RECORDS, ...existingPrincipal("bob@acme.com")];
    const saml = await samlHandler(mailboxRecords);
    const oidc = await samlHandler([providerRecord(), verifiedDomainRecord()]);
    const start = post("/v1/auth/federation/start", { organizationId: ORGANIZATION });

    const oidcStart = await oidc.handle(start);
    const samlStart = await saml.handle(start);
    const binding = (response: RestApiResponse) =>
      /^__Host-dpl_federation=([^;]+);/u.exec(setCookies(response)?.[0] ?? "")?.[1] ?? "";
    const solicitedMailbox = await saml.handle(
      acsPost(idpResponse({ inResponseTo: authnRequest(samlStart).id, nameId: "bob@acme.com" }), {
        cookie: `__Host-dpl_federation=${binding(samlStart)}`,
      }),
    );
    const unsolicited = await saml.handle(
      acsPost(idpResponse({ assertionId: "_bob-app-list", nameId: "bob@acme.com" })),
    );
    const confirmedMailbox = await saml.handle(
      post(CONFIRM, { token: unsolicited.headers.Location!.split("#token=")[1] }),
    );

    expect(
      [oidcStart, samlStart, solicitedMailbox, confirmedMailbox].map((response) =>
        setCookies(response)?.map((value) => value.replace(/=[^;]+;/u, "=…;")),
      ),
    ).toEqual([
      ["__Host-dpl_federation=…; Path=/; Max-Age=600; SameSite=Lax; Secure; HttpOnly"],
      ["__Host-dpl_federation=…; Path=/; Max-Age=600; SameSite=None; Secure; HttpOnly"],
      ["__Host-dpl_federation=…; Path=/; Max-Age=1800; SameSite=Lax; Secure; HttpOnly"],
      ["__Host-dpl_federation=…; Path=/; Max-Age=1800; SameSite=Lax; Secure; HttpOnly"],
    ]);
    expect([messageOf(solicitedMailbox), JSON.parse(confirmedMailbox.body)]).toEqual([
      [
        200,
        "We sent a confirmation link to b***@acme.com. Open it in this browser to connect your account, then sign in again.",
      ],
      { kind: "mailbox-confirmation-sent", maskedEmail: "b***@acme.com" },
    ]);
  });

  test("an ACS form over 128 KiB is refused before it is parsed", async () => {
    const { fixture, handle } = await samlHandler(ALICE_RECORDS);
    const oversized = await handle({
      ...acsPost(idpResponse()),
      body: `SAMLResponse=${"A".repeat(128 * 1_024)}`,
    });
    expect(errorOf(oversized)).toEqual([413, { error: "invalid_request" }]);
    expect(fixture.harness.memory.of("identity-federation-unsolicited-sign-in")).toEqual([]);
  });

  test("a URN entity ID names the provider on the sign-in and confirmation pages", async () => {
    const issuer = "urn:acme:idp";
    const { handle } = await samlHandler([
      samlProviderRecord({ issuer }),
      verifiedDomainRecord(),
      organizationRecord(),
    ]);
    const browser = fakeBrowser(handle, IDENTITY_ISSUER);

    const signIn = await browser.open(`/sign-in?organization=${ORGANIZATION}`);
    const unsolicited = await browser.request(acsPost(idpResponse({ issuer })));
    const confirm = await browser.open(unsolicited.headers.Location!);
    expect([
      signIn.element("#sso-continue").textContent,
      confirm.element("#confirm-provider").textContent,
    ]).toEqual(["Continue with Acme SAML (urn:acme:idp)", "Acme SAML (urn:acme:idp)"]);
  });

  test("the metadata route publishes the SP entity ID and ACS URL", async () => {
    const { handle } = await samlHandler([]);
    const metadata = await handle({ httpMethod: "GET", path: `/saml/${ORGANIZATION}/metadata` });
    const unknown = await handle({ httpMethod: "GET", path: "/saml/not-an-id/metadata" });

    expect([metadata.statusCode, metadata.headers["Content-Type"], unknown.statusCode]).toEqual([
      200,
      "application/samlmetadata+xml",
      404,
    ]);
    expect(metadata.body).toContain(
      `entityID="https://auth.deployments.ai/saml/01ARZ3NDEKTSV4RRFFQ69G5FC0"`,
    );
    expect(metadata.body).toContain(
      `Location="https://auth.deployments.ai/saml/01ARZ3NDEKTSV4RRFFQ69G5FC0/acs"`,
    );
  });
});
