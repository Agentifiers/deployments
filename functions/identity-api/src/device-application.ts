import {
  acquireExpiringUniqueClaim,
  deviceGrantRecord,
  federatedGrantRecord,
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  makeUniqueClaimRecord,
  refreshRecords,
  type IdentityRecord,
  type IdentityRepository,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  uniqueClaimRequirements,
} from "@deployments-ai/db";
import {
  accessTokenClaims,
  assertDeviceScopes,
  humanUserCode,
  IdentityError,
  normalizeUserCode,
  randomToken,
  refreshToken,
  sha256,
  validateScopes,
  type RandomSource,
  systemRandom,
} from "@deployments-ai/identity";
import { domainClient, type AuthenticatedBrowserSession } from "./oauth-application-support.ts";
import type { JwtSigner } from "./signer.ts";
import { plusSeconds } from "./time-arithmetic.ts";

export interface DeviceApplicationConfig {
  readonly accessTokenSeconds: number;
  /** The browser app that serves the `/device` approval page, such as the console. */
  readonly applicationOrigin: string;
  readonly deviceLifetimeSeconds: number;
  readonly issuer: string;
  readonly pollingIntervalSeconds: number;
  readonly refreshTokenSeconds: number;
  readonly resourceAudience: string;
}

export interface DeviceApplicationDependencies {
  readonly generateId: () => Ulid;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  readonly repository: IdentityRepository;
  readonly signer: JwtSigner;
}

/**
 * Why a person cannot use a user code. Each reason is its own page in the browser: an unknown
 * code may be a typo, while an expired or used one means starting the sign-in again.
 */
export type DeviceCodeRefusal = "expired" | "unknown" | "used";

const REFUSALS: Readonly<
  Record<DeviceCodeRefusal, { readonly code: "expired_token" | "invalid_grant"; message: string }>
> = {
  expired: { code: "expired_token", message: "Device authorization expired." },
  unknown: { code: "invalid_grant", message: "Device user code is invalid." },
  used: { code: "invalid_grant", message: "Device code was already used." },
};

export class DeviceCodeRefusedError extends IdentityError {
  constructor(readonly refusal: DeviceCodeRefusal) {
    super(REFUSALS[refusal].code, REFUSALS[refusal].message);
  }
}

/**
 * The signed-in person deciding on a code, and the identity browser session they decide from.
 * The grant binds to that session, and approval reads the authentication time from it.
 */
export type DeviceApprover = Pick<AuthenticatedBrowserSession, "principalId" | "sessionId">;

const put = (record: PlatformRecord): TransactionOperation => ({
  kind: "put",
  record,
});
const DEVICE_DECISION_WRITE_ATTEMPTS = 5;
const DEVICE_CONSUME_WRITE_ATTEMPTS = 5;
const DEVICE_CREATE_WRITE_ATTEMPTS = 5;
const DEVICE_CLAIM_WRITE_ATTEMPTS = 5;
const DEVICE_POLL_WRITE_ATTEMPTS = 5;

