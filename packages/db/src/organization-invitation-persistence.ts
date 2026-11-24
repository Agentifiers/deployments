import { createHash } from "node:crypto";
import { key } from "./keys.ts";
import { organizationInvitationEmailDelivery } from "./organization-invitation-email.ts";
import { organizationRoleAllows } from "./organization-role-matrix.ts";
import { PersistenceError } from "./persistence-types.ts";
import {
  actsUnderOperatorAccess,
  operatorAccessSelfMembershipError,
} from "./tenancy-authorization.ts";
import type { OrganizationInvitation, TenancyContext, TenancyPersistence } from "./tenancy.ts";
import {
  createOperations,
  databaseValue,
  id,
  organizationInvitationRecord,
  organizationInvitationResult,
  organizationMemberRecord,
  organizationMemberResult,
  requiredResourceId,
  requiredScope,
  updateOperations,
  updatedOrganizationInvitation,
  updatedOrganizationMember,
} from "./tenancy.ts";

export function makeOrganizationInvitationPersistence(context: TenancyContext) {
  const {
    dependencies,
    generateId,
    now,
    generateInvitationToken,
    getRecord,
    listRecords,
    authorizeOrganization,
    requireOrganizationRole,
    writeOrganizationRecords,
    principalFor,
    invitationTokenMatches,
    invitationById,
    expirePendingInvitationForEmail,
  } = context;
  const service: TenancyPersistence["organizationInvitations"] = {
    async list(invocation) {
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      await requireOrganizationRole(
        invocation,
        organizationId,
        "invitations.manage",
        "Listing organization invitations",
      );
      const page = await listRecords<OrganizationInvitation>(
        invocation,
        key("ORG", organizationId),
        "organization-invitation",
      );
      const currentTime = now().getTime();
      return {
        items: page.items
          .map((record) => organizationInvitationResult(record.data, currentTime))
          .filter((invitation) => invitation.status === "pending"),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      const actor = await requireOrganizationRole(
        invocation,
        organizationId,
        "invitations.manage",
        "Creating organization invitations",
      );
      if (
        invocation.body.role === "owner" &&
        actor !== undefined &&
        !organizationRoleAllows(actor.data.role, "owners.manage")
      ) {
        throw new PersistenceError(
          "forbidden",
          "insufficient_role",
          "Only an organization owner can invite another owner.",
        );
      }
      const current = now();
      const expiration = invocation.body.expiresAt
        ? new Date(invocation.body.expiresAt)
        : new Date(current.getTime() + 7 * 24 * 60 * 60_000);
      if (
        !Number.isFinite(expiration.getTime()) ||
        expiration.getTime() <= current.getTime() ||
        expiration.getTime() > current.getTime() + 30 * 24 * 60 * 60_000
      ) {
        throw new PersistenceError(
          "unprocessable",
          "invalid_expiration",
          "Invitation expiration must be in the future and no more than 30 days away.",
        );
      }
      const email = invocation.body.email.toLowerCase();
      if (actsUnderOperatorAccess(invocation, organizationId)) {
        const inviter = await principalFor(id(invocation.identity.principalId));
        if (inviter?.data.primaryEmail?.trim().toLowerCase() === email.trim()) {
          throw operatorAccessSelfMembershipError();
        }
      }
      await expirePendingInvitationForEmail(invocation, organizationId, email, current);
      const timestamp = current.toISOString();
      const invitationId = id(await generateId());
      const token = generateInvitationToken(invitationId);
      const record = organizationInvitationRecord({
        createdAt: timestamp,
        email,
        expiresAt: expiration.toISOString(),
        id: invitationId,
        invitedByPrincipalId: id(invocation.identity.principalId),
        organizationId,
        role: invocation.body.role,
        status: "pending",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        updatedAt: timestamp,
        version: 1,
      });
      const operations = createOperations(record as never, timestamp);
      await writeOrganizationRecords(
        invocation,
        "organization-invitation.create",
        dependencies.invitationEmail
          ? [
              ...operations,
              await organizationInvitationEmailDelivery({
                deliveryId: id(await generateId()),
                encryptPayload: dependencies.invitationEmail.encryptPayload,
                invitation: record,
                token,
              }),
            ]
          : operations,
        {
          aggregateId: invitationId,
          aggregateType: "organization-invitation",
          aggregateVersion: record.data.version,
          eventType: "organization-invitation.created",
          organizationId,
          payload: { email: record.data.email, role: record.data.role, status: record.data.status },
        },
        timestamp,
        {
          code: "invitation_conflict",
          message: "A pending invitation already exists for this email address.",
        },
      );
      return {
        ...organizationInvitationResult(record.data, current.getTime()),
        secretVisibleOnce: true,
        token,
      };
    },
    async revoke(invocation) {
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      const previous = await invitationById(organizationId, requiredResourceId(invocation));
      const actor = await requireOrganizationRole(
        invocation,
        organizationId,
        "invitations.manage",
        "Revoking organization invitations",
      );
      if (
        previous.data.role === "owner" &&
        actor !== undefined &&
        !organizationRoleAllows(actor.data.role, "owners.manage")
      ) {
        throw new PersistenceError(
          "forbidden",
          "insufficient_role",
          "Only an organization owner can revoke an owner invitation.",
        );
      }
      if (previous.data.status === "revoked") return organizationInvitationResult(previous.data);
      if (previous.data.status === "accepted") {
        throw new PersistenceError(
          "conflict",
          "invitation_accepted",
          "Accepted invitations cannot be revoked.",
        );
      }
      const timestamp = now().toISOString();
      const next = updatedOrganizationInvitation(previous, timestamp, {
        revokedAt: timestamp,
        status: "revoked",
      });
      await writeOrganizationRecords(
        invocation,
        "organization-invitation.revoke",
        updateOperations(previous as never, next as never, timestamp),
        {
          aggregateId: next.data.id,
          aggregateType: "organization-invitation",
          aggregateVersion: next.data.version,
          eventType: "organization-invitation.revoked",
          organizationId,
          payload: { email: next.data.email, role: next.data.role, status: next.data.status },
        },
        timestamp,
        { code: "invitation_conflict", message: "The invitation changed concurrently." },
      );
      return organizationInvitationResult(next.data);
    },
    async accept(invocation) {
      const invitationId = requiredResourceId(invocation);
      const claim = await databaseValue(
        dependencies.database.getRecord(
          "control",
          {
            pk: key("UNIQUE", "organization-invitation-id"),
            sk: key("VALUE", invitationId),
          },
          true,
        ),
      );
      if (
        claim?.itemType !== "unique-claim" ||
        claim.data.ownerItemType !== "organization-invitation" ||
        claim.data.ownerId !== invitationId
      ) {
        throw new PersistenceError(
          "not-found",
          "invitation_not_found",
          "Organization invitation was not found.",
        );
      }
      const previous = await getRecord<OrganizationInvitation>(
        { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
        "organization-invitation",
        "Organization invitation",
      );
      if (!invitationTokenMatches(invocation.body.token, previous.data.tokenHash)) {
        throw new PersistenceError(
          "forbidden",
          "invalid_invitation_token",
          "The invitation token is invalid.",
        );
      }
      if (previous.data.status !== "pending") {
        throw new PersistenceError(
          "conflict",
          "invitation_unavailable",
          "The invitation is no longer pending.",
        );
      }
      const current = now();
      if (Date.parse(previous.data.expiresAt) <= current.getTime()) {
        const timestamp = current.toISOString();
        const expired = updatedOrganizationInvitation(previous, timestamp, {
          status: "expired",
        });
        await writeOrganizationRecords(
          invocation,
          "organization-invitation.expire",
          updateOperations(previous as never, expired as never, timestamp),
          {
            aggregateId: expired.data.id,
            aggregateType: "organization-invitation",
            aggregateVersion: expired.data.version,
            eventType: "organization-invitation.expired",
            organizationId: expired.data.organizationId,
            payload: { email: expired.data.email, status: expired.data.status },
          },
          timestamp,
          { code: "invitation_conflict", message: "The invitation changed concurrently." },
          // Lazy reconciliation of an invitation whose deadline already passed, not an admin action.
          "none",
        );
        throw new PersistenceError("conflict", "invitation_expired", "The invitation has expired.");
      }
      const principalId = id(invocation.identity.principalId);
      const principal = await principalFor(principalId);
      // An administrator could have invited themselves only under operator access, perhaps to an
      // address they made their own afterwards; accepting would keep the access as a membership.
      if (
        principal?.data.platformRole === "administrator" &&
        previous.data.invitedByPrincipalId === principalId
      ) {
        throw operatorAccessSelfMembershipError();
      }
      if (
        !principal ||
        principal.data.kind !== "human" ||
        principal.data.status !== "active" ||
        principal.data.primaryEmail?.trim().toLowerCase() !==
          previous.data.email.trim().toLowerCase()
      ) {
        throw new PersistenceError(
          "forbidden",
          "invitation_email_mismatch",
          "The invitation is not valid for the authenticated account.",
        );
      }
      const existing = await databaseValue(
        dependencies.database.getRecord(
          "control",
          {
            pk: key("ORG", previous.data.organizationId),
            sk: key("ORGANIZATION-MEMBER", principalId),
          },
          true,
        ),
      );
      if (existing?.itemType === "organization-member" && existing.data.status === "active") {
        throw new PersistenceError(
          "conflict",
          "member_exists",
          "The principal is already an active organization member.",
        );
      }
      const timestamp = current.toISOString();
      const member =
        existing?.itemType === "organization-member"
          ? updatedOrganizationMember(existing, timestamp, {
              joinedAt: timestamp,
              removedAt: undefined,
              removedByPrincipalId: undefined,
              role: previous.data.role,
              status: "active",
            })
          : organizationMemberRecord({
              createdAt: timestamp,
              invitedAt: previous.data.createdAt,
              joinedAt: timestamp,
              organizationId: previous.data.organizationId,
              principalId,
              role: previous.data.role,
              status: "active",
              updatedAt: timestamp,
              version: 1,
            });
      const accepted = updatedOrganizationInvitation(previous, timestamp, {
        acceptedAt: timestamp,
        acceptedByPrincipalId: principalId,
        status: "accepted",
      });
      await writeOrganizationRecords(
        invocation,
        "organization-invitation.accept",
        [
          {
            conditionExpression:
              "#data.#version = :version AND #data.#status = :active AND #data.#kind = :human AND #data.#primaryEmail = :primaryEmail",
            expressionAttributeNames: {
              "#data": "data",
              "#kind": "kind",
              "#primaryEmail": "primaryEmail",
              "#status": "status",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":active": "active",
              ":human": "human",
              ":primaryEmail": principal.data.primaryEmail,
              ":version": principal.data.version,
            },
            key: { pk: principal.pk, sk: principal.sk },
            kind: "condition-check" as const,
            table: "control" as const,
          },
          ...updateOperations(previous as never, accepted as never, timestamp),
          ...(existing?.itemType === "organization-member"
            ? existing === member
              ? []
              : [{ kind: "put" as const, previousRecord: existing, record: member }]
            : [{ kind: "put" as const, record: member }]),
        ],
        [
          {
            aggregateId: accepted.data.id,
            aggregateType: "organization-invitation",
            aggregateVersion: accepted.data.version,
            eventType: "organization-invitation.accepted",
            organizationId: accepted.data.organizationId,
            payload: { principalId, role: member.data.role, status: accepted.data.status },
          },
          {
            aggregateId: member.data.principalId,
            aggregateType: "organization-member",
            aggregateVersion: member.data.version,
            eventType:
              existing?.itemType === "organization-member"
                ? "organization-member.reactivated"
                : "organization-member.added",
            organizationId: accepted.data.organizationId,
            payload: {
              principalId,
              role: member.data.role,
              status: member.data.status,
            },
          },
        ],
        timestamp,
        { code: "invitation_conflict", message: "The invitation changed concurrently." },
      );
      return organizationMemberResult(member.data, principal.data);
    },
  };
  return service;
}
