import { Effect, Fiber, Schedule, type Scope } from "effect";
import type { E2eConfigurationError } from "./errors.ts";

/** A platform bearer token and its validity window, both in epoch milliseconds. */
export interface IssuedPlatformToken {
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
  readonly token: string;
}

/**
 * The platform bearer credential of a credentialed E2E test. Identity-minted access
 * tokens are short-lived, while evaluation waits and cleanup can run far longer, so
 * readers MUST read `token` when they send a request instead of capturing it once.
 */
export interface PlatformCredential {
  readonly token: string;
}

interface TenantScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

const REFRESH_LEAD_MS = 3 * 60_000;
const REFRESH_RETRY_INTERVAL = "15 seconds";

export function staticPlatformCredential(token: string): PlatformCredential {
  return { token };
}

/** Milliseconds until a token should be replaced: before its last lead window, capped at half its lifetime. */
function platformTokenRefreshDelayMs(issued: IssuedPlatformToken, nowMs: number): number {
  const leadMs = Math.min(REFRESH_LEAD_MS, (issued.expiresAtMs - issued.issuedAtMs) / 2);
  return Math.max(0, issued.expiresAtMs - leadMs - nowMs);
}

/**
 * Mints a platform credential and keeps re-minting it before expiry until the owning
 * test scope closes. Scope finalizers run in reverse acquisition order, so every
 * resource cleanup registered after the credential still sees a valid token. The
 * refresh fiber runs on the default runtime so it follows wall-clock time even when
 * the test itself runs under TestClock.
 */
export function refreshingPlatformCredential(
  mint: Effect.Effect<IssuedPlatformToken, E2eConfigurationError>,
): Effect.Effect<PlatformCredential, E2eConfigurationError, Scope.Scope> {
  return Effect.gen(function* () {
    let current = yield* mint;
    const refresh = Effect.suspend(() =>
      Effect.sleep(platformTokenRefreshDelayMs(current, Date.now())),
    ).pipe(
      Effect.andThen(
        mint.pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Platform credential refresh failed; retrying.", error.message),
          ),
          Effect.retry(Schedule.spaced(REFRESH_RETRY_INTERVAL)),
        ),
      ),
      Effect.tap((next) =>
        Effect.sync(() => {
          current = next;
        }),
      ),
      Effect.forever,
    );
    const fiber = Effect.runFork(refresh);
    yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
    return {
      get token() {
        return current.token;
      },
    };
  });
}

/**
 * Tenant-scoped request headers. A platform credential's authorization header is a live
 * accessor, so header objects captured at the start of a long test (and spread into each
 * request) always carry the current token; a string (runtime API key) is used as-is.
 */
export function tenantHeaders(
  credential: PlatformCredential | string,
  scope: TenantScope,
): Readonly<Record<string, string>> {
  const headers = {
    "x-deployments-environment": scope.environmentId,
    "x-deployments-organization": scope.organizationId,
    "x-deployments-project": scope.projectId,
  };
  return bearerAuthorization(credential, headers);
}

/** Adds a bearer `authorization` header to `headers`, read live for a platform credential. */
export function bearerAuthorization<Headers extends Record<string, string>>(
  credential: PlatformCredential | string,
  headers: Headers = {} as Headers,
): Headers & { readonly authorization: string } {
  if (typeof credential === "string") {
    return { authorization: `Bearer ${credential}`, ...headers };
  }
  return Object.defineProperty({ ...headers }, "authorization", {
    enumerable: true,
    get: () => `Bearer ${credential.token}`,
  }) as Headers & { readonly authorization: string };
}
