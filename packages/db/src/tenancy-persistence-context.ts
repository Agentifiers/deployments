import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type TransactionOperation } from "./client-types.ts";
import { Ulid, makeIdGenerator } from "./ids.ts";
import { key } from "./keys.ts";
import { PersistenceError, type PersistenceInvocation } from "./persistence-types.ts";
import type { DynamoValue } from "./record-schema.ts";
import { type PlatformRecord } from "./records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "./semantic-event-storage.ts";
import { organizationAuditOperationForEvent } from "./audit/organization-audit-log.ts";
import { makePersistenceTransactionToken } from "./transaction-conditions.ts";
import {
  actsUnderOperatorAccess,
  isPlatformAdministrator,
  principalAuditActor,
} from "./tenancy-authorization.ts";
import {
  organizationRoleAllows,
  organizationRolesAllowing,
  type OrganizationRoleAction,
} from "./organization-role-matrix.ts";

import {
  type ApiCredential,
  type CursorIndex,
  type Environment,
  type Organization,
  type OrganizationInvitation,
  type OrganizationMember,
  type Principal,
  type Project,
  type TenancyPersistenceDependencies,
  type TenancyRecord,
  type Workspace,
  assertIdentityGrant,
  id,
  identityOrganizations,
  requiredResourceId,
} from "./tenancy-contracts.ts";
import {
  databaseValue,
  decodeCursor,
  encodeCursor,
  requiredScope,
  updateOperations,
  updatedOrganizationInvitation,
} from "./tenancy-record-mapping.ts";

/**
 * Organization administration audited in the organization audit log. Environment-scoped tenancy
 * resources (workspaces, service accounts, API keys) are environment activity, not organization
 * administration.
 */
const ORGANIZATION_AUDITED_RECORD_TYPES: Partial<Record<TenancyRecord["itemType"], true>> = {
  environment: true,
  organization: true,
  project: true,
};

