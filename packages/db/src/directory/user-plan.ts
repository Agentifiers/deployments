import type { Ulid } from "../ids.ts";
import type { DirectoryRole, OrganizationDirectoryUserRecord } from "../records/directory.ts";
import type { OrganizationMember, OrganizationRole } from "../tenancy-contracts.ts";

/** Why the directory refused a write. Each maps to one SCIM error at the HTTP boundary. */
export type DirectoryRefusal =
  | "email_domain_not_verified"
  | "external_id_taken"
  | "principal_ineligible"
  | "protected_role"
  | "user_exists"
  | "user_not_found";

/** A new SCIM user, already parsed from the wire. `email` is lower-cased. */
export interface NewDirectoryUser {
  readonly active: boolean;
  readonly displayName?: string;
  readonly email: string;
  readonly externalId?: string;
  readonly userName: string;
}

/**
 * The one change PUT, PATCH and active toggles all become. An absent key leaves the attribute
 * alone; `externalId: null` removes it. Emails are absent: SCIM never changes a primary email.
 */
export interface DirectoryUserChange {
  readonly active?: boolean;
  readonly displayName?: string;
  readonly externalId?: string | null;
  readonly userName?: string;
}

export type MembershipStep =
  | { readonly kind: "activate"; readonly role: DirectoryRole }
  | { readonly kind: "keep" }
  | { readonly kind: "remove" };

type Membership = Pick<OrganizationMember["data"], "role" | "status">;

/** Roles only people manage. SCIM never assigns, changes or removes an active one. */
const PROTECTED_ROLE: Readonly<Record<OrganizationRole, boolean>> = {
  admin: true,
  billing: false,
  member: false,
  owner: true,
  viewer: false,
};

function protectedMembership(membership: Membership | undefined) {
  return membership?.status === "active" && PROTECTED_ROLE[membership.role];
}

export interface CreateFacts {
  readonly defaultRole: DirectoryRole;
  readonly domainVerified: boolean;
  /** The principal that already holds the requested externalId in this organization. */
  readonly externalIdOwner: Ulid | undefined;
  readonly principal:
    | { readonly kind: "absent" }
    | {
        readonly eligible: boolean;
        readonly id: Ulid;
        readonly kind: "present";
        readonly mapped: boolean;
        readonly membership: Membership | undefined;
      };
  /** The principal that already holds the requested userName in this organization. */
  readonly userNameOwner: Ulid | undefined;
}

export type CreatePlan =
  | { readonly kind: "adopt"; readonly membership: MembershipStep; readonly principalId: Ulid }
  | { readonly kind: "provision"; readonly membership: MembershipStep }
  | { readonly kind: "refused"; readonly reason: DirectoryRefusal };

export function planDirectoryCreate(facts: CreateFacts, input: NewDirectoryUser): CreatePlan {
  if (!facts.domainVerified) return { kind: "refused", reason: "email_domain_not_verified" };
  if (facts.userNameOwner) return { kind: "refused", reason: "user_exists" };
  if (facts.externalIdOwner) return { kind: "refused", reason: "external_id_taken" };
  const activate: MembershipStep = { kind: "activate", role: facts.defaultRole };
  const { principal } = facts;
  if (principal.kind === "absent") {
    return { kind: "provision", membership: input.active ? activate : { kind: "keep" } };
  }
  if (!principal.eligible) return { kind: "refused", reason: "principal_ineligible" };
  if (principal.mapped) return { kind: "refused", reason: "user_exists" };
  return {
    kind: "adopt",
    membership:
      input.active && principal.membership?.status !== "active" ? activate : { kind: "keep" },
    principalId: principal.id,
  };
}

export interface ChangeFacts {
  readonly defaultRole: DirectoryRole;
  readonly externalIdOwner: Ulid | undefined;
  readonly mapping: Pick<
    OrganizationDirectoryUserRecord["data"],
    "externalId" | "origin" | "userName"
  >;
  readonly membership: Membership | undefined;
  /** True when the principal has a membership row in any other organization. */
  readonly otherMemberships: boolean;
  readonly principal: { readonly displayName?: string | undefined };
  readonly userNameOwner: Ulid | undefined;
}

export type ChangePlan =
  | { readonly kind: "refused"; readonly reason: DirectoryRefusal }
  | { readonly kind: "unchanged" }
  | {
      readonly displayName: string | undefined;
      readonly kind: "write";
      readonly mapping: { readonly externalId: string | undefined; readonly userName: string };
      readonly membership: MembershipStep;
    };

function membershipStep(
  facts: ChangeFacts,
  active: boolean | undefined,
): MembershipStep | DirectoryRefusal {
  const status = facts.membership?.status;
  if (active === false && status === "active") {
    return protectedMembership(facts.membership) ? "protected_role" : { kind: "remove" };
  }
  if (active === true && status !== "active") return { kind: "activate", role: facts.defaultRole };
  return { kind: "keep" };
}

/**
 * The global display name is the organization's to change only when it provisioned the principal,
 * the principal belongs to no other organization, and the membership here is not protected.
 */
function displayNameChange(facts: ChangeFacts, displayName: string | undefined) {
  const owned =
    facts.mapping.origin === "provisioned" &&
    !facts.otherMemberships &&
    !(facts.membership && PROTECTED_ROLE[facts.membership.role]);
  return owned && displayName !== undefined && displayName !== facts.principal.displayName
    ? displayName
    : undefined;
}

export function planDirectoryChange(facts: ChangeFacts, change: DirectoryUserChange): ChangePlan {
  const membership = membershipStep(facts, change.active);
  if (typeof membership === "string") return { kind: "refused", reason: membership };
  // Deprovisioning must never fail on an unrelated attribute, so a deactivation keeps the
  // current userName or externalId when the new one is taken instead of refusing.
  const deactivating = change.active === false;
  if (facts.userNameOwner && !deactivating) return { kind: "refused", reason: "user_exists" };
  if (facts.externalIdOwner && !deactivating) {
    return { kind: "refused", reason: "external_id_taken" };
  }
  const mapping = {
    externalId:
      facts.externalIdOwner || change.externalId === undefined
        ? facts.mapping.externalId
        : (change.externalId ?? undefined),
    userName: facts.userNameOwner
      ? facts.mapping.userName
      : (change.userName ?? facts.mapping.userName),
  };
  const displayName = displayNameChange(facts, change.displayName);
  if (
    membership.kind === "keep" &&
    displayName === undefined &&
    mapping.externalId === facts.mapping.externalId &&
    mapping.userName === facts.mapping.userName
  ) {
    return { kind: "unchanged" };
  }
  return { displayName, kind: "write", mapping, membership };
}

export type DeletePlan =
  | { readonly kind: "refused"; readonly reason: "protected_role" }
  | { readonly kind: "write"; readonly membership: MembershipStep };

/** Deleting forgets the mapping and ends an active membership, unless that membership is protected. */
export function planDirectoryDelete(membership: Membership | undefined): DeletePlan {
  if (protectedMembership(membership)) return { kind: "refused", reason: "protected_role" };
  return {
    kind: "write",
    membership: membership?.status === "active" ? { kind: "remove" } : { kind: "keep" },
  };
}
