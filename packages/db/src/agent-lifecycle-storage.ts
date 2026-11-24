import { Schema } from "effect";
import { DatabaseError, type DynamoDatabaseService } from "./client-types.ts";
import { key, UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import {
  AgentDefinitionRecord,
  AgentDefinitionReleaseIndexRecord,
  AgentReleaseControlRecord,
  AgentReleaseRecord,
} from "./records/control.ts";
import { SemanticEventRecord } from "./records/events.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { isDatabaseWriteConflict } from "./transaction-conditions.ts";

type AgentDefinition = typeof AgentDefinitionRecord.Type;
type AgentRelease = typeof AgentReleaseRecord.Type;
type AgentReleaseControl = typeof AgentReleaseControlRecord.Type;
type SemanticEvent = typeof SemanticEventRecord.Type;
type AgentEnvironmentItemType =
  | "agent-definition"
  | "agent-deployment"
  | "agent-release"
  | "workspace";
type Workspace = Extract<PlatformRecord, { readonly itemType: "workspace" }>;
type CursorIndex = "base" | "gsi2";

export interface AgentEnvironmentRecordScope {
  readonly environmentId: string;
  readonly organizationId: string;
}

export interface AgentRecordPage {
  readonly items: readonly PlatformRecord[];
  readonly nextCursor: string | null;
}

export class InvalidAgentRecordCursorError extends Schema.TaggedErrorClass<InvalidAgentRecordCursorError>()(
  "InvalidAgentRecordCursorError",
  { message: Schema.String },
) {}

export class AgentLifecycleStorageError extends Schema.TaggedErrorClass<AgentLifecycleStorageError>()(
  "AgentLifecycleStorageError",
  { message: Schema.String },
) {}

export interface AgentLifecycleRecordStore {
  readonly ensureReleaseIndex: (definition: AgentDefinition, timestamp: string) => Promise<void>;
  readonly getEnvironmentRecord: (
    scope: AgentEnvironmentRecordScope,
    itemType: AgentEnvironmentItemType,
    resourceId: string,
  ) => Promise<PlatformRecord | undefined>;
  readonly getLatestSemanticEvent: (
    organizationId: string,
    aggregateType: string,
    aggregateId: string,
  ) => Promise<SemanticEvent | undefined>;
  readonly getRelease: (
    definition: AgentDefinition,
    releaseId: string,
  ) => Promise<PlatformRecord | undefined>;
  readonly getReleaseControl: (release: AgentRelease) => Promise<PlatformRecord | undefined>;
  readonly getReleaseIndex: (definition: AgentDefinition) => Promise<PlatformRecord | undefined>;
  readonly listAllEnvironmentRecords: (
    scope: AgentEnvironmentRecordScope,
    itemType: "agent-deployment" | "agent-release",
  ) => Promise<readonly PlatformRecord[]>;
  readonly listEnvironmentRecords: (
    environmentId: string,
    itemType: "agent-definition" | "agent-deployment",
    options: { readonly cursor?: string; readonly limit: number },
  ) => Promise<AgentRecordPage>;
  readonly listReleaseControls: (
    definition: AgentDefinition,
    options: { readonly cursor?: string; readonly limit: number },
  ) => Promise<AgentRecordPage>;
  readonly listReleases: (
    definition: AgentDefinition,
    options: { readonly cursor?: string; readonly limit: number },
  ) => Promise<AgentRecordPage>;
}

function invalidCursor() {
  return new InvalidAgentRecordCursorError({ message: "The agent record cursor is invalid." });
}

function environmentPartition(scope: AgentEnvironmentRecordScope) {
  return key("ORG", scope.organizationId, "ENV", scope.environmentId);
}

function environmentRecordKey(
  scope: AgentEnvironmentRecordScope,
  itemType: AgentEnvironmentItemType,
  resourceId: string,
) {
  return {
    pk: environmentPartition(scope),
    sk: key(itemType.toUpperCase(), resourceId),
  };
}

function releaseAggregatePartition(definition: AgentDefinition) {
  return key("ORG", definition.data.organizationId, "AGENT-DEFINITION", definition.data.id);
}

function releaseIndexKey(definition: AgentDefinition) {
  return {
    pk: releaseAggregatePartition(definition),
    sk: key("AGENT-DEFINITION-RELEASE-INDEX", definition.data.id),
  };
}

function releaseControlKey(release: AgentRelease) {
  return {
    pk: key("ORG", release.data.organizationId, "AGENT-DEFINITION", release.data.agentDefinitionId),
    sk: key(
      "AGENT-RELEASE-CONTROL",
      String(release.data.releaseNumber).padStart(16, "0"),
      release.data.id,
    ),
  };
}

function cursorKey(value: unknown, index: CursorIndex): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCursor();
  const expectedNames = index === "base" ? ["pk", "sk"] : ["gsi2pk", "gsi2sk", "pk", "sk"];
  const entries = Object.entries(value);
  if (
    entries.length !== expectedNames.length ||
    expectedNames.some((name) => !Object.hasOwn(value, name))
  ) {
    throw invalidCursor();
  }
  const result = Object.fromEntries(entries) as Record<string, unknown>;
  for (const name of expectedNames) {
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

function decodeCursor(
  cursor: string | undefined,
  index: CursorIndex,
  expected: { readonly partition: string; readonly prefix: string },
): Record<string, string> | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly index?: unknown;
      readonly key?: unknown;
      readonly version?: unknown;
    };
    if (decoded.version !== 1 || decoded.index !== index) throw invalidCursor();
    const result = cursorKey(decoded.key, index);
    const partitionName = index === "base" ? "pk" : "gsi2pk";
    const sortName = index === "base" ? "sk" : "gsi2sk";
    if (
      result[partitionName] !== expected.partition ||
      !result[sortName]?.startsWith(expected.prefix)
    ) {
      throw invalidCursor();
    }
    return result;
  } catch {
    throw invalidCursor();
  }
}

