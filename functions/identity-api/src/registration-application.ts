import {
  acquireUniqueClaim,
  actionRecord,
  bffFenceRecord,
  identityRegistrationRecord,
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  makeUniqueClaimRecord,
  passwordCredentialRecord,
  pendingEmailDeliveryRecord,
  principalRecord,
  securityStateRecord,
  type IdentityRepository,
  type PlatformRecord,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
  uniqueClaimRequirements,
  type VerificationReissue,
  type VerificationReissueCommand,
} from "@deployments-ai/db";
import {
  IdentityError,
  emailClaimValue,
  hashPassword,
  normalizeEmail,
  randomToken,
  sha256,
  type PasswordProfile,
  type RandomSource,
} from "@deployments-ai/identity";
import { enforceIdentityRateLimits, type IdentityRateLimitPolicies } from "./rate-limits.ts";
import {
  commitPublicEmailNoop,
  makePublicEmailRequestMarker,
  publicEmailRequestWasProcessed,
} from "./public-email-deduplication.ts";
import { deliveryShard } from "./email-delivery-shard.ts";
import { plusSeconds } from "./time-arithmetic.ts";

const VERIFICATION_EMAIL_RESEND_SECONDS = 60;
const REGISTRATION_WRITE_ATTEMPTS = 5;

function put(record: PlatformRecord) {
  return { kind: "put" as const, record } as TransactionOperation;
}

