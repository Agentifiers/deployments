import { IdentityError } from "@deployments-ai/identity";
import type { AccountAuthenticator } from "./account-authentication.ts";
import { accountLifecycleResponse } from "./account-lifecycle-http.ts";
import type { IdentityApplication } from "./application.ts";
import { empty, json, type RestApiResponse } from "./http-responses.ts";

const SESSION_PATH = /^\/v1\/account\/sessions\/([^/]+)$/u;

export interface AccountRequest {
  readonly authorization: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly readBody: () => Record<string, unknown>;
}

function text(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !value) {
    throw new IdentityError("invalid_request", `${name} is required.`, { exposeDescription: true });
  }
  return value;
}

/**
 * Self-service account security for the console's server, under `/v1/account/`. Every route takes
 * the console's bearer access token instead of the identity browser cookie, so these routes skip
 * the browser Origin and CSRF guard: a browser cannot attach the token, and nothing here reads a
 * cookie. Sensitive changes prove the person again with a password or a second-factor code.
 * Returns `undefined` for paths outside `/v1/account/`.
 */
export async function accountResponse(
  application: IdentityApplication,
  authenticate: AccountAuthenticator,
  request: AccountRequest,
): Promise<RestApiResponse | undefined> {
  if (!request.path.startsWith("/v1/account/")) return undefined;
  const caller = await authenticate(request.authorization);
  if (!caller) return json(401, { error: "unauthorized" });
  const principalId = caller.principal.id;
  const route = `${request.method} ${request.path}`;
  switch (route) {
    case "GET /v1/account/security":
      return json(200, await application.mfa.accountSecurity(principalId));
    case "GET /v1/account/sessions": {
      const rawLimit = request.query.limit;
      if (rawLimit !== undefined && !/^\d{1,3}$/u.test(rawLimit)) {
        throw new IdentityError("invalid_request", "Session page limit is invalid.", {
          exposeDescription: true,
        });
      }
      return json(
        200,
        await application.listCallerSessions(caller, {
          ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
          ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
        }),
      );
    }
    case "POST /v1/account/sign-out":
      // The console's sign-out: ends the browser session the token came from, so the next
      // authorize shows the sign-in form instead of silently signing the browser back in.
      await application.revokeCallerSession(caller, caller.sessionId);
      return empty(204);
    case "POST /v1/account/sign-out-all":
      await application.signOutAll(principalId);
      return empty(204);
    case "POST /v1/account/password": {
      const body = request.readBody();
      await application.mfa.limitVerification(principalId);
      await application.changePassword({
        currentPassword: text(body, "currentPassword"),
        password: text(body, "password"),
        principalId,
      });
      return empty(204);
    }
    case "POST /v1/account/mfa/enrollment":
      return json(
        200,
        await application.mfa.beginEnrollment({
          password: text(request.readBody(), "password"),
          principalId,
        }),
      );
    case "POST /v1/account/mfa/enrollment/confirm":
      return json(
        200,
        await application.mfa.confirmEnrollment({
          code: text(request.readBody(), "code"),
          principalId,
        }),
      );
    case "POST /v1/account/mfa/disable":
      await application.mfa.disable({ code: text(request.readBody(), "code"), principalId });
      return empty(204);
    case "POST /v1/account/mfa/recovery-codes":
      return json(
        200,
        await application.mfa.regenerateRecoveryCodes({
          code: text(request.readBody(), "code"),
          principalId,
        }),
      );
  }
  const lifecycle = await accountLifecycleResponse(application, caller, request);
  if (lifecycle) return lifecycle;
  const sessionId = request.method === "DELETE" ? SESSION_PATH.exec(request.path)?.[1] : undefined;
  if (sessionId === undefined) return json(404, { error: "not_found" });
  const revoked = await application.revokeCallerSession(caller, sessionId);
  return revoked.outcome === "not_found"
    ? json(404, { error: "not_found" })
    : json(200, { current: revoked.current });
}