function encodeCursor(keyValue: Record<string, unknown>, index: CursorIndex) {
  return Buffer.from(
    JSON.stringify({ index, key: cursorKey(keyValue, index), version: 1 }),
  ).toString("base64url");
}

function recordPage(
  result: {
    readonly items: readonly PlatformRecord[];
    readonly lastEvaluatedKey?: Record<string, unknown>;
  },
  index: CursorIndex,
): AgentRecordPage {
  return {
    items: result.items,
    nextCursor: result.lastEvaluatedKey ? encodeCursor(result.lastEvaluatedKey, index) : null,
  };
}

export function makeAgentLifecycleRecordStore(
  database: DynamoDatabaseService,
): AgentLifecycleRecordStore {
  async function writeAttempt(write: Promise<void>) {
    try {
      await write;
      return true;
    } catch (error) {
      if (error instanceof DatabaseError && isDatabaseWriteConflict(error)) return false;
      throw error;
    }
  }

  function getEnvironmentRecord(
    scope: AgentEnvironmentRecordScope,
    itemType: AgentEnvironmentItemType,
    resourceId: string,
  ) {
    return database.getRecord("control", environmentRecordKey(scope, itemType, resourceId), true);
  }

  async function listEnvironmentRecords(
    environmentId: string,
    itemType: "agent-definition" | "agent-deployment",
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<AgentRecordPage> {
    const partition = key("ENV", environmentId);
    const prefix = `${key(itemType.toUpperCase())}#`;
    const exclusiveStartKey = decodeCursor(options.cursor, "gsi2", { partition, prefix });
    const result = await database.queryRecords("control", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeValues: { ":pk": partition, ":prefix": prefix },
      IndexName: "gsi2",
      KeyConditionExpression: "gsi2pk = :pk AND begins_with(gsi2sk, :prefix)",
      Limit: options.limit,
      ScanIndexForward: false,
    });
    return recordPage(result, "gsi2");
  }

  async function listAllEnvironmentRecords(
    scope: AgentEnvironmentRecordScope,
    itemType: "agent-deployment" | "agent-release",
  ) {
    const records: PlatformRecord[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await database.queryRecords("control", {
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ExpressionAttributeValues: {
          ":pk": environmentPartition(scope),
          ":prefix": `${key(itemType.toUpperCase())}#`,
        },
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        Limit: 100,
      });
      records.push(...page.items);
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return records;
  }

  async function getLatestSemanticEvent(
    organizationId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<SemanticEvent | undefined> {
    const result = await database.queryRecords("events", {
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk": key("ORG", organizationId, "AGGREGATE", aggregateType, aggregateId),
        ":prefix": `${key("SEMANTIC-EVENT")}#`,
      },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      Limit: 1,
      ScanIndexForward: false,
    });
    return result.items.find(
      (record): record is SemanticEvent => record.itemType === "semantic-event",
    );
  }

  function getReleaseIndex(definition: AgentDefinition) {
    return database.getRecord("control", releaseIndexKey(definition), true);
  }

  function getReleaseControl(release: AgentRelease) {
    return database.getRecord("control", releaseControlKey(release), true);
  }

  function getRelease(definition: AgentDefinition, releaseId: string) {
    return getEnvironmentRecord(
      {
        environmentId: definition.data.environmentId,
        organizationId: definition.data.organizationId,
      },
      "agent-release",
      releaseId,
    );
  }

  async function listReleaseControls(
    definition: AgentDefinition,
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<AgentRecordPage> {
    const partition = releaseAggregatePartition(definition);
    const prefix = `${key("AGENT-RELEASE-CONTROL")}#`;
    const exclusiveStartKey = decodeCursor(options.cursor, "base", { partition, prefix });
    const result = await database.queryRecords("control", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeValues: { ":pk": partition, ":prefix": prefix },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      Limit: options.limit,
      ScanIndexForward: true,
    });
    return recordPage(result, "base");
  }

  async function listReleases(
    definition: AgentDefinition,
    options: { readonly cursor?: string; readonly limit: number },
  ): Promise<AgentRecordPage> {
    const page = await listReleaseControls(definition, options);
    const controls = page.items.filter(
      (record): record is AgentReleaseControl =>
        record.itemType === "agent-release-control" &&
        record.data.agentDefinitionId === definition.data.id,
    );
    if (controls.length !== page.items.length) {
      throw new AgentLifecycleStorageError({
        message: "The agent release control index is inconsistent.",
      });
    }
    const releases: AgentRelease[] = [];
    for (const control of controls) {
      const release = await getRelease(definition, control.data.agentReleaseId);
      if (
        !release ||
        release.itemType !== "agent-release" ||
        release.data.agentDefinitionId !== definition.data.id ||
        release.data.releaseNumber !== control.data.releaseNumber
      ) {
        throw new AgentLifecycleStorageError({
          message: "The agent release control index is inconsistent.",
        });
      }
      releases.push(release);
    }
    return { items: releases, nextCursor: page.nextCursor };
  }

  async function ensureReleaseIndex(definition: AgentDefinition, timestamp: string) {
    const marker = await getReleaseIndex(definition);
    if (marker?.itemType === "agent-definition-release-index") return;

    const scope = {
      environmentId: definition.data.environmentId,
      organizationId: definition.data.organizationId,
    };
    const releases = (await listAllEnvironmentRecords(scope, "agent-release")).filter(
      (record): record is AgentRelease =>
        record.itemType === "agent-release" && record.data.agentDefinitionId === definition.data.id,
    );
    const deployments = (await listAllEnvironmentRecords(scope, "agent-deployment")).filter(
      (record) => record.itemType === "agent-deployment",
    );

    for (const release of releases) {
      const activeDeploymentCount = deployments.filter(
        (deployment) =>
          (deployment.data.agentReleaseId === release.data.id ||
            deployment.data.candidateAgentReleaseId === release.data.id) &&
          deployment.data.currentState !== "stopped",
      ).length;
      const attempted = makeAgentReleaseControlRecord(release, timestamp, activeDeploymentCount);
      let settled = false;
      for (let attempt = 0; attempt < 5 && !settled; attempt += 1) {
        if (await writeAttempt(database.putRecord(attempted, UNIQUE_CLAIM_CONDITION))) {
          settled = true;
          continue;
        }
        const existing = await getReleaseControl(release);
        if (
          existing?.itemType === "agent-release-control" &&
          existing.data.agentDefinitionId === release.data.agentDefinitionId &&
          existing.data.agentReleaseId === release.data.id &&
          existing.data.releaseNumber === release.data.releaseNumber
        ) {
          settled = true;
        } else if (existing) {
          throw new AgentLifecycleStorageError({
            message: "The agent release control index is inconsistent.",
          });
        }
      }
      if (!settled) {
        throw new AgentLifecycleStorageError({
          message: "The agent release control index backfill did not settle.",
        });
      }
    }

    const indexRecord = makeAgentDefinitionReleaseIndexRecord(definition, timestamp);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await writeAttempt(database.putRecord(indexRecord))) return;
      const existing = await getReleaseIndex(definition);
      if (existing?.itemType === "agent-definition-release-index") return;
    }
    throw new AgentLifecycleStorageError({
      message: "The agent release index marker did not settle.",
    });
  }

  return {
    ensureReleaseIndex,
    getEnvironmentRecord,
    getLatestSemanticEvent,
    getRelease,
    getReleaseControl,
    getReleaseIndex,
    listAllEnvironmentRecords,
    listEnvironmentRecords,
    listReleaseControls,
    listReleases,
  } as const;
}

