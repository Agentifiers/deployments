import {
  federatedGrantRecord,
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  reauthenticationRequestRecord,
  refreshRecords,
  withCanonicalRecordKeys,
  type IdentitySessionAuthentication,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  accessTokenClaims,
  idTokenClaims,
  IdentityError,
  narrowScopes,
  randomToken,
  refreshToken,
  sha256,
  validateScopes,
  validatePkce,
  systemRandom,
} from "@deployments-ai/identity";
import {
  activeRefreshConflict,
  authenticateClient,
  authenticationMethodReferences,
  put,
  refreshConflictUnavailable,
  REFRESH_WRITE_ATTEMPTS,
  type AuthenticatedBrowserSession,
  type ClientRecord,
  type OAuthApplicationConfig,
  type OAuthApplicationDependencies,
} from "./oauth-application-support.ts";
import { makeOAuthAuthorizationApplication } from "./oauth-authorization.ts";
import { makeOAuthRevocationApplication } from "./oauth-revocation.ts";
import { makeRefreshReuseApplication } from "./refresh-reuse.ts";
import { plusSeconds } from "./time-arithmetic.ts";

const AUTHORIZATION_CODE_WRITE_ATTEMPTS = 5;
// Presenting a rotated token again within this window retries a rotation whose response was lost.
// The API abandons this call after 5 s, this Lambda stops by 15 s, and the CLI retries on its next
// command, so a genuine retry lands well inside 60 s of rotatedAt.
const REFRESH_RETRY_GRACE_MS = 60_000;

