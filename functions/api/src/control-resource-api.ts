import { TENANCY_API_SCHEMAS } from "@deployments-ai/api-contract";
import {
  DatabaseError,
  dynamoItemByteSize,
  key,
  makeIdGenerator,
  managedSkillInstallationClaimNamespace,
  managedSkillInstallationClaimValue,
  makePersistenceTransactionToken,
  makeSemanticEventRecord,
  makeUniqueClaimRecord,
  MAX_DYNAMODB_ITEM_BYTES,
  PersistenceError,
  Ulid,
  UniqueClaimRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  apiPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { ApiInvocation, TenancyApiService } from "./index.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { makeManagedSkillInstallationServices } from "./managed-skill-installation-services.ts";
import { makeManagedSkillReleaseServices } from "./managed-skill-release-services.ts";
import { makeManagedSkillServices } from "./managed-skill-services.ts";
import { makeManagedSkillSourceServices } from "./managed-skill-source-services.ts";
import { makeWorkflowDefinitionServices } from "./workflow-definition-services.ts";
import { makeWorkflowReleaseServices } from "./workflow-release-services.ts";

export const schemas = TENANCY_API_SCHEMAS;
export const MAX_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_LIST_SCAN_RECORDS = 100;
export const MAX_DYNAMODB_TRANSACTION_BYTES = 4 * 1024 * 1024;
export const MAX_FILTERED_LIST_PAGES = 10;

export type WorkflowDefinition = Extract<
  PlatformRecord,
  { readonly itemType: "workflow-definition" }
>;
export type WorkflowRelease = Extract<PlatformRecord, { readonly itemType: "workflow-release" }>;
export type AgentDefinition = Extract<PlatformRecord, { readonly itemType: "agent-definition" }>;
export type ManagedSkillSource = Extract<
  PlatformRecord,
  { readonly itemType: "managed-skill-source" }
>;
export type ManagedSkillRelease = Extract<
  PlatformRecord,
  { readonly itemType: "managed-skill-release" }
>;
export type ManagedSkill = Extract<PlatformRecord, { readonly itemType: "managed-skill" }>;
export type ManagedSkillInstallation = Extract<
  PlatformRecord,
  { readonly itemType: "managed-skill-installation" }
>;

export function transactionToken(invocation: ApiInvocation) {
  return makePersistenceTransactionToken(invocation, "control-resource");
}

export function requireActiveManagedSkillRelease(release: ManagedSkillRelease) {
  return {
    conditionExpression: "#data.#status = :active AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":version": release.data.version,
    },
    key: { pk: release.pk, sk: release.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function requireActiveAgentDefinition(definition: AgentDefinition) {
  return {
    conditionExpression: "#data.#status = :active AND #data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":version": definition.data.version,
    },
    key: { pk: definition.pk, sk: definition.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export type ControlResourceServices = Required<
  Pick<
    TenancyApiService,
    | "workflowDefinitions"
    | "workflowReleases"
    | "managedSkillSources"
    | "managedSkillReleases"
    | "managedSkills"
    | "managedSkillInstallations"
  >
>;

export interface ControlResourceApiDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Promise<Ulid>;
  readonly now?: () => Date;
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, entry]) => [name, canonical(entry)]),
  );
}

export function contentHash(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

export async function databaseValue<Value>(
  operation: Promise<Value>,
  message = "Control resource persistence failed.",
  conflict?: { readonly code: string; readonly kind: "conflict"; readonly message: string },
): Promise<Value> {
  try {
    return await operation;
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    if (cause instanceof DatabaseError && cause.reason === "conflict" && conflict) {
      throw new PersistenceError(conflict.kind, conflict.code, conflict.message);
    }
    console.error(message, errorLogFields(cause));
    throw new PersistenceError("internal", "persistence_failed", message);
  }
}

export function versionConflict(label: string) {
  return {
    code: "version_conflict",
    kind: "conflict" as const,
    message: `${label} version changed concurrently.`,
  };
}

export function id(value: string | undefined, label: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new PersistenceError("invalid-input", "invalid_id", `${label} must be a canonical ULID.`);
  }
}

export function requiredId(invocation: ApiInvocation, label: string) {
  if (!invocation.id) {
    throw new PersistenceError("invalid-input", "missing_id", `${label} id is required.`);
  }
  return id(invocation.id, label);
}

