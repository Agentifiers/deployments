import {
  decodeProtectedHeader,
  importJWK,
  type JWK,
  jwtVerify,
  type ProtectedHeaderParameters,
} from "jose";

import { asRecord } from "../../shared/core.ts";

export const TEAMS_BOT_FRAMEWORK_OPENID_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const TEAMS_BOT_FRAMEWORK_TOKEN_ISSUER = "https://api.botframework.com";

const CLOCK_SKEW_SECONDS = 300;
const SIGNING_KEYS_TTL_MS = 24 * 60 * 60 * 1_000;
const UNKNOWN_KEY_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const FAILED_REFRESH_BACKOFF_MS = 30 * 1_000;
const SIGNING_KEYS_REQUEST_TIMEOUT_MS = 10_000;
const MAX_AUTHORIZATION_CHARACTERS = 16_384;

export class TeamsIngressError extends Error {
  readonly status: 400 | 401 | 403;

  constructor(status: TeamsIngressError["status"], message: string) {
    super(message);
    this.name = "TeamsIngressError";
    this.status = status;
  }
}

export interface TeamsBotFrameworkTokenVerifier {
  /** Throws `TeamsIngressError` (401 or 403) when the request is not from Bot Framework. */
  verify(input: {
    readonly appId: string;
    readonly authorization: string | null | undefined;
    readonly channelId: string;
    readonly serviceUrl: string;
  }): Promise<void>;
}

interface BotFrameworkSigningKey extends JWK {
  readonly endorsements?: unknown;
}

interface SigningKeyCache {
  fetchedAt: number;
  inFlight?: Promise<readonly BotFrameworkSigningKey[]> | undefined;
  keys?: readonly BotFrameworkSigningKey[];
  /** Time of the last failed download; further downloads wait out the backoff. */
  lastFailureAt?: number | undefined;
  lastRefreshAt?: number;
}

/**
 * Process-wide signing key caches, one per fetch implementation so injected test transports
 * never observe production keys (or each other's).
 */
const signingKeyCaches = new WeakMap<typeof fetch, SigningKeyCache>();

async function fetchJson(fetchImpl: typeof fetch, url: string) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(SIGNING_KEYS_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Bot Framework metadata request failed with HTTP ${String(response.status)}.`);
  }
  return asRecord(await response.json());
}

async function downloadSigningKeys(fetchImpl: typeof fetch) {
  const metadata = await fetchJson(fetchImpl, TEAMS_BOT_FRAMEWORK_OPENID_METADATA_URL);
  const jwksUri = metadata?.jwks_uri;
  if (typeof jwksUri !== "string" || !URL.canParse(jwksUri)) {
    throw new Error("Bot Framework OpenID metadata has no jwks_uri.");
  }
  if (new URL(jwksUri).protocol !== "https:") {
    throw new Error("Bot Framework jwks_uri must use HTTPS.");
  }
  const keys = (await fetchJson(fetchImpl, jwksUri))?.keys;
  if (!Array.isArray(keys)) throw new Error("Bot Framework JWKS has no keys.");
  return keys.filter(
    (key): key is BotFrameworkSigningKey =>
      Boolean(asRecord(key)) && typeof (key as JWK).kid === "string",
  );
}

function refreshSigningKeys(fetchImpl: typeof fetch, cache: SigningKeyCache, now: number) {
  if (
    !cache.inFlight &&
    cache.lastFailureAt !== undefined &&
    now - cache.lastFailureAt < FAILED_REFRESH_BACKOFF_MS
  ) {
    return Promise.reject(new Error("Bot Framework signing keys are unavailable."));
  }
  cache.inFlight ??= (async () => {
    cache.lastRefreshAt = now;
    try {
      const keys = await downloadSigningKeys(fetchImpl);
      cache.keys = keys;
      cache.fetchedAt = now;
      cache.lastFailureAt = undefined;
      return keys;
    } catch (error) {
      cache.lastFailureAt = now;
      throw error;
    } finally {
      cache.inFlight = undefined;
    }
  })();
  return cache.inFlight;
}

async function signingKey(fetchImpl: typeof fetch, kid: string, now: number) {
  let cache = signingKeyCaches.get(fetchImpl);
  if (!cache) {
    cache = { fetchedAt: 0 };
    signingKeyCaches.set(fetchImpl, cache);
  }
  let keys = cache.keys;
  if (!keys || now - cache.fetchedAt >= SIGNING_KEYS_TTL_MS) {
    try {
      keys = await refreshSigningKeys(fetchImpl, cache, now);
    } catch (error) {
      // An expired cache stays usable while Bot Framework metadata is unavailable.
      if (!cache.keys) throw error;
      keys = cache.keys;
    }
  }
  let key = keys.find((candidate) => candidate.kid === kid);
  if (
    !key &&
    (cache.lastRefreshAt === undefined ||
      now - cache.lastRefreshAt >= UNKNOWN_KEY_REFRESH_INTERVAL_MS)
  ) {
    keys = await refreshSigningKeys(fetchImpl, cache, now);
    key = keys.find((candidate) => candidate.kid === kid);
  }
  return key;
}

function bearerToken(authorization: string | null | undefined) {
  if (typeof authorization !== "string" || authorization.length > MAX_AUTHORIZATION_CHARACTERS) {
    return undefined;
  }
  return /^Bearer\s+([A-Za-z0-9_.-]+)\s*$/iu.exec(authorization.trim())?.[1];
}

/**
 * Verifies the Bot Framework channel JWT on inbound activities: RS256 signature from a
 * Bot Framework signing key endorsed for the activity channel, issuer, audience (bot app id),
 * expiry/not-before with five minutes of skew, and the `serviceUrl` claim.
 */
export function teamsBotFrameworkTokenVerifier(
  options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): TeamsBotFrameworkTokenVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return {
    async verify(input) {
      const token = bearerToken(input.authorization);
      if (!token) throw new TeamsIngressError(401, "Teams request bearer token is missing.");
      let header: ProtectedHeaderParameters;
      try {
        header = decodeProtectedHeader(token);
      } catch {
        throw new TeamsIngressError(401, "Teams request bearer token is malformed.");
      }
      if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
        throw new TeamsIngressError(401, "Teams request bearer token algorithm is not allowed.");
      }
      const currentTime = now();
      const jwk = await signingKey(fetchImpl, header.kid, currentTime);
      if (!jwk) throw new TeamsIngressError(401, "Teams request signing key is unknown.");
      const endorsements = Array.isArray(jwk.endorsements) ? jwk.endorsements : [];
      if (!input.channelId || !endorsements.includes(input.channelId)) {
        throw new TeamsIngressError(403, "Teams request signing key is not endorsed for channel.");
      }
      let claims: Readonly<Record<string, unknown>>;
      try {
        const { endorsements: _endorsements, ...publicKey } = jwk;
        const key = await importJWK(publicKey, "RS256");
        claims = (
          await jwtVerify(token, key, {
            algorithms: ["RS256"],
            audience: input.appId,
            clockTolerance: CLOCK_SKEW_SECONDS,
            currentDate: new Date(currentTime),
            issuer: TEAMS_BOT_FRAMEWORK_TOKEN_ISSUER,
            requiredClaims: ["exp"],
          })
        ).payload;
      } catch {
        throw new TeamsIngressError(401, "Teams request bearer token is invalid.");
      }
      if (typeof claims.serviceUrl !== "string" || claims.serviceUrl !== input.serviceUrl) {
        throw new TeamsIngressError(401, "Teams request serviceUrl claim does not match.");
      }
    },
  };
}
