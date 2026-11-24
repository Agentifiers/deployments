import { randomBytes } from "node:crypto";

import type { OAuthHttpResponse } from "./oauth-validation.ts";

/** Only these codes reach the browser; provider error text never does. */
export type OAuthCallbackError = "access_denied" | "authorization_failed";

/** Result of completing a state-verified authorization attempt. */
export type OAuthCallbackOutcome =
  | { readonly connectionId: string; readonly kind: "connected" }
  | { readonly error: OAuthCallbackError; readonly kind: "failed" };

/** The callback URL carries `code` and `state`: never cache it or leak it as a referrer. */
const CALLBACK_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redirect(returnTo: string, parameters: Readonly<Record<string, string>>) {
  const location = new URL(returnTo);
  for (const [name, value] of Object.entries(parameters)) location.searchParams.set(name, value);
  return {
    headers: { ...CALLBACK_HEADERS, location: location.href },
    statusCode: 303,
  } satisfies OAuthHttpResponse;
}

/** Static, script-free result page; `message` must already be HTML-safe. */
function page(statusCode: number, title: string, message: string): OAuthHttpResponse {
  const nonce = randomBytes(18).toString("base64");
  return {
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">body{font:16px/1.5 system-ui,sans-serif;background:#f7f5f1;color:#181715;margin:0}main{max-width:30rem;margin:10vh auto;padding:2rem;background:#fff;border:1px solid #ddd;border-radius:12px}h1{font-size:1.25rem;margin:0 0 .5rem}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
    headers: {
      ...CALLBACK_HEADERS,
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      "content-type": "text/html; charset=utf-8",
    },
    statusCode,
  };
}

/** Completed authorization: redirect to the attempt's `returnTo`, else a static page. */
export function oauthCallbackConnected(input: {
  readonly connectionId: string;
  readonly providerDisplayName: string;
  readonly providerKey: string;
  readonly returnTo: string | undefined;
}): OAuthHttpResponse {
  return input.returnTo
    ? redirect(input.returnTo, { connection_id: input.connectionId, provider: input.providerKey })
    : page(
        200,
        "Connected",
        `Connected ${escapeHtml(input.providerDisplayName)}. You can close this window.`,
      );
}

/** Failed authorization of a trusted (state-verified) attempt. */
export function oauthCallbackFailed(
  returnTo: string | undefined,
  error: OAuthCallbackError,
): OAuthHttpResponse {
  return returnTo
    ? redirect(returnTo, { error })
    : page(
        400,
        "Authorization failed",
        "The app could not be connected. Close this window and try again.",
      );
}

/** Untrusted callback (bad, unknown, expired, or replayed state): never redirect. */
export function oauthCallbackRejected(): OAuthHttpResponse {
  return page(
    400,
    "Authorization failed",
    "This authorization link is invalid or has expired. Close this window and start again.",
  );
}
