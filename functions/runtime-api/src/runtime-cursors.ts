import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { publicRun, publicThread } from "./public-projections.ts";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

const MAX_CURSOR_CHARACTERS = 4_096;
const MAX_DYNAMODB_PARTITION_KEY_BYTES = 2_048;
const MAX_DYNAMODB_SORT_KEY_BYTES = 1_024;
export const MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS = 100;
const MAX_FILTERED_QUERY_PAGES = 10;
const CURSOR_TOKEN_VERSION = "rac2";
const LEGACY_RUN_CURSOR_SENTINEL = "RUN-LIST#LEGACY-START";

function cursorKey(secret: string) {
  return createHash("sha256")
    .update("runtime-api-list-cursor\u0000", "utf8")
    .update(secret, "utf8")
    .digest();
}

function cursorAssociatedData(
  indexName: "gsi1" | "gsi2" | undefined,
  expressionAttributeValues: Readonly<Record<string, unknown>>,
  cursorContext: Readonly<Record<string, unknown>> | undefined,
) {
  return Buffer.from(
    JSON.stringify({
      context: Object.fromEntries(
        Object.entries(cursorContext ?? {}).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      indexName: indexName ?? null,
      partition: expressionAttributeValues[":pk"],
      prefix: expressionAttributeValues[":prefix"],
    }),
    "utf8",
  );
}

export function encodeCursor(
  value: Readonly<Record<string, unknown>>,
  secret: string,
  indexName: "gsi1" | "gsi2" | undefined,
  expressionAttributeValues: Readonly<Record<string, unknown>>,
  cursorContext?: Readonly<Record<string, unknown>>,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(secret), iv);
  cipher.setAAD(cursorAssociatedData(indexName, expressionAttributeValues, cursorContext));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [
    CURSOR_TOKEN_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function decodeCursor(
  value: string | undefined,
  secret: string,
  indexName: "gsi1" | "gsi2" | undefined,
  expressionAttributeValues: Readonly<Record<string, unknown>>,
  cursorContext?: Readonly<Record<string, unknown>>,
) {
  if (value === undefined) return undefined;
  if (!value || value.length > MAX_CURSOR_CHARACTERS) {
    throw new RuntimeApiError(400, "invalid_cursor", "cursor is invalid.");
  }
  try {
    const [version, encodedIv, encodedCiphertext, encodedTag, extra] = value.split(".");
    if (
      version !== CURSOR_TOKEN_VERSION ||
      !encodedIv ||
      !encodedCiphertext ||
      !encodedTag ||
      extra !== undefined
    ) {
      throw new Error();
    }
    const iv = Buffer.from(encodedIv, "base64url");
    const authenticationTag = Buffer.from(encodedTag, "base64url");
    if (iv.byteLength !== 12 || authenticationTag.byteLength !== 16) {
      throw new Error();
    }
    const decipher = createDecipheriv("aes-256-gcm", cursorKey(secret), iv);
    decipher.setAAD(cursorAssociatedData(indexName, expressionAttributeValues, cursorContext));
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const values = parsed as Readonly<Record<string, unknown>>;
    const partitionKey = indexName ? `${indexName}pk` : "pk";
    const sortKey = indexName ? `${indexName}sk` : "sk";
    const expectedFields = indexName
      ? [partitionKey, sortKey, "pk", "sk"].toSorted()
      : ["pk", "sk"];
    if (Object.keys(values).toSorted().join(",") !== expectedFields.join(",")) throw new Error();
    for (const name of expectedFields) {
      const keyValue = values[name];
      const maximumBytes = name.endsWith("pk")
        ? MAX_DYNAMODB_PARTITION_KEY_BYTES
        : MAX_DYNAMODB_SORT_KEY_BYTES;
      if (
        typeof keyValue !== "string" ||
        !keyValue ||
        Buffer.byteLength(keyValue, "utf8") > maximumBytes
      ) {
        throw new Error();
      }
    }
    const expectedPartition = expressionAttributeValues[":pk"];
    const expectedPrefix = expressionAttributeValues[":prefix"];
    if (
      typeof expectedPartition !== "string" ||
      typeof expectedPrefix !== "string" ||
      values[partitionKey] !== expectedPartition ||
      !(values[sortKey] as string).startsWith(expectedPrefix)
    ) {
      throw new Error();
    }
    return values;
  } catch {
    throw new RuntimeApiError(400, "invalid_cursor", "cursor is invalid.");
  }
}

export function pageLimit(value: string | undefined) {
  if (value === undefined) return 100;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RuntimeApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  return limit;
}

export async function queryRecords(
  database: DynamoDatabaseService,
  table: "control" | "events" | "execution",
  cursorSecret: string,
  input: {
    readonly cursor?: string | undefined;
    readonly cursorContext?: Readonly<Record<string, unknown>>;
    readonly consistentRead?: boolean;
    readonly expressionAttributeNames: Readonly<Record<string, string>>;
    readonly expressionAttributeValues: Readonly<Record<string, unknown>>;
    readonly indexName?: "gsi1" | "gsi2";
    readonly keyConditionExpression: string;
    readonly limit?: string | undefined;
    readonly filter?: (record: PlatformRecord) => boolean;
    readonly scanIndexForward?: boolean;
  },
) {
  let exclusiveStartKey = decodeCursor(
    input.cursor,
    cursorSecret,
    input.indexName,
    input.expressionAttributeValues,
    input.cursorContext,
  );
  const limit = pageLimit(input.limit);
  const items: PlatformRecord[] = [];
  let evaluatedPages = 0;
  do {
    const result = await runtimeApiPersistence.find(database, table, {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ...(input.consistentRead ? { ConsistentRead: true } : {}),
      ExpressionAttributeNames: input.expressionAttributeNames,
      ExpressionAttributeValues: input.expressionAttributeValues,
      ...(input.indexName ? { IndexName: input.indexName } : {}),
      KeyConditionExpression: input.keyConditionExpression,
      Limit: limit - items.length,
      ScanIndexForward: input.scanIndexForward ?? false,
    });
    items.push(...(input.filter ? result.items.filter(input.filter) : result.items));
    exclusiveStartKey = result.lastEvaluatedKey;
    evaluatedPages += 1;
  } while (
    items.length < limit &&
    exclusiveStartKey &&
    (!input.filter || evaluatedPages < MAX_FILTERED_QUERY_PAGES)
  );
  return {
    items,
    ...(exclusiveStartKey
      ? {
          nextCursor: encodeCursor(
            exclusiveStartKey,
            cursorSecret,
            input.indexName,
            input.expressionAttributeValues,
            input.cursorContext,
          ),
        }
      : {}),
  };
}

export async function loadRunById(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
) {
  const locator = scoped(
    assertRecord(
      await getRecord(dependencies.database, "control", {
        pk: key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
        sk: key("RUN-LOCATOR", runId),
      }),
      "run-locator",
      "Run",
    ),
    principal,
  );
  const run = scoped(
    assertRecord(
      await getRecord(dependencies.database, "execution", {
        pk: locator.data.runPk,
        sk: locator.data.runSk,
      }),
      "run",
      "Run",
    ),
    principal,
  );
  if (run.data.id !== runId) {
    throw new RuntimeApiError(404, "not_found", "Run was not found.");
  }
  return run;
}

export function projectItems<T extends PlatformRecord["itemType"]>(
  records: readonly PlatformRecord[],
  itemType: T,
  principal: RuntimeApiPrincipal,
): Extract<PlatformRecord, { readonly itemType: T }>[] {
  return records.filter((record): record is Extract<PlatformRecord, { readonly itemType: T }> => {
    if (record.itemType !== itemType) return false;
    const data = record.data as Readonly<Record<string, unknown>>;
    return (
      data.organizationId === principal.scope.organizationId &&
      data.projectId === principal.scope.projectId &&
      data.environmentId === principal.scope.environmentId
    );
  });
}

export async function nextAggregateEventVersion(
  dependencies: RuntimeApiDependencies,
  organizationId: Ulid,
  aggregateType: string,
  aggregateId: Ulid,
) {
  const page = await runtimeApiPersistence.find(dependencies.database, "events", {
    ConsistentRead: true,
    ExpressionAttributeNames: { "#pk": "pk" },
    ExpressionAttributeValues: {
      ":pk": key("ORG", organizationId, "AGGREGATE", aggregateType, aggregateId),
    },
    KeyConditionExpression: "#pk = :pk",
    Limit: 1,
    ScanIndexForward: false,
  });
  const latest = page.items.find(
    (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
      record.itemType === "semantic-event" &&
      record.data.aggregateType === aggregateType &&
      record.data.aggregateId === aggregateId,
  );
  return latest ? latest.data.aggregateVersion + 1 : 1;
}

/** Runs belong to either a customer agent deployment or a preview/evaluation execution binding. */
export type RunListOwner =
  | { readonly agentDeploymentId: Ulid; readonly executionBindingId?: undefined }
  | { readonly agentDeploymentId?: undefined; readonly executionBindingId: Ulid };

export async function listRuns(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  query: Readonly<Record<string, string | undefined>>,
  filters: RunListOwner & {
    readonly agentReleaseId?: Ulid;
    readonly createdAfter?: string;
    readonly createdBefore?: string;
    readonly executionPurpose?: string;
    readonly status?: string;
    readonly threadId?: Ulid;
  },
) {
  const status = filters.status;
  if (
    status !== undefined &&
    ![
      "canceled",
      "completed",
      "failed",
      "queued",
      "running",
      "waiting-for-approval",
      "waiting-for-tool",
    ].includes(status)
  ) {
    throw new RuntimeApiError(400, "invalid_status", "status is invalid.");
  }
  const prefix = status ? `RUN#${status}#` : "RUN#";
  const canonicalValues = {
    ":pk":
      filters.executionBindingId === undefined
        ? key("ENV", principal.scope.environmentId, "AGENT-DEPLOYMENT", filters.agentDeploymentId)
        : key(
            "ENV",
            principal.scope.environmentId,
            "EXECUTION-BINDING",
            filters.executionBindingId,
          ),
    ":prefix": prefix,
  };
  const legacyValues = {
    ":pk": key("ENV", principal.scope.environmentId),
    ":prefix": prefix,
  };
  const cursorContext = {
    agentDeploymentId: filters.agentDeploymentId ?? null,
    agentReleaseId: filters.agentReleaseId ?? null,
    executionBindingId: filters.executionBindingId ?? null,
    createdAfter: filters.createdAfter ?? null,
    createdBefore: filters.createdBefore ?? null,
    organizationId: principal.scope.organizationId,
    projectId: principal.scope.projectId,
    status: status ?? null,
    ...(filters.executionPurpose === undefined
      ? {}
      : { executionPurpose: filters.executionPurpose }),
    threadId: filters.threadId ?? null,
  };
  const filter = (record: PlatformRecord) => {
    if (record.itemType !== "run") return false;
    const run = record.data;
    return (
      run.organizationId === principal.scope.organizationId &&
      run.projectId === principal.scope.projectId &&
      run.environmentId === principal.scope.environmentId &&
      run.agentDeploymentId === filters.agentDeploymentId &&
      (filters.agentReleaseId === undefined || run.agentReleaseId === filters.agentReleaseId) &&
      run.executionBindingId === filters.executionBindingId &&
      (filters.executionPurpose === undefined ||
        (run.executionPurpose ?? "customer") === filters.executionPurpose) &&
      (filters.threadId === undefined || run.threadId === filters.threadId) &&
      (filters.createdAfter === undefined ||
        Date.parse(run.createdAt) >= Date.parse(filters.createdAfter)) &&
      (filters.createdBefore === undefined ||
        Date.parse(run.createdAt) <= Date.parse(filters.createdBefore))
    );
  };
  let source: "canonical" | "legacy" = "canonical";
  let legacyCursor = query.cursor;
  if (query.cursor) {
    try {
      decodeCursor(
        query.cursor,
        dependencies.sessionTokenSecret,
        "gsi2",
        canonicalValues,
        cursorContext,
      );
    } catch {
      const decoded = decodeCursor(
        query.cursor,
        dependencies.sessionTokenSecret,
        "gsi2",
        legacyValues,
        cursorContext,
      );
      source = "legacy";
      if (decoded?.pk === LEGACY_RUN_CURSOR_SENTINEL && decoded.sk === LEGACY_RUN_CURSOR_SENTINEL) {
        legacyCursor = undefined;
      }
    }
  }
  const queryIndex = (
    expressionAttributeValues: Readonly<Record<string, unknown>>,
    cursor: string | undefined,
    limit: string | undefined,
  ) =>
    queryRecords(dependencies.database, "execution", dependencies.sessionTokenSecret, {
      cursor,
      cursorContext,
      expressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
      expressionAttributeValues,
      indexName: "gsi2",
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit,
      filter,
    });
  if (source === "legacy") {
    const page = await queryIndex(legacyValues, legacyCursor, query.limit);
    return {
      runs: projectItems(page.items, "run", principal).map(publicRun),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  const canonicalPage = await queryIndex(canonicalValues, query.cursor, query.limit);
  // Execution-binding runs were never written to the legacy environment partition.
  if (canonicalPage.nextCursor || filters.executionBindingId !== undefined) {
    return {
      runs: projectItems(canonicalPage.items, "run", principal).map(publicRun),
      ...(canonicalPage.nextCursor ? { nextCursor: canonicalPage.nextCursor } : {}),
    };
  }
  const remaining = pageLimit(query.limit) - canonicalPage.items.length;
  if (remaining === 0) {
    const nextCursor = encodeCursor(
      {
        gsi2pk: legacyValues[":pk"],
        gsi2sk: legacyValues[":prefix"],
        pk: LEGACY_RUN_CURSOR_SENTINEL,
        sk: LEGACY_RUN_CURSOR_SENTINEL,
      },
      dependencies.sessionTokenSecret,
      "gsi2",
      legacyValues,
      cursorContext,
    );
    return {
      runs: projectItems(canonicalPage.items, "run", principal).map(publicRun),
      nextCursor,
    };
  }
  const legacyPage = await queryIndex(legacyValues, undefined, String(remaining));
  return {
    runs: projectItems([...canonicalPage.items, ...legacyPage.items], "run", principal).map(
      publicRun,
    ),
    ...(legacyPage.nextCursor ? { nextCursor: legacyPage.nextCursor } : {}),
  };
}

/**
 * Environment thread listings exclude preview and evaluation threads, which are indexed under
 * their execution binding; pass `executionBindingId` to list those instead.
 */
export async function listThreads(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  query: Readonly<Record<string, string | undefined>>,
  executionBindingId?: Ulid,
) {
  const page = await queryRecords(
    dependencies.database,
    "execution",
    dependencies.sessionTokenSecret,
    {
      cursor: query.cursor,
      expressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
      expressionAttributeValues: {
        ":pk":
          executionBindingId === undefined
            ? key("ENV", principal.scope.environmentId)
            : key("ENV", principal.scope.environmentId, "EXECUTION-BINDING", executionBindingId),
        ":prefix": "THREAD#",
      },
      indexName: "gsi2",
      keyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      limit: query.limit,
    },
  );
  return {
    threads: projectItems(page.items, "thread", principal).map(publicThread),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}
