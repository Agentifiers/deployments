import { PLATFORM_OAUTH_RETURN_ORIGINS_ENV } from "./platform-oauth-types.ts";

const RETURN_TO_MAX_LENGTH = 2_048;
/** Literal `https://` prefix; no whitespace, controls, backslashes, or fragment for WHATWG to repair. */
const RETURN_TO_SYNTAX = /^https:\/\/[^\s\p{Cc}\\#]+$/u;

/** An authorization `returnTo` that is not an allowlisted HTTPS URL. */
export class PlatformOAuthReturnToError extends Error {
  override readonly name = "PlatformOAuthReturnToError";
  readonly code = "invalid_return_to" as const;

  constructor() {
    super("returnTo must be an https URL on an allowed return origin.");
  }
}

/**
 * Parses `PLATFORM_OAUTH_RETURN_ORIGINS`: comma-separated exact HTTPS origins (no path or
 * trailing slash). Empty or unset yields an empty allowlist, which rejects every `returnTo`.
 */
export function platformOAuthReturnOrigins(value: string | undefined): readonly string[] {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const url = URL.canParse(entry) ? new URL(entry) : undefined;
    if (url?.protocol !== "https:" || url.origin !== entry) {
      throw new Error(`${PLATFORM_OAUTH_RETURN_ORIGINS_ENV} entries must be exact HTTPS origins.`);
    }
  }
  return [...new Set(entries)];
}

/**
 * Validates an authorization `returnTo`: an absolute `https:` URL without userinfo or a
 * fragment whose origin is exactly one of `allowedOrigins`. Returns the normalized href.
 */
export function platformOAuthReturnTo(value: string, allowedOrigins: readonly string[]): string {
  if (
    value.length > RETURN_TO_MAX_LENGTH ||
    !RETURN_TO_SYNTAX.test(value) ||
    !URL.canParse(value)
  ) {
    throw new PlatformOAuthReturnToError();
  }
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || !allowedOrigins.includes(url.origin)) {
    throw new PlatformOAuthReturnToError();
  }
  return url.href;
}
