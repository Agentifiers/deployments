import type { TransactionPut } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import type { Organization, OrganizationMember, OrganizationRole } from "./tenancy-contracts.ts";
import {
  organizationMemberRecord,
  updatedOrganizationMember,
  updatedRecord,
} from "./tenancy-record-mapping.ts";

/** Where a membership change came from. Callers authorize it; the writer stamps the event actor. */
export type MembershipChangeSource =
  | { readonly kind: "member-api"; readonly actorPrincipalId: Ulid }
  | { readonly kind: "identity-federation" }
  | { readonly kind: "scim" };

export interface MembershipEvent {
  readonly aggregateId: Ulid;
  readonly aggregateType: "organization" | "organization-member";
  readonly aggregateVersion: number;
  readonly eventType:
    | "organization-member.added"
    | "organization-member.removed"
    | "organization.membership-revised";
  readonly organizationId: Ulid;
  readonly payload: Readonly<Record<string, string>>;
}

export interface MembershipChange {
  readonly events: readonly MembershipEvent[];
  readonly member: OrganizationMember;
  readonly operations: readonly TransactionPut[];
}

function payloadSource(source: MembershipChangeSource): { readonly source?: string } {
  switch (source.kind) {
    case "member-api":
      return {};
    case "identity-federation":
    case "scim":
      return { source: source.kind };
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

/**
 * Creates the membership, or reactivates an invited or removed one, as active with `role`.
 * An already active `existing` member is the caller's to refuse before calling this.
 */
export function memberActivation(input: {
  readonly at: string;
  readonly existing: OrganizationMember | undefined;
  readonly organizationId: Ulid;
  readonly principalId: Ulid;
  readonly role: OrganizationRole;
  readonly source: MembershipChangeSource;
}): MembershipChange {
  const { at, existing, organizationId, principalId } = input;
  const member = existing
    ? updatedOrganizationMember(existing, at, {
        joinedAt: at,
        removedAt: undefined,
        removedByPrincipalId: undefined,
        role: input.role,
        status: "active",
      })
    : organizationMemberRecord({
        createdAt: at,
        joinedAt: at,
        organizationId,
        principalId,
        role: input.role,
        status: "active",
        updatedAt: at,
        version: 1,
      });
  return {
    events: [
      {
        aggregateId: principalId,
        aggregateType: "organization-member",
        aggregateVersion: member.data.version,
        eventType: "organization-member.added",
        organizationId,
        payload: {
          principalId,
          role: member.data.role,
          ...payloadSource(input.source),
          status: member.data.status,
        },
      },
    ],
    member,
    operations: [
      existing
        ? { kind: "put", previousRecord: existing, record: member }
        : { kind: "put", record: member },
    ],
  };
}

/**
 * Soft-removes the membership and revises the organization. Last-owner protection is the
 * caller's, as is returning early for an already removed member.
 */
export function memberRemoval(input: {
  readonly at: string;
  readonly organization: Organization;
  readonly previous: OrganizationMember;
  readonly source: MembershipChangeSource;
}): MembershipChange {
  const { at, organization, previous, source } = input;
  const { organizationId, principalId } = previous.data;
  const member = updatedOrganizationMember(previous, at, {
    removedAt: at,
    ...(source.kind === "member-api" ? { removedByPrincipalId: source.actorPrincipalId } : {}),
    status: "removed",
  });
  const revision = updatedRecord(organization, at, {});
  const origin = payloadSource(source);
  return {
    events: [
      {
        aggregateId: principalId,
        aggregateType: "organization-member",
        aggregateVersion: member.data.version,
        eventType: "organization-member.removed",
        organizationId,
        payload: { principalId, role: member.data.role, ...origin, status: member.data.status },
      },
      {
        aggregateId: revision.data.id,
        aggregateType: "organization",
        aggregateVersion: revision.data.version,
        eventType: "organization.membership-revised",
        organizationId,
        payload: { principalId, ...origin, status: member.data.status },
      },
    ],
    member,
    operations: [
      { kind: "put", previousRecord: previous, record: member },
      { kind: "put", previousRecord: organization, record: revision },
    ],
  };
}
