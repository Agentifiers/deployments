import { key } from "./keys.ts";
import type { TenancyContext, TenancyPersistence, Workspace } from "./tenancy.ts";
import {
  createOperations,
  id,
  mutableRecord,
  resolveSlug,
  updateOperations,
  updatedRecord,
  workspaceResult,
} from "./tenancy.ts";

export function makeWorkspacePersistence(context: TenancyContext) {
  const {
    dependencies: _dependencies,
    idGenerator: _idGenerator,
    generateId,
    now,
    generateSecret: _generateSecret,
    generateInvitationToken: _generateInvitationToken,
    getRecord: _getRecord,
    listRecords,
    authorizeOrganization: _authorizeOrganization,
    isPlatformAdministrator: _isPlatformAdministrator,
    activeOrganizationMember: _activeOrganizationMember,
    requireOrganizationRole: _requireOrganizationRole,
    organizationsForIdentity: _organizationsForIdentity,
    recordById: _recordById,
    projectFor: _projectFor,
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
    environmentPartition,
    workspaceFor,
    credential: _credential,
  } = context;
  const service: TenancyPersistence["workspaces"] = {
    async list(invocation) {
      const scope = await environmentPartition(invocation);
      const page = await listRecords<Workspace>(
        invocation,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "workspace",
      );
      return {
        items: page.items.map((record) => workspaceResult(record.data)),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      const scope = await environmentPartition(invocation, true);
      const timestamp = now().toISOString();
      const record = mutableRecord("workspace", {
        createdAt: timestamp,
        createdByPrincipalId: id(invocation.identity.principalId),
        ...(invocation.body.description ? { description: invocation.body.description } : {}),
        environmentId: scope.environmentId,
        id: id(await generateId()),
        name: invocation.body.name,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        slug: String(
          resolveSlug({
            name: invocation.body.name,
            ...(invocation.body.slug ? { slug: invocation.body.slug } : {}),
          }),
        ),
        status: "active",
        updatedAt: timestamp,
        version: 1,
      });
      await write(
        invocation,
        "workspace.create",
        createOperations(record, timestamp),
        record,
        "workspace.created",
        timestamp,
        { code: "resource_conflict", message: "Workspace slug is already in use." },
      );
      return workspaceResult(record.data);
    },
    async get(invocation) {
      return workspaceResult((await workspaceFor(invocation)).data);
    },
    async update(invocation) {
      const previous = await workspaceFor(invocation);
      const timestamp = now().toISOString();
      const slug = invocation.body.slug
        ? String(
            resolveSlug({
              name: invocation.body.name ?? previous.data.name,
              slug: invocation.body.slug,
            }),
          )
        : previous.data.slug;
      const { description: _description, ...withoutDescription } = previous.data;
      const next = mutableRecord("workspace", {
        ...(invocation.body.description === null ? withoutDescription : previous.data),
        ...(invocation.body.description !== null && invocation.body.description !== undefined
          ? { description: invocation.body.description }
          : {}),
        ...(invocation.body.name !== undefined ? { name: invocation.body.name } : {}),
        slug,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      });
      await write(
        invocation,
        "workspace.update",
        updateOperations(previous, next, timestamp),
        next,
        "workspace.updated",
        timestamp,
        {
          code: "resource_conflict",
          message: "The workspace changed or its slug is already in use.",
        },
      );
      return workspaceResult(next.data);
    },
    async archive(invocation) {
      const previous = await workspaceFor(invocation);
      if (previous.data.status === "archived") return workspaceResult(previous.data);
      const timestamp = now().toISOString();
      const next = updatedRecord(previous, timestamp, { status: "archived" });
      await write(
        invocation,
        "workspace.archive",
        [{ kind: "put", previousRecord: previous, record: next }],
        next,
        "workspace.archived",
        timestamp,
        { code: "version_conflict", message: "The workspace changed concurrently." },
      );
      return workspaceResult(next.data);
    },
  };
  return service;
}
