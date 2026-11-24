import { key } from "./keys.ts";
import { organizationRoleAllows } from "./organization-role-matrix.ts";
import { PersistenceError } from "./persistence-types.ts";
import {
  actsUnderOperatorAccess,
  operatorAccessSelfMembershipError,
} from "./tenancy-authorization.ts";
import type { OrganizationMember, TenancyContext, TenancyPersistence } from "./tenancy.ts";
import { memberActivation, memberRemoval } from "./organization-membership-changes.ts";
import {
  databaseValue,
  id,
  organizationMemberResult,
  requiredResourceId,
  requiredScope,
  updatedOrganizationMember,
  updatedRecord,
} from "./tenancy.ts";

export function makeOrganizationMemberPersistence(context: TenancyContext) {
  const {
    dependencies,
    now,
    listRecords,
    authorizeOrganization,
    requireOrganizationRole,
    writeOrganizationRecords,
    principalFor,
    activeOwnerCount,
    organizationRecord,
    organizationMember,
  } = context;
  const service: TenancyPersistence["organizationMembers"] = {
    async list(invocation) {
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      await requireOrganizationRole(
        invocation,
        organizationId,
        "organization.read",
        "Listing organization members",
      );
      const page = await listRecords<OrganizationMember>(
        invocation,
        key("ORG", organizationId),
        "organization-member",
      );
      const items = await Promise.all(
        page.items.map(async (record) =>
          organizationMemberResult(
            record.data,
            (await principalFor(record.data.principalId))?.data,
          ),
        ),
      );
      return { items, nextCursor: page.nextCursor };
    },
    async add(invocation) {
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      const actor = await requireOrganizationRole(
        invocation,
        organizationId,
        "members.manage",
        "Adding organization members",
      );
      if (
        invocation.body.role === "owner" &&
        actor !== undefined &&
        !organizationRoleAllows(actor.data.role, "owners.manage")
      ) {
        throw new PersistenceError(
          "forbidden",
          "insufficient_role",
          "Only an organization owner can grant the owner role.",
        );
      }
      const principalId = id(invocation.body.principalId);
      if (
        principalId === invocation.identity.principalId &&
        actsUnderOperatorAccess(invocation, organizationId)
      ) {
        throw operatorAccessSelfMembershipError();
      }
      const principal = await principalFor(principalId);
      if (!principal || principal.data.kind !== "human" || principal.data.status !== "active") {
        throw new PersistenceError(
          "not-found",
          "principal_not_found",
          "An active human principal was not found.",
        );
      }
      const existing = await databaseValue(
        dependencies.database.getRecord(
          "control",
          {
            pk: key("ORG", organizationId),
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
      const timestamp = now().toISOString();
      const change = memberActivation({
        at: timestamp,
        existing: existing?.itemType === "organization-member" ? existing : undefined,
        organizationId,
        principalId,
        role: invocation.body.role,
        source: { actorPrincipalId: id(invocation.identity.principalId), kind: "member-api" },
      });
      // Account deletion archives the principal; a version pin keeps an archived one from joining.
      await writeOrganizationRecords(
        invocation,
        "organization-member.add",
        [
          {
            conditionExpression: "#data.#version = :version AND #data.#status = :active",
            expressionAttributeNames: {
              "#data": "data",
              "#status": "status",
              "#version": "version",
            },
            expressionAttributeValues: { ":active": "active", ":version": principal.data.version },
            key: { pk: principal.pk, sk: principal.sk },
            kind: "condition-check",
            table: "control",
          },
          ...change.operations,
        ],
        change.events,
        timestamp,
        { code: "member_conflict", message: "The organization member changed concurrently." },
      );
      return organizationMemberResult(change.member.data, principal.data);
    },
    async update(invocation) {
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      const targetId = requiredResourceId(invocation);
      const previous = await organizationMember(organizationId, targetId);
      const actor = await requireOrganizationRole(
        invocation,
        organizationId,
        "members.manage",
        "Updating organization member roles",
      );
      if (
        (previous.data.role === "owner" || invocation.body.role === "owner") &&
        actor !== undefined &&
        !organizationRoleAllows(actor.data.role, "owners.manage")
      ) {
        throw new PersistenceError(
          "forbidden",
          "insufficient_role",
          "Only an organization owner can change owner memberships.",
        );
      }
      if (previous.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "member_inactive",
          "Only active organization members can change roles.",
        );
      }
      if (previous.data.role === invocation.body.role) {
        return organizationMemberResult(
          previous.data,
          (await principalFor(previous.data.principalId))?.data,
        );
      }
      if (previous.data.role === "owner" && (await activeOwnerCount(organizationId)) <= 1) {
        throw new PersistenceError(
          "conflict",
          "last_owner_required",
          "The organization must retain at least one active owner.",
        );
      }
      const organization = await organizationRecord(organizationId);
      const timestamp = now().toISOString();
      const next = updatedOrganizationMember(previous, timestamp, {
        role: invocation.body.role,
      });
      const organizationRevision = updatedRecord(organization, timestamp, {});
      await writeOrganizationRecords(
        invocation,
        "organization-member.update",
        [
          { kind: "put", previousRecord: previous, record: next },
          { kind: "put", previousRecord: organization, record: organizationRevision },
        ],
        [
          {
            aggregateId: targetId,
            aggregateType: "organization-member",
            aggregateVersion: next.data.version,
            eventType: "organization-member.role-updated",
            organizationId,
            payload: { principalId: targetId, role: next.data.role, status: next.data.status },
          },
          {
            aggregateId: organizationRevision.data.id,
            aggregateType: "organization",
            aggregateVersion: organizationRevision.data.version,
            eventType: "organization.membership-revised",
            organizationId,
            payload: { principalId: targetId, status: next.data.status },
          },
        ],
        timestamp,
        { code: "member_conflict", message: "The organization member changed concurrently." },
      );
      return organizationMemberResult(next.data, (await principalFor(next.data.principalId))?.data);
    },
    async remove(invocation) {
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      const targetId = requiredResourceId(invocation);
      const previous = await organizationMember(organizationId, targetId);
      const actor = await requireOrganizationRole(
        invocation,
        organizationId,
        "members.manage",
        "Removing organization members",
      );
      if (
        previous.data.role === "owner" &&
        actor !== undefined &&
        !organizationRoleAllows(actor.data.role, "owners.manage")
      ) {
        throw new PersistenceError(
          "forbidden",
          "insufficient_role",
          "Only an organization owner can remove another owner.",
        );
      }
      if (previous.data.status === "removed") {
        return organizationMemberResult(
          previous.data,
          (await principalFor(previous.data.principalId))?.data,
        );
      }
      if (previous.data.role === "owner" && (await activeOwnerCount(organizationId)) <= 1) {
        throw new PersistenceError(
          "conflict",
          "last_owner_required",
          "The organization must retain at least one active owner.",
        );
      }
      const organization = await organizationRecord(organizationId);
      const timestamp = now().toISOString();
      const change = memberRemoval({
        at: timestamp,
        organization,
        previous,
        source: { actorPrincipalId: id(invocation.identity.principalId), kind: "member-api" },
      });
      await writeOrganizationRecords(
        invocation,
        "organization-member.remove",
        change.operations,
        change.events,
        timestamp,
        { code: "member_conflict", message: "The organization member changed concurrently." },
      );
      return organizationMemberResult(
        change.member.data,
        (await principalFor(change.member.data.principalId))?.data,
      );
    },
  };
  return service;
}