export function makeAgentDefinitionReleaseIndexRecord(
  definition: AgentDefinition,
  timestamp: string,
) {
  return Schema.decodeUnknownSync(AgentDefinitionReleaseIndexRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: definition.data.id,
        createdAt: timestamp,
        environmentId: definition.data.environmentId,
        id: definition.data.id,
        organizationId: definition.data.organizationId,
        projectId: definition.data.projectId,
        status: "ready" as const,
        version: 0,
      },
      itemType: "agent-definition-release-index" as const,
    }),
  );
}

export function makeAgentReleaseControlRecord(
  release: AgentRelease,
  timestamp: string,
  activeDeploymentCount: number,
) {
  return Schema.decodeUnknownSync(AgentReleaseControlRecord)(
    withCanonicalRecordKeys({
      data: {
        activeDeploymentCount,
        agentDefinitionId: release.data.agentDefinitionId,
        agentReleaseId: release.data.id,
        createdAt: timestamp,
        environmentId: release.data.environmentId,
        id: release.data.id,
        organizationId: release.data.organizationId,
        projectId: release.data.projectId,
        releaseNumber: release.data.releaseNumber,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-release-control" as const,
    }),
  );
}

export function updateAgentReleaseControlRecord(
  previous: AgentReleaseControl,
  timestamp: string,
  activeDeploymentCount: number,
) {
  return Schema.decodeUnknownSync(AgentReleaseControlRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        activeDeploymentCount,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "agent-release-control" as const,
    }),
  );
}

export function requireActiveAgentRelease(release: AgentRelease) {
  return {
    conditionExpression: "#data.#status = :active AND #data.#version = :version",
    expressionAttributeNames: { "#data": "data", "#status": "status", "#version": "version" },
    expressionAttributeValues: { ":active": "active", ":version": release.data.version },
    key: { pk: release.pk, sk: release.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function requireActiveWorkspace(workspace: Workspace) {
  return {
    conditionExpression: "#data.#status = :active",
    expressionAttributeNames: { "#data": "data", "#status": "status" },
    expressionAttributeValues: { ":active": "active" },
    key: { pk: workspace.pk, sk: workspace.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function requireUnusedAgentRelease(control: AgentReleaseControl) {
  return {
    conditionExpression: "#data.#count = :zero AND #data.#version = :version",
    expressionAttributeNames: {
      "#count": "activeDeploymentCount",
      "#data": "data",
      "#version": "version",
    },
    expressionAttributeValues: { ":version": control.data.version, ":zero": 0 },
    key: { pk: control.pk, sk: control.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}
