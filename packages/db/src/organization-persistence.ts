import { Schema } from "effect";
import { key } from "./keys.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import { OrganizationMemberRecord } from "./records/tenancy.ts";
import {
  MemorySearchMutationFenceRecord,
  MemorySearchPlacementRecord,
} from "./records/memory-search.ts";
import { BrainSearchPlacementRecord } from "./records/brain-search.ts";
import type {
  Organization,
  OrganizationMember,
  TenancyContext,
  TenancyPersistence,
} from "./tenancy.ts";
import {
  assertPathScope,
  createOperations,
  databaseValue,
  encodeIdentityPageCursor,
  id,
  identityPageCursor,
  mutableRecord,
  organizationResult,
  requiredResourceId,
  resolveSlug,
  updatedRecord,
  updateOperations,
} from "./tenancy.ts";
import {
  makeOrganizationCreationFence,
  UNLIMITED_ORGANIZATION_CREATION,
} from "./tenancy/organization-creation-policy.ts";

export function makeOrganizationPersistence(context: TenancyContext) {
  const {
    dependencies,
    generateId,
    now,
    getRecord,
    listRecords,
    authorizeOrganization,
    requireOrganizationRole,
    organizationsForIdentity,
    write,
    writeOrganizationRecords,
    activeOwnerCount: _activeOwnerCount,
    invitationTokenMatches: _invitationTokenMatches,
    organizationRecord: _organizationRecord,
    organizationMember: _organizationMember,
    invitationById: _invitationById,
    expirePendingInvitationForEmail: _expirePendingInvitationForEmail,
    environmentPartition: _environmentPartition,
    workspaceFor: _workspaceFor,
    credential: _credential,
  } = context;
  const creationFence = makeOrganizationCreationFence(
    dependencies.database,
    dependencies.organizationCreation ?? UNLIMITED_ORGANIZATION_CREATION,
  );
  const service: TenancyPersistence["organizations"] = {
    async list(invocation) {
      const allowed = await organizationsForIdentity(invocation);
      if (allowed === "*") {
        const page = await listRecords<Organization>(
          invocation,
          key("GLOBAL", "ORGANIZATIONS"),
          "organization",
          "gsi1",
        );
        return {
          items: page.items.map((record) => organizationResult(record.data)),
          nextCursor: page.nextCursor,
        };
      }
      const organizationIds = allowed.toSorted();
      let offset: number;
      try {
        offset = identityPageCursor(invocation.query.cursor, organizationIds);
      } catch (cause) {
        return databaseValue(Promise.reject(cause));
      }
      const limit = invocation.query.limit ?? 50;
      const selected = organizationIds.slice(offset, offset + limit);
      const records = await Promise.all(
        selected.map(async (organizationId) => {
          const record = await databaseValue(
            dependencies.database.getRecord(
              "control",
              { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
              true,
            ),
          );
          return record?.itemType === "organization" ? organizationResult(record.data) : undefined;
        }),
      );
      return {
        items: records.filter((record) => record !== undefined),
        nextCursor: encodeIdentityPageCursor(offset + selected.length, organizationIds),
      };
    },
    async create(invocation) {
      const timestamp = now().toISOString();
      const resourceId = id(await generateId());
      const slug = String(
        resolveSlug({
          name: invocation.body.name,
          ...(invocation.body.slug ? { slug: invocation.body.slug } : {}),
        }),
      );
      const record = mutableRecord("organization", {
        createdAt: timestamp,
        id: resourceId,
        name: invocation.body.name,
        slug,
        status: "active",
        updatedAt: timestamp,
        version: 1,
      });
      const member = Schema.decodeUnknownSync(OrganizationMemberRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            joinedAt: timestamp,
            organizationId: resourceId,
            principalId: id(invocation.identity.principalId),
            role: "owner",
            status: "active",
            updatedAt: timestamp,
            version: 1,
          },
          itemType: "organization-member" as const,
        }),
      ) as OrganizationMember;
      const memorySearchPlacement = Schema.decodeUnknownSync(MemorySearchPlacementRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            generation: 0,
            organizationId: resourceId,
            phase: "unconfigured" as const,
            updatedAt: timestamp,
            version: 0,
            writeTargets: [],
          },
          itemType: "memory-search-placement" as const,
        }),
      );
      const memorySearchFence = Schema.decodeUnknownSync(MemorySearchMutationFenceRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            epoch: 0,
            organizationId: resourceId,
            status: "open" as const,
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "memory-search-mutation-fence" as const,
        }),
      );
      const brainSearchPlacement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: timestamp,
            generation: 0,
            organizationId: resourceId,
            phase: "unconfigured" as const,
            updatedAt: timestamp,
            version: 0,
          },
          itemType: "brain-search-placement" as const,
        }),
      );
      await creationFence.commit(invocation, timestamp, (fenceOperations) =>
        writeOrganizationRecords(
          invocation,
          "organization.create",
          [
            ...createOperations(record, timestamp),
            { kind: "put", record: member },
            { kind: "put", record: memorySearchPlacement },
            { kind: "put", record: memorySearchFence },
            { kind: "put", record: brainSearchPlacement },
            ...fenceOperations,
          ],
          [
            {
              aggregateId: record.data.id,
              aggregateType: "organization",
              aggregateVersion: record.data.version,
              eventType: "organization.created",
              organizationId: record.data.id,
              payload: { id: record.data.id, status: record.data.status },
            },
            {
              aggregateId: member.data.principalId,
              aggregateType: "organization-member",
              aggregateVersion: member.data.version,
              eventType: "organization-member.added",
              organizationId: record.data.id,
              payload: {
                principalId: member.data.principalId,
                role: member.data.role,
                status: member.data.status,
              },
            },
          ],
          timestamp,
          { code: "resource_conflict", message: "Organization slug is already in use." },
        ),
      );
      return organizationResult(record.data);
    },
    async get(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "organizationId", resourceId);
      await authorizeOrganization(invocation, resourceId);
      const record = await getRecord<Organization>(
        { pk: key("ORG", resourceId), sk: key("ORG", resourceId) },
        "organization",
        "Organization",
      );
      return organizationResult(record.data);
    },
    async update(invocation) {
      const resourceId = requiredResourceId(invocation);
      assertPathScope(invocation, "organizationId", resourceId);
      await authorizeOrganization(invocation, resourceId);
      await requireOrganizationRole(
        invocation,
        resourceId,
        "organization.update",
        "Updating the organization",
      );
      const previous = await getRecord<Organization>(
        { pk: key("ORG", resourceId), sk: key("ORG", resourceId) },
        "organization",
        "Organization",
      );
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
        "organization.update",
        updateOperations(previous, next, timestamp),
        next,
        "organization.updated",
        timestamp,
        {
          code: "resource_conflict",
          message: "The organization changed or its slug is already in use.",
        },
      );
      return organizationResult(next.data);
    },
  };
  return service;
}
