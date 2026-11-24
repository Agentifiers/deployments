import { Schema } from "effect";
import { createHash } from "node:crypto";
import { DatabaseError, type TransactionOperation } from "./client-types.ts";
import { Ulid } from "./ids.ts";
import { PersistenceError, type PersistenceInvocation } from "./persistence-types.ts";
import { WorkspaceRecord } from "./records/control.ts";
import { type PlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";
import {
  ApiCredentialRecord,
  EnvironmentRecord,
  OrganizationInvitationRecord,
  OrganizationMemberRecord,
  OrganizationRecord,
  ProjectRecord,
  ServiceAccountRecord,
} from "./records/tenancy.ts";
import { isDatabaseWriteConflict } from "./transaction-conditions.ts";
import {
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  uniqueClaimRequirements,
} from "./unique-claims.ts";

import {
  type CursorIndex,
  InvalidTenancyCursorError,
  type OrganizationInvitation,
  type OrganizationMember,
  type TenancyRecord,
  id,
  invalidCursor,
} from "./tenancy-contracts.ts";
export function requiredScope(
  invocation: PersistenceInvocation,
  field: "organizationId" | "projectId" | "environmentId",
): Ulid {
  const value = invocation.scope[field];
  if (!value) {
    throw new PersistenceError(
      "invalid-input",
      "missing_scope",
      `The ${field.replace("Id", "")} scope is required.`,
    );
  }
  return id(value);
}

export function assertPathScope(
  invocation: PersistenceInvocation,
  field: "organizationId" | "projectId" | "environmentId",
  resourceId: string,
) {
  const scopedId = requiredScope(invocation, field);
  if (String(scopedId) !== String(resourceId)) {
    throw new PersistenceError(
      "forbidden",
      `${field.replace("Id", "")}_scope_violation`,
      "The resource is outside the requested scope.",
    );
  }
}

export async function databaseValue<A>(
  promise: Promise<A>,
  conflict?: { readonly code: string; readonly message: string },
): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    if (cause instanceof InvalidTenancyCursorError) {
      throw new PersistenceError(
        "invalid-input",
        "invalid_cursor",
        "The pagination cursor is invalid.",
      );
    }
    if (cause instanceof DatabaseError && conflict && isDatabaseWriteConflict(cause)) {
      throw new PersistenceError("conflict", conflict.code, conflict.message);
    }
    throw new PersistenceError("internal", "persistence_error", "Tenancy persistence failed.");
  }
}

export function cursorKey(value: unknown, index: CursorIndex): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCursor();
  const expected = index === "base" ? ["pk", "sk"] : [`${index}pk`, `${index}sk`, "pk", "sk"];
  const entries = Object.entries(value);
  if (entries.length !== expected.length || expected.some((name) => !Object.hasOwn(value, name))) {
    throw invalidCursor();
  }
  const result = Object.fromEntries(entries) as Record<string, unknown>;
  for (const name of expected) {
    const entry = result[name];
    const byteLimit = name.endsWith("pk") ? 2_048 : 1_024;
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      new TextEncoder().encode(entry).byteLength > byteLimit
    ) {
      throw invalidCursor();
    }
  }
  return result as Record<string, string>;
}

export function decodeCursor(
  cursor: string | undefined,
  index: CursorIndex,
  partition: string,
  prefix: string,
) {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly index?: unknown;
      readonly key?: unknown;
      readonly partition?: unknown;
      readonly prefix?: unknown;
      readonly version?: unknown;
    };
    if (
      decoded.version !== 1 ||
      decoded.index !== index ||
      decoded.partition !== partition ||
      decoded.prefix !== prefix
    ) {
      throw invalidCursor();
    }
    const decodedKey = cursorKey(decoded.key, index);
    const partitionName = index === "base" ? "pk" : `${index}pk`;
    const sortName = index === "base" ? "sk" : `${index}sk`;
    if (decodedKey[partitionName] !== partition || !decodedKey[sortName]?.startsWith(prefix)) {
      throw invalidCursor();
    }
    return decodedKey;
  } catch (cause) {
    if (cause instanceof InvalidTenancyCursorError) throw cause;
    throw invalidCursor();
  }
}

export function encodeCursor(
  keyValue: Readonly<Record<string, unknown>>,
  index: CursorIndex,
  partition: string,
  prefix: string,
) {
  return Buffer.from(
    JSON.stringify({
      index,
      key: cursorKey(keyValue, index),
      partition,
      prefix,
      version: 1,
    }),
  ).toString("base64url");
}

export function identityPageCursor(cursor: string | undefined, organizationIds: readonly Ulid[]) {
  if (!cursor) return 0;
  const scopeHash = createHash("sha256").update(organizationIds.join("\u0000")).digest("hex");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly index?: unknown;
      readonly offset?: unknown;
      readonly scopeHash?: unknown;
      readonly version?: unknown;
    };
    if (
      decoded.version !== 1 ||
      decoded.index !== "identity" ||
      decoded.scopeHash !== scopeHash ||
      !Number.isSafeInteger(decoded.offset) ||
      (decoded.offset as number) < 0 ||
      (decoded.offset as number) >= organizationIds.length
    ) {
      throw invalidCursor();
    }
    return decoded.offset as number;
  } catch (cause) {
    if (cause instanceof InvalidTenancyCursorError) throw cause;
    throw invalidCursor();
  }
}

