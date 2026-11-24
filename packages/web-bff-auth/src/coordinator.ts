import {
  isDatabaseWriteConflict,
  webBffAuthorizationRecord,
  webBffSessionRecord,
  type EnvelopeAdapter,
  type IdentityRecord,
  type IdentityRepository,
  type Ulid,
  type WebBffSessionData,
} from "@deployments-ai/db";
import { randomToken, sha256, systemRandom, type RandomSource } from "@deployments-ai/identity";
import {
  beginAuthorization,
  callbackBindingIsValid,
  type ProtectedAuthorizationState,
  WEB_BFF_CLIENT_ID,
} from "./authorization.ts";
import { OAuthTokenRequestError, type OAuthTokenSet, type OidcClient } from "./oidc.ts";

/**
 * Explicit BFF session policy. Lifetimes follow the identity plan's recommended browser-session
 * values (idle 7 days, absolute 30 days); the absolute lifetime equals the refresh-family lifetime
 * so the session never outlives the refresh credential it wraps. Idle expiry slides on every
 * successful token refresh, which an active user triggers at least once per access-token lifetime
 * (10 minutes), so no separate renewal write is needed.
 */
export const WEB_BFF_POLICY = {
  /** Authorization transaction (and its callback cookie) lifetime; matches the authorize request. */
  authorizationLifetimeSeconds: 10 * 60,
  /** Access tokens with less remaining life are refreshed before use. */
  minimumAccessTokenRemainingSeconds: 60,
  /** Ambiguity fence: a lease older than this forces reauthentication; it is never stolen. */
  refreshLeaseSeconds: 30,
  /** How long a request waits for another caller's refresh before giving up. */
  refreshWaitMilliseconds: 8_000,
  refreshWaitInitialDelayMilliseconds: 100,
  refreshWaitMaximumDelayMilliseconds: 1_000,
  sessionAbsoluteLifetimeSeconds: 30 * 24 * 60 * 60,
  sessionIdleLifetimeSeconds: 7 * 24 * 60 * 60,
} as const;

export type WebBffPolicy = { readonly [Name in keyof typeof WEB_BFF_POLICY]: number };

const MAXIMUM_STATE_READS = 64;
const MAXIMUM_LOGOUT_ATTEMPTS = 4;

export type WebBffRepository = Pick<
  IdentityRepository,
  | "bffAuthorizationForHash"
  | "bffFenceForPrincipal"
  | "bffSessionForHash"
  | "createBffAuthorization"
  | "createBffSession"
  | "replaceBffSession"
  | "replacePendingBffAuthorization"
>;

type BffSession = IdentityRecord<"web-bff-session">;
type BffFence = IdentityRecord<"identity-bff-revocation-fence">;

interface ProtectedCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export type CallbackFailureReason =
  | "authorization-error"
  | "binding-mismatch"
  | "credential-persistence-failed"
  | "decrypt-failed"
  | "duplicate-callback"
  | "fence-rejected"
  | "id-token-invalid"
  | "missing-transaction-cookie"
  | "token-exchange-failed"
  | "token-response-incomplete"
  | "unknown-transaction";

export type ReauthenticationReason =
  | "credentials-unreadable"
  | "fence-rejected"
  | "missing-cookie"
  | "refresh-commit-failed"
  | "refresh-failed"
  | "refresh-lease-expired"
  | "refresh-response-incomplete"
  | "reauthentication-required"
  | "revoked"
  | "session-expired"
  | "unknown-session";

/** The callback failed closed; the browser must start a new authorization interaction. */
export class WebBffCallbackError extends Error {
  readonly reason: CallbackFailureReason;

  constructor(reason: CallbackFailureReason, options?: ErrorOptions) {
    super(`OAuth callback rejected: ${reason}.`, options);
    this.name = "WebBffCallbackError";
    this.reason = reason;
  }
}

/** No usable session: the caller must sign in again. */
export class WebBffReauthenticationRequiredError extends Error {
  readonly reason: ReauthenticationReason;

  constructor(reason: ReauthenticationReason) {
    super(`Reauthentication required: ${reason}.`);
    this.name = "WebBffReauthenticationRequiredError";
    this.reason = reason;
  }
}

