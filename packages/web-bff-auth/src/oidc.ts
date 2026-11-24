import { Ulid } from "@deployments-ai/db";
import { constantTimeTextEqual, sha256 } from "@deployments-ai/identity";
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyResult,
} from "jose";
import { Schema } from "effect";
import { createHash } from "node:crypto";

/** Private ID-token claim the identity service issues only to `deployments-web`. */
export const SESSION_EPOCH_CLAIM = "https://deployments.ai/session_epoch";

const JWKS_MAXIMUM_AGE_MILLISECONDS = 10 * 60 * 1_000;
const JWKS_MINIMUM_REFETCH_MILLISECONDS = 60 * 1_000;

export interface OidcProviderMetadata {
  readonly authorizationEndpoint: string;
  readonly issuer: string;
  readonly jwksUri: string;
  readonly revocationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface OAuthTokenSet {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly idToken?: string;
  readonly refreshToken?: string;
}

export interface VerifiedIdToken {
  readonly principalId: Ulid;
  readonly sessionEpoch: number;
}

/** Source of the confidential client secret; `invalidate` drops a cached value after rotation. */
export interface ClientSecretSource {
  readonly current: () => Promise<string>;
  readonly invalidate: () => void;
}

/**
 * A token-endpoint request did not yield usable tokens. `definitive` means the server answered
 * with a standard OAuth error; otherwise the outcome is unknown and the presented grant may have
 * been consumed. Callers never retry either case with the same grant.
 */
export class OAuthTokenRequestError extends Error {
  readonly code: string | undefined;
  readonly definitive: boolean;

  constructor(message: string, input: { readonly code?: string; readonly definitive: boolean }) {
    super(message);
    this.name = "OAuthTokenRequestError";
    this.code = input.code;
    this.definitive = input.definitive;
  }
}

export class IdTokenValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdTokenValidationError";
  }
}

export interface OidcClient {
  readonly exchangeCode: (input: {
    readonly code: string;
    readonly codeVerifier: string;
  }) => Promise<OAuthTokenSet>;
  readonly metadata: () => Promise<OidcProviderMetadata>;
  readonly refresh: (refreshToken: string) => Promise<OAuthTokenSet>;
  readonly revoke: (token: string, hint: "access_token" | "refresh_token") => Promise<void>;
  readonly verifyIdTokenClaims: (
    idToken: string,
    expected: { readonly code: string; readonly nonceHash: string },
  ) => Promise<JWTPayload>;
  readonly verifyIdToken: (
    idToken: string,
    expected: { readonly code: string; readonly nonceHash: string },
  ) => Promise<VerifiedIdToken>;
}

function requiredEndpoint(document: Readonly<Record<string, unknown>>, name: string, issuer: URL) {
  const value = document[name];
  if (typeof value !== "string") throw new Error(`Identity discovery is missing ${name}.`);
  const endpoint = new URL(value);
  if (endpoint.origin !== issuer.origin || endpoint.username || endpoint.password) {
    throw new Error(`Identity discovery ${name} is not served by the issuer origin.`);
  }
  return endpoint.href;
}

/** jose's own JWKS acceptance check; jose validates each key's parameters when importing it. */
function isJsonWebKeySet(value: unknown): value is JSONWebKeySet {
  return (
    !!value &&
    typeof value === "object" &&
    "keys" in value &&
    Array.isArray(value.keys) &&
    value.keys.every((key: unknown) => !!key && typeof key === "object" && !Array.isArray(key))
  );
}

/** OIDC `c_hash`: base64url of the left half of the SHA-256 digest of the authorization code. */
function codeHash(code: string) {
  return createHash("sha256").update(code, "ascii").digest().subarray(0, 16).toString("base64url");
}

/**
 * Confidential OAuth/OIDC client for the platform identity issuer: cached discovery and JWKS,
 * `client_secret_basic` token and revocation requests, and ID-token validation.
 */
