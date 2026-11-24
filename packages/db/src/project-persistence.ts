import { key } from "./keys.ts";
import { PersistenceError } from "./persistence-types.ts";
import type { Organization, Project, TenancyContext, TenancyPersistence } from "./tenancy.ts";
import {
  assertCollectionGrant,
  assertPathScope,
  createOperations,
  id,
  mutableRecord,
  projectResult,
  requiredResourceId,
  requiredScope,
  resolveSlug,
  updateOperations,
  updatedRecord,
} from "./tenancy.ts";

export function makeProjectPersistence(
  context: TenancyContext & Pick<TenancyPersistence, "organizations">,
) {
  const {
    dependencies: _dependencies,
    idGenerator: _idGenerator,
    generateId,
    now,
    generateSecret: _generateSecret,
    generateInvitationToken: _generateInvitationToken,
    getRecord,
    listRecords,
    authorizeOrganization,
    isPlatformAdministrator: _isPlatformAdministrator,
    activeOrganizationMember: _activeOrganizationMember,
    requireOrganizationRole: _requireOrganizationRole,
    organizationsForIdentity: _organizationsForIdentity,
    recordById: _recordById,
    projectFor,
    environmentFor: _environmentFor,
    event: _event,
    write,
    organizationScopedEvent: _organizationScopedEvent,
    writeOrganizationRecords: _writeOrganizationRecords,
    principalFor: _principalFor,
    activeOwnerCount: _activeOwnerCount,
    invitationTokenMatches: _invitationTokenMatches,
    organizationRecord: _organizationRecord,
    organizationMember: _organizationMember,
    invitationById: _invitationById,
    expirePendingInvitationForEmail: _expirePendingInvitationForEmail,
    environmentPartition: _environmentPartition,
    workspaceFor: _workspaceFor,
    credential: _credential,
    organizations: _organizations,
  } = context;
  const service: TenancyPersistence["projects"] = {
    async list(invocation) {
      assertCollectionGrant(invocation.identity.projectIds, "project");
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      const page = await listRecords<Project>(invocation, key("ORG", organizationId), "project");
      return {
        items: page.items.map((record) => projectResult(record.data)),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      assertCollectionGrant(invocation.identity.projectIds, "project");
      const organizationId = requiredScope(invocation, "organizationId");
      await authorizeOrganization(invocation, organizationId);
      const organization = await getRecord<Organization>(
        { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
        "organization",
        "Organization",
      );
      if (organization.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "organization_inactive",
          "Inactive organizations cannot accept new projects.",
        );
      }
      const timestamp = now().toISOString();
      const slug = String(
        resolveSlug({
          name: invocation.body.name,
          ...(invocation.body.slug ? { slug: invocation.body.slug } : {}),
        }),
      );
      const record = mutableRecord("project", {
        createdAt: timestamp,
        id: id(await generateId()),
        name: invocation.body.name,
        organizationId,
        slug,
        status: "active",
        updatedAt: timestamp,
        version: 1,
      });
      await write(
        invocation,
        "project.create",
        createOperations(record, timestamp),
        record,
        "project.created",
        timestamp,
        { code: "resource_conflict", message: "Project slug is already in use." },
      );
      return projectResult(record.data);
    },
    async get(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "projectId", resourceId);
      const record = await projectFor(invocation, resourceId);
      return projectResult(record.data);
    },
    async update(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "projectId", resourceId);
      const previous = await projectFor(invocation, resourceId);
      const timestamp = now().toISOString();
      const slug = invocation.body.slug
        ? String(
            resolveSlug({
              name: invocation.body.name ?? previous.data.name,
              slug: invocation.body.slug,
            }),
          )
        : previous.data.slug;
      const next = updatedRecord(previous, timestamp, {
        ...(invocation.body.name !== undefined ? { name: invocation.body.name } : {}),
        slug,
      });
      await write(
        invocation,
        "project.update",
        updateOperations(previous, next, timestamp),
        next,
        "project.updated",
        timestamp,
        {
          code: "resource_conflict",
          message: "The project changed or its slug is already in use.",
        },
      );
      return projectResult(next.data);
    },
    async archive(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "projectId", resourceId);
      const previous = await projectFor(invocation, resourceId);
      if (previous.data.status === "archived") return projectResult(previous.data);
      const timestamp = now().toISOString();
      const next = updatedRecord(previous, timestamp, { status: "archived" });
      await write(
        invocation,
        "project.archive",
        [{ kind: "put", previousRecord: previous, record: next }],
        next,
        "project.archived",
        timestamp,
        { code: "version_conflict", message: "The project changed concurrently." },
      );
      return projectResult(next.data);
    },
  };
  return service;
}
