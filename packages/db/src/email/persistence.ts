import { normalizeAgentEmailDomain } from "@deployments-ai/agent-email";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { DynamoValue } from "../record-schema.ts";
import { EmailDomainRecord, EmailTenantRecord } from "../records/email.ts";
import { UniqueClaimRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  makeSemanticEventRecord,
  transactWithSemanticEvents,
  type CreateSemanticEventRecordOptions,
} from "../semantic-event-storage.ts";
import {
  hasSameImmutableIdentity,
  isDatabaseWriteConflict,
  withClaimOwnerCondition,
} from "../transaction-conditions.ts";
import {
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  uniqueClaimRequirements,
} from "../unique-claims.ts";

export interface EmailScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
}

export interface EmailPersistenceEvent {
  readonly eventId: Ulid;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly actor?: CreateSemanticEventRecordOptions["actor"];
  readonly traceId?: string;
  readonly payload?: Readonly<Record<string, DynamoValue>>;
}

export type EmailTenantInput = Pick<EmailTenantRecord, "itemType" | "data">;
export type EmailDomainInput = Pick<EmailDomainRecord, "itemType" | "data">;
export interface EmailPageOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}
export interface EmailPage<Resource> {
  readonly items: readonly Resource[];
  readonly nextCursor?: string;
}

export interface EmailPersistence {
  readonly createTenant: (
    input: EmailTenantInput,
    event: EmailPersistenceEvent,
  ) => Promise<EmailTenantRecord>;
  readonly updateTenant: (
    input: EmailTenantInput,
    event: EmailPersistenceEvent,
  ) => Promise<EmailTenantRecord | undefined>;
  readonly getTenant: (id: string) => Promise<EmailTenantRecord | undefined>;
  readonly listTenants: (options?: EmailPageOptions) => Promise<EmailPage<EmailTenantRecord>>;
  readonly createDomain: (
    input: EmailDomainInput,
    event: EmailPersistenceEvent,
  ) => Promise<EmailDomainRecord>;
  readonly updateDomain: (
    input: EmailDomainInput,
    event: EmailPersistenceEvent,
  ) => Promise<EmailDomainRecord | undefined>;
  readonly completeDomainRevocation: (
    input: EmailDomainInput,
    event: EmailPersistenceEvent,
  ) => Promise<EmailDomainRecord | undefined>;
  readonly getDomain: (id: string) => Promise<EmailDomainRecord | undefined>;
  readonly listDomains: (
    tenantId: string,
    options?: EmailPageOptions,
  ) => Promise<EmailPage<EmailDomainRecord>>;
  readonly findDomainByName: (name: string) => Promise<EmailDomainRecord | undefined>;
}

export class EmailPersistenceError extends Schema.TaggedErrorClass<EmailPersistenceError>()(
  "EmailPersistenceError",
  {
    cause: Schema.Unknown,
    message: Schema.String,
    operation: Schema.String,
    reason: Schema.Literals(["validation", "conflict", "unknown"]),
  },
) {}

type EmailRecord = EmailTenantRecord | EmailDomainRecord;

function invalid(
  operation: string,
  message: string,
  reason: "validation" | "conflict" = "validation",
): never {
  throw new EmailPersistenceError({ cause: message, message, operation, reason });
}

async function run<A>(operation: string, promise: Promise<A>): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    throw new EmailPersistenceError({
      cause,
      message: `Email persistence ${operation} failed.`,
      operation,
      reason: isDatabaseWriteConflict(cause) ? "conflict" : "unknown",
    });
  }
}