export function makeOAuthApplication(
  dependencies: OAuthApplicationDependencies,
  config: OAuthApplicationConfig,
) {
  const random = dependencies.random ?? systemRandom;
  const now = dependencies.now ?? (() => new Date());
  const tokenPolicy = {
    accessTokenSeconds: config.accessTokenSeconds,
    idTokenSeconds: config.idTokenSeconds,
    issuer: config.issuer,
    resourceAudience: config.resourceAudience,
  };
  const revocation = makeOAuthRevocationApplication({ ...dependencies, now });
  const refreshReuse = makeRefreshReuseApplication(
    { ...dependencies, now },
    config.securityNotificationSeconds ?? 24 * 60 * 60,
  );

  async function client(clientId: string) {
    const record = await dependencies.repository.clientForId(clientId);
    if (!record || record.data.status !== "active") {
      throw new IdentityError("invalid_client", "Client authentication failed.");
    }
    return record;
  }

  async function beginReauthentication(input: {
    readonly previousSessionId?: Ulid;
    readonly requestFingerprint: string;
  }) {
    const timestamp = now();
    const createdAt = timestamp.toISOString();
    const token = randomToken(random);
    const request = reauthenticationRequestRecord({
      createdAt,
      expiresAt: plusSeconds(timestamp, config.authorizationRequestSeconds),
      id: dependencies.generateId(),
      ...(input.previousSessionId ? { previousSessionId: input.previousSessionId } : {}),
      requestFingerprint: input.requestFingerprint,
      tokenHash: sha256(token),
    });
    await dependencies.repository.transact([put(request)]);
    return token;
  }

  async function reauthenticationForSession(input: {
    readonly browserSession: AuthenticatedBrowserSession;
    readonly requestFingerprint: string;
    readonly token: string;
  }) {
    const request = await dependencies.repository.reauthenticationRequestForHash(
      sha256(input.token),
    );
    const authorizationTime = Date.parse(input.browserSession.authenticationTime);
    if (
      !request ||
      request.data.status !== "pending" ||
      request.data.requestFingerprint !== input.requestFingerprint ||
      Date.parse(request.data.expiresAt) <= now().getTime() ||
      authorizationTime < Date.parse(request.data.createdAt) ||
      request.data.previousSessionId === input.browserSession.sessionId
    ) {
      throw new IdentityError("login_required", "Fresh authentication is required.");
    }
    return request;
  }

  async function validateReauthentication(input: {
    readonly browserSession: AuthenticatedBrowserSession;
    readonly requestFingerprint: string;
    readonly token: string;
  }) {
    await reauthenticationForSession(input);
  }

  const authorization = makeOAuthAuthorizationApplication({
    client,
    config,
    dependencies,
    reauthenticationForSession,
  });

  function assertGrantType(record: ClientRecord, grantType: string) {
    if (!record.data.grantTypes.includes(grantType)) {
      throw new IdentityError(
        "unauthorized_client",
        `Client is not authorized for the ${grantType} grant.`,
        { exposeDescription: true },
      );
    }
  }

  async function issueTokens(input: {
    /** The browser session's authentication; the ID token reports it as `amr`. */
    readonly authentication: IdentitySessionAuthentication | undefined;
    readonly authenticationTime: string;
    readonly browserSessionId?: Ulid;
    readonly clientId: string;
    readonly emailVerified: boolean;
    readonly nonce?: string;
    readonly principalId: Ulid;
    readonly scopes: readonly string[];
    readonly sessionEpoch: number;
    readonly sid: Ulid;
  }) {
    const issuedAt = now();
    const principal = await dependencies.repository.principalForId(input.principalId);
    if (!principal) throw new IdentityError("invalid_grant", "Principal no longer exists.");
    const accessClaims = accessTokenClaims({
      clientId: input.clientId,
      emailVerified: input.emailVerified,
      issuedAt,
      jti: dependencies.generateId(),
      policy: tokenPolicy,
      principalId: input.principalId,
      scopes: input.scopes,
      sessionId: input.sid,
    });
    const identityClaims = idTokenClaims({
      authenticationMethods: input.authentication
        ? authenticationMethodReferences(input.authentication)
        : undefined,
      authenticationTime: new Date(input.authenticationTime),
      clientId: input.clientId,
      ...(principal.data.displayName ? { displayName: principal.data.displayName } : {}),
      ...(principal.data.primaryEmail ? { email: principal.data.primaryEmail } : {}),
      emailVerified: input.emailVerified,
      issuedAt,
      ...(input.nonce ? { nonce: input.nonce } : {}),
      policy: tokenPolicy,
      principalId: input.principalId,
      scopes: input.scopes,
      sessionEpoch: input.sessionEpoch,
    });
    const [accessToken, idToken] = await Promise.all([
      dependencies.signer.sign(accessClaims),
      identityClaims ? dependencies.signer.sign(identityClaims) : Promise.resolve(undefined),
    ]);
    return {
      accessToken,
      expiresIn: config.accessTokenSeconds,
      ...(idToken ? { idToken } : {}),
    };
  }

  async function exchangeAuthorizationCode(
    input: {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly code: string;
      readonly codeVerifier: string;
      readonly redirectUri: string;
    },
    writeAttempt = 0,
  ) {
    const clientRecord = await client(input.clientId);
    authenticateClient(clientRecord, input.clientSecret, now);
    assertGrantType(clientRecord, "authorization_code");
    const code = await dependencies.repository.authorizationCodeForHash(sha256(input.code));
    const timestamp = now();
    if (
      !code ||
      code.data.status !== "active" ||
      code.data.clientId !== input.clientId ||
      code.data.redirectUri !== input.redirectUri ||
      Date.parse(code.data.expiresAt) <= timestamp.getTime()
    ) {
      throw new IdentityError("invalid_grant", "Authorization code is invalid.");
    }
    validatePkce({
      challenge: code.data.codeChallenge,
      method: code.data.codeChallengeMethod,
      verifier: input.codeVerifier,
    });
    const material = await dependencies.repository.loadLoginMaterial(code.data.principalId);
    const locator = await dependencies.repository.sessionLocator(
      code.data.principalId,
      code.data.browserSessionId,
    );
    const linkedSession = locator
      ? await dependencies.repository.sessionForHash(locator.data.sessionTokenHash)
      : undefined;
    if (
      material.principal?.data.status !== "active" ||
      !material.securityState ||
      material.securityState.data.sessionEpoch !== code.data.sessionEpoch ||
      locator?.data.status !== "active" ||
      locator.data.sessionId !== code.data.browserSessionId ||
      locator.data.principalId !== code.data.principalId ||
      Date.parse(locator.data.expiresAt) <= timestamp.getTime() ||
      linkedSession?.data.status !== "active" ||
      linkedSession.data.id !== code.data.browserSessionId ||
      linkedSession.data.principalId !== code.data.principalId ||
      linkedSession.data.sessionEpoch !== code.data.sessionEpoch ||
      Date.parse(linkedSession.data.expiresAt) <= timestamp.getTime() ||
      Date.parse(linkedSession.data.idleExpiresAt) <= timestamp.getTime()
    ) {
      throw new IdentityError("invalid_grant", "Authorization session is no longer active.");
    }
    const consumedAt = timestamp.toISOString();
    const consumed = {
      ...code,
      data: {
        ...code.data,
        consumedAt,
        status: "consumed" as const,
        updatedAt: consumedAt,
        version: code.data.version + 1,
      },
    };
    const offline = code.data.scopes.includes("offline_access");
    const rawRefresh = offline ? refreshToken(random) : undefined;
    const refresh = offline
      ? refreshRecords({
          audience: config.resourceAudience,
          authenticationTime: code.data.authenticationTime,
          browserSessionId: code.data.browserSessionId,
          clientId: input.clientId,
          createdAt: consumedAt,
          expiresAt: plusSeconds(timestamp, config.refreshTokenSeconds),
          familyId: dependencies.generateId(),
          principalId: code.data.principalId,
          scopes: code.data.scopes,
          sessionEpoch: code.data.sessionEpoch,
          tokenHash: sha256(rawRefresh!),
          tokenId: dependencies.generateId(),
        })
      : undefined;
    const sid = refresh?.family.data.id ?? code.data.id;
    const tokens = await issueTokens({
      authentication: linkedSession.data.authentication,
      authenticationTime: code.data.authenticationTime,
      browserSessionId: code.data.browserSessionId,
      clientId: input.clientId,
      emailVerified: material.securityState.data.emailVerifiedAt !== undefined,
      ...(code.data.nonce ? { nonce: code.data.nonce } : {}),
      principalId: code.data.principalId,
      scopes: code.data.scopes,
      sessionEpoch: code.data.sessionEpoch,
      sid,
    });
    const authentication = linkedSession.data.authentication;
    const federatedGrant =
      authentication.method === "federated"
        ? federatedGrantRecord({
            authentication,
            createdAt: consumedAt,
            principalId: code.data.principalId,
            tokenSessionExpiresAt: refresh?.family.data.expiresAt ?? linkedSession.data.expiresAt,
            tokenSessionId: sid,
          })
        : undefined;
    const event = makeIdentitySecurityEventRecord({
      aggregateId: code.data.id,
      aggregateType: "oauth-authorization-code",
      aggregateVersion: consumed.data.version,
      eventId: dependencies.generateId(),
      eventType: "identity.authorization-code-consumed",
      occurredAt: consumedAt,
      principalId: code.data.principalId,
      payload: { clientId: input.clientId },
    });
    try {
      await dependencies.repository.transact([
        ...dependencies.repository.loginMaterialVersionChecks(
          material.principal,
          material.securityState,
        ),
        ...dependencies.repository.browserSessionVersionChecks(locator, linkedSession),
        { kind: "put", previousRecord: code, record: consumed },
        ...(refresh ? [put(refresh.family), put(refresh.token)] : []),
        ...(federatedGrant ? [put(federatedGrant)] : []),
        put(event),
      ]);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      const observed = await dependencies.repository.authorizationCodeForHash(sha256(input.code));
      if (!observed || observed.data.status !== "active") {
        throw new IdentityError("invalid_grant", "Authorization code is no longer active.");
      }
      if (writeAttempt + 1 < AUTHORIZATION_CODE_WRITE_ATTEMPTS) {
        return exchangeAuthorizationCode(input, writeAttempt + 1);
      }
      throw new IdentityError(
        "temporarily_unavailable",
        "Authorization code exchange could not be completed because identity state kept changing.",
        { status: 503 },
      );
    }
    return {
      access_token: tokens.accessToken,
      expires_in: tokens.expiresIn,
      ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
      ...(rawRefresh ? { refresh_token: rawRefresh } : {}),
      scope: code.data.scopes.join(" "),
      token_type: "Bearer",
    };
  }

  async function exchangeRefreshToken(
    input: {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly refreshToken: string;
      readonly scopes?: readonly string[];
    },
    writeAttempt = 0,
  ) {
    const clientRecord = await client(input.clientId);
    authenticateClient(clientRecord, input.clientSecret, now);
    assertGrantType(clientRecord, "refresh_token");
    const token = await dependencies.repository.refreshTokenForHash(sha256(input.refreshToken));
    if (!token) throw new IdentityError("invalid_grant", "Refresh token is invalid.");
    const family = await dependencies.repository.refreshFamilyForId(token.data.familyId);
    if (
      !family ||
      family.data.clientId !== input.clientId ||
      family.data.audience !== config.resourceAudience
    ) {
      throw new IdentityError("invalid_grant", "Refresh token is invalid.");
    }
    const timestamp = now();
    const retriedSuccessor =
      token.data.status === "rotated" &&
      token.data.replacementTokenHash &&
      token.data.rotatedAt &&
      timestamp.getTime() - Date.parse(token.data.rotatedAt) <= REFRESH_RETRY_GRACE_MS
        ? await dependencies.repository.refreshTokenForHash(token.data.replacementTokenHash)
        : undefined;
    const head =
      token.data.status !== "rotated"
        ? token
        : retriedSuccessor?.data.status === "active"
          ? retriedSuccessor
          : undefined;
    if (!head) {
      await refreshReuse.compromiseRefreshFamily(family, token, input.clientId);
      throw new IdentityError("invalid_grant", "Refresh token reuse detected.");
    }
    const material = await dependencies.repository.loadLoginMaterial(family.data.principalId);
    const browserLocator = family.data.browserSessionId
      ? await dependencies.repository.sessionLocator(
          family.data.principalId,
          family.data.browserSessionId,
        )
      : undefined;
    const browserSession = browserLocator
      ? await dependencies.repository.sessionForHash(browserLocator.data.sessionTokenHash)
      : undefined;
    const browserSessionActive = family.data.browserSessionId
      ? browserLocator?.data.status === "active" &&
        browserLocator.data.sessionId === family.data.browserSessionId &&
        browserLocator.data.principalId === family.data.principalId &&
        Date.parse(browserLocator.data.expiresAt) > timestamp.getTime() &&
        browserSession?.data.status === "active" &&
        browserSession.data.id === family.data.browserSessionId &&
        browserSession.data.principalId === family.data.principalId &&
        browserSession.data.sessionEpoch === family.data.sessionEpoch &&
        Date.parse(browserSession.data.expiresAt) > timestamp.getTime() &&
        Date.parse(browserSession.data.idleExpiresAt) > timestamp.getTime()
      : true;
    if (
      head.data.status !== "active" ||
      family.data.status !== "active" ||
      Date.parse(family.data.expiresAt) <= timestamp.getTime() ||
      material.principal?.data.status !== "active" ||
      material.securityState?.data.sessionEpoch !== family.data.sessionEpoch ||
      !browserSessionActive
    ) {
      throw new IdentityError("invalid_grant", "Refresh token is no longer active.");
    }
    const scopes = narrowScopes(family.data.scopes, input.scopes);
    validateScopes(clientRecord.data, scopes);
    const rawReplacement = refreshToken(random);
    const replacementId = dependencies.generateId();
    const updatedAt = timestamp.toISOString();
    const {
      replacementTokenHash: _replacementTokenHash,
      rotatedAt: _rotatedAt,
      ...rotatableData
    } = head.data;
    const replacement = {
      ...head,
      data: {
        ...rotatableData,
        createdAt: updatedAt,
        generation: head.data.generation + 1,
        id: replacementId,
        status: "active" as const,
        tokenHash: sha256(rawReplacement),
        updatedAt,
        version: 1,
      },
    };
    const canonicalReplacement = withCanonicalRecordKeys(replacement) as PlatformRecord;
    const rotated = {
      ...head,
      data: {
        ...head.data,
        replacementTokenHash: replacement.data.tokenHash,
        rotatedAt: updatedAt,
        status: "rotated" as const,
        updatedAt,
        version: head.data.version + 1,
      },
    };
    // A retried token keeps its first rotatedAt so retries cannot stretch its window.
    const retried =
      head === token
        ? []
        : [
            {
              kind: "put" as const,
              previousRecord: token,
              record: {
                ...token,
                data: {
                  ...token.data,
                  replacementTokenHash: replacement.data.tokenHash,
                  updatedAt,
                  version: token.data.version + 1,
                },
              },
            },
          ];
    const nextFamily = {
      ...family,
      data: {
        ...family.data,
        latestGeneration: replacement.data.generation,
        scopes,
        updatedAt,
        version: family.data.version + 1,
      },
    };
    const tokens = await issueTokens({
      authentication: browserSession?.data.authentication,
      authenticationTime: family.data.authenticationTime,
      ...(family.data.browserSessionId ? { browserSessionId: family.data.browserSessionId } : {}),
      clientId: family.data.clientId,
      emailVerified: material.securityState?.data.emailVerifiedAt !== undefined,
      principalId: family.data.principalId,
      scopes,
      sessionEpoch: family.data.sessionEpoch,
      sid: family.data.id,
    });
    try {
      await dependencies.repository.transact([
        ...dependencies.repository.loginMaterialVersionChecks(
          material.principal,
          material.securityState,
        ),
        // A console in use refreshes about every 10 minutes, so stamping the browser session here
        // keeps the account page's "Last active" current without a write on every request.
        ...(browserLocator && browserSession
          ? dependencies.repository.browserSessionActivity(
              browserLocator,
              browserSession,
              updatedAt,
            )
          : []),
        { kind: "put", previousRecord: head, record: rotated },
        ...retried,
        put(canonicalReplacement),
        { kind: "put", previousRecord: family, record: nextFamily },
        put(
          makeIdentitySecurityEventRecord({
            aggregateId: family.data.id,
            aggregateType: "oauth-refresh-family",
            aggregateVersion: nextFamily.data.version,
            eventId: dependencies.generateId(),
            eventType: "identity.refresh-rotated",
            occurredAt: updatedAt,
            principalId: family.data.principalId,
            payload: {
              clientId: input.clientId,
              generation: replacement.data.generation,
              ...(head === token ? {} : { retriedGeneration: token.data.generation }),
            },
          }),
        ),
      ]);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      const [observedToken, observedFamily] = await Promise.all([
        dependencies.repository.refreshTokenForHash(sha256(input.refreshToken)),
        dependencies.repository.refreshFamilyForId(family.data.id),
      ]);
      // A concurrent exchange of the same token won; its successor stays the live one.
      if (observedToken?.data.status === "rotated" && observedFamily?.data.status === "active") {
        throw refreshConflictUnavailable();
      }
      if (activeRefreshConflict(observedToken, observedFamily, input.clientId)) {
        if (writeAttempt + 1 < REFRESH_WRITE_ATTEMPTS) {
          return exchangeRefreshToken(input, writeAttempt + 1);
        }
        throw refreshConflictUnavailable();
      }
      throw new IdentityError("invalid_grant", "Refresh token is no longer active.");
    }
    return {
      access_token: tokens.accessToken,
      expires_in: tokens.expiresIn,
      ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
      refresh_token: rawReplacement,
      scope: scopes.join(" "),
      token_type: "Bearer",
    };
  }

  return {
    beginReauthentication,
    ...authorization,
    client,
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    ...revocation,
    validateReauthentication,
  };
}

export type OAuthApplication = ReturnType<typeof makeOAuthApplication>;
