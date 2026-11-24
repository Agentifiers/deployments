import { describe, expect, mock, test } from "bun:test";
import { IdentityError, sha256 } from "@deployments-ai/identity";
import type { IdentityApplication } from "./application.ts";
import type { DeviceApplication } from "./device-application.ts";
import { makeIdentityHttpHandler } from "./http.ts";
import type { OAuthApplication } from "./oauth-application.ts";
import type { JwtSigner } from "./signer.ts";

const config = {
  applicationOrigin: "https://app.deployments.ai",
  issuer: "https://auth.deployments.ai",
  publicResponseMinimumMs: 0,
  queuePublicEmailRequest: async () => undefined,
  registrationEnabled: true,
  secureCookies: true,
  uiOrigin: "https://auth.deployments.ai",
};

const browserSession = {
  authenticationTime: "2026-07-28T00:00:00.000Z",
  principal: { id: "01K00000000000000000000000" },
  sessionId: "01K00000000000000000000001",
};

function fixtures(authenticated: boolean) {
  const authorize = mock(async (_input: unknown) =>
    Promise.resolve("http://127.0.0.1:48123/callback?code=issued"),
  );
  const beginReauthentication = mock(async (_input: unknown) => "reauthentication-token");
  const beginAuthorizationInteraction = mock(async (_input: unknown) => "authorization-handle");
  const claim = mock(async () => ({
    clientId: "deployments-cli",
    requestedScopes: ["openid", "offline_access"],
    userCode: "ABCD-EFGH",
  }));
  const decide = mock(async () => undefined);
  const revokeRefreshToken = mock(async (_input: unknown) => undefined);
  const confirmAuthorizationInteraction = mock(async (_input: unknown) =>
    Promise.resolve("http://127.0.0.1:48123/callback?code=issued"),
  );
  const signOut = mock(async (_token: string) => undefined);
  const validateReauthentication = mock(async (_input: unknown) => undefined);
  const client = mock(async () => ({
    data: {
      allowedScopes: ["offline_access", "openid", "organizations:read", "organizations:write"],
      clientId: "deployments-cli",
      grantTypes: ["authorization_code", "refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      requirePkce: true,
      responseTypes: ["code"],
      status: "active",
      tokenEndpointAuthMethod: "none",
      type: "public",
    },
  }));
  const application = {
    session: mock(async () => (authenticated ? browserSession : undefined)),
    signOut,
  } as unknown as IdentityApplication;
  const protocol = {
    device: { claim, decide } as unknown as DeviceApplication,
    oauth: {
      authorize,
      beginAuthorizationInteraction,
      beginReauthentication,
      client,
      confirmAuthorizationInteraction,
      revokeRefreshToken,
      validateReauthentication,
    } as unknown as OAuthApplication,
    signer: {} as JwtSigner,
  };
  return {
    application,
    authorize,
    beginAuthorizationInteraction,
    beginReauthentication,
    claim,
    client,
    confirmAuthorizationInteraction,
    decide,
    protocol,
    revokeRefreshToken,
    signOut,
    validateReauthentication,
  };
}

const authorizationParameters = {
  client_id: "deployments-cli",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  nonce: "browser-nonce",
  redirect_uri: "http://127.0.0.1:48123/callback",
  response_type: "code",
  scope: "openid offline_access",
  state: "state-value",
};

describe("identity HTTP interactions", () => {
  test("redirects a signed-out authorization request through sign-in without losing it", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: authorizationParameters,
    });

    expect(response.statusCode).toBe(302);
    const signIn = new URL(response.headers.Location!);
    expect(signIn.pathname).toBe("/sign-in");
    const continuation = new URL(
      signIn.searchParams.get("return_to")!,
      "https://auth.deployments.ai",
    );
    expect(continuation.pathname).toBe("/oauth2/authorize");
    expect(continuation.searchParams.get("code_challenge")).toBe("a".repeat(43));
    expect(continuation.searchParams.get("nonce")).toBe("browser-nonce");
    expect(continuation.searchParams.get("state")).toBe("state-value");
  });

  test("returns prompt=none to the client instead of showing sign-in", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: { ...authorizationParameters, prompt: "none" },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.Location!);
    expect(location.origin + location.pathname).toBe("http://127.0.0.1:48123/callback");
    expect(location.searchParams.get("error")).toBe("login_required");
    expect(location.searchParams.get("state")).toBe("state-value");
  });

  test("forces prompt=login through sign-in once without retaining the prompt", async () => {
    const fixture = fixtures(true);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      headers: { cookie: "__Host-dpl_identity=session-token" },
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: { ...authorizationParameters, prompt: "login" },
    });

    expect(response.statusCode).toBe(302);
    const signIn = new URL(response.headers.Location!);
    expect(signIn.pathname).toBe("/sign-in");
    const continuation = new URL(
      signIn.searchParams.get("return_to")!,
      "https://auth.deployments.ai",
    );
    expect(continuation.searchParams.has("prompt")).toBeFalse();
    expect(continuation.searchParams.get("reauthentication_token")).toBe("reauthentication-token");
    expect(fixture.beginReauthentication).toHaveBeenCalledTimes(1);
    expect(fixture.beginReauthentication.mock.calls[0]?.[0]).toMatchObject({
      previousSessionId: browserSession.sessionId,
    });
    expect(fixture.authorize).not.toHaveBeenCalled();
  });

  test("validates a reauthentication continuation before showing CLI consent", async () => {
    const fixture = fixtures(true);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      headers: { cookie: "__Host-dpl_identity=fresh-session-token" },
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: {
        ...authorizationParameters,
        reauthentication_token: "reauthentication-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Authorize Deployments CLI?");
    expect(fixture.beginAuthorizationInteraction).toHaveBeenCalledTimes(1);
    expect(fixture.beginAuthorizationInteraction.mock.calls[0]?.[0]).toMatchObject({
      reauthenticationToken: "reauthentication-token",
    });
  });

  test("requires a CSRF-protected POST before issuing a CLI authorization code", async () => {
    const fixture = fixtures(true);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const interaction = await handler({
      headers: { cookie: "__Host-dpl_identity=session-token" },
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: { ...authorizationParameters, confirm: "1" },
    });

    expect(interaction.statusCode).toBe(200);
    expect(interaction.body).toContain("Authorize Deployments CLI?");
    expect(interaction.body).toContain("<li><code>openid</code></li>");
    expect(interaction.body).toContain("<li><code>offline_access</code></li>");
    expect(interaction.body).toContain('const requestHandle="authorization-handle"');
    expect(interaction.body).not.toContain("state-value");
    expect(fixture.beginAuthorizationInteraction).toHaveBeenCalledTimes(1);
    expect(fixture.authorize).not.toHaveBeenCalled();

    const csrfCookie = interaction.multiValueHeaders?.["Set-Cookie"]?.[0];
    const csrf = csrfCookie?.match(/^__Host-dpl_csrf=([^;]+)/u)?.[1];
    expect(csrf).toBeTruthy();
    const approved = await handler({
      body: JSON.stringify({ request_handle: "authorization-handle" }),
      headers: {
        "content-type": "application/json",
        cookie: `__Host-dpl_identity=session-token; __Host-dpl_csrf=${csrf}`,
        origin: config.uiOrigin,
        "x-csrf-token": csrf,
      },
      httpMethod: "POST",
      path: "/v1/oauth/authorize",
    });

    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.body)).toEqual({
      redirect: "http://127.0.0.1:48123/callback?code=issued",
    });
    expect(fixture.confirmAuthorizationInteraction).toHaveBeenCalledTimes(1);
    expect(fixture.confirmAuthorizationInteraction.mock.calls[0]?.[0]).toMatchObject({
      clientId: "deployments-cli",
      requestHandle: "authorization-handle",
    });
  });

  test("validates CLI scopes before presenting consent", async () => {
    const fixture = fixtures(true);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      headers: { cookie: "__Host-dpl_identity=session-token" },
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: { ...authorizationParameters, scope: "openid super-admin" },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.Location!);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(response.body).not.toContain("Authorize CLI");
  });

  test("sends the old device page to the console's device page, carrying a query code", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const bare = await handler({ httpMethod: "GET", path: "/device" });
    const withCode = await handler({
      httpMethod: "GET",
      path: "/device",
      queryStringParameters: { code: "ABCD-EFGH" },
    });

    expect([bare.statusCode, bare.headers.Location]).toEqual([
      302,
      "https://app.deployments.ai/device",
    ]);
    expect([withCode.statusCode, withCode.headers.Location]).toEqual([
      302,
      "https://app.deployments.ai/device?code=ABCD-EFGH",
    ]);
  });

  test("keeps the cookie device claim and approval and drops the cookie denial", async () => {
    const fixture = fixtures(true);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const post = (path: string) =>
      handler({
        body: JSON.stringify({ userCode: "ABCD-EFGH" }),
        headers: {
          "content-type": "application/json",
          cookie: "__Host-dpl_identity=session-token; __Host-dpl_csrf=csrf",
          origin: "https://auth.deployments.ai",
          "x-csrf-token": "csrf",
        },
        httpMethod: "POST",
        path,
      });

    expect((await post("/v1/device/claim")).statusCode).toBe(200);
    expect((await post("/v1/device/approve")).statusCode).toBe(204);
    expect((await post("/v1/device/deny")).statusCode).toBe(404);
    expect(fixture.decide).toHaveBeenCalledTimes(1);
  });

  test("selects account creation when navigating directly to sign-up", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const page = await handler({ httpMethod: "GET", path: "/sign-up" });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('const initialMode="sign-up"');
    expect(page.body).toContain('const applicationOrigin="https://app.deployments.ai"');
  });

  test("hides and rejects registration while the rollout gate is disabled", async () => {
    const fixture = fixtures(false);
    const signUp = mock(async () => undefined);
    fixture.application.signUp = signUp;
    const handler = makeIdentityHttpHandler(
      fixture.application,
      { ...config, registrationEnabled: false },
      fixture.protocol,
    );

    const signInPage = await handler({ httpMethod: "GET", path: "/sign-in" });
    expect(signInPage.statusCode).toBe(200);
    expect(signInPage.body).not.toContain("Create account");
    expect(signInPage.body).not.toContain('form id="sign-up"');
    expect((await handler({ httpMethod: "GET", path: "/sign-up" })).statusCode).toBe(404);

    const response = await handler({
      body: JSON.stringify({ email: "user@example.com" }),
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/sign-up",
    });
    expect(response.statusCode).toBe(403);
    expect(signUp).not.toHaveBeenCalled();
  });

  test("serves password recovery UI and accepts a generic forgot-password request", async () => {
    const fixture = fixtures(false);
    const queuePublicEmailRequest = mock(async () => undefined);
    const handler = makeIdentityHttpHandler(
      fixture.application,
      { ...config, queuePublicEmailRequest },
      fixture.protocol,
    );
    const page = await handler({ httpMethod: "GET", path: "/reset-password" });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('form id="forgot"');
    expect(page.body).toContain('form id="reset"');
    expect(page.body).toContain("hash.startsWith('reset=')");

    const response = await handler({
      body: JSON.stringify({ email: "user@example.com" }),
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/password/forgot",
      requestContext: { identity: { sourceIp: "203.0.113.42" } },
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: true });
    expect(queuePublicEmailRequest).toHaveBeenCalledWith({
      email: "user@example.com",
      operation: "password-recovery",
      sourcePrefixHash: sha256("203.0.113"),
    });
  });

  test("routes reset-password submissions to the application", async () => {
    const fixture = fixtures(false);
    const resetPassword = mock(async () => undefined);
    fixture.application.resetPassword = resetPassword;
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      body: JSON.stringify({ password: "new correct horse battery staple", token: "reset-token" }),
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/password/reset",
    });

    expect(response.statusCode).toBe(200);
    expect(resetPassword).toHaveBeenCalledWith({
      password: "new correct horse battery staple",
      token: "reset-token",
    });
  });

  test("requires a session for password changes and clears it after success", async () => {
    const signedOut = fixtures(false);
    const signedOutChange = mock(async () => undefined);
    signedOut.application.changePassword = signedOutChange;
    const signedOutHandler = makeIdentityHttpHandler(
      signedOut.application,
      config,
      signedOut.protocol,
    );
    const request = {
      body: JSON.stringify({
        currentPassword: "correct horse battery staple",
        password: "new correct horse battery staple",
      }),
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/password/change",
    } as const;

    const denied = await signedOutHandler(request);
    expect(denied.statusCode).toBe(401);
    expect(signedOutChange).not.toHaveBeenCalled();

    const signedIn = fixtures(true);
    const changePassword = mock(async () => undefined);
    signedIn.application.changePassword = changePassword;
    const signedInHandler = makeIdentityHttpHandler(
      signedIn.application,
      config,
      signedIn.protocol,
    );
    const changed = await signedInHandler({
      ...request,
      headers: {
        ...request.headers,
        cookie: "__Host-dpl_identity=session-token; __Host-dpl_csrf=csrf-token",
      },
    });

    expect(changed.statusCode).toBe(200);
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "correct horse battery staple",
      password: "new correct horse battery staple",
      principalId: browserSession.principal.id,
    });
    expect(changed.multiValueHeaders?.["Set-Cookie"]?.[0]).toContain("__Host-dpl_identity=;");
    expect(changed.multiValueHeaders?.["Set-Cookie"]?.[0]).toContain("Max-Age=0");
  });

  test("uses browser-valid unprefixed cookies for local HTTP", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(
      fixture.application,
      { ...config, secureCookies: false },
      fixture.protocol,
    );
    const page = await handler({ httpMethod: "GET", path: "/sign-in" });
    const csrfCookie = page.multiValueHeaders?.["Set-Cookie"]?.[0];

    expect(csrfCookie).toStartWith("dpl_csrf=");
    expect(csrfCookie).not.toContain("__Host-");
    expect(csrfCookie).not.toContain("; Secure");
  });

  test("a second sign-in page keeps the CSRF token the browser already holds", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const held = "k".repeat(43);
    const page = await handler({
      headers: { cookie: `__Host-dpl_csrf=${held}` },
      httpMethod: "GET",
      path: "/sign-in",
    });
    // Another tab or a re-rendered redirect must not invalidate the token an open page uses.
    expect(page.multiValueHeaders?.["Set-Cookie"]?.[0]).toStartWith(`__Host-dpl_csrf=${held};`);
    expect(page.body).toContain(`const csrf="${held}"`);

    const malformed = await handler({
      headers: { cookie: "__Host-dpl_csrf=short" },
      httpMethod: "GET",
      path: "/sign-in",
    });
    expect(malformed.multiValueHeaders?.["Set-Cookie"]?.[0]).not.toContain("=short;");
  });

  test("advertises only implemented optional protocol endpoints", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      httpMethod: "GET",
      path: "/.well-known/openid-configuration",
    });
    const metadata = JSON.parse(response.body) as Record<string, unknown>;

    expect(metadata.revocation_endpoint).toBe("https://auth.deployments.ai/oauth2/revoke");
    expect(metadata.revocation_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
      "none",
    ]);
    expect(metadata.userinfo_endpoint).toBeUndefined();
    expect(metadata.end_session_endpoint).toBeUndefined();
    expect(metadata.scopes_supported).toContain("organizations:write");
  });

  test("revokes refresh tokens through the RFC 7009 endpoint", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      body: new URLSearchParams({
        client_id: "deployments-cli",
        token: "refresh-token",
        token_type_hint: "refresh_token",
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      httpMethod: "POST",
      path: "/oauth2/revoke",
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.revokeRefreshToken).toHaveBeenCalledWith({
      clientId: "deployments-cli",
      refreshToken: "refresh-token",
    });
  });

  test("maps malformed Basic client credentials to invalid_client", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      body: new URLSearchParams({ token: "refresh-token" }).toString(),
      headers: {
        authorization: `Basic ${Buffer.from("deployments-cli:%").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      httpMethod: "POST",
      path: "/oauth2/revoke",
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_client" });
    expect(fixture.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("rejects duplicate OAuth form parameters", async () => {
    const fixture = fixtures(false);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      body: "client_id=deployments-cli&token=first&token=second",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      httpMethod: "POST",
      path: "/oauth2/revoke",
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_request" });
    expect(fixture.revokeRefreshToken).not.toHaveBeenCalled();
  });

  test("revokes and clears only the current browser session", async () => {
    const fixture = fixtures(true);
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);
    const response = await handler({
      body: "{}",
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token; __Host-dpl_identity=session-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/sign-out",
    });

    expect(response.statusCode).toBe(204);
    expect(fixture.signOut).toHaveBeenCalledWith("session-token");
    expect(response.multiValueHeaders?.["Set-Cookie"]?.[0]).toContain("__Host-dpl_identity=;");
    expect(response.multiValueHeaders?.["Set-Cookie"]?.[0]).toContain("Max-Age=0");
  });

  test("applies the public response-time floor to failed sign-ins", async () => {
    const fixture = fixtures(false);
    const signIn = mock(async () => {
      throw new IdentityError("access_denied", "Email or password is incorrect.");
    });
    fixture.application.signIn = signIn;
    const handler = makeIdentityHttpHandler(
      fixture.application,
      { ...config, publicResponseMinimumMs: 25 },
      fixture.protocol,
    );
    const started = performance.now();
    const response = await handler({
      body: JSON.stringify({ email: "unknown@example.com", password: "wrong password value" }),
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/sign-in",
      requestContext: { identity: { sourceIp: "203.0.113.42" } },
    });

    expect(response.statusCode).toBe(400);
    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({ ipPrefixHash: sha256("203.0.113") }),
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });

  test("returns signup handoff failures generically after the public response-time floor", async () => {
    const fixture = fixtures(false);
    const queuePublicEmailRequest = mock(async () => {
      throw new Error("DynamoDB unavailable");
    });
    const handler = makeIdentityHttpHandler(
      fixture.application,
      { ...config, publicResponseMinimumMs: 25, queuePublicEmailRequest },
      fixture.protocol,
    );
    const started = performance.now();
    const response = await handler({
      body: JSON.stringify({ email: "user@example.com" }),
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/sign-up",
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "temporarily_unavailable" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });

  test("returns recovery handoff failures without disclosing the account", async () => {
    const fixture = fixtures(false);
    const queuePublicEmailRequest = mock(async () => {
      throw new Error("KMS unavailable");
    });
    const handler = makeIdentityHttpHandler(
      fixture.application,
      { ...config, publicResponseMinimumMs: 25, queuePublicEmailRequest },
      fixture.protocol,
    );
    const started = performance.now();
    const response = await handler({
      body: JSON.stringify({ email: "registered@example.com" }),
      headers: {
        "content-type": "application/json",
        cookie: "__Host-dpl_csrf=csrf-token",
        origin: config.uiOrigin,
        "x-csrf-token": "csrf-token",
      },
      httpMethod: "POST",
      path: "/v1/auth/password/forgot",
      requestContext: { requestId: "request-123" },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "temporarily_unavailable" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);
  });

  test("redirects authorization errors to a validated client URI with state and issuer", async () => {
    const fixture = fixtures(true);
    fixture.protocol.oauth = {
      authorize: mock(async () => {
        throw new IdentityError("invalid_scope", "The requested scope is not registered.", {
          exposeDescription: true,
        });
      }),
      client: mock(async () => ({
        data: {
          allowedScopes: ["openid"],
          clientId: "web-app",
          grantTypes: ["authorization_code"],
          redirectUris: ["https://app.deployments.ai/callback"],
          requiredScopes: ["openid"],
          requirePkce: true,
          responseTypes: ["code"],
          status: "active",
          tokenEndpointAuthMethod: "none",
          type: "public",
        },
      })),
    } as unknown as OAuthApplication;
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);

    const response = await handler({
      headers: { cookie: "__Host-dpl_identity=session-token" },
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: {
        ...authorizationParameters,
        client_id: "web-app",
        redirect_uri: "https://app.deployments.ai/callback",
        scope: "openid admin",
      },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.Location!);
    expect(location.origin + location.pathname).toBe("https://app.deployments.ai/callback");
    expect(location.searchParams.get("error")).toBe("invalid_scope");
    expect(location.searchParams.get("error_description")).toBeNull();
    expect(location.searchParams.get("state")).toBe("state-value");
    expect(location.searchParams.get("iss")).toBe(config.issuer);
    expect(fixture.protocol.oauth.authorize).not.toHaveBeenCalled();
  });

  test("returns authorization errors directly when the redirect URI is not registered", async () => {
    const fixture = fixtures(true);
    fixture.protocol.oauth = {
      authorize: mock(async () => {
        throw new IdentityError("invalid_request", "The redirect URI is not registered.");
      }),
      client: mock(async () => ({
        data: {
          allowedScopes: ["openid"],
          clientId: "web-app",
          grantTypes: ["authorization_code"],
          redirectUris: ["https://app.deployments.ai/callback"],
          requiredScopes: ["openid"],
          requirePkce: true,
          responseTypes: ["code"],
          status: "active",
          tokenEndpointAuthMethod: "none",
          type: "public",
        },
      })),
    } as unknown as OAuthApplication;
    const handler = makeIdentityHttpHandler(fixture.application, config, fixture.protocol);

    const response = await handler({
      headers: { cookie: "__Host-dpl_identity=session-token" },
      httpMethod: "GET",
      path: "/oauth2/authorize",
      queryStringParameters: {
        ...authorizationParameters,
        client_id: "web-app",
        redirect_uri: "https://attacker.example/callback",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers.Location).toBeUndefined();
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_request" });
  });
});
