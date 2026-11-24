import {
  actionRecord,
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  passwordCredentialRecord,
  pendingEmailDeliveryRecord,
  type IdentityLoginMaterial,
  type IdentityRecord,
  type IdentityRepository,
  type PlatformRecord,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import {
  IdentityError,
  emailClaimValue,
  hashPassword,
  normalizeEmail,
  randomToken,
  sha256,
  verifyPasswordEqualized,
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

type CompleteLoginMaterial = {
  readonly credential: IdentityRecord<"principal-credential">;
  readonly principal: IdentityRecord<"principal">;
  readonly securityState: IdentityRecord<"principal-security-state">;
};

const PASSWORD_REPLACEMENT_ATTEMPTS = 5;

function put(record: PlatformRecord): TransactionOperation {
  return { kind: "put", record };
}

function completeMaterial(material: IdentityLoginMaterial): CompleteLoginMaterial | undefined {
  return material.principal?.data.status === "active" &&
    material.principal.data.kind === "human" &&
    material.principal.data.primaryEmail &&
    material.credential?.data.status === "active" &&
    material.securityState?.data.emailVerifiedAt
    ? {
        credential: material.credential,
        principal: material.principal,
        securityState: material.securityState,
      }
    : undefined;
}

export function makePasswordApplication(
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
    readonly notificationLifetimeSeconds: number;
    readonly passwordProfiles: readonly [PasswordProfile, PasswordProfile?];
    readonly rateLimits?: IdentityRateLimitPolicies;
  },
) {
  async function emailDelivery(input: {
    readonly actionId?: Ulid;
    readonly actionToken?: string;
    readonly expiresAt: string;
    readonly principalId: Ulid;
    readonly purpose: "password-changed" | "reset-password";
    readonly recipient: string;
    readonly timestamp: string;
  }) {
    const deliveryId = dependencies.generateId();
    const protectedPayload = await dependencies.encryptEmailPayload(
      {
        ...(input.actionToken ? { actionToken: input.actionToken } : {}),
        recipient: input.recipient,
        schemaVersion: 1,
      },
      {
        ...(input.actionId ? { actionId: input.actionId } : {}),
        deliveryId,
        purpose: input.purpose,
      },
    );
    return pendingEmailDeliveryRecord({
      ...(input.actionId ? { actionId: input.actionId } : {}),
      createdAt: input.timestamp,
      dispatchShard: deliveryShard(deliveryId),
      expiresAt: input.expiresAt,
      id: deliveryId,
      principalId: input.principalId,
      protectedPayload,
      purpose: input.purpose,
    });
  }

  async function forgotPassword(emailInput: string, sourceHash?: string, publicRequestId?: Ulid) {
    const email = normalizeEmail(emailInput);
    const emailHash = emailClaimValue(email);
    const timestamp = dependencies.now();
    const requestMarker = makePublicEmailRequestMarker(
      publicRequestId,
      "password-recovery",
      timestamp,
    );
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
          emailPolicy: config.rateLimits.forgotPasswordEmail,
          limitKey: "forgot-password",
          now: timestamp,
          repository: dependencies.repository,
          ...(publicRequestId ? { requestId: publicRequestId } : {}),
          ...(sourceHash ? { sourceHash } : {}),
          sourcePolicy: config.rateLimits.forgotPasswordSource,
        });
      } catch (error) {
        if (publicRequestId && error instanceof IdentityError && error.code === "slow_down") {
          await commitPublicEmailNoop(dependencies.repository, requestMarker, timestamp);
          return;
        }
        throw error;
      }
    }
    const principal = await dependencies.repository.principalForEmailHash(emailHash);
    if (!principal) {
      await commitPublicEmailNoop(dependencies.repository, requestMarker, timestamp);
      return;
    }
    const material = completeMaterial(
      await dependencies.repository.loadLoginMaterial(principal.data.id),
    );
    if (!material) {
      await commitPublicEmailNoop(dependencies.repository, requestMarker, timestamp);
      return;
    }
    const createdAt = timestamp.toISOString();
    const expiresAt = plusSeconds(timestamp, config.actionLifetimeSeconds);
    const actionId = dependencies.generateId();
    const token = randomToken(dependencies.random);
    const action = actionRecord({
      createdAt,
      expiresAt,
      id: actionId,
      issuedCredentialVersion: material.securityState.data.credentialVersion,
      principalId: material.principal.data.id,
      purpose: "reset-password",
      tokenHash: sha256(token),
    });
    const delivery = await emailDelivery({
      actionId,
      actionToken: token,
      expiresAt,
      principalId: material.principal.data.id,
      purpose: "reset-password",
      recipient: material.principal.data.primaryEmail!,
      timestamp: createdAt,
    });
    try {
      await dependencies.repository.transact([
        ...dependencies.repository.loginMaterialVersionChecks(
          material.principal,
          material.securityState,
        ),
        {
          conditionExpression: "#data.#version = :version AND #data.#status = :active",
          expressionAttributeNames: {
            "#data": "data",
            "#status": "status",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":active": "active",
            ":version": material.credential.data.version,
          },
          key: { pk: material.credential.pk, sk: material.credential.sk },
          kind: "condition-check",
          table: "identity",
        },
        put(action),
        put(delivery),
        ...(requestMarker ? [put(requestMarker)] : []),
      ]);
    } catch (error) {
      if (
        publicRequestId &&
        (await publicEmailRequestWasProcessed(dependencies.repository, publicRequestId, timestamp))
      ) {
        return;
      }
      throw error;
    }
  }

  async function loadReset(tokenHash: string, timestamp: Date) {
    const action = await dependencies.repository.identityActionForHash(tokenHash);
    if (
      !action ||
      action.data.purpose !== "reset-password" ||
      action.data.status !== "pending" ||
      Date.parse(action.data.expiresAt) <= timestamp.getTime()
    ) {
      throw new IdentityError("invalid_grant", "Password reset link is invalid or expired.");
    }
    const material = completeMaterial(
      await dependencies.repository.loadLoginMaterial(action.data.principalId),
    );
    const fence = await dependencies.repository.bffFenceForPrincipal(action.data.principalId);
    if (
      !material ||
      !fence ||
      action.data.issuedCredentialVersion !== material.securityState.data.credentialVersion ||
      fence.data.principalStatus !== "active" ||
      fence.data.sessionEpoch !== material.securityState.data.sessionEpoch
    ) {
      throw new IdentityError("invalid_grant", "Password reset link is no longer usable.");
    }
    return { action, fence, material };
  }

  async function replacePassword(input: {
    readonly action?: IdentityRecord<"identity-action">;
    readonly fence: IdentityRecord<"identity-bff-revocation-fence">;
    readonly material: CompleteLoginMaterial;
    readonly passwordHash: string;
    readonly timestamp: Date;
  }) {
    const updatedAt = input.timestamp.toISOString();
    const credentialTemplate = passwordCredentialRecord({
      createdAt: updatedAt,
      passwordHash: input.passwordHash,
      ...(config.passwordProfiles[0].pepperVersion
        ? { pepperVersion: config.passwordProfiles[0].pepperVersion }
        : {}),
      principalId: input.material.principal.data.id,
      version: input.material.credential.data.version + 1,
    });
    const credential = {
      ...credentialTemplate,
      data: {
        ...credentialTemplate.data,
        createdAt: input.material.credential.data.createdAt,
      },
    };
    const {
      authenticationFailedAt: _authenticationFailedAt,
      authenticationFailureCount: _authenticationFailureCount,
      ...securityData
    } = input.material.securityState.data;
    const security = {
      ...input.material.securityState,
      data: {
        ...securityData,
        credentialVersion: input.material.securityState.data.credentialVersion + 1,
        sessionEpoch: input.material.securityState.data.sessionEpoch + 1,
        updatedAt,
        version: input.material.securityState.data.version + 1,
      },
    };
    const fence = {
      ...input.fence,
      data: {
        ...input.fence.data,
        sessionEpoch: security.data.sessionEpoch,
        updatedAt,
        version: input.fence.data.version + 1,
      },
    };
    const delivery = await emailDelivery({
      expiresAt: plusSeconds(input.timestamp, config.notificationLifetimeSeconds),
      principalId: input.material.principal.data.id,
      purpose: "password-changed",
      recipient: input.material.principal.data.primaryEmail!,
      timestamp: updatedAt,
    });
    const operations: TransactionOperation[] = [
      {
        conditionExpression: "#data.#version = :version AND #data.#status = :active",
        expressionAttributeNames: {
          "#data": "data",
          "#status": "status",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":active": "active",
          ":version": input.material.principal.data.version,
        },
        key: { pk: input.material.principal.pk, sk: input.material.principal.sk },
        kind: "condition-check",
        table: "control",
      },
      ...(input.action
        ? [
            {
              kind: "put" as const,
              previousRecord: input.action,
              record: {
                ...input.action,
                data: {
                  ...input.action.data,
                  consumedAt: updatedAt,
                  status: "consumed" as const,
                  updatedAt,
                  version: input.action.data.version + 1,
                },
              },
            },
          ]
        : []),
      { kind: "put", previousRecord: input.material.credential, record: credential },
      { kind: "put", previousRecord: input.material.securityState, record: security },
      { kind: "put", previousRecord: input.fence, record: fence },
      put(delivery),
      put(
        makeIdentitySecurityEventRecord({
          aggregateId: input.material.principal.data.id,
          aggregateType: "principal-security-state",
          aggregateVersion: security.data.version,
          eventId: dependencies.generateId(),
          eventType: "identity.password-changed",
          occurredAt: updatedAt,
          principalId: input.material.principal.data.id,
        }),
      ),
    ];
    await dependencies.repository.transact(operations);
  }

  async function resetPassword(input: { readonly password: string; readonly token: string }) {
    const tokenHash = sha256(input.token);
    let timestamp = dependencies.now();
    let reset = await loadReset(tokenHash, timestamp);
    const passwordHash = await hashPassword(input.password, config.passwordProfiles[0]);
    for (let attempt = 0; attempt < PASSWORD_REPLACEMENT_ATTEMPTS; attempt += 1) {
      try {
        await replacePassword({ ...reset, passwordHash, timestamp });
        return;
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        if (attempt + 1 >= PASSWORD_REPLACEMENT_ATTEMPTS) {
          throw new IdentityError(
            "temporarily_unavailable",
            "Password reset could not complete because identity state kept changing.",
            { status: 503 },
          );
        }
        timestamp = dependencies.now();
        reset = await loadReset(tokenHash, timestamp);
      }
    }
  }

  async function authenticatedChangeMaterial(principalId: Ulid, currentPassword: string) {
    const material = completeMaterial(await dependencies.repository.loadLoginMaterial(principalId));
    const fence = await dependencies.repository.bffFenceForPrincipal(principalId);
    const current = await verifyPasswordEqualized({
      ...(material ? { encodedHash: material.credential.data.passwordHash } : {}),
      password: currentPassword,
      profiles: config.passwordProfiles,
    });
    if (!current.matched || !material || !fence) {
      throw new IdentityError("access_denied", "Current password is incorrect.");
    }
    return { fence, material };
  }

  async function changePassword(input: {
    readonly currentPassword: string;
    readonly password: string;
    readonly principalId: Ulid;
  }) {
    let current = await authenticatedChangeMaterial(input.principalId, input.currentPassword);
    const passwordHash = await hashPassword(input.password, config.passwordProfiles[0]);
    for (let attempt = 0; attempt < PASSWORD_REPLACEMENT_ATTEMPTS; attempt += 1) {
      try {
        await replacePassword({ ...current, passwordHash, timestamp: dependencies.now() });
        return;
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        if (attempt + 1 >= PASSWORD_REPLACEMENT_ATTEMPTS) {
          throw new IdentityError(
            "temporarily_unavailable",
            "Password change could not complete because identity state kept changing.",
            { status: 503 },
          );
        }
        current = await authenticatedChangeMaterial(input.principalId, input.currentPassword);
      }
    }
  }

  return { changePassword, forgotPassword, resetPassword };
}
