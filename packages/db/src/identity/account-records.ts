import { Schema } from "effect";
import type { TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { replaceWithClaims } from "../identity-federation/administration-context.ts";
import { PrincipalEmailChangeRecord } from "../records/identity-account.ts";
import type {
  IdentityBffRevocationFenceRecord,
  PrincipalCredentialRecord,
  PrincipalSecurityStateRecord,
} from "../records/identity-auth.ts";
import { PrincipalRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeIdentitySecurityEventRecord } from "./security-events.ts";

export type EmailChangeData = PrincipalEmailChangeRecord["data"];
type Principal = typeof PrincipalRecord.Type;

/** Builds a validated email change from its full data; every transition goes through it. */
export function emailChangeRecord(data: EmailChangeData): PrincipalEmailChangeRecord {
  return Schema.decodeUnknownSync(PrincipalEmailChangeRecord)(
    withCanonicalRecordKeys({ data, itemType: "principal-email-change" }),
  );
}

function nextPrincipal(data: Principal["data"]): Principal {
  return Schema.decodeUnknownSync(PrincipalRecord)(
    withCanonicalRecordKeys({ data, itemType: "principal" as const }),
  );
}

type SecurityState = typeof PrincipalSecurityStateRecord.Type;
type Fence = typeof IdentityBffRevocationFenceRecord.Type;

function sessionsEnded(input: {
  readonly at: string;
  readonly eventId: Ulid;
  readonly eventType: string;
  readonly fence: Fence;
  readonly principalStatus: Principal["data"]["status"];
  readonly security: SecurityState;
  readonly voidCredentials?: boolean;
}): TransactionOperation[] {
  const { at, fence, security } = input;
  const credentialVersion = security.data.credentialVersion + (input.voidCredentials ? 1 : 0);
  const sessionEpoch = security.data.sessionEpoch + 1;
  const version = security.data.version + 1;
  return [
    {
      kind: "put",
      previousRecord: security,
      record: {
        ...security,
        data: { ...security.data, credentialVersion, sessionEpoch, updatedAt: at, version },
      },
    },
    {
      kind: "put",
      previousRecord: fence,
      record: {
        ...fence,
        data: {
          ...fence.data,
          principalStatus: input.principalStatus,
          sessionEpoch,
          updatedAt: at,
          version: fence.data.version + 1,
        },
      },
    },
    {
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: security.data.principalId,
        aggregateType: "principal-security-state",
        aggregateVersion: version,
        eventId: input.eventId,
        eventType: input.eventType,
        occurredAt: at,
        principalId: security.data.principalId,
      }),
    },
  ];
}

export interface AccountSignInState {
  readonly at: string;
  readonly eventId: Ulid;
  readonly fence: Fence;
  readonly principal: Principal;
  readonly security: SecurityState;
  /**
   * Also advances the credential version, which voids every password reset link, MFA sign-in
   * challenge, and pending email change issued before.
   */
  readonly voidCredentials?: boolean;
}

/**
 * Advances the session epoch and the fence with it, which ends every browser session, refresh
 * token family, device grant, and app session the person holds.
 */
export function accountSessionsEnded(
  input: AccountSignInState & { readonly eventType: string },
): TransactionOperation[] {
  return sessionsEnded({ ...input, principalStatus: input.principal.data.status });
}

/**
 * Moves a person to a new primary email. The new address's uniqueness claim is acquired
 * create-only and the old one is released in the same transaction, so two people racing for one
 * address cannot both win and the old address is free the moment the change commits. Every
 * session ends too: ID tokens and app sessions carry the email, and the session epoch is what
 * voids them all at once.
 */
export function principalEmailReplacement(
  input: AccountSignInState & { readonly primaryEmail: string },
): TransactionOperation[] {
  const { at, principal: previous } = input;
  const principal = nextPrincipal({
    ...previous.data,
    primaryEmail: input.primaryEmail,
    updatedAt: at,
    version: previous.data.version + 1,
  });
  return [
    ...replaceWithClaims(previous, principal, at),
    ...sessionsEnded({ ...input, eventType: "identity.email-changed", principalStatus: "active" }),
  ];
}

/**
 * The tombstone a deleted person leaves: archived, with no email, name, or metadata, so records
 * that still name the principal ID resolve to nobody. Its email claim is released, and the session
 * epoch advances with the fence archived, which ends every browser session, refresh token family,
 * and device grant the person held.
 */
export function anonymizedPrincipal(input: AccountSignInState): TransactionOperation[] {
  const { at, principal: previous } = input;
  const {
    displayName: _displayName,
    metadata: _metadata,
    primaryEmail: _primaryEmail,
    ...kept
  } = previous.data;
  const principal = nextPrincipal({
    ...kept,
    status: "archived",
    updatedAt: at,
    version: previous.data.version + 1,
  });
  return [
    ...replaceWithClaims(previous, principal, at),
    ...sessionsEnded({
      ...input,
      eventType: "identity.account-deleted",
      principalStatus: "archived",
    }),
  ];
}

/**
 * Stored in place of a voided password's hash. It is not a valid encoded hash, so no password
 * verifies against it, and only a password reset sent to the account's address sets one again.
 */
const VOIDED_PASSWORD_HASH = "voided";

/** Makes the current password stop working without disabling the credential, so reset works. */
export function passwordVoided(
  credential: typeof PrincipalCredentialRecord.Type,
  at: string,
): TransactionOperation {
  return {
    kind: "put",
    previousRecord: credential,
    record: {
      ...credential,
      data: {
        ...credential.data,
        passwordChangedAt: at,
        passwordHash: VOIDED_PASSWORD_HASH,
        updatedAt: at,
        version: credential.data.version + 1,
      },
    },
  };
}