export function makeOidcClient(config: {
  readonly clientId: string;
  readonly clientSecret: ClientSecretSource;
  readonly clockToleranceSeconds?: number;
  readonly fetch?: typeof fetch;
  readonly issuer: string;
  readonly now?: () => Date;
  readonly redirectUri: string;
  readonly requestTimeoutMilliseconds?: number;
}): OidcClient {
  const send = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const timeout = config.requestTimeoutMilliseconds ?? 10_000;
  const issuerUrl = new URL(config.issuer);
  let metadataLoad: Promise<OidcProviderMetadata> | undefined;
  let keys: { readonly fetchedAt: number; readonly keySet: JWTVerifyGetKey } | undefined;

  async function getJson(url: string) {
    const response = await send(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`Identity request to ${url} failed with ${response.status}.`);
    return (await response.json()) as Readonly<Record<string, unknown>>;
  }

  function metadata() {
    metadataLoad ??= (async () => {
      const document = await getJson(
        `${config.issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`,
      );
      if (document.issuer !== config.issuer) {
        throw new Error("Identity discovery issuer does not match the configured issuer.");
      }
      return {
        authorizationEndpoint: requiredEndpoint(document, "authorization_endpoint", issuerUrl),
        issuer: config.issuer,
        jwksUri: requiredEndpoint(document, "jwks_uri", issuerUrl),
        revocationEndpoint: requiredEndpoint(document, "revocation_endpoint", issuerUrl),
        tokenEndpoint: requiredEndpoint(document, "token_endpoint", issuerUrl),
      };
    })().catch((error: unknown) => {
      metadataLoad = undefined;
      throw error;
    });
    return metadataLoad;
  }

  async function loadKeys() {
    const document = await getJson((await metadata()).jwksUri);
    if (!isJsonWebKeySet(document)) {
      throw new joseErrors.JWKSInvalid("JSON Web Key Set malformed");
    }
    keys = { fetchedAt: Date.now(), keySet: createLocalJWKSet(document) };
    return keys.keySet;
  }

  async function clientRequest(endpoint: string, form: Readonly<Record<string, string>>) {
    const secret = await config.clientSecret.current();
    const credentials = Buffer.from(
      `${encodeURIComponent(config.clientId)}:${encodeURIComponent(secret)}`,
      "utf8",
    ).toString("base64");
    return send(endpoint, {
      body: new URLSearchParams(form),
      headers: {
        accept: "application/json",
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  }

  async function tokenRequest(form: Readonly<Record<string, string>>): Promise<OAuthTokenSet> {
    const { tokenEndpoint } = await metadata();
    let response: Response;
    try {
      response = await clientRequest(tokenEndpoint, form);
    } catch (cause) {
      throw new OAuthTokenRequestError(`Token request failed: ${String(cause)}`, {
        definitive: false,
      });
    }
    const body = (await response.json().catch(() => undefined)) as
      | Readonly<Record<string, unknown>>
      | undefined;
    if (!response.ok) {
      const code = typeof body?.error === "string" ? body.error : undefined;
      if (code === "invalid_client") config.clientSecret.invalidate();
      throw new OAuthTokenRequestError(`Token endpoint returned ${response.status}.`, {
        ...(code ? { code } : {}),
        definitive: code !== undefined && (response.status === 400 || response.status === 401),
      });
    }
    const accessToken = body?.access_token;
    const expiresIn = body?.expires_in;
    const tokenType = body?.token_type;
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      typeof tokenType !== "string" ||
      tokenType.toLowerCase() !== "bearer" ||
      typeof expiresIn !== "number" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new OAuthTokenRequestError("Token endpoint returned a malformed token response.", {
        definitive: false,
      });
    }
    return {
      accessToken,
      expiresInSeconds: expiresIn,
      ...(typeof body?.id_token === "string" ? { idToken: body.id_token } : {}),
      ...(typeof body?.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    };
  }

  async function verifyIdTokenClaims(
    idToken: string,
    expected: { readonly code: string; readonly nonceHash: string },
  ): Promise<JWTPayload> {
    const options = {
      algorithms: ["RS256"],
      audience: config.clientId,
      clockTolerance: config.clockToleranceSeconds ?? 30,
      currentDate: now(),
      issuer: config.issuer,
      requiredClaims: ["exp", "iat", "nonce", "sub"],
    };
    let verified: JWTVerifyResult;
    try {
      const keySet =
        keys && Date.now() - keys.fetchedAt < JWKS_MAXIMUM_AGE_MILLISECONDS
          ? keys.keySet
          : await loadKeys();
      try {
        verified = await jwtVerify(idToken, keySet, options);
      } catch (error) {
        // A key rotation publishes a new kid; refetch at most once per minimum interval.
        if (
          !(error instanceof joseErrors.JWKSNoMatchingKey) ||
          (keys && Date.now() - keys.fetchedAt < JWKS_MINIMUM_REFETCH_MILLISECONDS)
        ) {
          throw error;
        }
        verified = await jwtVerify(idToken, await loadKeys(), options);
      }
    } catch (cause) {
      throw new IdTokenValidationError("ID token verification failed.", { cause });
    }
    const claims = verified.payload;
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId) {
      throw new IdTokenValidationError("ID token authorized party does not match.");
    }
    if (claims.azp !== undefined && claims.azp !== config.clientId) {
      throw new IdTokenValidationError("ID token authorized party does not match.");
    }
    if (
      typeof claims.nonce !== "string" ||
      !constantTimeTextEqual(sha256(claims.nonce), expected.nonceHash)
    ) {
      throw new IdTokenValidationError("ID token nonce does not match the authorization request.");
    }
    if (
      claims.c_hash !== undefined &&
      (typeof claims.c_hash !== "string" ||
        !constantTimeTextEqual(claims.c_hash, codeHash(expected.code)))
    ) {
      throw new IdTokenValidationError("ID token code hash does not match.");
    }
    return claims;
  }

  async function verifyIdToken(
    idToken: string,
    expected: { readonly code: string; readonly nonceHash: string },
  ): Promise<VerifiedIdToken> {
    const claims = await verifyIdTokenClaims(idToken, expected);
    const sessionEpoch = claims[SESSION_EPOCH_CLAIM];
    if (
      typeof sessionEpoch !== "number" ||
      !Number.isSafeInteger(sessionEpoch) ||
      sessionEpoch < 0
    ) {
      throw new IdTokenValidationError("ID token has no valid session epoch.");
    }
    const principalId = claims.sub;
    if (!Schema.is(Ulid)(principalId)) {
      throw new IdTokenValidationError("ID token subject is not a platform principal ID.");
    }
    return { principalId, sessionEpoch };
  }

  return {
    exchangeCode: ({ code, codeVerifier }) =>
      tokenRequest({
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
      }),
    metadata,
    refresh: (refreshToken) =>
      tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
    revoke: async (token, hint) => {
      const response = await clientRequest((await metadata()).revocationEndpoint, {
        token,
        token_type_hint: hint,
      });
      if (!response.ok) throw new Error(`Token revocation returned ${response.status}.`);
    },
    verifyIdToken,
    verifyIdTokenClaims,
  };
}