export function encodeIdentityPageCursor(offset: number, organizationIds: readonly Ulid[]) {
  if (offset >= organizationIds.length) return null;
  return Buffer.from(
    JSON.stringify({
      index: "identity",
      offset,
      scopeHash: createHash("sha256").update(organizationIds.join("\u0000")).digest("hex"),
      version: 1,
    }),
  ).toString("base64url");
}

export function mutableRecord<ItemType extends TenancyRecord["itemType"]>(
  itemType: ItemType,
  data: Extract<TenancyRecord, { readonly itemType: ItemType }>["data"],
) {
  return Schema.decodeUnknownSync(
    itemType === "organization"
      ? OrganizationRecord
      : itemType === "project"
        ? ProjectRecord
        : itemType === "environment"
          ? EnvironmentRecord
          : itemType === "workspace"
            ? WorkspaceRecord
            : itemType === "service-account"
              ? ServiceAccountRecord
              : ApiCredentialRecord,
  )(withCanonicalRecordKeys({ data, itemType })) as Extract<
    TenancyRecord,
    { readonly itemType: ItemType }
  >;
}

function nextVersionData<Data extends { readonly version: number }>(
  previous: Data,
  timestamp: string,
  changes: Partial<Data>,
): Data {
  // Record schemas reject undefined values, so an undefined change clears the field.
  return Object.fromEntries(
    Object.entries({
      ...previous,
      ...changes,
      updatedAt: timestamp,
      version: previous.version + 1,
    }).filter(([, value]) => value !== undefined),
  ) as Data;
}

export function updatedRecord<RecordType extends TenancyRecord>(
  previous: RecordType,
  timestamp: string,
  changes: Partial<RecordType["data"]>,
): RecordType {
  return mutableRecord(
    previous.itemType,
    nextVersionData(previous.data, timestamp, changes) as never,
  ) as RecordType;
}

export function organizationMemberRecord(data: OrganizationMember["data"]): OrganizationMember {
  return Schema.decodeUnknownSync(OrganizationMemberRecord)(
    withCanonicalRecordKeys({ data, itemType: "organization-member" as const }),
  ) as OrganizationMember;
}

export function updatedOrganizationMember(
  previous: OrganizationMember,
  timestamp: string,
  changes: Partial<OrganizationMember["data"]>,
) {
  return organizationMemberRecord(nextVersionData(previous.data, timestamp, changes));
}

export function organizationInvitationRecord(
  data: OrganizationInvitation["data"],
): OrganizationInvitation {
  return Schema.decodeUnknownSync(OrganizationInvitationRecord)(
    withCanonicalRecordKeys({ data, itemType: "organization-invitation" as const }),
  ) as OrganizationInvitation;
}

export function updatedOrganizationInvitation(
  previous: OrganizationInvitation,
  timestamp: string,
  changes: Partial<OrganizationInvitation["data"]>,
) {
  return organizationInvitationRecord(nextVersionData(previous.data, timestamp, changes));
}

export function claimRecord(
  requirement: ReturnType<typeof uniqueClaimRequirements>[number],
  timestamp: string,
) {
  return makeUniqueClaimRecord(requirement, timestamp) as Extract<
    PlatformRecord,
    { readonly itemType: "unique-claim" }
  >;
}

export function sameClaim(
  left: ReturnType<typeof uniqueClaimRequirements>[number],
  right: ReturnType<typeof uniqueClaimRequirements>[number],
) {
  return left.namespace === right.namespace && left.value === right.value;
}

export function createOperations(record: TenancyRecord, timestamp: string): TransactionOperation[] {
  return [
    { kind: "put", record },
    ...uniqueClaimRequirements(record).map((requirement) =>
      acquireUniqueClaim(claimRecord(requirement, timestamp)),
    ),
  ];
}

export function updateOperations(previous: TenancyRecord, next: TenancyRecord, timestamp: string) {
  const previousClaims = uniqueClaimRequirements(previous);
  const nextClaims = uniqueClaimRequirements(next);
  const operations: TransactionOperation[] = [
    { kind: "put", previousRecord: previous, record: next },
  ];
  for (const requirement of nextClaims) {
    if (!previousClaims.some((candidate) => sameClaim(candidate, requirement))) {
      operations.push(acquireUniqueClaim(claimRecord(requirement, timestamp)));
    }
  }
  for (const requirement of previousClaims) {
    if (!nextClaims.some((candidate) => sameClaim(candidate, requirement))) {
      operations.push(releaseUniqueClaim(claimRecord(requirement, previous.data.createdAt)));
    }
  }
  return operations;
}
