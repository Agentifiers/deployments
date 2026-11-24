import "@tanstack/react-start/server-only";
import {
  readCookie,
  type SessionAccess,
  WEB_BFF_SESSION_COOKIE,
  WebBffReauthenticationRequiredError,
} from "@deployments-ai/web-bff-auth";
import { getRequest } from "@tanstack/react-start/server";
import { UnauthenticatedError } from "../errors.ts";
import { authRouteContext } from "./auth/runtime.ts";

/**
 * Validates the request's BFF session (strong session + revocation-fence reads, refreshing the
 * access token under the per-session lease when needed). A missing or unusable session surfaces as
 * `UnauthenticatedError`; other failures propagate.
 */
async function currentSession(): Promise<SessionAccess> {
  const cookie = readCookie(getRequest().headers.get("cookie"), WEB_BFF_SESSION_COOKIE);
  try {
    return await authRouteContext().auth.requireAccessToken(cookie);
  } catch (error) {
    if (error instanceof WebBffReauthenticationRequiredError) throw new UnauthenticatedError();
    throw error;
  }
}

/**
 * The console's only authentication seam: every server function obtains the caller's platform
 * access token here. The token never leaves the server.
 */
export async function requireAccessToken(): Promise<string> {
  return (await currentSession()).accessToken;
}
