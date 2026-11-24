import {
  constantTimeTextEqual,
  randomToken,
  sha256,
  sha256Base64Url,
  type RandomSource,
  systemRandom,
} from "@deployments-ai/identity";

/** The confidential first-party web client the BFF authenticates as. */
export const WEB_BFF_CLIENT_ID = "deployments-web";

/** Immutable bindings of one stored authorization transaction that the callback revalidates. */
export interface BffAuthorizationBinding {
  readonly clientId: typeof WEB_BFF_CLIENT_ID;
  readonly expiresAt: string;
  readonly nonceHash: string;
  readonly redirectUri: string;
  readonly stateHash: string;
  readonly status: "pending" | "consumed" | "expired";
  readonly transactionTokenHash: string;
}

/** Encrypted at rest; never stored or sent in plaintext outside the BFF process. */
export interface ProtectedAuthorizationState {
  readonly pkceVerifier: string;
  readonly postLoginPath: string;
}

export interface BeginAuthorizationResult {
  readonly authorizationParameters: Readonly<Record<string, string>>;
  readonly binding: BffAuthorizationBinding;
  readonly protectedState: ProtectedAuthorizationState;
  readonly transactionCookie: string;
}

/**
 * Reduces an untrusted `returnTo` value to a path on the console origin. Absolute URLs are
 * accepted only for that exact origin; everything else, and every `/auth/*` path (which would
 * loop the login flow), falls back to `/`.
 */
export function safePostLoginPath(value: string, publicOrigin: string) {
  const origin = new URL(publicOrigin).origin;
  if (value.includes("\\") || /\p{Cc}/u.test(value)) return "/";
  if (!value.startsWith("/") && value !== origin && !value.startsWith(`${origin}/`)) return "/";
  let parsed: URL;
  try {
    parsed = new URL(value, origin);
  } catch {
    return "/";
  }
  if (parsed.origin !== origin) return "/";
  if (parsed.pathname === "/auth" || parsed.pathname.startsWith("/auth/")) return "/";
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Generates independent 32-byte transaction-cookie, state, PKCE verifier, and nonce values. Only
 * hashes of the cookie, state, and nonce are persisted; the verifier and post-login path go into
 * the protected envelope.
 */
export function beginAuthorization(input: {
  readonly expiresAt: string;
  readonly postLoginPath: string;
  /** `login` makes the issuer show its sign-in form even while its own session is live. */
  readonly prompt?: "login";
  readonly random?: RandomSource;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
}): BeginAuthorizationResult {
  const random = input.random ?? systemRandom;
  const transactionCookie = randomToken(random);
  const state = randomToken(random);
  const nonce = randomToken(random);
  const verifier = randomToken(random);
  return {
    authorizationParameters: {
      client_id: WEB_BFF_CLIENT_ID,
      code_challenge: sha256Base64Url(verifier),
      code_challenge_method: "S256",
      nonce,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: [...new Set(input.scopes)].sort().join(" "),
      state,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    },
    binding: {
      clientId: WEB_BFF_CLIENT_ID,
      expiresAt: input.expiresAt,
      nonceHash: sha256(nonce),
      redirectUri: input.redirectUri,
      stateHash: sha256(state),
      status: "pending",
      transactionTokenHash: sha256(transactionCookie),
    },
    protectedState: {
      pkceVerifier: verifier,
      postLoginPath: safePostLoginPath(input.postLoginPath, new URL(input.redirectUri).origin),
    },
    transactionCookie,
  };
}

/**
 * Validates a callback against its stored transaction: pending status, logical expiry, exact
 * redirect URI, RFC 9207 `iss`, and constant-time state and cookie hashes. Returns whether the
 * callback may attempt to consume the transaction; it never touches the token endpoint.
 */
export function callbackBindingIsValid(input: {
  readonly binding: BffAuthorizationBinding;
  readonly callbackIssuer: string | undefined;
  readonly callbackState: string | undefined;
  readonly configuredIssuer: string;
  readonly now: Date;
  readonly redirectUri: string;
  readonly transactionCookie: string | undefined;
}) {
  return (
    input.binding.status === "pending" &&
    input.binding.clientId === WEB_BFF_CLIENT_ID &&
    Date.parse(input.binding.expiresAt) > input.now.getTime() &&
    input.binding.redirectUri === input.redirectUri &&
    input.callbackIssuer === input.configuredIssuer &&
    Boolean(input.callbackState) &&
    constantTimeTextEqual(sha256(input.callbackState ?? ""), input.binding.stateHash) &&
    Boolean(input.transactionCookie) &&
    constantTimeTextEqual(sha256(input.transactionCookie ?? ""), input.binding.transactionTokenHash)
  );
}
