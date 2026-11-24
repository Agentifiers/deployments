import {
  acquireUniqueClaim,
  bffFenceRecord,
  makeIdentitySecurityEventRecord,
  makeUniqueClaimRecord,
  passwordCredentialRecord,
  type PlatformRecord,
  principalRecord,
  securityStateRecord,
  type TransactionOperation,
  type Ulid,
  UniqueClaimRecord,
  uniqueClaimRequirements,
} from "@deployments-ai/db";
import { Schema } from "effect";

type Principal = Extract<PlatformRecord, { readonly itemType: "principal" }>;
type Credential = Extract<PlatformRecord, { readonly itemType: "principal-credential" }>;
type Security = Extract<PlatformRecord, { readonly itemType: "principal-security-state" }>;
type Fence = Extract<PlatformRecord, { readonly itemType: "identity-bff-revocation-fence" }>;

/** The stored login state of the operator principal, as read before any write. */
export interface OperatorIdentityState {
  readonly credential: Credential | undefined;
  readonly fence: Fence | undefined;
  readonly principal: Principal | undefined;
  readonly principalId: Ulid;
  readonly security: Security | undefined;
}

export type OperatorIdentityChange =
  | { readonly kind: "unchanged" }
  | { readonly kind: "create"; readonly principal: Principal | undefined }
  | {
      readonly credential: Credential;
      readonly fence: Fence;
      readonly kind: "rotate";
      readonly principal: Principal;
      readonly security: Security;
    };

/**
 * Checks that the principal is a complete, consistent active human platform administrator and
 * decides what to write. The password stays when it verifies against the active stored hash,
 * unless `rotate` forces a new credential version and session epoch.
 */
export function operatorIdentityChange(
  input: OperatorIdentityState & {
    readonly rotate: boolean;
    readonly storedPasswordMatches: boolean;
  },
): OperatorIdentityChange {
  const { credential, fence, principal, principalId, security } = input;
  if (principal && (principal.data.kind !== "human" || principal.data.status !== "active")) {
    throw new Error("The operator principal must be an active human.");
  }
  if (principal && principal.data.platformRole !== "administrator") {
    throw new Error("The operator principal must be a platform administrator.");
  }
  if (principal && principal.data.id !== principalId) {
    throw new Error("The operator principal does not match the configured principal ID.");
  }
  if (!credential && !security && !fence) return { kind: "create", principal };
  if (!credential || !security || !fence) {
    throw new Error("The operator identity has incomplete login material.");
  }
  if (!principal) throw new Error("Existing operator login material has no principal.");
  if (
    security.data.principalId !== principalId ||
    credential.data.principalId !== principalId ||
    fence.data.principalId !== principalId ||
    fence.data.principalStatus !== principal.data.status ||
    fence.data.sessionEpoch !== security.data.sessionEpoch
  ) {
    throw new Error("The operator login material does not match its principal.");
  }
  if (!input.rotate && input.storedPasswordMatches && credential.data.status === "active") {
    return { kind: "unchanged" };
  }
  return { credential, fence, kind: "rotate", principal, security };
}

/** The single transaction that applies a create or rotate change. */
export function operatorIdentityOperations(input: {
  readonly change: Exclude<OperatorIdentityChange, { readonly kind: "unchanged" }>;
  readonly generateId: () => Ulid;
  readonly now: string;
  readonly passwordHash: string;
  readonly principalId: Ulid;
  readonly username: string;
}): readonly TransactionOperation[] {
  const { change, now, principalId } = input;
  if (change.kind === "create") {
    const nextPrincipal = change.principal
      ? {
          ...change.principal,
          data: {
            ...change.principal.data,
            updatedAt: now,
            version: change.principal.data.version + 1,
          },
        }
      : principalRecord({
          createdAt: now,
          id: principalId,
          platformRole: "administrator",
          primaryEmail: input.username,
        });
    const emailClaim = change.principal ? undefined : uniqueClaimRequirements(nextPrincipal)[0];
    if (!change.principal && !emailClaim) {
      throw new Error("The operator principal did not derive an email claim.");
    }
    return [
      change.principal
        ? { kind: "put", previousRecord: change.principal, record: nextPrincipal }
        : { kind: "put", record: nextPrincipal },
      {
        kind: "put",
        record: passwordCredentialRecord({
          createdAt: now,
          passwordHash: input.passwordHash,
          principalId,
          version: 1,
        }),
      },
      {
        kind: "put",
        record: securityStateRecord({
          createdAt: now,
          credentialVersion: 1,
          emailVerifiedAt: now,
          principalId,
          sessionEpoch: 0,
          version: 1,
        }),
      },
      {
        kind: "put",
        record: bffFenceRecord({
          createdAt: now,
          principalId,
          principalStatus: nextPrincipal.data.status,
          sessionEpoch: 0,
          version: 1,
        }),
      },
      ...(emailClaim
        ? [
            acquireUniqueClaim(
              Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(emailClaim, now)),
            ),
          ]
        : []),
      {
        kind: "put",
        record: makeIdentitySecurityEventRecord({
          aggregateId: principalId,
          aggregateType: "principal",
          aggregateVersion: nextPrincipal.data.version,
          eventId: input.generateId(),
          eventType: "identity.operator-login-enabled",
          occurredAt: now,
          principalId,
        }),
      },
      {
        kind: "put",
        record: makeIdentitySecurityEventRecord({
          aggregateId: principalId,
          aggregateType: "principal-security-state",
          aggregateVersion: 1,
          eventId: input.generateId(),
          eventType: "identity.credentials-created",
          occurredAt: now,
          principalId,
        }),
      },
    ];
  }
  const credential = passwordCredentialRecord({
    createdAt: now,
    passwordHash: input.passwordHash,
    principalId,
    version: change.credential.data.version + 1,
  });
  const security = securityStateRecord({
    createdAt: now,
    credentialVersion: change.security.data.credentialVersion + 1,
    emailVerifiedAt: change.security.data.emailVerifiedAt ?? now,
    principalId,
    sessionEpoch: change.security.data.sessionEpoch + 1,
    version: change.security.data.version + 1,
  });
  const fence = bffFenceRecord({
    createdAt: now,
    principalId,
    principalStatus: change.principal.data.status,
    sessionEpoch: security.data.sessionEpoch,
    version: change.fence.data.version + 1,
  });
  return [
    {
      kind: "put",
      previousRecord: change.credential,
      record: {
        ...credential,
        data: { ...credential.data, createdAt: change.credential.data.createdAt },
      },
    },
    {
      kind: "put",
      previousRecord: change.security,
      record: {
        ...security,
        data: { ...security.data, createdAt: change.security.data.createdAt },
      },
    },
    {
      kind: "put",
      previousRecord: change.fence,
      record: { ...fence, data: { ...fence.data, createdAt: change.fence.data.createdAt } },
    },
    {
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: principalId,
        aggregateType: "principal-security-state",
        aggregateVersion: security.data.version,
        eventId: input.generateId(),
        eventType: "identity.credentials-rotated",
        occurredAt: now,
        principalId,
      }),
    },
  ];
}