export function makeTenancyContext(dependencies: TenancyPersistenceDependencies) {
  const idGenerator = makeIdGenerator();
  const generateId = dependencies.generateId ?? (async () => idGenerator.generate());
  const now = dependencies.now ?? (() => new Date());
  const generateSecret =
    dependencies.generateSecret ??
    ((credentialId: string) => `dpl_${credentialId}_${randomBytes(24).toString("base64url")}`);
  const generateInvitationToken =
    dependencies.generateInvitationToken ??
    ((invitationId: string) => `dpl_inv_${invitationId}_${randomBytes(32).toString("base64url")}`);

  async function getRecord<RecordType extends PlatformRecord>(
    tableKey: { readonly pk: string; readonly sk: string },
    itemType: RecordType["itemType"],
    label: string,
  ): Promise<RecordType> {
    const record = await databaseValue(dependencies.database.getRecord("control", tableKey, true));
    if (!record || record.itemType !== itemType) {
      throw new PersistenceError("not-found", "resource_not_found", `${label} was not found.`);
    }
    return record as RecordType;
  }

  async function listRecords<RecordType extends PlatformRecord>(
    invocation: PersistenceInvocation,
    partition: string,
    itemType: RecordType["itemType"],
    index: CursorIndex = "base",
  ) {
    const prefix = `${key(itemType.toUpperCase())}#`;
    let exclusiveStartKey: Record<string, string> | undefined;
    try {
      exclusiveStartKey = decodeCursor(invocation.query.cursor, index, partition, prefix);
    } catch (cause) {
      return databaseValue(Promise.reject(cause));
    }
    const partitionName = index === "base" ? "pk" : `${index}pk`;
    const sortName = index === "base" ? "sk" : `${index}sk`;
    const result = await databaseValue(
      dependencies.database.queryRecords("control", {
        ...(index === "base" ? { ConsistentRead: true } : { IndexName: index }),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ExpressionAttributeNames: { "#partition": partitionName, "#sort": sortName },
        ExpressionAttributeValues: { ":partition": partition, ":prefix": prefix },
        KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
        Limit: invocation.query.limit ?? 50,
      }),
    );
    return {
      items: result.items.filter((record): record is RecordType => record.itemType === itemType),
      nextCursor: result.lastEvaluatedKey
        ? encodeCursor(result.lastEvaluatedKey, index, partition, prefix)
        : null,
    };
  }

  async function authorizeOrganization(invocation: PersistenceInvocation, organizationId: Ulid) {
    const allowed = identityOrganizations(invocation.identity);
    if (allowed !== undefined) {
      if (allowed === "*" || allowed.some((candidate) => candidate === organizationId)) return;
      throw new PersistenceError(
        "forbidden",
        "organization_scope_violation",
        "The credential cannot access the requested organization.",
      );
    }
    const membership = await databaseValue(
      dependencies.database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId),
          sk: key("ORGANIZATION-MEMBER", id(invocation.identity.principalId)),
        },
        true,
      ),
    );
    if (membership?.itemType === "organization-member" && membership.data.status === "active") {
      return;
    }
    throw new PersistenceError(
      "forbidden",
      "organization_scope_violation",
      "The credential cannot access the requested organization.",
    );
  }

  async function activeOrganizationMember(invocation: PersistenceInvocation, organizationId: Ulid) {
    const member = await databaseValue(
      dependencies.database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId),
          sk: key("ORGANIZATION-MEMBER", id(invocation.identity.principalId)),
        },
        true,
      ),
    );
    return member?.itemType === "organization-member" && member.data.status === "active"
      ? member
      : undefined;
  }

  async function requireOrganizationRole(
    invocation: PersistenceInvocation,
    organizationId: Ulid,
    action: OrganizationRoleAction,
    description: string,
  ) {
    if (actsUnderOperatorAccess(invocation, organizationId)) return undefined;
    const member = await activeOrganizationMember(invocation, organizationId);
    if (!member || !organizationRoleAllows(member.data.role, action)) {
      throw new PersistenceError(
        "forbidden",
        "insufficient_role",
        `${description} requires one of these organization roles: ${organizationRolesAllowing(action).join(", ")}.`,
      );
    }
    return member;
  }

  async function organizationsForIdentity(
    invocation: PersistenceInvocation,
  ): Promise<readonly Ulid[] | "*"> {
    const allowed = identityOrganizations(invocation.identity);
    if (allowed) return allowed;
    const organizationIds: Ulid[] = [];
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      const page = await databaseValue(
        dependencies.database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#partition": "gsi2pk", "#sort": "gsi2sk" },
          ExpressionAttributeValues: {
            ":partition": key("PRINCIPAL", id(invocation.identity.principalId)),
            ":prefix": `${key("ORGANIZATION-MEMBER")}#`,
          },
          IndexName: "gsi2",
          KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
          Limit: 100,
        }),
      );
      organizationIds.push(
        ...page.items
          .filter(
            (record): record is OrganizationMember =>
              record.itemType === "organization-member" && record.data.status === "active",
          )
          .map((record) => record.data.organizationId),
      );
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return organizationIds;
  }

  async function recordById<RecordType extends Project | Environment>(
    invocation: PersistenceInvocation,
    itemType: RecordType["itemType"],
    resourceId: Ulid,
  ): Promise<RecordType> {
    const claim = await databaseValue(
      dependencies.database.getRecord(
        "control",
        { pk: key("UNIQUE", `${itemType}-id`), sk: key("VALUE", resourceId) },
        true,
      ),
    );
    if (
      claim?.itemType !== "unique-claim" ||
      claim.data.ownerItemType !== itemType ||
      claim.data.ownerId !== resourceId
    ) {
      throw new PersistenceError(
        "not-found",
        "resource_not_found",
        `${itemType === "project" ? "Project" : "Environment"} was not found.`,
      );
    }
    const record = await getRecord<RecordType>(
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      itemType,
      itemType === "project" ? "Project" : "Environment",
    );
    await authorizeOrganization(invocation, record.data.organizationId);
    if (record.itemType === "project") {
      assertIdentityGrant(invocation.identity.projectIds, record.data.id, "project");
    } else {
      assertIdentityGrant(invocation.identity.projectIds, record.data.projectId, "project");
      assertIdentityGrant(invocation.identity.environmentIds, record.data.id, "environment");
    }
    return record;
  }

  function projectFor(invocation: PersistenceInvocation, projectId: Ulid) {
    return recordById<Project>(invocation, "project", projectId);
  }

  function environmentFor(invocation: PersistenceInvocation, environmentId?: Ulid) {
    return recordById<Environment>(
      invocation,
      "environment",
      environmentId ?? requiredScope(invocation, "environmentId"),
    );
  }

  async function event(
    invocation: PersistenceInvocation,
    record: TenancyRecord,
    eventType: string,
    timestamp: string,
  ) {
    const data = record.data;
    const organizationId =
      record.itemType === "organization" ? record.data.id : record.data.organizationId;
    const projectId =
      record.itemType === "project"
        ? record.data.id
        : record.itemType === "organization"
          ? undefined
          : record.data.projectId;
    const environmentId =
      record.itemType === "environment"
        ? record.data.id
        : record.itemType === "workspace" ||
            record.itemType === "service-account" ||
            record.itemType === "api-credential"
          ? record.data.environmentId
          : undefined;
    return makeSemanticEventRecord({
      actor: { id: id(invocation.identity.principalId), type: "principal" },
      aggregateId: data.id,
      aggregateType: record.itemType,
      aggregateVersion: data.version,
      ...(environmentId ? { environmentId } : {}),
      eventId: id(await generateId()),
      eventType,
      occurredAt: timestamp,
      organizationId,
      payload: { id: data.id, status: data.status },
      ...(projectId ? { projectId } : {}),
    });
  }

  async function write(
    invocation: PersistenceInvocation,
    operation: string,
    operations: readonly TransactionOperation[],
    record: TenancyRecord,
    eventType: string,
    timestamp: string,
    conflict: { readonly code: string; readonly message: string },
  ) {
    const semanticEvent = await event(invocation, record, eventType, timestamp);
    await databaseValue(
      transactWithSemanticEvents(
        dependencies.database,
        ORGANIZATION_AUDITED_RECORD_TYPES[record.itemType]
          ? [
              ...operations,
              organizationAuditOperationForEvent(
                semanticEvent,
                principalAuditActor(
                  invocation.identity.principalId,
                  invocation.identity.operatorAccess?.grantId,
                ),
              ),
            ]
          : operations,
        [semanticEvent],
        makePersistenceTransactionToken(invocation, operation),
      ),
      conflict,
    );
  }

  async function organizationScopedEvent(input: {
    readonly aggregateId: Ulid;
    readonly aggregateType: "organization" | "organization-invitation" | "organization-member";
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly invocation: PersistenceInvocation;
    readonly organizationId: Ulid;
    readonly payload: Readonly<Record<string, DynamoValue>>;
    readonly timestamp: string;
  }) {
    return makeSemanticEventRecord({
      actor: { id: id(input.invocation.identity.principalId), type: "principal" },
      aggregateId: input.aggregateId,
      aggregateType: input.aggregateType,
      aggregateVersion: input.aggregateVersion,
      eventId: id(await generateId()),
      eventType: input.eventType,
      occurredAt: input.timestamp,
      organizationId: input.organizationId,
      payload: input.payload,
    });
  }

  async function writeOrganizationRecords(
    invocation: PersistenceInvocation,
    operation: string,
    operations: readonly TransactionOperation[],
    eventInput:
      | Omit<Parameters<typeof organizationScopedEvent>[0], "invocation" | "timestamp">
      | readonly Omit<Parameters<typeof organizationScopedEvent>[0], "invocation" | "timestamp">[],
    timestamp: string,
    conflict: { readonly code: string; readonly message: string },
    audit: "none" | "primary-event" = "primary-event",
  ) {
    const events = await Promise.all(
      (Array.isArray(eventInput) ? eventInput : [eventInput]).map((input) =>
        organizationScopedEvent({
          ...input,
          invocation,
          timestamp,
        }),
      ),
    );
    await databaseValue(
      transactWithSemanticEvents(
        dependencies.database,
        audit === "primary-event" && events[0]
          ? [
              ...operations,
              organizationAuditOperationForEvent(
                events[0],
                principalAuditActor(
                  invocation.identity.principalId,
                  invocation.identity.operatorAccess?.grantId,
                ),
              ),
            ]
          : operations,
        events,
        makePersistenceTransactionToken(invocation, operation),
      ),
      conflict,
    );
  }

  async function principalFor(principalId: Ulid): Promise<Principal | undefined> {
    const record = await databaseValue(
      dependencies.database.getRecord(
        "control",
        { pk: key("PRINCIPAL", principalId), sk: key("PRINCIPAL", principalId) },
        true,
      ),
    );
    return record?.itemType === "principal" ? record : undefined;
  }

  async function activeOwnerCount(organizationId: Ulid) {
    let count = 0;
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      const page = await databaseValue(
        dependencies.database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", organizationId),
            ":prefix": `${key("ORGANIZATION-MEMBER")}#`,
          },
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          Limit: 100,
        }),
      );
      count += page.items.filter(
        (record) =>
          record.itemType === "organization-member" &&
          record.data.status === "active" &&
          record.data.role === "owner",
      ).length;
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return count;
  }

  function invitationTokenMatches(token: string, expectedHash: string) {
    const actual = Buffer.from(createHash("sha256").update(token).digest("hex"));
    const expected = Buffer.from(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async function organizationRecord(organizationId: Ulid) {
    return getRecord<Organization>(
      { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
      "organization",
      "Organization",
    );
  }

  async function organizationMember(
    organizationId: Ulid,
    principalId: Ulid,
  ): Promise<OrganizationMember> {
    return getRecord<OrganizationMember>(
      {
        pk: key("ORG", organizationId),
        sk: key("ORGANIZATION-MEMBER", principalId),
      },
      "organization-member",
      "Organization member",
    );
  }

  async function invitationById(organizationId: Ulid, invitationId: Ulid) {
    return getRecord<OrganizationInvitation>(
      {
        pk: key("ORG", organizationId),
        sk: key("ORGANIZATION-INVITATION", invitationId),
      },
      "organization-invitation",
      "Organization invitation",
    );
  }

  async function expirePendingInvitationForEmail(
    invocation: PersistenceInvocation,
    organizationId: Ulid,
    email: string,
    current: Date,
  ) {
    const claim = await databaseValue(
      dependencies.database.getRecord(
        "control",
        {
          pk: key("UNIQUE", `organization:${organizationId}:pending-invitation-email`),
          sk: key("VALUE", email),
        },
        true,
      ),
    );
    if (
      claim?.itemType !== "unique-claim" ||
      claim.data.ownerItemType !== "organization-invitation"
    ) {
      return;
    }
    const previous = await getRecord<OrganizationInvitation>(
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      "organization-invitation",
      "Organization invitation",
    );
    if (
      previous.data.organizationId !== organizationId ||
      previous.data.email !== email ||
      previous.data.status !== "pending" ||
      Date.parse(previous.data.expiresAt) > current.getTime()
    ) {
      return;
    }
    const timestamp = current.toISOString();
    const expired = updatedOrganizationInvitation(previous, timestamp, {
      status: "expired",
    });
    await writeOrganizationRecords(
      invocation,
      "organization-invitation.expire-existing",
      updateOperations(previous as never, expired as never, timestamp),
      {
        aggregateId: expired.data.id,
        aggregateType: "organization-invitation",
        aggregateVersion: expired.data.version,
        eventType: "organization-invitation.expired",
        organizationId,
        payload: { email: expired.data.email, status: expired.data.status },
      },
      timestamp,
      { code: "invitation_conflict", message: "The invitation changed concurrently." },
      "none",
    );
  }

  async function environmentPartition(invocation: PersistenceInvocation, requireActive = false) {
    const environment = await environmentFor(invocation);
    if (requireActive && environment.data.status !== "active") {
      throw new PersistenceError(
        "conflict",
        "environment_archived",
        "Archived environments cannot accept new resources.",
      );
    }
    return {
      environmentId: environment.data.id,
      organizationId: environment.data.organizationId,
      projectId: environment.data.projectId,
    };
  }

  async function workspaceFor(invocation: PersistenceInvocation) {
    const scope = await environmentPartition(invocation);
    return getRecord<Workspace>(
      {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("WORKSPACE", requiredResourceId(invocation)),
      },
      "workspace",
      "Workspace",
    );
  }

  async function credential(invocation: PersistenceInvocation, requireActive = false) {
    const scope = await environmentPartition(invocation, requireActive);
    const record = await getRecord<ApiCredential>(
      {
        pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
        sk: key("API-CREDENTIAL", requiredResourceId(invocation)),
      },
      "api-credential",
      "API credential",
    );
    return { record, scope };
  }
  return {
    dependencies,
    idGenerator,
    generateId,
    now,
    generateSecret,
    generateInvitationToken,
    getRecord,
    listRecords,
    authorizeOrganization,
    isPlatformAdministrator,
    activeOrganizationMember,
    requireOrganizationRole,
    organizationsForIdentity,
    recordById,
    projectFor,
    environmentFor,
    event,
    write,
    organizationScopedEvent,
    writeOrganizationRecords,
    principalFor,
    activeOwnerCount,
    invitationTokenMatches,
    organizationRecord,
    organizationMember,
    invitationById,
    expirePendingInvitationForEmail,
    environmentPartition,
    workspaceFor,
    credential,
  };
}

export type TenancyContext = ReturnType<typeof makeTenancyContext>;
