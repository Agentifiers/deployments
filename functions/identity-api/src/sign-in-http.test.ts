import { describe, expect, mock, test } from "bun:test";
import { IdentityError } from "@deployments-ai/identity";
import type { IdentityApplication } from "./application.ts";
import { makeIdentityHttpHandler } from "./http.ts";

const config = {
  applicationOrigin: "https://app.deployments.ai",
  issuer: "https://auth.deployments.ai",
  publicResponseMinimumMs: 0,
  queuePublicEmailRequest: async () => undefined,
  registrationEnabled: false,
  secureCookies: true,
  uiOrigin: "https://auth.deployments.ai",
};

const signedIn = {
  expiresAt: "2026-08-27T00:00:00.000Z",
  kind: "signed-in" as const,
  principalId: "01K00000000000000000000000",
  sessionId: "01K00000000000000000000001",
  sessionToken: "session-token",
};

function post(path: string, body: Record<string, string>) {
  return {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      cookie: "__Host-dpl_csrf=csrf-token",
      origin: config.uiOrigin,
      "x-csrf-token": "csrf-token",
    },
    httpMethod: "POST",
    path,
  };
}

function handlerWith(application: Partial<IdentityApplication>) {
  return makeIdentityHttpHandler(application as IdentityApplication, config);
}

describe("password sign-in with a second factor", () => {
  test("answers the password with a challenge and sets no session cookie", async () => {
    const signIn = mock(async () => ({
      challengeToken: "challenge-token",
      expiresAt: "2026-07-28T00:05:00.000Z",
      kind: "mfa-required" as const,
    }));
    const response = await handlerWith({ signIn } as never)(
      post("/v1/auth/sign-in", { email: "user@example.com", password: "correct horse battery" }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      challengeToken: "challenge-token",
      expiresAt: "2026-07-28T00:05:00.000Z",
      mfaRequired: true,
    });
    expect(response.multiValueHeaders).toBeUndefined();
  });

  test("sets the session cookie once the code completes the challenge", async () => {
    const completeSignIn = mock(async (_input: unknown) => signedIn);
    const response = await handlerWith({ mfa: { completeSignIn } } as never)(
      post("/v1/auth/sign-in/mfa", { challengeToken: "challenge-token", code: "123456" }),
    );

    expect(response.statusCode).toBe(200);
    expect(completeSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ challengeToken: "challenge-token", code: "123456" }),
    );
    expect(response.multiValueHeaders?.["Set-Cookie"]?.[0]).toStartWith(
      "__Host-dpl_identity=session-token;",
    );
  });

  test("keeps the second step behind the Origin and CSRF guard", async () => {
    const completeSignIn = mock(async (_input: unknown) => signedIn);
    const request = post("/v1/auth/sign-in/mfa", { challengeToken: "t", code: "123456" });
    const response = await handlerWith({ mfa: { completeSignIn } } as never)({
      ...request,
      headers: { ...request.headers, origin: "https://evil.example" },
    });

    expect(response.statusCode).toBe(403);
    expect(completeSignIn).not.toHaveBeenCalled();
  });

  test("reports a wrong code without a cookie", async () => {
    const completeSignIn = mock(async () => {
      throw new IdentityError("access_denied", "The code is incorrect.", {
        exposeDescription: true,
      });
    });
    const response = await handlerWith({ mfa: { completeSignIn } } as never)(
      post("/v1/auth/sign-in/mfa", { challengeToken: "challenge-token", code: "000000" }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "access_denied",
      error_description: "The code is incorrect.",
    });
    expect(response.multiValueHeaders).toBeUndefined();
  });

  test("serves the code step in the hosted sign-in page", async () => {
    const response = await handlerWith({})({ httpMethod: "GET", path: "/sign-in" });
    expect(response.body).toContain('<form id="mfa" hidden>');
    expect(response.body).toContain('mfa:"/v1/auth/sign-in/mfa"');
  });
});
