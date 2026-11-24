import { IdentityError, sha256 } from "@deployments-ai/identity";
import type { IdentityApplication } from "./application.ts";
import { deviceLabel } from "./device-label.ts";
import { json, type RestApiResponse } from "./http-responses.ts";
import type { SignInOutcome } from "./mfa-application.ts";
import { waitForPublicResponse } from "./public-email-response.ts";

const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function requiredText(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !value) {
    throw new IdentityError("invalid_request", `${name} is required.`, { exposeDescription: true });
  }
  return value;
}

/**
 * Password sign-in (`/v1/auth/sign-in`) and its second step (`/v1/auth/sign-in/mfa`). Only a
 * `signed-in` outcome sets the browser session cookie; `mfa-required` hands back a short-lived
 * challenge token the page posts with the code. Device approval, CLI consent, and the console's
 * authorization-code flow all start from that cookie, so none of them can skip the second step.
 */
export async function signInResponse(
  application: Pick<IdentityApplication, "mfa" | "signIn">,
  request: {
    readonly body: Record<string, unknown>;
    readonly ipPrefixHash: string | undefined;
    readonly path: "/v1/auth/sign-in" | "/v1/auth/sign-in/mfa";
    readonly publicResponseMinimumMs: number;
    readonly sessionCookie: (value: string, maxAge: number) => string;
    readonly userAgent: string | undefined;
  },
): Promise<RestApiResponse> {
  const started = Date.now();
  const label = deviceLabel(request.userAgent);
  const hashes = {
    ...(label ? { deviceLabel: label } : {}),
    ...(request.ipPrefixHash ? { ipPrefixHash: request.ipPrefixHash } : {}),
    ...(request.userAgent ? { userAgentHash: sha256(request.userAgent) } : {}),
  };
  let outcome: SignInOutcome;
  try {
    outcome =
      request.path === "/v1/auth/sign-in"
        ? await application.signIn({
            email: requiredText(request.body, "email"),
            password: requiredText(request.body, "password"),
            ...hashes,
          })
        : await application.mfa.completeSignIn({
            challengeToken: requiredText(request.body, "challengeToken"),
            code: requiredText(request.body, "code"),
            ...hashes,
          });
  } catch (error) {
    await waitForPublicResponse(started, request.publicResponseMinimumMs);
    throw error;
  }
  if (outcome.kind === "mfa-required") {
    return json(200, {
      challengeToken: outcome.challengeToken,
      expiresAt: outcome.expiresAt,
      mfaRequired: true,
    });
  }
  return {
    ...json(200, { expiresAt: outcome.expiresAt, principalId: outcome.principalId }),
    multiValueHeaders: {
      "Set-Cookie": [request.sessionCookie(outcome.sessionToken, SESSION_COOKIE_MAX_AGE_SECONDS)],
    },
  };
}