/** Another request holds the refresh lease past this request's wait deadline; retry later. */
export class WebBffSessionBusyError extends Error {
  constructor() {
    super("The session is being refreshed by another request.");
    this.name = "WebBffSessionBusyError";
  }
}

/** Non-secret state transitions for metrics and logs. Never carries a token or cookie. */
export type WebBffAuthEvent =
  | { readonly type: "authorization.initiated"; readonly transactionId: string }
  | { readonly type: "authorization.consumed"; readonly transactionId: string }
  | { readonly reason: CallbackFailureReason; readonly type: "authorization.rejected" }
  | { readonly sessionId: string; readonly type: "session.created" }
  | { readonly sessionId: string; readonly type: "session.refresh-lease-acquired" }
  | { readonly sessionId: string; readonly type: "session.refresh-lease-contended" }
  | { readonly sessionId: string; readonly type: "session.refreshed" }
  | {
      readonly reason: ReauthenticationReason;
      readonly sessionId: string;
      readonly type: "session.reauthentication-required";
    }
  | { readonly sessionId: string; readonly type: "session.revoked" }
  | { readonly reason: string; readonly type: "token.revocation-failed" };

export interface WebBffAuthDependencies {
  readonly envelope: EnvelopeAdapter;
  readonly generateId: () => Ulid;
  /** Configured issuer, compared verbatim with the RFC 9207 `iss` callback parameter. */
  readonly issuer: string;
  readonly jitter?: () => number;
  readonly now?: () => Date;
  readonly oidc: OidcClient;
  readonly onEvent?: (event: WebBffAuthEvent) => void;
  readonly policy?: Partial<WebBffPolicy>;
  readonly random?: RandomSource;
  /** Exact registered callback URI; its origin is the only accepted post-login origin. */
  readonly redirectUri: string;
  readonly repository: WebBffRepository;
  readonly scopes: readonly string[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface BeginLoginResult {
  readonly authorizationUrl: string;
  readonly transactionCookie: string;
  readonly transactionCookieMaxAgeSeconds: number;
}

/** Callback query parameters plus the transaction cookie; every field is untrusted input. */
export interface CompleteCallbackInput {
  readonly code: string | undefined;
  readonly error: string | undefined;
  readonly iss: string | undefined;
  readonly state: string | undefined;
  readonly transactionCookie: string | undefined;
}

export interface CompleteCallbackResult {
  readonly postLoginPath: string;
  readonly sessionCookie: string;
  readonly sessionCookieMaxAgeSeconds: number;
}

export interface SessionAccess {
  readonly accessToken: string;
  readonly principalId: string;
}

export interface WebBffAuth {
  readonly beginLogin: (input: {
    readonly prompt?: "login";
    readonly returnTo: string;
  }) => Promise<BeginLoginResult>;
  readonly completeCallback: (input: CompleteCallbackInput) => Promise<CompleteCallbackResult>;
  readonly logout: (sessionCookie: string | undefined) => Promise<void>;
  readonly requireAccessToken: (sessionCookie: string | undefined) => Promise<SessionAccess>;
}

function iso(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

/** Non-secret fields every session union member carries. */
function sessionBase(data: WebBffSessionData) {
  return {
    clientId: data.clientId,
    cookieTokenHash: data.cookieTokenHash,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    id: data.id,
    idleExpiresAt: data.idleExpiresAt,
    principalId: data.principalId,
    refreshCredentialVersion: data.refreshCredentialVersion,
    sessionEpoch: data.sessionEpoch,
  };
}

function fenceAdmits(fence: BffFence | undefined, session: BffSession): fence is BffFence {
  return (
    fence !== undefined &&
    fence.data.principalStatus === "active" &&
    fence.data.sessionEpoch === session.data.sessionEpoch
  );
}

/**
 * Server-side web authentication composition over the identity repository, a KMS envelope
 * adapter, and the platform OIDC issuer. Every session transition is a full validated put of the
 * exact next version, so concurrent requests serialize through DynamoDB conditions.
 */
export function makeWebBffAuth(dependencies: WebBffAuthDependencies): WebBffAuth {
  const policy: WebBffPolicy = { ...WEB_BFF_POLICY, ...dependencies.policy };
  const clock = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? systemRandom;
  const jitter = dependencies.jitter ?? Math.random;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const emit = dependencies.onEvent ?? (() => undefined);
  const { envelope, oidc, repository } = dependencies;

  const envelopeBinding = (
    kind: "web-bff-authorization-transaction" | "web-bff-session",
    id: string,
  ) => ({
    clientId: WEB_BFF_CLIENT_ID,
    id,
    issuer: dependencies.issuer,
    kind,
    redirectUri: dependencies.redirectUri,
  });

  async function revokeQuietly(refreshToken: string | undefined) {
    if (!refreshToken) return;
    try {
      await oidc.revoke(refreshToken, "refresh_token");
    } catch (error) {
      emit({
        reason: error instanceof Error ? error.message : "unknown",
        type: "token.revocation-failed",
      });
    }
  }

  async function decryptCredentials(session: BffSession) {
    if (session.data.status !== "active") throw new Error("Only active sessions hold credentials.");
    const credentials = await envelope.decrypt<ProtectedCredentials>(
      session.data.protectedCredentials,
      envelopeBinding("web-bff-session", session.data.id),
    );
    if (
      typeof credentials.accessToken !== "string" ||
      typeof credentials.refreshToken !== "string"
    ) {
      throw new Error("Protected session credentials are malformed.");
    }
    return credentials;
  }

  /**
   * Conditionally clears the session's credentials into `reauthentication-required`. Returns false
   * when the observed version is stale, so the caller re-reads instead of acting on old state.
   */
  async function invalidate(session: BffSession, reason: ReauthenticationReason) {
    const at = iso(clock().getTime());
    const next = webBffSessionRecord({
      ...sessionBase(session.data),
      invalidatedAt: at,
      status: "reauthentication-required",
      updatedAt: at,
      version: session.data.version + 1,
    });
    try {
      await repository.replaceBffSession(session, next);
    } catch (error) {
      if (isDatabaseWriteConflict(error)) return false;
      throw error;
    }
    emit({ reason, sessionId: session.data.id, type: "session.reauthentication-required" });
    return true;
  }

  async function beginLogin(input: {
    readonly prompt?: "login";
    readonly returnTo: string;
  }): Promise<BeginLoginResult> {
    const { authorizationEndpoint } = await oidc.metadata();
    const createdAt = clock().getTime();
    const begun = beginAuthorization({
      expiresAt: iso(createdAt + policy.authorizationLifetimeSeconds * 1_000),
      postLoginPath: input.returnTo,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      random,
      redirectUri: dependencies.redirectUri,
      scopes: dependencies.scopes,
    });
    const id = dependencies.generateId();
    const protectedClientState = await envelope.encrypt(
      begun.protectedState,
      envelopeBinding("web-bff-authorization-transaction", id),
    );
    await repository.createBffAuthorization(
      webBffAuthorizationRecord({
        ...begun.binding,
        createdAt: iso(createdAt),
        id,
        protectedClientState,
        updatedAt: iso(createdAt),
        version: 1,
      }),
    );
    emit({ transactionId: id, type: "authorization.initiated" });
    const url = new URL(authorizationEndpoint);
    for (const [name, value] of Object.entries(begun.authorizationParameters)) {
      url.searchParams.set(name, value);
    }
    return {
      authorizationUrl: url.href,
      transactionCookie: begun.transactionCookie,
      transactionCookieMaxAgeSeconds: policy.authorizationLifetimeSeconds,
    };
  }

  async function completeCallback(input: CompleteCallbackInput): Promise<CompleteCallbackResult> {
    const reject = (reason: CallbackFailureReason, cause?: unknown) => {
      emit({ reason, type: "authorization.rejected" });
      return new WebBffCallbackError(reason, cause === undefined ? undefined : { cause });
    };
    if (!input.transactionCookie) throw reject("missing-transaction-cookie");
    const record = await repository.bffAuthorizationForHash(sha256(input.transactionCookie));
    if (!record) throw reject("unknown-transaction");
    const valid = callbackBindingIsValid({
      binding: record.data,
      callbackIssuer: input.iss,
      callbackState: input.state,
      configuredIssuer: dependencies.issuer,
      now: clock(),
      redirectUri: dependencies.redirectUri,
      transactionCookie: input.transactionCookie,
    });
    if (!valid) {
      throw reject(record.data.status === "pending" ? "binding-mismatch" : "duplicate-callback");
    }

    // Consume the exact observed pending version before any secret is decrypted or sent.
    const consumedAt = iso(clock().getTime());
    try {
      await repository.replacePendingBffAuthorization(
        record,
        webBffAuthorizationRecord({
          ...record.data,
          consumedAt,
          status: "consumed",
          updatedAt: consumedAt,
          version: record.data.version + 1,
        }),
      );
    } catch (error) {
      if (isDatabaseWriteConflict(error)) throw reject("duplicate-callback", error);
      throw error;
    }
    emit({ transactionId: record.data.id, type: "authorization.consumed" });
    if (input.error !== undefined || !input.code) throw reject("authorization-error");

    let protectedState: ProtectedAuthorizationState;
    try {
      protectedState = await envelope.decrypt<ProtectedAuthorizationState>(
        record.data.protectedClientState,
        envelopeBinding("web-bff-authorization-transaction", record.data.id),
      );
    } catch (error) {
      throw reject("decrypt-failed", error);
    }

    let tokens: OAuthTokenSet;
    try {
      tokens = await oidc.exchangeCode({
        code: input.code,
        codeVerifier: protectedState.pkceVerifier,
      });
    } catch (error) {
      throw reject("token-exchange-failed", error);
    }

    let failure: CallbackFailureReason = "token-response-incomplete";
    try {
      const { idToken, refreshToken } = tokens;
      if (!idToken || !refreshToken)
        throw new Error("Token response lacks an ID or refresh token.");
      failure = "id-token-invalid";
      const identity = await oidc.verifyIdToken(idToken, {
        code: input.code,
        nonceHash: record.data.nonceHash,
      });
      failure = "fence-rejected";
      const fence = await repository.bffFenceForPrincipal(identity.principalId);
      if (
        !fence ||
        fence.data.principalStatus !== "active" ||
        fence.data.sessionEpoch !== identity.sessionEpoch
      ) {
        throw new Error("The principal's revocation fence does not admit this login.");
      }
      failure = "credential-persistence-failed";
      const sessionCookie = randomToken(random);
      const sessionId = dependencies.generateId();
      const protectedCredentials = await envelope.encrypt(
        { accessToken: tokens.accessToken, refreshToken } satisfies ProtectedCredentials,
        envelopeBinding("web-bff-session", sessionId),
      );
      const createdAt = clock().getTime();
      const expiresAt = createdAt + policy.sessionAbsoluteLifetimeSeconds * 1_000;
      await repository.createBffSession(
        fence,
        webBffSessionRecord({
          accessTokenExpiresAt: iso(createdAt + tokens.expiresInSeconds * 1_000),
          clientId: WEB_BFF_CLIENT_ID,
          cookieTokenHash: sha256(sessionCookie),
          createdAt: iso(createdAt),
          expiresAt: iso(expiresAt),
          id: sessionId,
          idleExpiresAt: iso(
            Math.min(createdAt + policy.sessionIdleLifetimeSeconds * 1_000, expiresAt),
          ),
          principalId: identity.principalId,
          protectedCredentials,
          refreshCredentialVersion: 1,
          refreshState: "idle",
          sessionEpoch: identity.sessionEpoch,
          status: "active",
          updatedAt: iso(createdAt),
          version: 1,
        }),
      );
      emit({ sessionId, type: "session.created" });
      return {
        postLoginPath: protectedState.postLoginPath,
        sessionCookie,
        sessionCookieMaxAgeSeconds: policy.sessionAbsoluteLifetimeSeconds,
      };
    } catch (error) {
      // The exchange succeeded but no session committed: revoke rather than strand the grant.
      await revokeQuietly(tokens.refreshToken);
      throw reject(failure, error);
    }
  }

  /**
   * Lease-holder refresh. Returns undefined when another request won the lease, so the caller
   * re-reads. Never retries the refresh credential: any failure forces reauthentication.
   */
  async function refreshAsLeaseHolder(
    session: BffSession,
    idle: Extract<WebBffSessionData, { readonly refreshState: "idle" }>,
    fence: BffFence,
  ): Promise<SessionAccess | undefined> {
    const leasedAt = clock().getTime();
    const ownerToken = randomToken(random);
    const leased = webBffSessionRecord({
      ...sessionBase(idle),
      accessTokenExpiresAt: idle.accessTokenExpiresAt,
      ...(idle.lastRefreshedAt ? { lastRefreshedAt: idle.lastRefreshedAt } : {}),
      protectedCredentials: idle.protectedCredentials,
      refreshLeaseExpiresAt: iso(leasedAt + policy.refreshLeaseSeconds * 1_000),
      refreshLeaseOwnerHash: sha256(ownerToken),
      refreshState: "leased",
      status: "active",
      updatedAt: iso(leasedAt),
      version: idle.version + 1,
    });
    try {
      await repository.replaceBffSession(session, leased, fence);
    } catch (error) {
      if (isDatabaseWriteConflict(error)) return undefined;
      throw error;
    }
    emit({ sessionId: session.data.id, type: "session.refresh-lease-acquired" });

    let credentials: ProtectedCredentials;
    try {
      credentials = await decryptCredentials(leased);
    } catch {
      await invalidate(leased, "credentials-unreadable");
      throw new WebBffReauthenticationRequiredError("credentials-unreadable");
    }

    let tokens: OAuthTokenSet;
    try {
      tokens = await oidc.refresh(credentials.refreshToken);
    } catch (error) {
      // Definitive rejection and ambiguous outcomes both end here: the presented refresh token
      // may be consumed, so it is never retried.
      if (!(error instanceof OAuthTokenRequestError)) throw error;
      await invalidate(leased, "refresh-failed");
      throw new WebBffReauthenticationRequiredError("refresh-failed");
    }
    if (!tokens.refreshToken) {
      await invalidate(leased, "refresh-response-incomplete");
      throw new WebBffReauthenticationRequiredError("refresh-response-incomplete");
    }

    const completedAt = clock().getTime();
    let replacementCiphertext: string | undefined;
    try {
      const protectedCredentials = await envelope.encrypt(
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        } satisfies ProtectedCredentials,
        envelopeBinding("web-bff-session", session.data.id),
      );
      replacementCiphertext = protectedCredentials.ciphertext;
      const refreshed = webBffSessionRecord({
        ...sessionBase(leased.data),
        accessTokenExpiresAt: iso(completedAt + tokens.expiresInSeconds * 1_000),
        idleExpiresAt: iso(
          Math.min(
            completedAt + policy.sessionIdleLifetimeSeconds * 1_000,
            Date.parse(leased.data.expiresAt),
          ),
        ),
        lastRefreshedAt: iso(completedAt),
        protectedCredentials,
        refreshCredentialVersion: leased.data.refreshCredentialVersion + 1,
        refreshState: "idle",
        status: "active",
        updatedAt: iso(completedAt),
        version: leased.data.version + 1,
      });
      await repository.replaceBffSession(leased, refreshed);
    } catch {
      // The write may still have committed (ambiguous response); only an exact match proves it.
      const observed = await repository
        .bffSessionForHash(session.data.cookieTokenHash)
        .catch(() => undefined);
      if (
        observed?.data.status === "active" &&
        observed.data.version === leased.data.version + 1 &&
        observed.data.protectedCredentials.ciphertext === replacementCiphertext
      ) {
        emit({ sessionId: session.data.id, type: "session.refreshed" });
        return { accessToken: tokens.accessToken, principalId: session.data.principalId };
      }
      await revokeQuietly(tokens.refreshToken);
      if (observed?.data.version === leased.data.version) {
        await invalidate(leased, "refresh-commit-failed");
      }
      throw new WebBffReauthenticationRequiredError("refresh-commit-failed");
    }
    emit({ sessionId: session.data.id, type: "session.refreshed" });
    return { accessToken: tokens.accessToken, principalId: session.data.principalId };
  }

  async function requireAccessToken(sessionCookie: string | undefined): Promise<SessionAccess> {
    if (!sessionCookie) throw new WebBffReauthenticationRequiredError("missing-cookie");
    const cookieTokenHash = sha256(sessionCookie);
    const waitDeadline = clock().getTime() + policy.refreshWaitMilliseconds;
    let delay = policy.refreshWaitInitialDelayMilliseconds;
    for (let read = 0; read < MAXIMUM_STATE_READS; read += 1) {
      const session = await repository.bffSessionForHash(cookieTokenHash);
      if (!session) throw new WebBffReauthenticationRequiredError("unknown-session");
      if (session.data.status === "revoked")
        throw new WebBffReauthenticationRequiredError("revoked");
      if (session.data.status !== "active") {
        throw new WebBffReauthenticationRequiredError("reauthentication-required");
      }
      const now = clock().getTime();
      if (
        Date.parse(session.data.expiresAt) <= now ||
        Date.parse(session.data.idleExpiresAt) <= now
      ) {
        if (await invalidate(session, "session-expired")) {
          throw new WebBffReauthenticationRequiredError("session-expired");
        }
        continue;
      }
      // Strong, uncached fence read on every request before any credential is released.
      const fence = await repository.bffFenceForPrincipal(session.data.principalId);
      if (!fenceAdmits(fence, session)) {
        if (await invalidate(session, "fence-rejected")) {
          throw new WebBffReauthenticationRequiredError("fence-rejected");
        }
        continue;
      }
      if (session.data.refreshState === "leased") {
        if (Date.parse(session.data.refreshLeaseExpiresAt) <= now) {
          if (await invalidate(session, "refresh-lease-expired")) {
            throw new WebBffReauthenticationRequiredError("refresh-lease-expired");
          }
          continue;
        }
        if (now >= waitDeadline) throw new WebBffSessionBusyError();
        emit({ sessionId: session.data.id, type: "session.refresh-lease-contended" });
        await sleep(Math.min(delay * (0.5 + jitter()), waitDeadline - now));
        delay = Math.min(delay * 2, policy.refreshWaitMaximumDelayMilliseconds);
        continue;
      }
      const remaining = Date.parse(session.data.accessTokenExpiresAt) - now;
      if (remaining >= policy.minimumAccessTokenRemainingSeconds * 1_000) {
        let credentials: ProtectedCredentials;
        try {
          credentials = await decryptCredentials(session);
        } catch {
          if (await invalidate(session, "credentials-unreadable")) {
            throw new WebBffReauthenticationRequiredError("credentials-unreadable");
          }
          continue;
        }
        return { accessToken: credentials.accessToken, principalId: session.data.principalId };
      }
      const refreshed = await refreshAsLeaseHolder(session, session.data, fence);
      if (refreshed) return refreshed;
    }
    throw new WebBffSessionBusyError();
  }

  async function logout(sessionCookie: string | undefined) {
    if (!sessionCookie) return;
    const cookieTokenHash = sha256(sessionCookie);
    for (let attempt = 0; attempt < MAXIMUM_LOGOUT_ATTEMPTS; attempt += 1) {
      const session = await repository.bffSessionForHash(cookieTokenHash);
      if (!session || session.data.status === "revoked") return;
      const refreshToken =
        session.data.status === "active"
          ? await decryptCredentials(session).then(
              (credentials) => credentials.refreshToken,
              () => undefined,
            )
          : undefined;
      const at = iso(clock().getTime());
      try {
        await repository.replaceBffSession(
          session,
          webBffSessionRecord({
            ...sessionBase(session.data),
            revokedAt: at,
            status: "revoked",
            updatedAt: at,
            version: session.data.version + 1,
          }),
        );
      } catch (error) {
        if (isDatabaseWriteConflict(error)) continue;
        throw error;
      }
      emit({ sessionId: session.data.id, type: "session.revoked" });
      // Local logout is committed; remote revocation is best effort.
      await revokeQuietly(refreshToken);
      return;
    }
    throw new Error("BFF session logout could not commit because the session kept changing.");
  }

  return { beginLogin, completeCallback, logout, requireAccessToken };
}
