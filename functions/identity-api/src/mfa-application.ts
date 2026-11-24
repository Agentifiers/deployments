import {
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  mfaChallengeRecord,
  mfaFactorRecord,
  pendingEmailDeliveryRecord,
  type IdentityLoginMaterial,
  type IdentityRecord,
  type IdentityRepository,
  type MfaFactorData,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import {
  IdentityError,
  constantTimeTextEqual,
  generateRecoveryCodes,
  generateTotpSecret,
  looksLikeRecoveryCode,
  matchTotpStep,
  randomToken,
  recoveryCodeHash,
  sha256,
  totpUri,
  verifyPasswordEqualized,
  type PasswordProfile,
  type RandomSource,
} from "@deployments-ai/identity";
import { deliveryShard } from "./email-delivery-shard.ts";
import {
  passwordMaterialOperations,
  passwordSessionOperations,
  type PasswordSession,
  type PasswordSessionPolicy,
  type PasswordSignInMaterial,
} from "./password-session.ts";
import { enforcePrincipalRateLimit, type IdentityRateLimitPolicies } from "./rate-limits.ts";
import { plusSeconds } from "./time-arithmetic.ts";

/** KMS encryption-context purpose binding every stored TOTP secret to its principal. */
export const MFA_SECRET_PURPOSE = "mfa-totp-secret";
const CHALLENGE_LIFETIME_SECONDS = 5 * 60;
const NOTICE_LIFETIME_SECONDS = 24 * 60 * 60;
const SIGN_IN_WRITE_ATTEMPTS = 3;

type FactorRecord = IdentityRecord<"principal-mfa-factor">;
type ActiveFactor = Extract<MfaFactorData, { readonly state: "active" }>;
type FactorProof =
  | { readonly kind: "recovery-code"; readonly index: number }
  | { readonly kind: "totp"; readonly step: number };

export type SignInOutcome =
  | ({ readonly kind: "signed-in" } & PasswordSession)
  | {
      readonly challengeToken: string;
      readonly expiresAt: string;
      readonly kind: "mfa-required";
    };

export interface AccountSecurity {
  readonly mfa:
    | { readonly state: "off" }
    | {
        readonly activatedAt: string;
        readonly recoveryCodesRemaining: number;
        readonly state: "on";
      };
  readonly passwordSignIn: boolean;
}

export interface MfaSecretEnvelope {
  readonly decrypt: <Value>(
    envelope: ProtectedEnvelope,
    binding: Readonly<Record<string, string>>,
  ) => Promise<Value>;
  readonly encrypt: (
    value: unknown,
    binding: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
}

export interface MfaApplicationDependencies {
  readonly encryptEmailPayload: (
    value: unknown,
    context: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
  readonly generateId: () => Ulid;
  readonly now: () => Date;
  readonly random: RandomSource;
  readonly repository: IdentityRepository;
  readonly secrets: MfaSecretEnvelope;
}

export interface MfaApplicationConfig extends PasswordSessionPolicy {
  /** The name authenticator apps show beside the account. */
  readonly issuerName: string;
  readonly passwordProfiles: readonly [PasswordProfile, PasswordProfile?];
  readonly rateLimits?: Pick<IdentityRateLimitPolicies, "verificationPrincipal">;
}

/** The second sign-in step a correct password leads to while the principal has an active factor. */
export function mfaChallengeStep(input: {
  readonly generateId: () => Ulid;
  readonly material: PasswordSignInMaterial;
  readonly random: RandomSource;
  readonly replacementHash?: string;
  readonly timestamp: Date;
}): { readonly operations: TransactionOperation[]; readonly outcome: SignInOutcome } {
  const createdAt = input.timestamp.toISOString();
  const challengeToken = randomToken(input.random);
  const expiresAt = plusSeconds(input.timestamp, CHALLENGE_LIFETIME_SECONDS);
  const challenge = mfaChallengeRecord({
    createdAt,
    credentialVersion: input.material.securityState.data.credentialVersion,
    expiresAt,
    id: input.generateId(),
    principalId: input.material.principal.data.id,
    sessionEpoch: input.material.securityState.data.sessionEpoch,
    tokenHash: sha256(challengeToken),
  });
  return {
    operations: [
      ...passwordMaterialOperations({
        material: input.material,
        ...(input.replacementHash ? { replacementHash: input.replacementHash } : {}),
        updatedAt: createdAt,
      }),
      { kind: "put", record: challenge },
    ],
    outcome: { challengeToken, expiresAt, kind: "mfa-required" },
  };
}

function exposed(code: "access_denied" | "invalid_request", message: string, status?: number) {
  return new IdentityError(code, message, {
    exposeDescription: true,
    ...(status ? { status } : {}),
  });
}

const codeIncorrect = () => exposed("access_denied", "The code is incorrect.");
const challengeInvalid = () =>
  exposed("access_denied", "This sign-in expired. Sign in again with your password.", 401);

function activeFactor(record: FactorRecord | undefined): ActiveFactor | undefined {
  return record?.data.state === "active" ? record.data : undefined;
}

function completeMaterial(material: IdentityLoginMaterial): PasswordSignInMaterial | undefined {
  return material.principal?.data.status === "active" &&
    material.credential?.data.status === "active" &&
    material.securityState?.data.emailVerifiedAt
    ? {
        credential: material.credential,
        principal: material.principal,
        securityState: material.securityState,
      }
    : undefined;
}

export function makeMfaApplication(
  dependencies: MfaApplicationDependencies,
  config: MfaApplicationConfig,
) {
  const { repository } = dependencies;
  const binding = (principalId: string) => ({ principalId, purpose: MFA_SECRET_PURPOSE });

  async function limit(principalId: string, at: Date) {
    if (!config.rateLimits) return;
    await enforcePrincipalRateLimit({
      limitKey: "verification",
      now: at,
      policy: config.rateLimits.verificationPrincipal,
      principalId,
      repository,
    });
  }

  async function secretOf(factor: {
    readonly principalId: string;
    readonly protectedSecret: ProtectedEnvelope;
  }) {
    const opened = await dependencies.secrets.decrypt<{ readonly secret: string }>(
      factor.protectedSecret,
      binding(factor.principalId),
    );
    return opened.secret;
  }

  async function prove(factor: ActiveFactor, code: string, at: Date) {
    if (looksLikeRecoveryCode(code)) {
      const hash = recoveryCodeHash(code);
      const index = factor.recoveryCodes.findIndex(
        (candidate) =>
          candidate.usedAt === undefined && constantTimeTextEqual(candidate.hash, hash),
      );
      return index < 0 ? undefined : ({ index, kind: "recovery-code" } as const);
    }
    const step = matchTotpStep({
      at,
      code,
      notAfterStep: factor.lastUsedStep,
      secret: await secretOf(factor),
    });
    return step === undefined ? undefined : ({ kind: "totp", step } as const);
  }

  function spent(factor: ActiveFactor, proof: FactorProof, updatedAt: string): ActiveFactor {
    return {
      ...factor,
      lastUsedStep: proof.kind === "totp" ? proof.step : factor.lastUsedStep,
      recoveryCodes:
        proof.kind === "recovery-code"
          ? factor.recoveryCodes.map((code, index) =>
              index === proof.index ? { ...code, usedAt: updatedAt } : code,
            )
          : factor.recoveryCodes,
      updatedAt,
      version: factor.version + 1,
    };
  }

  function transition(
    previous: FactorRecord | undefined,
    next: MfaFactorData,
    eventType: string,
  ): TransactionOperation[] {
    return [
      {
        kind: "put",
        ...(previous ? { previousRecord: previous } : {}),
        record: mfaFactorRecord(next),
      },
      {
        kind: "put",
        record: makeIdentitySecurityEventRecord({
          aggregateId: next.id,
          aggregateType: "principal-mfa-factor",
          aggregateVersion: next.version,
          eventId: dependencies.generateId(),
          eventType,
          occurredAt: next.updatedAt,
          principalId: next.principalId,
        }),
      },
    ];
  }

  async function notice(
    purpose: "mfa-disabled" | "mfa-enabled",
    principalId: Ulid,
    at: Date,
  ): Promise<TransactionOperation[]> {
    const principal = await repository.principalForId(principalId);
    const recipient = principal?.data.primaryEmail;
    if (!recipient) return [];
    const deliveryId = dependencies.generateId();
    const protectedPayload = await dependencies.encryptEmailPayload(
      { recipient, schemaVersion: 1 },
      { deliveryId, purpose },
    );
    return [
      {
        kind: "put",
        record: pendingEmailDeliveryRecord({
          createdAt: at.toISOString(),
          dispatchShard: deliveryShard(deliveryId),
          expiresAt: plusSeconds(at, NOTICE_LIFETIME_SECONDS),
          id: deliveryId,
          principalId,
          protectedPayload,
          purpose,
        }),
      },
    ];
  }

  async function commit(operations: readonly TransactionOperation[]) {
    try {
      await repository.transact(operations);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      throw exposed(
        "invalid_request",
        "Your security settings changed while this was saving. Reload and try again.",
        409,
      );
    }
  }

  async function requireActive(principalId: Ulid) {
    const record = await repository.mfaFactorForPrincipal(principalId);
    const factor = activeFactor(record);
    if (!record || !factor) {
      throw exposed("invalid_request", "Two-factor authentication is not on.", 409);
    }
    return { factor, record };
  }

  /**
   * Finishes a password sign-in that `mfaChallengeStep` paused. The challenge, the security state
   * it was issued under, and the factor's replay position all commit with the new session, so a
   * code, a recovery code, or the challenge itself works once.
   */
  async function completeSignIn(input: {
    readonly challengeToken: string;
    readonly code: string;
    readonly ipPrefixHash?: string;
    readonly deviceLabel?: string;
    readonly userAgentHash?: string;
  }): Promise<SignInOutcome> {
    const tokenHash = sha256(input.challengeToken);
    const load = async (at: Date) => {
      const challenge = await repository.mfaChallengeForHash(tokenHash);
      if (
        challenge?.data.status !== "pending" ||
        Date.parse(challenge.data.expiresAt) <= at.getTime()
      ) {
        throw challengeInvalid();
      }
      return challenge;
    };
    await limit((await load(dependencies.now())).data.principalId, dependencies.now());
    for (let attempt = 0; attempt < SIGN_IN_WRITE_ATTEMPTS; attempt += 1) {
      const timestamp = dependencies.now();
      const challenge = await load(timestamp);
      const principalId = challenge.data.principalId;
      const [loaded, record] = await Promise.all([
        repository.loadLoginMaterial(principalId),
        repository.mfaFactorForPrincipal(principalId),
      ]);
      const material = completeMaterial(loaded);
      const factor = activeFactor(record);
      if (
        !material ||
        !record ||
        !factor ||
        material.securityState.data.credentialVersion !== challenge.data.credentialVersion ||
        material.securityState.data.sessionEpoch !== challenge.data.sessionEpoch
      ) {
        throw challengeInvalid();
      }
      const proof = await prove(factor, input.code, timestamp);
      if (!proof) throw codeIncorrect();
      const updatedAt = timestamp.toISOString();
      const signedIn = passwordSessionOperations({
        generateId: dependencies.generateId,
        ...(input.ipPrefixHash ? { ipPrefixHash: input.ipPrefixHash } : {}),
        material,
        policy: config,
        random: dependencies.random,
        secondFactor: proof.kind,
        timestamp,
        ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
        ...(input.userAgentHash ? { userAgentHash: input.userAgentHash } : {}),
      });
      try {
        await repository.transact([
          ...signedIn.operations,
          {
            kind: "put",
            previousRecord: challenge,
            record: {
              ...challenge,
              data: {
                ...challenge.data,
                consumedAt: updatedAt,
                status: "consumed",
                updatedAt,
                version: challenge.data.version + 1,
              },
            },
          },
          ...transition(
            record,
            spent(factor, proof, updatedAt),
            proof.kind === "totp"
              ? "identity.mfa-code-accepted"
              : "identity.mfa-recovery-code-used",
          ),
        ]);
        return { kind: "signed-in", ...signedIn.session };
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
      }
    }
    throw new IdentityError(
      "temporarily_unavailable",
      "Sign-in could not be completed because identity state kept changing.",
      { status: 503 },
    );
  }

  async function accountSecurity(principalId: Ulid): Promise<AccountSecurity> {
    const [record, credential] = await Promise.all([
      repository.mfaFactorForPrincipal(principalId),
      repository.credentialForPrincipal(principalId),
    ]);
    const factor = activeFactor(record);
    return {
      mfa: factor
        ? {
            activatedAt: factor.activatedAt,
            recoveryCodesRemaining: factor.recoveryCodes.filter((code) => !code.usedAt).length,
            state: "on",
          }
        : { state: "off" },
      passwordSignIn: credential?.data.status === "active",
    };
  }

  /** Starts enrollment after the person proves their password again; returns the new secret. */
  async function beginEnrollment(input: { readonly password: string; readonly principalId: Ulid }) {
    const timestamp = dependencies.now();
    await limit(input.principalId, timestamp);
    const [loaded, record] = await Promise.all([
      repository.loadLoginMaterial(input.principalId),
      repository.mfaFactorForPrincipal(input.principalId),
    ]);
    const material = completeMaterial(loaded);
    const verification = await verifyPasswordEqualized({
      ...(material ? { encodedHash: material.credential.data.passwordHash } : {}),
      password: input.password,
      profiles: config.passwordProfiles,
    });
    if (!material || !verification.matched) {
      throw exposed("access_denied", "The password is incorrect.");
    }
    if (activeFactor(record)) {
      throw exposed("invalid_request", "Two-factor authentication is already on.", 409);
    }
    const secret = generateTotpSecret(dependencies.random);
    const updatedAt = timestamp.toISOString();
    await commit(
      transition(
        record,
        {
          createdAt: record?.data.createdAt ?? updatedAt,
          id: input.principalId,
          kind: "totp",
          principalId: input.principalId,
          protectedSecret: await dependencies.secrets.encrypt(
            { secret },
            binding(input.principalId),
          ),
          state: "pending",
          updatedAt,
          version: (record?.data.version ?? 0) + 1,
        },
        "identity.mfa-enrollment-started",
      ),
    );
    return {
      otpauthUri: totpUri({
        account: material.principal.data.primaryEmail ?? input.principalId,
        issuer: config.issuerName,
        secret,
      }),
      secret,
    };
  }

  /** Turns the pending factor on once a code proves the authenticator holds its secret. */
  async function confirmEnrollment(input: { readonly code: string; readonly principalId: Ulid }) {
    const timestamp = dependencies.now();
    await limit(input.principalId, timestamp);
    const record = await repository.mfaFactorForPrincipal(input.principalId);
    if (record?.data.state !== "pending") {
      throw exposed("invalid_request", "Start two-factor setup again.", 409);
    }
    const pending = record.data;
    const step = matchTotpStep({
      at: timestamp,
      code: input.code,
      secret: await secretOf(pending),
    });
    if (step === undefined) throw codeIncorrect();
    const recoveryCodes = generateRecoveryCodes(dependencies.random);
    const updatedAt = timestamp.toISOString();
    await commit([
      ...transition(
        record,
        {
          ...pending,
          activatedAt: updatedAt,
          lastUsedStep: step,
          recoveryCodes: recoveryCodes.map((code) => ({ hash: recoveryCodeHash(code) })),
          state: "active",
          updatedAt,
          version: pending.version + 1,
        },
        "identity.mfa-enabled",
      ),
      ...(await notice("mfa-enabled", input.principalId, timestamp)),
    ]);
    return { recoveryCodes };
  }

  /** Turns the factor off with a current code or an unused recovery code. */
  async function disable(input: { readonly code: string; readonly principalId: Ulid }) {
    const timestamp = dependencies.now();
    await limit(input.principalId, timestamp);
    const { factor, record } = await requireActive(input.principalId);
    if (!(await prove(factor, input.code, timestamp))) throw codeIncorrect();
    const updatedAt = timestamp.toISOString();
    await commit([
      ...transition(
        record,
        {
          createdAt: factor.createdAt,
          disabledAt: updatedAt,
          id: factor.id,
          kind: "totp",
          principalId: factor.principalId,
          state: "disabled",
          updatedAt,
          version: factor.version + 1,
        },
        "identity.mfa-disabled",
      ),
      ...(await notice("mfa-disabled", input.principalId, timestamp)),
    ]);
  }

  /** Replaces every recovery code; the code that authorizes it is spent too. */
  async function regenerateRecoveryCodes(input: {
    readonly code: string;
    readonly principalId: Ulid;
  }) {
    const timestamp = dependencies.now();
    await limit(input.principalId, timestamp);
    const { factor, record } = await requireActive(input.principalId);
    const proof = await prove(factor, input.code, timestamp);
    if (!proof) throw codeIncorrect();
    const recoveryCodes = generateRecoveryCodes(dependencies.random);
    const updatedAt = timestamp.toISOString();
    await commit(
      transition(
        record,
        {
          ...spent(factor, proof, updatedAt),
          recoveryCodes: recoveryCodes.map((code) => ({ hash: recoveryCodeHash(code) })),
        },
        "identity.mfa-recovery-codes-regenerated",
      ),
    );
    return { recoveryCodes };
  }

  /**
   * Proves the person again before an account change: the password, plus a current code or an
   * unused recovery code while a factor is active. The returned operations spend that code, or
   * pin that no factor became active, and must commit with the change they authorize.
   */
  async function reauthenticate(input: {
    readonly code?: string;
    readonly password: string;
    readonly principalId: Ulid;
  }): Promise<{
    readonly material: PasswordSignInMaterial;
    readonly operations: TransactionOperation[];
  }> {
    const timestamp = dependencies.now();
    await limit(input.principalId, timestamp);
    const [loaded, record] = await Promise.all([
      repository.loadLoginMaterial(input.principalId),
      repository.mfaFactorForPrincipal(input.principalId),
    ]);
    const material = completeMaterial(loaded);
    const verification = await verifyPasswordEqualized({
      ...(material ? { encodedHash: material.credential.data.passwordHash } : {}),
      password: input.password,
      profiles: config.passwordProfiles,
    });
    if (!material || !verification.matched) {
      throw exposed("access_denied", "The password is incorrect.");
    }
    const factor = activeFactor(record);
    if (!record || !factor) {
      return { material, operations: [repository.mfaFactorInactiveCheck(input.principalId)] };
    }
    if (!input.code) {
      throw exposed(
        "invalid_request",
        "Enter a code from your authenticator app or a recovery code.",
      );
    }
    const proof = await prove(factor, input.code, timestamp);
    if (!proof) throw codeIncorrect();
    return {
      material,
      operations: transition(
        record,
        spent(factor, proof, timestamp.toISOString()),
        proof.kind === "totp" ? "identity.mfa-code-accepted" : "identity.mfa-recovery-code-used",
      ),
    };
  }

  return {
    accountSecurity,
    beginEnrollment,
    reauthenticate,
    /** Spends one of the principal's verification attempts, as every MFA operation does. */
    limitVerification: (principalId: Ulid) => limit(principalId, dependencies.now()),
    completeSignIn,
    confirmEnrollment,
    disable,
    regenerateRecoveryCodes,
  };
}

export type MfaApplication = ReturnType<typeof makeMfaApplication>;