export function makeRegistrationApplication(
  dependencies: {
    readonly encryptEmailPayload: (
      value: unknown,
      context: Readonly<Record<string, string>>,
    ) => Promise<ProtectedEnvelope>;
    readonly generateId: () => Ulid;
    readonly now: () => Date;
    readonly random: RandomSource;
    readonly repository: IdentityRepository;
  },
  config: {
    readonly actionLifetimeSeconds: number;
    readonly passwordProfile: PasswordProfile;
    readonly rateLimits?: IdentityRateLimitPolicies;
    readonly registrationLifetimeSeconds: number;
  },
) {
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

  async function verificationArtifacts(input: {
    readonly createdAt: string;
    readonly email: string;
    readonly emailHash: string;
    readonly principalId: Ulid;
    readonly timestamp: Date;
  }) {
    const actionId = dependencies.generateId();
    const deliveryId = dependencies.generateId();
    const rawActionToken = randomToken(dependencies.random);
    const expiresAt = plusSeconds(input.timestamp, config.actionLifetimeSeconds);
    const action = actionRecord({
      createdAt: input.createdAt,
      expiresAt,
      id: actionId,
      principalId: input.principalId,
      purpose: "verify-email",
      targetEmail: input.email,
      targetEmailHash: input.emailHash,
      tokenHash: sha256(rawActionToken),
    });
    const envelope = await dependencies.encryptEmailPayload(
      { actionToken: rawActionToken, recipient: input.email, schemaVersion: 1 },
      { actionId, deliveryId, purpose: "verify-email" },
    );
    const delivery = pendingEmailDeliveryRecord({
      actionId,
      createdAt: input.createdAt,
      dispatchShard: deliveryShard(deliveryId),
      expiresAt,
      id: deliveryId,
      principalId: input.principalId,
      protectedPayload: envelope,
      purpose: "verify-email",
    });
    return { action, delivery };
  }

  async function signUp(
    emailInput: string,
    sourceHash?: string,
    publicRequestId?: Ulid,
  ): Promise<void> {
    const email = normalizeEmail(emailInput);
    const emailHash = emailClaimValue(email);
    const timestamp = dependencies.now();
    const createdAt = timestamp.toISOString();
    const requestMarker = makePublicEmailRequestMarker(publicRequestId, "sign-up", timestamp);
    if (
      publicRequestId &&
      (await publicEmailRequestWasProcessed(dependencies.repository, publicRequestId, timestamp))
    ) {
      return;
    }
    if (config.rateLimits) {
      try {
        await enforceIdentityRateLimits({
          emailHash,
          emailPolicy: config.rateLimits.signUpEmail,
          limitKey: "sign-up",
          now: timestamp,
          repository: dependencies.repository,
          ...(publicRequestId ? { requestId: publicRequestId } : {}),
          ...(sourceHash ? { sourceHash } : {}),
          sourcePolicy: config.rateLimits.signUpSource,
        });
      } catch (error) {
        if (publicRequestId && error instanceof IdentityError && error.code === "slow_down") {
          await commitPublicEmailNoop(dependencies.repository, requestMarker, timestamp);
          return;
        }
        throw error;
      }
    }
    if (await dependencies.repository.principalForEmailHash(emailHash)) {
      await commitPublicEmailNoop(dependencies.repository, requestMarker, timestamp);
      return;
    }
    let lastConflict: unknown;
    for (let attempt = 0; attempt < REGISTRATION_WRITE_ATTEMPTS; attempt += 1) {
      const registration = await dependencies.repository.registrationForEmailHash(emailHash);
      if (
        registration &&
        Date.parse(registration.data.expiresAt) > timestamp.getTime() &&
        Date.parse(registration.data.verificationEmailSentAt) +
          VERIFICATION_EMAIL_RESEND_SECONDS * 1_000 >
          timestamp.getTime()
      ) {
        await commitPublicEmailNoop(dependencies.repository, requestMarker, timestamp);
        return;
      }
      const principalId = registration?.data.id ?? dependencies.generateId();
      const { action, delivery } = await verificationArtifacts({
        createdAt,
        email,
        emailHash,
        principalId,
        timestamp,
      });
      const nextRegistration = identityRegistrationRecord({
        createdAt: registration?.data.createdAt ?? createdAt,
        email,
        emailHash,
        expiresAt: plusSeconds(timestamp, config.registrationLifetimeSeconds),
        id: principalId,
        updatedAt: createdAt,
        verificationEmailSentAt: createdAt,
        version: (registration?.data.version ?? 0) + 1,
      });
      try {
        await dependencies.repository.transact([
          registration
            ? { kind: "put", previousRecord: registration, record: nextRegistration }
            : put(nextRegistration),
          put(action),
          put(delivery),
          put(
            await securityEvent({
              aggregateId: principalId,
              aggregateType: "identity-registration",
              aggregateVersion: nextRegistration.data.version,
              eventType: registration
                ? "identity.verification-email-reissued"
                : "identity.registration-created",
              principalId,
              timestamp: createdAt,
            }),
          ),
          ...(requestMarker ? [put(requestMarker)] : []),
        ]);
        return;
      } catch (error) {
        if (
          publicRequestId &&
          (await publicEmailRequestWasProcessed(
            dependencies.repository,
            publicRequestId,
            timestamp,
          ))
        ) {
          return;
        }
        if (!isDatabaseWriteConflict(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  async function verifyEmail(input: {
    readonly displayName?: string;
    readonly password: string;
    readonly token: string;
  }) {
    const tokenHash = sha256(input.token);
    const timestamp = dependencies.now();
    const updatedAt = timestamp.toISOString();
    const loadVerification = async () => {
      const action = await dependencies.repository.identityActionForHash(tokenHash);
      if (
        !action ||
        action.data.purpose !== "verify-email" ||
        action.data.status !== "pending" ||
        Date.parse(action.data.expiresAt) <= timestamp.getTime()
      ) {
        throw new IdentityError("invalid_grant", "Verification link is invalid or expired.");
      }
      const targetEmail = action.data.targetEmail;
      const targetEmailHash = action.data.targetEmailHash;
      if (!targetEmail || !targetEmailHash) {
        throw new IdentityError("invalid_grant", "Verification link is no longer usable.");
      }
      const registration = await dependencies.repository.registrationForEmailHash(targetEmailHash);
      if (
        !registration ||
        registration.data.id !== action.data.principalId ||
        registration.data.email !== targetEmail ||
        Date.parse(registration.data.expiresAt) <= timestamp.getTime() ||
        (await dependencies.repository.principalForEmailHash(targetEmailHash))
      ) {
        throw new IdentityError("invalid_grant", "Verification link is no longer usable.");
      }
      return { action, registration };
    };
    const initial = await loadVerification();
    const passwordHash = await hashPassword(input.password, config.passwordProfile);
    let lastConflict: unknown;
    for (let attempt = 0; attempt < REGISTRATION_WRITE_ATTEMPTS; attempt += 1) {
      const { action, registration } = attempt === 0 ? initial : await loadVerification();
      const consumedAction = {
        ...action,
        data: {
          ...action.data,
          consumedAt: updatedAt,
          status: "consumed" as const,
          updatedAt,
          version: action.data.version + 1,
        },
      };
      const principal = principalRecord({
        createdAt: updatedAt,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        id: registration.data.id,
        primaryEmail: registration.data.email,
      });
      const credential = passwordCredentialRecord({
        createdAt: updatedAt,
        passwordHash,
        ...(config.passwordProfile.pepperVersion
          ? { pepperVersion: config.passwordProfile.pepperVersion }
          : {}),
        principalId: registration.data.id,
        version: 1,
      });
      const security = securityStateRecord({
        createdAt: updatedAt,
        credentialVersion: 1,
        emailVerifiedAt: updatedAt,
        principalId: registration.data.id,
        sessionEpoch: 0,
        version: 1,
      });
      const fence = bffFenceRecord({
        createdAt: updatedAt,
        principalId: registration.data.id,
        principalStatus: "active",
        sessionEpoch: 0,
        version: 1,
      });
      const claimRequirement = uniqueClaimRequirements(principal)[0];
      if (!claimRequirement) throw new Error("Human principal did not derive an email claim.");
      const event = await securityEvent({
        aggregateId: registration.data.id,
        aggregateType: "principal",
        aggregateVersion: 1,
        eventType: "identity.principal-created",
        principalId: registration.data.id,
        timestamp: updatedAt,
      });
      try {
        await dependencies.repository.transact([
          { kind: "put", previousRecord: action, record: consumedAction },
          { kind: "delete", record: registration },
          put(principal),
          put(security),
          put(fence),
          put(credential),
          acquireUniqueClaim(
            makeUniqueClaimRecord(claimRequirement, updatedAt) as Parameters<
              typeof acquireUniqueClaim
            >[0],
          ),
          put(event),
        ]);
        // The verify page prefills sign-in with the address the person just proved they own.
        return { email: registration.data.email, principalId: registration.data.id };
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  /**
   * A platform administrator's resend for a sign-up still waiting on its email. It shares the
   * self-service limits: the same minimum gap since the last email and the same per-email hourly
   * count, so an operator cannot mail a person more often than the person could ask for.
   */
  async function reissueVerification(
    command: VerificationReissueCommand,
  ): Promise<VerificationReissue> {
    const principal = await dependencies.repository.principalForId(command.principalId);
    if (principal) {
      const security = await dependencies.repository.securityStateForPrincipal(principal.data.id);
      return {
        emailVerified: security?.data.emailVerifiedAt !== undefined,
        outcome: "principal-exists",
      };
    }
    if (command.email === undefined) return { outcome: "sign-up-not-found" };
    const email = normalizeEmail(command.email);
    const emailHash = emailClaimValue(email);
    let lastConflict: unknown;
    for (let attempt = 0; attempt < REGISTRATION_WRITE_ATTEMPTS; attempt += 1) {
      const timestamp = dependencies.now();
      const createdAt = timestamp.toISOString();
      const [holder, registration] = await Promise.all([
        dependencies.repository.principalForEmailHash(emailHash),
        dependencies.repository.registrationForEmailHash(emailHash),
      ]);
      if (
        holder ||
        !registration ||
        registration.data.id !== command.principalId ||
        Date.parse(registration.data.expiresAt) <= timestamp.getTime()
      ) {
        return { outcome: "sign-up-not-found" };
      }
      if (
        Date.parse(registration.data.verificationEmailSentAt) +
          VERIFICATION_EMAIL_RESEND_SECONDS * 1_000 >
        timestamp.getTime()
      ) {
        return { outcome: "rate-limited", reason: "recently-sent" };
      }
      if (attempt === 0 && config.rateLimits) {
        try {
          await enforceIdentityRateLimits({
            emailHash,
            emailPolicy: config.rateLimits.signUpEmail,
            limitKey: "sign-up",
            now: timestamp,
            repository: dependencies.repository,
            sourcePolicy: config.rateLimits.signUpSource,
          });
        } catch (error) {
          if (error instanceof IdentityError && error.code === "slow_down") {
            return { outcome: "rate-limited", reason: "hourly-limit" };
          }
          throw error;
        }
      }
      const principalId = registration.data.id;
      const { action, delivery } = await verificationArtifacts({
        createdAt,
        email,
        emailHash,
        principalId,
        timestamp,
      });
      const nextRegistration = identityRegistrationRecord({
        createdAt: registration.data.createdAt,
        email,
        emailHash,
        expiresAt: plusSeconds(timestamp, config.registrationLifetimeSeconds),
        id: principalId,
        updatedAt: createdAt,
        verificationEmailSentAt: createdAt,
        version: registration.data.version + 1,
      });
      try {
        await dependencies.repository.transact([
          { kind: "put", previousRecord: registration, record: nextRegistration },
          put(action),
          put(delivery),
          put(
            makeIdentitySecurityEventRecord({
              actor: { id: command.actorPrincipalId, type: "principal" },
              aggregateId: principalId,
              aggregateType: "identity-registration",
              aggregateVersion: nextRegistration.data.version,
              eventId: dependencies.generateId(),
              eventType: "identity.verification-email-reissued",
              occurredAt: createdAt,
              payload: { reason: command.reason },
              principalId,
            }),
          ),
        ]);
        return { email, outcome: "sent", principalId, sentAt: createdAt };
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  }

  return { reissueVerification, signUp, verifyEmail };
}