export function assertGrant(
  values: readonly string[] | "*" | undefined,
  value: string,
  label: string,
) {
  if (values !== "*" && !values?.includes(value)) {
    throw new PersistenceError(
      "forbidden",
      `${label}_scope_violation`,
      `The credential cannot access the requested ${label}.`,
    );
  }
}

export function cursorKey(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const entries = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(entries).toSorted().join(",") !== "pk,sk" ||
    typeof entries.pk !== "string" ||
    !entries.pk ||
    new TextEncoder().encode(entries.pk).byteLength > 2_048 ||
    typeof entries.sk !== "string" ||
    !entries.sk ||
    new TextEncoder().encode(entries.sk).byteLength > 1_024
  ) {
    throw new Error();
  }
  return { pk: entries.pk, sk: entries.sk };
}

export function decodeCursor(
  value: string | undefined,
  partition: string,
  prefix: string,
  scope: string,
) {
  if (!value) return undefined;
  try {
    if (value.length > 4_096) throw new Error();
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    const entries = decoded as Readonly<Record<string, unknown>>;
    if (
      Object.keys(entries).toSorted().join(",") !== "key,partition,prefix,scope,version" ||
      entries.version !== 1 ||
      entries.partition !== partition ||
      entries.prefix !== prefix ||
      entries.scope !== scope
    ) {
      throw new Error();
    }
    const keyValue = cursorKey(entries.key);
    if (keyValue.pk !== partition || !keyValue.sk.startsWith(prefix)) throw new Error();
    return keyValue;
  } catch {
    throw new PersistenceError("invalid-input", "invalid_cursor", "Cursor is invalid.");
  }
}

export function encodeCursor(
  value: Readonly<Record<string, unknown>> | undefined,
  partition: string,
  prefix: string,
  scope: string,
) {
  if (!value) return null;
  return Buffer.from(
    JSON.stringify({
      key: cursorKey(value),
      partition,
      prefix,
      scope,
      version: 1,
    }),
    "utf8",
  ).toString("base64url");
}

export async function queryRecords(
  database: DynamoDatabaseService,
  partition: string,
  itemType: PlatformRecord["itemType"],
  invocation: ApiInvocation,
  predicate: (record: PlatformRecord) => boolean = () => true,
  cursorScope = "",
) {
  const prefix = `${key(itemType.toUpperCase())}#`;
  const limit = invocation.query.limit ?? 50;
  let exclusiveStartKey = invocation.query.cursor
    ? decodeCursor(invocation.query.cursor, partition, prefix, cursorScope)
    : undefined;
  const items: PlatformRecord[] = [];
  let encodedBytes = 0;
  let lastConsumed: PlatformRecord | undefined;
  let physicalPages = 0;
  while (true) {
    const result = await databaseValue(
      apiPersistence.find(database, "control", {
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": partition, ":prefix": prefix },
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        Limit: MAX_LIST_SCAN_RECORDS,
      }),
    );
    physicalPages += 1;
    for (const [index, record] of result.items.entries()) {
      if (record.itemType === itemType && predicate(record)) {
        const itemBytes = new TextEncoder().encode(JSON.stringify(record.data)).byteLength;
        if (
          items.length === limit ||
          (items.length > 0 && encodedBytes + itemBytes > MAX_LIST_RESPONSE_BYTES)
        ) {
          return {
            items,
            nextCursor: encodeCursor(
              lastConsumed ? { pk: lastConsumed.pk, sk: lastConsumed.sk } : undefined,
              partition,
              prefix,
              cursorScope,
            ),
          };
        }
        items.push(record);
        encodedBytes += itemBytes;
      }
      lastConsumed = record;
      if (items.length === limit) {
        const hasMore = index < result.items.length - 1 || result.lastEvaluatedKey !== undefined;
        return {
          items,
          nextCursor: hasMore
            ? encodeCursor({ pk: record.pk, sk: record.sk }, partition, prefix, cursorScope)
            : null,
        };
      }
    }
    if (!result.lastEvaluatedKey) {
      return {
        items,
        nextCursor: null,
      };
    }
    if (physicalPages >= MAX_FILTERED_LIST_PAGES) {
      return {
        items,
        nextCursor: encodeCursor(result.lastEvaluatedKey, partition, prefix, cursorScope),
      };
    }
    exclusiveStartKey = cursorKey(result.lastEvaluatedKey);
  }
}