export function makeEmailPersistence(
  database: DynamoDatabaseService,
  scope: EmailScope,
): EmailPersistence {
  const partition = key(
    "ORG",
    scope.organizationId,
    "PROJECT",
    scope.projectId,
    "ENV",
    scope.environmentId,
  );

  function inScope(record: EmailRecord) {
    return (
      record.data.organizationId === scope.organizationId &&
      record.data.projectId === scope.projectId &&
      record.data.environmentId === scope.environmentId
    );
  }

  function canonical(input: EmailTenantInput): EmailTenantRecord;
  function canonical(input: EmailDomainInput): EmailDomainRecord;
  function canonical(input: EmailTenantInput | EmailDomainInput): EmailRecord;
  function canonical(input: EmailTenantInput | EmailDomainInput): EmailRecord {
    try {
      const record =
        input.itemType === "email-tenant"
          ? Schema.decodeUnknownSync(EmailTenantRecord)(withCanonicalRecordKeys(input))
          : Schema.decodeUnknownSync(EmailDomainRecord)(
              withCanonicalRecordKeys({
                ...input,
                data: { ...input.data, domain: normalizeAgentEmailDomain(input.data.domain) },
              }),
            );
      if (!inScope(record)) invalid("write", "Email resource is outside the authenticated scope.");
      return record;
    } catch (cause) {
      if (cause instanceof EmailPersistenceError) throw cause;
      throw new EmailPersistenceError({
        cause,
        message: "Invalid email resource.",
        operation: "write",
        reason: "validation",
      });
    }
  }

  async function getTenant(id: string): Promise<EmailTenantRecord | undefined> {
    const found = await run(
      "get-tenant",
      database.getRecord(
        "control",
        {
          pk: partition,
          sk: key("EMAIL-TENANT", id),
        },
        true,
      ),
    );
    return found?.itemType === "email-tenant" && inScope(found) ? found : undefined;
  }

  async function getDomain(id: string): Promise<EmailDomainRecord | undefined> {
    const found = await run(
      "get-domain",
      database.getRecord(
        "control",
        {
          pk: partition,
          sk: key("EMAIL-DOMAIN", id),
        },
        true,
      ),
    );
    return found?.itemType === "email-domain" && inScope(found) ? found : undefined;
  }

  async function commit<Resource extends EmailRecord>(
    record: Resource,
    event: EmailPersistenceEvent,
    previous?: Resource,
    extra: readonly TransactionOperation[] = [],
  ): Promise<Resource> {
    const semanticEvent = makeSemanticEventRecord({
      ...scope,
      ...event,
      aggregateId: record.data.id,
      aggregateType: record.itemType === "email-tenant" ? "email_tenant" : "email_domain",
      aggregateVersion: record.data.version,
      payload: event.payload ?? { id: record.data.id, status: record.data.status },
    });
    await run(
      "write",
      transactWithSemanticEvents(
        database,
        [{ kind: "put", record, ...(previous ? { previousRecord: previous } : {}) }, ...extra],
        [semanticEvent],
        event.eventId,
      ),
    );
    return record;
  }

  function initial(record: EmailRecord) {
    if (record.data.version !== 1) invalid("create", "New email resources require version 1.");
  }

  function updated<Resource extends EmailRecord>(record: Resource, previous: Resource): Resource {
    if (record.data.version !== previous.data.version) {
      invalid("update", "Email resource version is stale.", "conflict");
    }
    if (!hasSameImmutableIdentity(previous, record)) {
      invalid("update", "Email resource identity cannot be changed.");
    }
    if (
      previous.itemType === "email-domain" &&
      previous.data.status === "revoked" &&
      record.data.status !== "revoked"
    ) {
      invalid("update", "Revoked email domains cannot be reactivated.");
    }
    return { ...record, data: { ...record.data, version: previous.data.version + 1 } };
  }

  async function updateDomain(
    input: EmailDomainInput,
    event: EmailPersistenceEvent,
    cleanupComplete = false,
  ) {
    const record = canonical(input);
    const previous = await getDomain(record.data.id);
    if (!previous) return undefined;
    if (record.data.revocationCompletedAt !== previous.data.revocationCompletedAt) {
      invalid("update-domain", "Provider cleanup completion requires the revocation operation.");
    }
    if (
      previous.data.verifiedAt !== undefined &&
      record.data.verifiedAt !== previous.data.verifiedAt
    ) {
      invalid("update-domain", "Established domain ownership cannot be cleared or replaced.");
    }
    if (
      cleanupComplete &&
      (previous.data.status !== "revoked" || record.data.status !== "revoked")
    ) {
      invalid("revoke-domain", "The domain must be revoked before provider cleanup completion.");
    }
    if (cleanupComplete && previous.data.revocationCompletedAt) return previous;
    const next = updated(
      cleanupComplete
        ? {
            ...record,
            data: { ...record.data, revocationCompletedAt: event.occurredAt },
          }
        : record,
      previous,
    );
    const [previousClaim] = uniqueClaimRequirements(previous);
    const [nextClaim] = uniqueClaimRequirements(next);
    const claims: TransactionOperation[] = [];
    if (!previousClaim && nextClaim) {
      claims.push(
        acquireUniqueClaim(
          Schema.decodeUnknownSync(UniqueClaimRecord)(
            makeUniqueClaimRecord(nextClaim, next.data.createdAt),
          ),
        ),
      );
    } else if (previousClaim && !nextClaim) {
      if (!cleanupComplete)
        invalid("update-domain", "Owned domain claims require completed provider cleanup.");
      claims.push(
        withClaimOwnerCondition(
          releaseUniqueClaim(
            Schema.decodeUnknownSync(UniqueClaimRecord)(
              makeUniqueClaimRecord(previousClaim, previous.data.createdAt),
            ),
          ),
          previousClaim,
        ),
      );
    }
    return commit(next, event, previous, claims);
  }

  function cursorKey(
    cursor: string | undefined,
    queryPartition: string,
    prefix: string,
    indexed: boolean,
  ) {
    if (cursor === undefined) return undefined;
    try {
      if (cursor.length > 8_192) invalid("list", "Invalid email page cursor.");
      const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
        invalid("list", "Invalid email page cursor.");
      const value = decoded as Record<string, unknown>;
      const fields = indexed ? ["pk", "sk", "gsi1pk", "gsi1sk"] : ["pk", "sk"];
      if (
        Object.keys(value).length !== fields.length ||
        fields.some((field) => typeof value[field] !== "string") ||
        value.pk !== partition ||
        !(value.sk as string).startsWith(prefix) ||
        (indexed && (value.gsi1pk !== queryPartition || value.gsi1sk !== value.sk))
      ) {
        invalid("list", "Email page cursor does not match this scope and resource collection.");
      }
      return value;
    } catch (cause) {
      if (cause instanceof EmailPersistenceError) throw cause;
      invalid("list", "Invalid email page cursor.");
    }
  }

  async function list<ItemType extends EmailRecord["itemType"]>(
    itemType: ItemType,
    options: EmailPageOptions,
    tenantId?: string,
  ): Promise<EmailPage<Extract<EmailRecord, { readonly itemType: ItemType }>>> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      invalid("list", "Email page limit must be an integer from 1 to 100.");
    const indexed = tenantId !== undefined;
    const queryPartition = indexed
      ? key(
          "ORG",
          scope.organizationId,
          "PROJECT",
          scope.projectId,
          "ENV",
          scope.environmentId,
          "EMAIL-TENANT",
          tenantId,
        )
      : partition;
    const prefix = `${itemType.toUpperCase()}#`;
    const exclusiveStartKey = cursorKey(options.cursor, queryPartition, prefix, indexed);
    const result = await run(
      "list",
      database.queryRecords("control", {
        ...(indexed ? { IndexName: "gsi1" } : { ConsistentRead: true }),
        KeyConditionExpression: indexed
          ? "gsi1pk = :pk AND begins_with(gsi1sk, :sk)"
          : "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: { ":pk": queryPartition, ":sk": prefix },
        Limit: limit,
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    const items = result.items.map((record) => {
      if (
        (record.itemType !== "email-tenant" && record.itemType !== "email-domain") ||
        record.itemType !== itemType ||
        !inScope(record) ||
        (indexed && (record.itemType !== "email-domain" || record.data.tenantId !== tenantId))
      ) {
        throw new EmailPersistenceError({
          cause: record.itemType,
          message: "Email collection contains an out-of-scope resource.",
          operation: "list",
          reason: "unknown",
        });
      }
      return record as Extract<EmailRecord, { readonly itemType: ItemType }>;
    });
    return {
      items,
      ...(result.lastEvaluatedKey
        ? { nextCursor: Buffer.from(JSON.stringify(result.lastEvaluatedKey)).toString("base64url") }
        : {}),
    };
  }

  return {
    getTenant,
    getDomain,
    async findDomainByName(name: string): Promise<EmailDomainRecord | undefined> {
      const domain = normalizeAgentEmailDomain(name);
      const claim = await run(
        "find-domain",
        database.getRecord(
          "control",
          {
            pk: key("UNIQUE", "inbox-domain"),
            sk: key("VALUE", domain),
          },
          true,
        ),
      );
      if (
        claim?.itemType !== "unique-claim" ||
        claim.data.ownerItemType !== "email-domain" ||
        claim.data.ownerPk !== partition
      )
        return undefined;
      const found = await getDomain(claim.data.ownerId);
      return found?.data.domain === domain && found.sk === claim.data.ownerSk ? found : undefined;
    },
    listTenants: (options: EmailPageOptions = {}) => list("email-tenant", options),
    listDomains: (tenantId: string, options: EmailPageOptions = {}) =>
      list("email-domain", options, tenantId),
    async createTenant(input: EmailTenantInput, event: EmailPersistenceEvent) {
      const record = canonical(input);
      initial(record);
      return commit(record, event);
    },
    async updateTenant(input: EmailTenantInput, event: EmailPersistenceEvent) {
      const record = canonical(input);
      const previous = await getTenant(record.data.id);
      return previous ? commit(updated(record, previous), event, previous) : undefined;
    },
    async createDomain(input: EmailDomainInput, event: EmailPersistenceEvent) {
      const record = canonical(input);
      initial(record);
      const tenant = await getTenant(record.data.tenantId);
      if (!tenant) invalid("create-domain", "Email tenant does not exist in this scope.");
      const claims = uniqueClaimRequirements(record).map((requirement) =>
        acquireUniqueClaim(
          Schema.decodeUnknownSync(UniqueClaimRecord)(
            makeUniqueClaimRecord(requirement, record.data.createdAt),
          ),
        ),
      );
      return commit(record, event, undefined, [
        ...claims,
        {
          kind: "condition-check",
          table: "control",
          key: { pk: tenant.pk, sk: tenant.sk },
          conditionExpression: "#itemType = :itemType AND #data.#version = :version",
          expressionAttributeNames: {
            "#itemType": "itemType",
            "#data": "data",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":itemType": "email-tenant",
            ":version": tenant.data.version,
          },
        },
      ]);
    },
    updateDomain: (input, event) => updateDomain(input, event),
    completeDomainRevocation: (input, event) => updateDomain(input, event, true),
  };
}
