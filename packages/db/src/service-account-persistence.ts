import { key } from "./keys.ts";
import type { ServiceAccount, TenancyContext, TenancyPersistence } from "./tenancy.ts";
import {
  delegatedScopes,
  id,
  mutableRecord,
  requiredResourceId,
  serviceAccountResult,
  updatedRecord,
} from "./tenancy.ts";

export function makeServiceAccountPersistence(context: TenancyContext) {
  const {
    dependencies: _dependencies,
    idGenerator: _idGenerator,
    generateId,
    now,
    generateSecret: _generateSecret,
    generateInvitationToken: _generateInvitationToken,
    getRecord,
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
    workspaceFor: _workspaceFor,
    credential: _credential,
  } = context;
  const service: TenancyPersistence["serviceAccounts"] = {
    async list(invocation) {
      const scope = await environmentPartition(invocation);
      const page = await listRecords<ServiceAccount>(
        invocation,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "service-account",
      );
      return {
        items: page.items.map((record) => serviceAccountResult(record.data)),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      const scope = await environmentPartition(invocation, true);
      const timestamp = now().toISOString();
      const record = mutableRecord("service-account", {
        createdAt: timestamp,
        createdByPrincipalId: id(invocation.identity.principalId),
        ...(invocation.body.description ? { description: invocation.body.description } : {}),
        environmentId: scope.environmentId,
        id: id(await generateId()),
        name: invocation.body.name,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        scopes: delegatedScopes(invocation.identity, invocation.body.scopes),
        status: "active",
        updatedAt: timestamp,
        version: 1,
      });
      await write(
        invocation,
        "service-account.create",
        [{ kind: "put", record }],
        record,
        "service-account.created",
        timestamp,
        { code: "resource_conflict", message: "The service account already exists." },
      );
      return serviceAccountResult(record.data);
    },
    async get(invocation) {
      const scope = await environmentPartition(invocation);
      const record = await getRecord<ServiceAccount>(
        {
          pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
          sk: key("SERVICE-ACCOUNT", requiredResourceId(invocation)),
        },
        "service-account",
        "Service account",
      );
      return serviceAccountResult(record.data);
    },
    async revoke(invocation) {
      const scope = await environmentPartition(invocation);
      const previous = await getRecord<ServiceAccount>(
        {
          pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
          sk: key("SERVICE-ACCOUNT", requiredResourceId(invocation)),
        },
        "service-account",
        "Service account",
      );
      if (previous.data.status === "disabled") return serviceAccountResult(previous.data);
      const timestamp = now().toISOString();
      const next = updatedRecord(previous, timestamp, { status: "disabled" });
      await write(
        invocation,
        "service-account.revoke",
        [{ kind: "put", previousRecord: previous, record: next }],
        next,
        "service-account.revoked",
        timestamp,
        { code: "version_conflict", message: "The service account changed concurrently." },
      );
      return serviceAccountResult(next.data);
    },
  };
  return service;
}
