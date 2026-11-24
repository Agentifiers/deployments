import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
} from "jose";
import { MemoryApiError, type MemoryApiEvent } from "./api-support.ts";

export type MemoryJwtVerifier = (token: string) => Promise<JWTPayload>;

const JWT_CLOCK_TOLERANCE_SECONDS = 60;
const JWT_DOCUMENT_FETCH_ATTEMPTS = 5;
const JWT_DOCUMENT_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function retryDelay(attempt: number) {
  const base = 50 * 2 ** attempt;
  return base + Math.floor(Math.random() * base);
}

async function waitForRetry(milliseconds: number, signal?: AbortSignal | null) {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function fetchJwtDocument(fetchImpl: typeof fetch, input: string | URL, init?: RequestInit) {
  let lastCause: unknown;
  for (let attempt = 0; attempt < JWT_DOCUMENT_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = init === undefined ? await fetchImpl(input) : await fetchImpl(input, init);
      if (
        !JWT_DOCUMENT_RETRYABLE_STATUSES.has(response.status) ||
        attempt === JWT_DOCUMENT_FETCH_ATTEMPTS - 1
      ) {
        return response;
      }
      if (response.body) await response.body.cancel().catch(() => undefined);
      lastCause = new Error(`JWT document endpoint returned ${response.status}.`);
    } catch (cause) {
      if (attempt === JWT_DOCUMENT_FETCH_ATTEMPTS - 1) throw cause;
      lastCause = cause;
    }
    await waitForRetry(retryDelay(attempt), init?.signal);
  }
  throw lastCause;
}

function requiredEnvironment(name: string, env: NodeJS.ProcessEnv) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function jwtAudiences(env: NodeJS.ProcessEnv) {
  const raw = requiredEnvironment("DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES", env);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES must be a JSON string array.");
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error("DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCES must be a non-empty JSON string array.");
  }
  return value as string[];
}

export function memoryJwtAudienceMatches(payload: JWTPayload, audiences: readonly string[]) {
  const tokenAudiences =
    typeof payload.aud === "string"
      ? [payload.aud]
      : Array.isArray(payload.aud)
        ? payload.aud
        : undefined;
  return tokenAudiences
    ? tokenAudiences.some((audience) => audiences.includes(audience))
    : typeof payload.client_id === "string" && audiences.includes(payload.client_id);
}

async function discoverJwksUrl(issuer: string, fetchImpl: typeof fetch) {
  const discoveryUrl = new URL(`${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`);
  const response = await fetchJwtDocument(fetchImpl, discoveryUrl);
  if (!response.ok) throw new Error("JWT issuer discovery failed.");
  const document: unknown = await response.json();
  if (
    typeof document !== "object" ||
    document === null ||
    !("issuer" in document) ||
    typeof document.issuer !== "string" ||
    document.issuer !== issuer ||
    !("jwks_uri" in document) ||
    typeof document.jwks_uri !== "string"
  ) {
    throw new Error("JWT issuer discovery document is invalid.");
  }
  const jwksUrl = new URL(document.jwks_uri);
  if (jwksUrl.protocol !== "https:") {
    throw new Error("Discovered JWT JWKS URI must be an HTTPS URL.");
  }
  return jwksUrl;
}

export function createMemoryJwtVerifier(
  env: NodeJS.ProcessEnv = process.env,
  createJwks: typeof createRemoteJWKSet = createRemoteJWKSet,
  fetchImpl: typeof fetch = fetch,
): MemoryJwtVerifier {
  const issuer = requiredEnvironment("DEPLOYMENTS_AI_MEMORY_JWT_ISSUER", env);
  const configuredJwksUri = env.DEPLOYMENTS_AI_MEMORY_JWKS_URI?.trim();
  let configuredJwksUrl: URL | undefined;
  if (configuredJwksUri) {
    configuredJwksUrl = new URL(configuredJwksUri);
    if (configuredJwksUrl.protocol !== "https:") {
      throw new Error("DEPLOYMENTS_AI_MEMORY_JWKS_URI must be an HTTPS URL.");
    }
  }
  let jwks: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
  const fetchJwks: FetchImplementation = (url, options) =>
    fetchJwtDocument(fetchImpl, url, options);
  const getJwks = () => {
    if (!jwks) {
      jwks = (
        configuredJwksUrl ? Promise.resolve(configuredJwksUrl) : discoverJwksUrl(issuer, fetchImpl)
      ).then((url) => createJwks(url, { [customFetch]: fetchJwks }));
      void jwks.catch(() => {
        jwks = undefined;
      });
    }
    return jwks;
  };
  const audience = jwtAudiences(env);
  return async (token) => {
    const { payload } = await jwtVerify(token, await getJwks(), {
      algorithms: ["RS256"],
      clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
      issuer,
    });
    if (typeof payload.exp !== "number") {
      throw new Error("JWT expiration is required.");
    }
    if (
      typeof payload.iat === "number" &&
      payload.iat > Math.floor(Date.now() / 1_000) + JWT_CLOCK_TOLERANCE_SECONDS
    ) {
      throw new Error("JWT was issued in the future.");
    }
    if (!memoryJwtAudienceMatches(payload, audience)) {
      throw new Error("JWT audience is not accepted.");
    }
    return payload;
  };
}

function bearerToken(event: MemoryApiEvent) {
  const authorization = Object.entries(event.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  const matched = authorization?.match(/^Bearer ([^\s]+)$/iu);
  return matched?.[1];
}

function gatewayClaims(payload: JWTPayload) {
  const claims: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      claims[name] = String(value);
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      claims[name] = JSON.stringify(value);
    }
  }
  return claims;
}

let defaultVerifier: MemoryJwtVerifier | undefined;

export async function authenticateMemoryApiEvent(
  event: MemoryApiEvent,
  verify?: MemoryJwtVerifier,
): Promise<MemoryApiEvent> {
  const token = bearerToken(event);
  if (!token) {
    throw new MemoryApiError(401, "unauthorized", "A valid platform access token is required.");
  }
  try {
    const claims = gatewayClaims(
      await (verify ?? (defaultVerifier ??= createMemoryJwtVerifier()))(token),
    );
    return {
      ...event,
      requestContext: {
        ...event.requestContext,
        authorizer: { jwt: { claims } },
      },
    };
  } catch {
    throw new MemoryApiError(401, "unauthorized", "A valid platform access token is required.");
  }
}
