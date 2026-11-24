import type { OrganizationMemberResponse } from "@deployments-ai/api-contract/tenancy";

/** Roles in descending authority, the order every role picker shows. */
export const ORGANIZATION_ROLES = [
  "owner",
  "admin",
  "billing",
  "member",
  "viewer",
] as const satisfies readonly (typeof OrganizationMemberResponse.Type)["role"][];

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export type MemberView = Pick<
  typeof OrganizationMemberResponse.Type,
  "displayName" | "joinedAt" | "primaryEmail" | "principalId" | "removedAt" | "role" | "status"
>;

export function memberName(member: {
  readonly displayName?: string | undefined;
  readonly primaryEmail?: string | undefined;
  readonly principalId: string;
}): string {
  return member.displayName ?? member.primaryEmail ?? `member …${member.principalId.slice(-8)}`;
}

export interface MemberActor {
  readonly platformAdministrator: boolean;
  readonly principalId: string;
  readonly role?: OrganizationRole;
}

export interface MemberSubject {
  readonly principalId: string;
  readonly role: OrganizationRole;
  readonly status: MemberView["status"];
}

export type ActionState =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };

export interface MemberActions {
  readonly assignableRoles: readonly OrganizationRole[];
  readonly changeRole: ActionState;
  readonly remove: ActionState;
  readonly self: boolean;
}

const ENABLED: ActionState = { enabled: true };

function managesMembers(actor: MemberActor) {
  return actor.platformAdministrator || actor.role === "owner" || actor.role === "admin";
}

function managesOwners(actor: MemberActor) {
  return actor.platformAdministrator || actor.role === "owner";
}

/** The number of active owners, or `undefined` while unread pages could hold more. */
export function activeOwnerCount(
  members: readonly MemberSubject[],
  complete: boolean,
): number | undefined {
  if (!complete) return undefined;
  return members.filter((member) => member.status === "active" && member.role === "owner").length;
}

/**
 * Roles the actor may invite or assign, mirroring the API's owner rule. Without billing, as on a
 * self-hosted install, the `billing` role grants nothing, so it is not offered.
 */
export function invitableRoles(
  actor: MemberActor,
  offersBillingRole = true,
): readonly OrganizationRole[] {
  const offered = offersBillingRole
    ? ORGANIZATION_ROLES
    : ORGANIZATION_ROLES.filter((role) => role !== "billing");
  if (managesOwners(actor)) return offered;
  if (managesMembers(actor)) return offered.filter((role) => role !== "owner");
  return [];
}

/**
 * Why the API would refuse to change or remove `subject`, in the order it checks: a removed
 * member, the actor's role, the owner rule, then the last active owner.
 */
function refusal(
  subject: MemberSubject,
  actor: MemberActor,
  activeOwners: number | undefined,
): string | undefined {
  if (subject.status === "removed") return "Removed members cannot change.";
  if (!managesMembers(actor)) return "Only an owner or admin can change members.";
  if (subject.role !== "owner") return undefined;
  if (!managesOwners(actor)) return "Only an owner can change or remove an owner.";
  if (subject.status === "active" && activeOwners !== undefined && activeOwners <= 1) {
    return "An organization needs at least one owner. Make another member an owner first.";
  }
  return undefined;
}

/** What the members table offers for one row; the API stays the authority. */
export function memberActions(
  subject: MemberSubject,
  actor: MemberActor,
  activeOwners: number | undefined,
  offersBillingRole = true,
): MemberActions {
  const reason = refusal(subject, actor, activeOwners);
  const state: ActionState = reason === undefined ? ENABLED : { enabled: false, reason };
  // A member who already holds `billing` keeps it as a choice, so the picker can show it.
  const roles = invitableRoles(actor, offersBillingRole || subject.role === "billing");
  return {
    assignableRoles: reason === undefined ? roles : [],
    changeRole: state,
    remove: state,
    self: subject.principalId === actor.principalId,
  };
}

/** Revoking an owner invitation needs the owner role, like granting owner does. */
export function invitationActions(
  invitation: { readonly role: OrganizationRole },
  actor: MemberActor,
): { readonly revoke: ActionState } {
  if (!managesMembers(actor)) {
    return { revoke: { enabled: false, reason: "Only an owner or admin can revoke invitations." } };
  }
  if (invitation.role === "owner" && !managesOwners(actor)) {
    return {
      revoke: { enabled: false, reason: "Only an owner can revoke an owner invitation." },
    };
  }
  return { revoke: ENABLED };
}

/** Whether a role change takes the actor's own owner or admin powers away. */
export function isSelfDemotion(
  actions: MemberActions,
  from: OrganizationRole,
  to: OrganizationRole,
): boolean {
  return (
    actions.self &&
    (from === "owner" || from === "admin") &&
    ORGANIZATION_ROLES.indexOf(to) > ORGANIZATION_ROLES.indexOf(from)
  );
}