export function makeDeviceApplication(
  dependencies: DeviceApplicationDependencies,
  config: DeviceApplicationConfig,
) {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? systemRandom;

  async function client(clientId: string) {
    const record = await dependencies.repository.clientForId(clientId);
    if (
      !record ||
      record.data.status !== "active" ||
      record.data.type !== "public" ||
      !record.data.grantTypes.includes("urn:ietf:params:oauth:grant-type:device_code")
    ) {
      throw new IdentityError("unauthorized_client", "Client cannot use device authorization.");
    }
    return record;
  }

  async function authorize(input: {
    readonly clientId: string;
    readonly scopes: readonly string[];
  }) {
    const clientRecord = await client(input.clientId);
    assertDeviceScopes(input.scopes);
    const scopes = validateScopes(domainClient(clientRecord), input.scopes);
    for (let attempt = 0; attempt < DEVICE_CREATE_WRITE_ATTEMPTS; attempt += 1) {
      const timestamp = now();
      const createdAt = timestamp.toISOString();
      const rawDeviceCode = randomToken(random);
      const rawUserCode = humanUserCode(random);
      const grant = deviceGrantRecord({
        clientId: input.clientId,
        createdAt,
        deviceCodeHash: sha256(rawDeviceCode),
        expiresAt: plusSeconds(timestamp, config.deviceLifetimeSeconds),
        id: dependencies.generateId(),
        pollingIntervalSeconds: config.pollingIntervalSeconds,
        requestedScopes: scopes,
        userCodeHash: sha256(normalizeUserCode(rawUserCode)),
      });
      const requirement = uniqueClaimRequirements(grant)[0];
      if (!requirement) throw new Error("Device grant did not derive a user-code claim.");
      try {
        await dependencies.repository.transact([
          put(grant),
          acquireExpiringUniqueClaim(
            makeUniqueClaimRecord(requirement, createdAt) as Parameters<
              typeof acquireExpiringUniqueClaim
            >[0],
            createdAt,
          ),
        ]);
        return {
          device_code: rawDeviceCode,
          expires_in: config.deviceLifetimeSeconds,
          interval: config.pollingIntervalSeconds,
          user_code: rawUserCode,
          verification_uri: `${config.applicationOrigin}/device`,
          verification_uri_complete: `${config.applicationOrigin}/device?code=${encodeURIComponent(rawUserCode)}`,
        };
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
      }
    }
    throw new IdentityError(
      "temporarily_unavailable",
      "A unique device authorization could not be created.",
      { status: 503 },
    );
  }

  async function grantForUserCode(userCode: string) {
    const claim = await dependencies.repository.userCodeClaim(sha256(normalizeUserCode(userCode)));
    if (!claim) throw new DeviceCodeRefusedError("unknown");
    if (claim.data.expiresAt && Date.parse(claim.data.expiresAt) <= now().getTime()) {
      throw new DeviceCodeRefusedError("expired");
    }
    const grant = await dependencies.repository.deviceGrantForKey({
      pk: claim.data.ownerPk,
      sk: claim.data.ownerSk,
    });
    if (!grant || Date.parse(grant.data.expiresAt) <= now().getTime()) {
      throw new DeviceCodeRefusedError("expired");
    }
    return grant;
  }

  /** What the approval page shows: the requesting client by name and the signed-in account. */
  async function claimed(grant: IdentityRecord<"oauth-device-grant">, principalId: Ulid) {
    const [clientRecord, principal] = await Promise.all([
      dependencies.repository.clientForId(grant.data.clientId),
      dependencies.repository.principalForId(principalId),
    ]);
    return {
      account: {
        ...(principal?.data.displayName ? { displayName: principal.data.displayName } : {}),
        ...(principal?.data.primaryEmail ? { email: principal.data.primaryEmail } : {}),
      },
      approved: grant.data.status === "approved" || grant.data.status === "consumed",
      clientId: grant.data.clientId,
      clientName: clientRecord?.data.name ?? grant.data.clientId,
      requestedScopes: grant.data.requestedScopes,
    };
  }

  async function claim(userCode: string, browser: DeviceApprover) {
    for (let attempt = 0; attempt < DEVICE_CLAIM_WRITE_ATTEMPTS; attempt += 1) {
      const grant = await grantForUserCode(userCode);
      const boundToBrowser =
        grant.data.principalId === browser.principalId &&
        grant.data.claimedBySessionId === browser.sessionId;
      if (boundToBrowser && ["claimed", "approved", "consumed"].includes(grant.data.status)) {
        return claimed(grant, browser.principalId);
      }
      if (grant.data.status !== "pending") throw new DeviceCodeRefusedError("used");
      const updatedAt = now().toISOString();
      const claimedGrant = {
        ...grant,
        data: {
          ...grant.data,
          claimedBySessionId: browser.sessionId,
          principalId: browser.principalId,
          status: "claimed" as const,
          updatedAt,
          version: grant.data.version + 1,
        },
      };
      try {
        await dependencies.repository.transact([
          { kind: "put", previousRecord: grant, record: claimedGrant },
        ]);
        return claimed(grant, browser.principalId);
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
      }
    }
    throw new IdentityError(
      "temporarily_unavailable",
      "Device authorization could not be claimed because its state kept changing.",
      { status: 503 },
    );
  }

  async function decide(
    userCode: string,
    browser: DeviceApprover,
    decision: "approved" | "denied",
  ) {
    let lastConflict: unknown;
    for (let attempt = 0; attempt < DEVICE_DECISION_WRITE_ATTEMPTS; attempt += 1) {
      const grant = await grantForUserCode(userCode);
      const boundToBrowser =
        grant.data.principalId === browser.principalId &&
        grant.data.claimedBySessionId === browser.sessionId;
      const decisionApplied =
        boundToBrowser &&
        (decision === "approved"
          ? grant.data.approvedAt !== undefined &&
            (grant.data.status === "approved" || grant.data.status === "consumed")
          : grant.data.deniedAt !== undefined && grant.data.status === "denied");
      if (decisionApplied) return;
      if (grant.data.status === "pending") {
        throw new IdentityError("access_denied", "Device grant is not bound to this session.");
      }
      if (grant.data.status !== "claimed" || !boundToBrowser) {
        throw new DeviceCodeRefusedError("used");
      }
      const [security, principal, locator] = await Promise.all([
        dependencies.repository.securityStateForPrincipal(browser.principalId),
        dependencies.repository.principalForId(browser.principalId),
        dependencies.repository.sessionLocator(browser.principalId, browser.sessionId),
      ]);
      const linkedSession = locator
        ? await dependencies.repository.sessionForHash(locator.data.sessionTokenHash)
        : undefined;
      const timestamp = now();
      if (
        !security ||
        principal?.data.status !== "active" ||
        locator?.data.status !== "active" ||
        locator.data.sessionId !== browser.sessionId ||
        locator.data.principalId !== browser.principalId ||
        Date.parse(locator.data.expiresAt) <= timestamp.getTime() ||
        linkedSession?.data.status !== "active" ||
        linkedSession.data.id !== browser.sessionId ||
        linkedSession.data.principalId !== browser.principalId ||
        linkedSession.data.sessionEpoch !== security.data.sessionEpoch ||
        Date.parse(linkedSession.data.expiresAt) <= timestamp.getTime() ||
        Date.parse(linkedSession.data.idleExpiresAt) <= timestamp.getTime()
      ) {
        throw new IdentityError("access_denied", "Authentication session is no longer active.");
      }
      const updatedAt = timestamp.toISOString();
      const next = {
        ...grant,
        data: {
          ...grant.data,
          ...(decision === "approved"
            ? {
                approvedAt: updatedAt,
                approvedSessionEpoch: security.data.sessionEpoch,
                authentication: linkedSession.data.authentication,
                authenticationTime: linkedSession.data.authenticationTime,
              }
            : { deniedAt: updatedAt }),
          status: decision,
          updatedAt,
          version: grant.data.version + 1,
        },
      };
      try {
        await dependencies.repository.transact([
          ...dependencies.repository.loginMaterialVersionChecks(principal, security),
          ...dependencies.repository.browserSessionVersionChecks(locator, linkedSession),
          { kind: "put", previousRecord: grant, record: next },
          put(
            makeIdentitySecurityEventRecord({
              aggregateId: grant.data.id,
              aggregateType: "oauth-device-grant",
              aggregateVersion: next.data.version,
              eventId: dependencies.generateId(),
              eventType:
                decision === "approved"
                  ? "identity.device-grant-approved"
                  : "identity.device-grant-denied",
              occurredAt: updatedAt,
              payload: { clientId: grant.data.clientId },
              principalId: browser.principalId,
            }),
          ),
        ]);
        return;
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  async function pendingPoll(
    grant: IdentityRecord<"oauth-device-grant">,
    timestamp: Date,
  ): Promise<never> {
    const early = grant.data.nextPollAt && Date.parse(grant.data.nextPollAt) > timestamp.getTime();
    const interval = grant.data.pollingIntervalSeconds + (early ? 5 : 0);
    const updatedAt = timestamp.toISOString();
    const polled = {
      ...grant,
      data: {
        ...grant.data,
        lastPolledAt: updatedAt,
        nextPollAt: plusSeconds(timestamp, interval),
        pollingIntervalSeconds: interval,
        updatedAt,
        version: grant.data.version + 1,
      },
    };
    await dependencies.repository.transact([
      { kind: "put", previousRecord: grant, record: polled },
    ]);
    throw new IdentityError(early ? "slow_down" : "authorization_pending", "Pending.");
  }

  async function poll(
    input: { readonly clientId: string; readonly deviceCode: string },
    consumeAttempt = 0,
    pendingAttempt = 0,
  ) {
    const clientRecord = await client(input.clientId);
    const deviceCodeHash = sha256(input.deviceCode);
    let grant = await dependencies.repository.deviceGrantForHash(deviceCodeHash);
    const timestamp = now();
    if (!grant || grant.data.clientId !== input.clientId) {
      throw new IdentityError("invalid_grant", "Device code is invalid.");
    }
    if (Date.parse(grant.data.expiresAt) <= timestamp.getTime()) {
      throw new IdentityError("expired_token", "Device authorization expired.");
    }
    if (grant.data.status === "denied") {
      throw new IdentityError("access_denied", "Device authorization was denied.");
    }
    if (grant.data.status === "consumed") {
      throw new IdentityError("invalid_grant", "Device code was already consumed.");
    }
    if (grant.data.status !== "approved") {
      try {
        return await pendingPoll(grant, timestamp);
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        grant = await dependencies.repository.deviceGrantForHash(deviceCodeHash);
        if (!grant || grant.data.clientId !== input.clientId) {
          throw new IdentityError("invalid_grant", "Device code is invalid.");
        }
        if (Date.parse(grant.data.expiresAt) <= timestamp.getTime()) {
          throw new IdentityError("expired_token", "Device authorization expired.");
        }
        if (grant.data.status === "denied") {
          throw new IdentityError("access_denied", "Device authorization was denied.");
        }
        if (grant.data.status === "consumed") {
          throw new IdentityError("invalid_grant", "Device code was already consumed.");
        }
        if (grant.data.status !== "approved") {
          if (pendingAttempt + 1 < DEVICE_POLL_WRITE_ATTEMPTS) {
            return poll(input, consumeAttempt, pendingAttempt + 1);
          }
          throw new IdentityError(
            "temporarily_unavailable",
            "Device polling state could not be advanced because it kept changing.",
            { status: 503 },
          );
        }
      }
    }
    if (
      !grant.data.principalId ||
      grant.data.approvedSessionEpoch === undefined ||
      !grant.data.authenticationTime
    ) {
      throw new IdentityError("invalid_grant", "Approved grant is incomplete.");
    }
    validateScopes(domainClient(clientRecord), grant.data.requestedScopes);
    const material = await dependencies.repository.loadLoginMaterial(grant.data.principalId);
    if (
      material.principal?.data.status !== "active" ||
      material.securityState?.data.sessionEpoch !== grant.data.approvedSessionEpoch
    ) {
      throw new IdentityError("invalid_grant", "Approval is no longer active.");
    }
    const createdAt = timestamp.toISOString();
    const offline = grant.data.requestedScopes.includes("offline_access");
    const rawRefresh = offline ? refreshToken(random) : undefined;
    const refresh = offline
      ? refreshRecords({
          audience: config.resourceAudience,
          authenticationTime: grant.data.authenticationTime,
          clientId: grant.data.clientId,
          createdAt,
          expiresAt: plusSeconds(timestamp, config.refreshTokenSeconds),
          familyId: dependencies.generateId(),
          principalId: grant.data.principalId,
          scopes: grant.data.requestedScopes,
          sessionEpoch: grant.data.approvedSessionEpoch,
          tokenHash: sha256(rawRefresh!),
          tokenId: dependencies.generateId(),
        })
      : undefined;
    const consumed = {
      ...grant,
      data: {
        ...grant.data,
        consumedAt: createdAt,
        status: "consumed" as const,
        updatedAt: createdAt,
        version: grant.data.version + 1,
      },
    };
    const sid = refresh?.family.data.id ?? grant.data.id;
    const accessToken = await dependencies.signer.sign(
      accessTokenClaims({
        clientId: grant.data.clientId,
        emailVerified: material.securityState?.data.emailVerifiedAt !== undefined,
        issuedAt: timestamp,
        jti: dependencies.generateId(),
        policy: {
          accessTokenSeconds: config.accessTokenSeconds,
          idTokenSeconds: config.accessTokenSeconds,
          issuer: config.issuer,
          resourceAudience: config.resourceAudience,
        },
        principalId: grant.data.principalId,
        scopes: grant.data.requestedScopes,
        sessionId: sid,
      }),
    );
    const authentication = grant.data.authentication;
    const federatedGrant =
      authentication?.method === "federated"
        ? federatedGrantRecord({
            authentication,
            createdAt,
            principalId: grant.data.principalId,
            tokenSessionExpiresAt:
              refresh?.family.data.expiresAt ?? plusSeconds(timestamp, config.accessTokenSeconds),
            tokenSessionId: sid,
          })
        : undefined;
    try {
      await dependencies.repository.transact([
        ...dependencies.repository.loginMaterialVersionChecks(
          material.principal,
          material.securityState,
        ),
        { kind: "put", previousRecord: grant, record: consumed },
        ...(refresh ? [put(refresh.family), put(refresh.token)] : []),
        ...(federatedGrant ? [put(federatedGrant)] : []),
        put(
          makeIdentitySecurityEventRecord({
            aggregateId: grant.data.id,
            aggregateType: "oauth-device-grant",
            aggregateVersion: consumed.data.version,
            eventId: dependencies.generateId(),
            eventType: "identity.device-grant-consumed",
            occurredAt: createdAt,
            payload: { clientId: grant.data.clientId },
            principalId: grant.data.principalId,
          }),
        ),
      ]);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      const observed = await dependencies.repository.deviceGrantForHash(deviceCodeHash);
      if (observed?.data.status === "denied") {
        throw new IdentityError("access_denied", "Device authorization was denied.");
      }
      if (observed?.data.status === "approved") {
        if (consumeAttempt + 1 < DEVICE_CONSUME_WRITE_ATTEMPTS) {
          return poll(input, consumeAttempt + 1, pendingAttempt);
        }
        throw new IdentityError(
          "temporarily_unavailable",
          "Device authorization could not be completed because identity state kept changing.",
          { status: 503 },
        );
      }
      throw new IdentityError("invalid_grant", "Device code was already consumed.");
    }
    return {
      access_token: accessToken,
      expires_in: config.accessTokenSeconds,
      ...(rawRefresh ? { refresh_token: rawRefresh } : {}),
      scope: grant.data.requestedScopes.join(" "),
      token_type: "Bearer",
    };
  }

  return { authorize, claim, decide, poll };
}

export type DeviceApplication = ReturnType<typeof makeDeviceApplication>;
