import "@tanstack/react-start/server-only";
import {
  readCookie,
  serializeBffCookie,
  WEB_BFF_SESSION_COOKIE,
  WEB_BFF_TRANSACTION_COOKIE,
  WebBffCallbackError,
  type WebBffAuth,
} from "@deployments-ai/web-bff-auth";

export interface AuthRouteContext {
  readonly auth: WebBffAuth;
  /**
   * Ends the issuer's browser session behind an access token. Without it, the issuer's session
   * cookie survives a console sign-out and the next authorize signs the browser straight back in.
   */
  readonly endIssuerSession: (accessToken: string) => Promise<void>;
  /** Exact console origin; the only origin allowed to post to `/auth/logout`. */
  readonly publicOrigin: string;
}

function redirect(location: string, status: 302 | 303, cookies: readonly string[]) {
  const headers = new Headers({ "cache-control": "no-store", location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { headers, status });
}

function signInFailedPage(status: 400 | 500, cookies: readonly string[]) {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head>' +
      '<body><p>Sign-in could not be completed.</p><p><a href="/auth/login">Sign in again</a></p></body></html>',
    { headers, status },
  );
}

/**
 * `POST` is accepted only from the console's own origin. Browsers send `Origin` on every POST;
 * when a privacy setting strips it, `Sec-Fetch-Site: same-origin` is the fallback proof.
 */
function isSameOrigin(request: Request, publicOrigin: string) {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === publicOrigin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** Only `prompt=login` forces the issuer's sign-in form; anything else keeps silent re-sign-in. */
export function loginPrompt(parameters: URLSearchParams): "login" | undefined {
  return parameters.get("prompt") === "login" ? "login" : undefined;
}

/**
 * Where a logout lands. A plain sign-out goes to the console root. Switching accounts
 * (`prompt=login`) goes straight to a forced sign-in that returns to `returnTo`; `handleLogin`
 * still reduces `returnTo` to a console path.
 */
export function postLogoutLocation(publicOrigin: string, form: URLSearchParams): string {
  if (loginPrompt(form) === undefined) return `${publicOrigin}/`;
  const login = new URLSearchParams({ prompt: "login", returnTo: form.get("returnTo") ?? "/" });
  return `${publicOrigin}/auth/login?${login}`;
}

/**
 * `GET /auth/login?returnTo=&prompt=`: persists the transaction, sets its cookie, redirects to
 * authorize.
 */
export async function handleLogin(request: Request, context: AuthRouteContext) {
  const parameters = new URL(request.url).searchParams;
  const returnTo = parameters.get("returnTo") ?? "/";
  const prompt = loginPrompt(parameters);
  try {
    const login = await context.auth.beginLogin({
      returnTo,
      ...(prompt === undefined ? {} : { prompt }),
    });
    return redirect(login.authorizationUrl, 302, [
      serializeBffCookie(
        WEB_BFF_TRANSACTION_COOKIE,
        login.transactionCookie,
        login.transactionCookieMaxAgeSeconds,
      ),
    ]);
  } catch (error) {
    console.error("OAuth authorization initiation failed.", error);
    return signInFailedPage(500, []);
  }
}

/**
 * `GET /auth/callback`: completes the code exchange. The transaction cookie is cleared on every
 * terminal outcome; the session cookie is set only after the session record committed.
 */
export async function handleCallback(request: Request, context: AuthRouteContext) {
  const parameters = new URL(request.url).searchParams;
  const clearTransaction = serializeBffCookie(WEB_BFF_TRANSACTION_COOKIE, "", 0);
  try {
    const result = await context.auth.completeCallback({
      code: parameters.get("code") ?? undefined,
      error: parameters.get("error") ?? undefined,
      iss: parameters.get("iss") ?? undefined,
      state: parameters.get("state") ?? undefined,
      transactionCookie: readCookie(request.headers.get("cookie"), WEB_BFF_TRANSACTION_COOKIE),
    });
    return redirect(`${context.publicOrigin}${result.postLoginPath}`, 303, [
      clearTransaction,
      serializeBffCookie(
        WEB_BFF_SESSION_COOKIE,
        result.sessionCookie,
        result.sessionCookieMaxAgeSeconds,
      ),
    ]);
  } catch (error) {
    if (error instanceof WebBffCallbackError) {
      console.warn(JSON.stringify({ component: "web-bff-auth", rejected: error.reason }));
      return signInFailedPage(400, [clearTransaction]);
    }
    console.error("OAuth callback failed.", error);
    return signInFailedPage(500, [clearTransaction]);
  }
}

/** Best effort: a session that is already gone, or an unreachable issuer, must not block logout. */
async function endIssuerSessionQuietly(
  context: AuthRouteContext,
  sessionCookie: string | undefined,
) {
  if (!sessionCookie) return;
  try {
    const { accessToken } = await context.auth.requireAccessToken(sessionCookie);
    await context.endIssuerSession(accessToken);
  } catch (error) {
    console.warn(JSON.stringify({ component: "web-bff-auth", issuerSignOutFailed: String(error) }));
  }
}

/**
 * `POST /auth/logout`: same-origin only. The issuer's browser session ends first, while the
 * console's access token still proves it; then the console session is revoked locally before the
 * best-effort refresh revocation, and the browser cookie is cleared even if persistence fails.
 * The form body may ask to switch accounts (see `postLogoutLocation`).
 */
export async function handleLogout(request: Request, context: AuthRouteContext) {
  if (!isSameOrigin(request, context.publicOrigin)) {
    return new Response("Cross-origin logout rejected.", { status: 403 });
  }
  const form = new URLSearchParams(await request.text());
  const sessionCookie = readCookie(request.headers.get("cookie"), WEB_BFF_SESSION_COOKIE);
  await endIssuerSessionQuietly(context, sessionCookie);
  try {
    await context.auth.logout(sessionCookie);
  } catch (error) {
    console.error("BFF session logout failed.", error);
  }
  return redirect(postLogoutLocation(context.publicOrigin, form), 303, [
    serializeBffCookie(WEB_BFF_SESSION_COOKIE, "", 0),
  ]);
}
