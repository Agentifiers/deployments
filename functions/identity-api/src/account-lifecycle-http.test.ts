import { describe, expect, test } from "bun:test";
import type { AccountAuthenticator } from "./account-authentication.ts";
import { ADA, ADA_EMAIL, PASSWORD, accountLifecycleHarness } from "./account-lifecycle.fixture.ts";
import { makeIdentityHttpHandler } from "./http.ts";

const ISSUER = "https://auth.deployments.ai";
const CSRF = "csrf-value";

async function scenario() {
  const h = await accountLifecycleHarness();
  /** Ada's console token for as long as her account is live; the token checks are covered elsewhere. */
  const accountAuthenticator: AccountAuthenticator = async (authorization) =>
    authorization === "Bearer ada" &&
    (await h.repository.principalForId(ADA))?.data.status === "active"
      ? { principal: { id: ADA }, sessionId: ADA }
      : undefined;
  const handler = makeIdentityHttpHandler(h.application, {
    accountAuthenticator,
    applicationOrigin: "https://app.deployments.ai",
    issuer: ISSUER,
    publicResponseMinimumMs: 0,
    queuePublicEmailRequest: async () => undefined,
    registrationEnabled: false,
    secureCookies: true,
    uiOrigin: ISSUER,
  });
  const account = async (method: string, path: string, body?: unknown) => {
    const response = await handler({
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { authorization: "Bearer ada", "content-type": "application/json" },
      httpMethod: method,
      path,
    });
    return {
      body: response.body ? JSON.parse(response.body) : undefined,
      status: response.statusCode,
    };
  };
  const link = async (path: string, token: string, guarded = true) => {
    const response = await handler({
      body: JSON.stringify({ token }),
      headers: {
        "content-type": "application/json",
        ...(guarded
          ? { cookie: `__Host-dpl_csrf=${CSRF}`, origin: ISSUER, "x-csrf-token": CSRF }
          : {}),
      },
      httpMethod: "POST",
      path,
    });
    return { body: JSON.parse(response.body), status: response.statusCode };
  };
  return { ...h, account, handler, link };
}

describe("account lifecycle routes", () => {
  test("the profile shows the email, what can change it, and whether deletion is allowed", async () => {
    const { account } = await scenario();

    expect(await account("GET", "/v1/account/profile")).toEqual({
      body: {
        deletion: { kind: "allowed", leaves: [] },
        email: ADA_EMAIL,
        emailChange: { kind: "available" },
      },
      status: 200,
    });
  });

  test("an email change runs from the console request through the emailed link", async () => {
    const { account, lastToken, link } = await scenario();

    const requested = await account("POST", "/v1/account/email-change", {
      newEmail: "ada@new.example",
      password: PASSWORD,
    });
    expect(requested).toEqual({
      body: { email: "ada@new.example", expiresAt: "2026-07-28T02:00:00.000Z" },
      status: 200,
    });
    const token = await lastToken("email-change-verify");

    expect((await link("/v1/auth/email-change/confirm", token, false)).status).toBe(403);
    expect(await link("/v1/auth/email-change/confirm", token)).toEqual({
      body: { email: "ada@new.example" },
      status: 200,
    });
    expect(await link("/v1/auth/email-change/report", await lastToken("email-changed"))).toEqual({
      body: { emailRestored: true },
      status: 200,
    });
    expect(await link("/v1/auth/email-change/confirm", token)).toEqual({
      body: { error: "invalid_grant", error_description: "This link is invalid or has expired." },
      status: 400,
    });
  });

  test("a pending change can be cancelled, twice without harm", async () => {
    const { account } = await scenario();
    await account("POST", "/v1/account/email-change", {
      newEmail: "ada@new.example",
      password: PASSWORD,
    });

    expect((await account("DELETE", "/v1/account/email-change")).status).toBe(204);
    expect((await account("DELETE", "/v1/account/email-change")).status).toBe(204);
    expect((await account("GET", "/v1/account/profile")).body.pendingEmail).toBeUndefined();
  });

  test("deletion needs the password, then the token stops working", async () => {
    const { account } = await scenario();

    expect(await account("POST", "/v1/account/delete", {})).toEqual({
      body: { error: "invalid_request", error_description: "password is required." },
      status: 400,
    });
    expect((await account("POST", "/v1/account/delete", { password: PASSWORD })).status).toBe(204);
    expect((await account("GET", "/v1/account/profile")).status).toBe(401);
  });

  test("the link pages carry the token only in the fragment and act only on a button press", async () => {
    const { handler } = await scenario();

    for (const path of ["/email-change/confirm", "/email-change/report"]) {
      const response = await handler({ headers: {}, httpMethod: "GET", path });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("location.hash.startsWith('#token=')");
      expect(response.body).toContain("history.replaceState");
      expect(response.body).toContain("button.addEventListener('click'");
      expect(response.multiValueHeaders?.["Set-Cookie"]?.[0] ?? "").toContain("__Host-dpl_csrf=");
    }
  });
});