export async function getRecord<Type extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  partition: string,
  itemType: Type,
  resourceId: Ulid,
  label: string,
): Promise<Extract<PlatformRecord, { readonly itemType: Type }>> {
  const value = await databaseValue(
    apiPersistence.read(
      database,
      "control",
      { pk: partition, sk: key(itemType.toUpperCase(), resourceId) },
      true,
    ),
  );
  if (!value || value.itemType !== itemType) {
    throw new PersistenceError("not-found", "resource_not_found", `${label} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: Type }>;
}

export async function tenantScope(
  dependencies: ControlResourceApiDependencies,
  invocation: ApiInvocation,
  requireActive = false,
) {
  const environmentId = id(invocation.scope.environmentId, "Environment");
  const claim = await databaseValue(
    apiPersistence.read(
      dependencies.database,
      "control",
      {
        pk: key("UNIQUE", "environment-id"),
        sk: key("VALUE", environmentId),
      },
      true,
    ),
  );
  if (claim?.itemType !== "unique-claim" || claim.data.ownerItemType !== "environment") {
    throw new PersistenceError("not-found", "environment_not_found", "Environment was not found.");
  }
  const environment = await databaseValue(
    apiPersistence.read(
      dependencies.database,
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      true,
    ),
  );
  if (!environment || environment.itemType !== "environment") {
    throw new PersistenceError("not-found", "environment_not_found", "Environment was not found.");
  }
  if (requireActive) assertActive(environment.data.status, "Environment");
  assertGrant(invocation.identity.environmentIds, environmentId, "environment");
  assertGrant(invocation.identity.projectIds, environment.data.projectId, "project");
  assertGrant(invocation.identity.organizationIds, environment.data.organizationId, "organization");
  return {
    environmentId,
    organizationId: environment.data.organizationId,
    projectId: environment.data.projectId,
  };
}

export function workflowDefinitionResponse(record: WorkflowDefinition) {
  return Schema.decodeUnknownSync(schemas.WorkflowDefinitionResponse)({
    ...record.data,
    draft: record.data.draft,
  });
}

export function workflowDefinitionSummary(record: WorkflowDefinition) {
  const {
    draft: _draft,
    createdByPrincipalId: _createdBy,
    lastReleaseNumber: _last,
    ...data
  } = record.data;
  return Schema.decodeUnknownSync(schemas.WorkflowDefinitionSummaryResponse)(data);
}

export function workflowReleaseResponse(record: WorkflowRelease) {
  return Schema.decodeUnknownSync(schemas.WorkflowReleaseResponse)(record.data);
}

export function workflowReleaseSummary(record: WorkflowRelease) {
  const { definition: _definition, ...data } = record.data;
  return Schema.decodeUnknownSync(schemas.WorkflowReleaseSummaryResponse)(data);
}

export function managedSkillSourceResponse(record: ManagedSkillSource) {
  return Schema.decodeUnknownSync(schemas.ManagedSkillSourceResponse)(record.data);
}

export function managedSkillSourceClaim(record: ManagedSkillSource) {
  return Schema.decodeUnknownSync(UniqueClaimRecord)(
    makeUniqueClaimRecord(
      {
        namespace: "managed-skill-source-key",
        ownerId: record.data.id,
        ownerItemType: record.itemType,
        ownerPk: record.pk,
        ownerSk: record.sk,
        ownerTable: "control",
        value: record.data.key,
      },
      record.data.createdAt,
    ),
  );
}

export function managedSkillInstallationClaim(record: ManagedSkillInstallation) {
  return Schema.decodeUnknownSync(UniqueClaimRecord)(
    makeUniqueClaimRecord(
      {
        namespace: managedSkillInstallationClaimNamespace(record.data.environmentId),
        ownerId: record.data.id,
        ownerItemType: record.itemType,
        ownerPk: record.pk,
        ownerSk: record.sk,
        ownerTable: "control",
        value: managedSkillInstallationClaimValue(
          record.data.agentDefinitionId,
          record.data.managedSkillId,
        ),
      },
      record.data.createdAt,
    ),
  );
}

export function managedSkillReleaseClaim(record: ManagedSkillRelease) {
  return Schema.decodeUnknownSync(UniqueClaimRecord)(
    makeUniqueClaimRecord(
      {
        namespace: `managed-skill-source:${record.data.sourceId}:release-version`,
        ownerId: record.data.id,
        ownerItemType: record.itemType,
        ownerPk: record.pk,
        ownerSk: record.sk,
        ownerTable: "control",
        value: record.data.releaseVersion,
      },
      record.data.createdAt,
    ),
  );
}

export function managedSkillReleaseResponse(record: ManagedSkillRelease) {
  return Schema.decodeUnknownSync(schemas.ManagedSkillReleaseResponse)(record.data);
}

export function assertManagedSkillPersistenceSize(records: readonly PlatformRecord[]) {
  if (records.some((record) => dynamoItemByteSize(record) > MAX_DYNAMODB_ITEM_BYTES)) {
    throw new PersistenceError(
      "invalid-input",
      "managed_skill_item_too_large",
      "Managed skill release content exceeds the persisted item size limit.",
    );
  }
  const transactionBytes = records.reduce((total, record) => total + dynamoItemByteSize(record), 0);
  if (transactionBytes > MAX_DYNAMODB_TRANSACTION_BYTES) {
    throw new PersistenceError(
      "invalid-input",
      "managed_skill_release_too_large",
      "Managed skill release content exceeds the atomic publication size limit.",
    );
  }
}

export function managedSkillResponse(record: ManagedSkill) {
  if (record.data.contentText === undefined) {
    throw new PersistenceError(
      "unprocessable",
      "skill_content_unavailable",
      "Managed skill content is not available for inspection.",
    );
  }
  const { content: _content, contentText, references, ...data } = record.data;
  return Schema.decodeUnknownSync(schemas.ManagedSkillResponse)({
    ...data,
    content: contentText,
    referencePaths: Object.keys(references ?? {}).toSorted(),
  });
}

export function managedSkillInstallationResponse(record: ManagedSkillInstallation) {
  return Schema.decodeUnknownSync(schemas.ManagedSkillInstallationResponse)(record.data);
}

export function assertVersion(actual: number, expected: number, label: string) {
  if (actual !== expected) {
    throw new PersistenceError(
      "conflict",
      "version_conflict",
      `${label} version does not match expectedVersion.`,
    );
  }
}

export function assertActive(status: string, label: string) {
  if (status !== "active") {
    throw new PersistenceError("conflict", "resource_inactive", `${label} is not active.`);
  }
}
export function makeControlResourceContext(dependencies: ControlResourceApiDependencies) {
  const generator = makeIdGenerator();
  const generateId = dependencies.generateId ?? (async () => generator.generate());
  const now = dependencies.now ?? (() => new Date());
  const database = dependencies.database;
  const tenantEvent = async (
    invocation: ApiInvocation,
    record: WorkflowDefinition | WorkflowRelease | ManagedSkillInstallation,
    eventType: string,
    occurredAt: string,
    payload: Readonly<Record<string, string | number | boolean | null>>,
  ) =>
    makeSemanticEventRecord({
      actor: { id: id(invocation.identity.principalId, "Principal"), type: "principal" },
      aggregateId: record.data.id,
      aggregateType: record.itemType,
      aggregateVersion: record.data.version + 1,
      environmentId: record.data.environmentId,
      eventId: await generateId(),
      eventType,
      occurredAt,
      organizationId: record.data.organizationId,
      payload,
      projectId: record.data.projectId,
    });

  const globalPartition = (itemType: PlatformRecord["itemType"]) => key("GLOBAL", itemType);
  return { database, dependencies, generateId, globalPartition, now, tenantEvent };
}

export type ControlResourceContext = ReturnType<typeof makeControlResourceContext>;

export function makeControlResourceApiServices(
  dependencies: ControlResourceApiDependencies,
): ControlResourceServices {
  const context = makeControlResourceContext(dependencies);
  return {
    managedSkillInstallations: makeManagedSkillInstallationServices(context),
    managedSkillReleases: makeManagedSkillReleaseServices(context),
    managedSkillSources: makeManagedSkillSourceServices(context),
    managedSkills: makeManagedSkillServices(context),
    workflowDefinitions: makeWorkflowDefinitionServices(context),
    workflowReleases: makeWorkflowReleaseServices(context),
  };
}
