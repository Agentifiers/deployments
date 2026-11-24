import {
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  type IdentityRepository,
  type IdentityLoginMaterial,
  type PlatformRecord,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import {
  DEFAULT_PASSWORD_PROFILE,
  IdentityError,
  emailClaimValue,
  normalizeEmail,
  sha256,
  verifyPasswordEqualized,
  type PasswordProfile,
  type RandomSource,
  systemRandom,
} from "@deployments-ai/identity";
import {
  makeAccountLifecycleApplication,
  type AccountLifecycleDependencies,
} from "./account-lifecycle-application.ts";
import {
  makeMfaApplication,
  mfaChallengeStep,
  type MfaSecretEnvelope,
  type SignInOutcome,
} from "./mfa-application.ts";
import { passwordSessionOperations } from "./password-session.ts";
import { enforceIdentityRateLimits, type IdentityRateLimitPolicies } from "./rate-limits.ts";
import { makeRegistrationApplication } from "./registration-application.ts";
import { makePasswordApplication } from "./password-application.ts";
import { makeSessionManagementApplication } from "./session-management.ts";
import { makeSessionRevocationApplication } from "./session-revocation.ts";

export interface IdentityApplicationConfig {
  readonly actionLifetimeSeconds: number;
  /** The account name authenticator apps show; defaults to the product name. */
  readonly mfaIssuerName?: string;
  readonly passwordProfiles?: readonly [PasswordProfile, PasswordProfile?];
  readonly rateLimits?: IdentityRateLimitPolicies;
  readonly registrationLifetimeSeconds?: number;
  readonly sessionAbsoluteLifetimeSeconds: number;
  readonly sessionIdleLifetimeSeconds: number;
}

export interface IdentityApplicationDependencies {
  readonly encryptEmailPayload: (
    value: unknown,
    context: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
  readonly generateId: () => Ulid;
  /** The person's organization ties; omitted where a test never changes an email or deletes. */
  readonly accountStanding?: AccountLifecycleDependencies["standing"];
  /** Seals TOTP secrets; omitted where a test never enrolls a factor. */
  readonly mfaSecrets?: MfaSecretEnvelope;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  readonly repository: IdentityRepository;
}

const FAILED_SIGN_IN_WRITE_ATTEMPTS = 5;
const SIGN_IN_WRITE_ATTEMPTS = 5;
const FAILURE_COUNT_DECAY_SECONDS = 15 * 60;

function put(record: PlatformRecord) {
  return { kind: "put" as const, record } as TransactionOperation;
}

export function makeIdentityApplication(
  dependencies: IdentityApplicationDependencies,
  config: IdentityApplicationConfig,
) {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? systemRandom;
  const profiles = config.passwordProfiles ?? [DEFAULT_PASSWORD_PROFILE];
  const registrationLifetimeSeconds = config.registrationLifetimeSeconds ?? 24 * 60 * 60;

  async function securityEvent(input: {
    aggregateId: Ulid;
    aggregateType: string;
    aggregateVersion: number;
    eventType: string;
    principalId: Ulid;
    timestamp: string;
  }) {
    return makeIdentitySecurityEventRecord({
      aggregateId: input.aggregateId,
      aggregateType: input.aggregateType,
      aggregateVersion: input.aggregateVersion,
      eventId: dependencies.generateId(),
      eventType: input.eventType,
      occurredAt: input.timestamp,
      principalId: input.principalId,
    });
  }

  const registration = makeRegistrationApplication(
    { ...dependencies, now, random },
    {
      actionLifetimeSeconds: config.actionLifetimeSeconds,
      passwordProfile: profiles[0],
      ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
      registrationLifetimeSeconds,
    },
  );
  const passwords = makePasswordApplication(
    { ...dependencies, now, random },
    {
      actionLifetimeSeconds: config.actionLifetimeSeconds,
      notificationLifetimeSeconds: 24 * 60 * 60,
      passwordProfiles: profiles,
      ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
    },
  );
  const sessionRevocation = makeSessionRevocationApplication({ ...dependencies, now });
  const mfa = makeMfaApplication(
    {
      ...dependencies,
      now,
      random,
      secrets: dependencies.mfaSecrets ?? {
        decrypt: () => Promise.reject(new Error("MFA secrets are not configured.")),
        encrypt: () => Promise.reject(new Error("MFA secrets are not configured.")),
      },
    },
    {
      issuerName: config.mfaIssuerName ?? "Deployments.ai",
      passwordProfiles: profiles,
      ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
      sessionAbsoluteLifetimeSeconds: config.sessionAbsoluteLifetimeSeconds,
      sessionIdleLifetimeSeconds: config.sessionIdleLifetimeSeconds,
    },
  );
  const account = makeAccountLifecycleApplication(
    {
      ...dependencies,
      now,
      random,
      standing: dependencies.accountStanding ?? {
        federatedLinkRemovals: () =>
          Promise.reject(new Error("Account standing is not configured.")),
        leave: () => Promise.reject(new Error("Account standing is not configured.")),
        ties: () => Promise.reject(new Error("Account standing is not configured.")),
      },
    },
    mfa,
  );
  const sessionManagement = makeSessionManagementApplication({
    ...dependencies,
    authenticate: session,
    now,
  });
  async function recordFailedSignIn(principalId: Ulid) {
    let lastConflict: unknown;
    for (let attempt = 0; attempt < FAILED_SIGN_IN_WRITE_ATTEMPTS; attempt += 1) {
      const material = await dependencies.repository.loadLoginMaterial(principalId);
      const timestamp = now();
      if (
        material.principal?.data.status !== "active" ||
        material.credential?.data.status !== "active" ||
        !material.securityState
      ) {
        return;
      }
      const previousFailureAt = material.securityState.data.authenticationFailedAt;
      const previousFailureCount = material.securityState.data.authenticationFailureCount ?? 0;
      const authenticationFailureCount =
        previousFailureAt &&
        Date.parse(previousFailureAt) + FAILURE_COUNT_DECAY_SECONDS * 1_000 > timestamp.getTime()
          ? previousFailureCount + 1
          : 1;
      const updatedAt = timestamp.toISOString();
      const security = {
        ...material.securityState,
        data: {
          ...material.securityState.data,
          authenticationFailedAt: updatedAt,
          authenticationFailureCount,
          updatedAt,
          version: material.securityState.data.version + 1,
        },
      };
      try {
        await dependencies.repository.transact([
          {
            kind: "put",
            previousRecord: material.securityState,
            record: security,
          },
          put(
            await securityEvent({
              aggregateId: principalId,
              aggregateType: "principal-security-state",
              aggregateVersion: security.data.version,
              eventType: "identity.sign-in-failed",
              principalId,
              timestamp: updatedAt,
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

  async function signIn(
    input: {
      readonly email: string;
      readonly ipPrefixHash?: string;
      readonly password: string;
      readonly deviceLabel?: string;
      readonly userAgentHash?: string;
    },
    writeAttempt = 0,
  ): Promise<SignInOutcome> {
    const email = normalizeEmail(input.email);
    const emailHash = emailClaimValue(email);
    const requestTimestamp = now();
    if (config.rateLimits && writeAttempt === 0) {
      await enforceIdentityRateLimits({
        limitKey: "sign-in",
        now: requestTimestamp,
        repository: dependencies.repository,
        ...(input.ipPrefixHash ? { sourceHash: input.ipPrefixHash } : {}),
        sourcePolicy: config.rateLimits.signInSource,
      });
    }
    const principal = await dependencies.repository.principalForEmailHash(emailHash);
    const material: IdentityLoginMaterial = principal
      ? await dependencies.repository.loadLoginMaterial(principal.data.id)
      : {
          credential: undefined,
          principal: undefined,
          securityState: undefined,
        };
    const verification = await verifyPasswordEqualized({
      ...(material.credential ? { encodedHash: material.credential.data.passwordHash } : {}),
      password: input.password,
      profiles,
    });
    const timestamp = requestTimestamp;
    // Account failure counters are attacker-influenced telemetry, never an authorization gate.
    // The durable source-prefix limit bounds pre-KDF attempts without letting a third party lock
    // the email owner out after they present the correct password.
    const eligible =
      verification.matched &&
      material.principal?.data.status === "active" &&
      material.credential?.data.status === "active" &&
      material.securityState?.data.emailVerifiedAt !== undefined;
    if (!eligible || !material.principal || !material.credential || !material.securityState) {
      if (!verification.matched && material.principal) {
        await recordFailedSignIn(material.principal.data.id).catch(() => undefined);
      }
      throw new IdentityError("access_denied", "Email or password is incorrect.");
    }
    const complete = {
      credential: material.credential,
      principal: material.principal,
      securityState: material.securityState,
    };
    const replacementHash = verification.needsRehash ? verification.replacementHash : undefined;
    const factor = await dependencies.repository.mfaFactorForPrincipal(material.principal.data.id);
    const step =
      factor?.data.state === "active"
        ? mfaChallengeStep({
            generateId: dependencies.generateId,
            material: complete,
            random,
            ...(replacementHash ? { replacementHash } : {}),
            timestamp,
          })
        : (() => {
            const signedIn = passwordSessionOperations({
              generateId: dependencies.generateId,
              ...(input.ipPrefixHash ? { ipPrefixHash: input.ipPrefixHash } : {}),
              material: complete,
              policy: config,
              random,
              ...(replacementHash ? { replacementHash } : {}),
              timestamp,
              ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
              ...(input.userAgentHash ? { userAgentHash: input.userAgentHash } : {}),
            });
            return {
              operations: [
                ...signedIn.operations,
                dependencies.repository.mfaFactorInactiveCheck(complete.principal.data.id),
              ],
              outcome: { kind: "signed-in", ...signedIn.session } satisfies SignInOutcome,
            };
          })();
    const { operations } = step;
    try {
      await dependencies.repository.transact(operations);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      if (writeAttempt + 1 < SIGN_IN_WRITE_ATTEMPTS) {
        return signIn(input, writeAttempt + 1);
      }
      throw new IdentityError(
        "temporarily_unavailable",
        "Sign-in could not be completed because identity state kept changing.",
        { status: 503 },
      );
    }
    return step.outcome;
  }

  async function session(rawToken: string) {
    const tokenHash = sha256(rawToken);
    let record = await dependencies.repository.sessionForHash(tokenHash);
    const timestampDate = now();
    const timestamp = timestampDate.getTime();
    if (
      !record ||
      record.data.status !== "active" ||
      Date.parse(record.data.expiresAt) <= timestamp ||
      Date.parse(record.data.idleExpiresAt) <= timestamp
    ) {
      return undefined;
    }
    let material = await dependencies.repository.loadLoginMaterial(record.data.principalId);
    if (
      material.principal?.data.status !== "active" ||
      !material.securityState ||
      material.securityState.data.sessionEpoch !== record.data.sessionEpoch
    ) {
      return undefined;
    }
    let principal = material.principal;
    const renewalThresholdMs =
      Math.max(1, Math.floor(config.sessionIdleLifetimeSeconds / 2)) * 1_000;
    const nextIdleExpiration = Math.min(
      Date.parse(record.data.expiresAt),
      timestamp + config.sessionIdleLifetimeSeconds * 1_000,
    );
    if (
      Date.parse(record.data.idleExpiresAt) - timestamp <= renewalThresholdMs &&
      nextIdleExpiration > Date.parse(record.data.idleExpiresAt)
    ) {
      const updatedAt = timestampDate.toISOString();
      const renewed = {
        ...record,
        data: {
          ...record.data,
          idleExpiresAt: new Date(nextIdleExpiration).toISOString(),
          lastRefreshedAt: updatedAt,
          updatedAt,
          version: record.data.version + 1,
        },
      };
      try {
        await dependencies.repository.transact([
          ...dependencies.repository.loginMaterialVersionChecks(
            material.principal,
            material.securityState,
          ),
          { kind: "put", previousRecord: record, record: renewed },
          put(
            await securityEvent({
              aggregateId: record.data.id,
              aggregateType: "identity-session",
              aggregateVersion: renewed.data.version,
              eventType: "identity.session-refreshed",
              principalId: record.data.principalId,
              timestamp: updatedAt,
            }),
          ),
        ]);
        record = renewed;
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        const observed = await dependencies.repository.sessionForHash(tokenHash);
        if (
          !observed ||
          observed.data.id !== record.data.id ||
          observed.data.status !== "active" ||
          Date.parse(observed.data.expiresAt) <= timestamp ||
          Date.parse(observed.data.idleExpiresAt) <= timestamp
        ) {
          return undefined;
        }
        const observedMaterial = await dependencies.repository.loadLoginMaterial(
          observed.data.principalId,
        );
        if (
          observedMaterial.principal?.data.status !== "active" ||
          !observedMaterial.securityState ||
          observedMaterial.securityState.data.sessionEpoch !== observed.data.sessionEpoch
        ) {
          return undefined;
        }
        record = observed;
        principal = observedMaterial.principal;
      }
    }
    return {
      authentication: record.data.authentication,
      authenticationTime: record.data.authenticationTime,
      principal: principal.data,
      sessionId: record.data.id,
    };
  }

  async function signOutAll(principalId: Ulid) {
    const [security, fence] = await Promise.all([
      dependencies.repository.securityStateForPrincipal(principalId),
      dependencies.repository.bffFenceForPrincipal(principalId),
    ]);
    if (!security || !fence) throw new IdentityError("access_denied", "Session is invalid.");
    const updatedAt = now().toISOString();
    const nextSecurity = {
      ...security,
      data: {
        ...security.data,
        sessionEpoch: security.data.sessionEpoch + 1,
        updatedAt,
        version: security.data.version + 1,
      },
    };
    const nextFence = {
      ...fence,
      data: {
        ...fence.data,
        sessionEpoch: nextSecurity.data.sessionEpoch,
        updatedAt,
        version: fence.data.version + 1,
      },
    };
    await dependencies.repository.transact([
      { kind: "put", previousRecord: security, record: nextSecurity },
      { kind: "put", previousRecord: fence, record: nextFence },
      put(
        await securityEvent({
          aggregateId: principalId,
          aggregateType: "principal-security-state",
          aggregateVersion: nextSecurity.data.version,
          eventType: "identity.sessions-invalidated",
          principalId,
          timestamp: updatedAt,
        }),
      ),
    ]);
  }

  return {
    account,
    mfa,
    ...passwords,
    ...registration,
    ...sessionManagement,
    ...sessionRevocation,
    session,
    signIn,
    signOutAll,
  };
}

export type IdentityApplication = ReturnType<typeof makeIdentityApplication>;
