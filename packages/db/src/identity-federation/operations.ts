import type {
  TransactionConditionCheck,
  TransactionOperation,
  UniqueClaimRecord,
} from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { makeIdentitySecurityEventRecord } from "../identity/security-events.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import type {
  IdentityBffRevocationFenceRecord,
  PrincipalSecurityStateRecord,
} from "../records/identity-auth.ts";
import type { OrganizationIdentityProviderRecord } from "../records/identity-federation.ts";
import {
  acquireExpiringUniqueClaim,
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  uniqueClaimRequirements,
  type UniqueClaimRequirement,
} from "../unique-claims.ts";

export const FEDERATED_AUTHENTICATION_MAX_AGE_SECONDS = 12 * 60 * 60;

export const IDENTITY_PROVIDER_SECRET_PURPOSE = "identity-provider-client-secret";

export type IdentityProviderSecretBinding = {
  readonly connectionId: Ulid;
  readonly organizationId: Ulid;
  readonly purpose: typeof IDENTITY_PROVIDER_SECRET_PURPOSE;
};

export function identityProviderSecretBinding(
  provider: Pick<OrganizationIdentityProviderRecord["data"], "connectionId" | "organizationId">,
): IdentityProviderSecretBinding {
  return {
    connectionId: provider.connectionId,
    organizationId: provider.organizationId,
    purpose: IDENTITY_PROVIDER_SECRET_PURPOSE,
  };
}

export function federatedGrantExpiry(input: {
  readonly authenticatedAt: string;
  readonly tokenSessionExpiresAt: string;
}): string {
  const cap = Date.parse(input.authenticatedAt) + FEDERATED_AUTHENTICATION_MAX_AGE_SECONDS * 1_000;
  return new Date(Math.min(cap, Date.parse(input.tokenSessionExpiresAt))).toISOString();
}

function claimRecord(requirement: UniqueClaimRequirement, at: string) {
  return makeUniqueClaimRecord(requirement, at) as UniqueClaimRecord;
}

export function versionPin(
  record: PlatformRecord & { readonly data: { readonly version: number } },
): TransactionConditionCheck {
  return {
    conditionExpression: "#data.#version = :version",
    expressionAttributeNames: { "#data": "data", "#version": "version" },
    expressionAttributeValues: { ":version": record.data.version },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check",
    table: tableForItemType(record.itemType),
  };
}

export function createWithClaims(record: PlatformRecord, at: string): TransactionOperation[] {
  return [
    { kind: "put", record },
    ...uniqueClaimRequirements(record).map((requirement) =>
      acquireUniqueClaim(claimRecord(requirement, at)),
    ),
  ];
}

/** Claims that outlive their owner's TTL are free again, so a lapsed claim is not a conflict. */
export function createWithExpiringClaims(
  record: PlatformRecord,
  at: string,
): TransactionOperation[] {
  return [
    { kind: "put", record },
    ...uniqueClaimRequirements(record).map((requirement) =>
      acquireExpiringUniqueClaim(claimRecord(requirement, at), at),
    ),
  ];
}

export function deleteWithClaims(
  record: PlatformRecord & { readonly data: { readonly createdAt: string } },
): TransactionOperation[] {
  return [
    { kind: "delete", record },
    ...uniqueClaimRequirements(record).map((requirement) =>
      releaseUniqueClaim(claimRecord(requirement, record.data.createdAt)),
    ),
  ];
}

export function maskedEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

export function endPrincipalSessions(input: {
  readonly at: string;
  readonly eventId: Ulid;
  readonly fence: typeof IdentityBffRevocationFenceRecord.Type;
  readonly security: typeof PrincipalSecurityStateRecord.Type;
}): TransactionOperation[] {
  const { at, fence, security } = input;
  const sessionEpoch = security.data.sessionEpoch + 1;
  const version = security.data.version + 1;
  return [
    {
      kind: "put",
      previousRecord: security,
      record: { ...security, data: { ...security.data, sessionEpoch, updatedAt: at, version } },
    },
    {
      kind: "put",
      previousRecord: fence,
      record: {
        ...fence,
        data: { ...fence.data, sessionEpoch, updatedAt: at, version: fence.data.version + 1 },
      },
    },
    {
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: security.data.principalId,
        aggregateType: "principal-security-state",
        aggregateVersion: version,
        eventId: input.eventId,
        eventType: "identity.sessions-invalidated",
        occurredAt: at,
        principalId: security.data.principalId,
      }),
    },
  ];
}
