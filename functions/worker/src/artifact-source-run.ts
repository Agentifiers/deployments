import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import { key, type PlatformRecord, type Ulid, workerPersistence } from "@deployments-ai/db";
import { Buffer } from "node:buffer";
import {
  jsonToolResult,
  logicallyExpired,
  optionalInteger,
  optionalString,
  toolInput,
  ulid,
} from "./builtin-tool-support.ts";
import type { RuntimeArtifactLifecycleOptions } from "./artifact-lifecycle-runtime-tools.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";

type Artifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;
type Request = Parameters<ExecuteRuntimeBuiltinTool>[0];

const DEFAULT_SOURCE_RUN_LIMIT = 25;
const MAX_SOURCE_RUN_LIMIT = 100;
const MAX_SOURCE_RUN_SCAN_RECORDS = 250;
const MAX_SOURCE_RUN_RESPONSE_BYTES = 512 * 1024;

interface SourceRunCursor {
  readonly gsiSortKey?: string;
  readonly knownArtifactIds: readonly Ulid[];
  readonly knownOffset: number;
  readonly sourceRunId: Ulid;
}

function encodeCursor(cursor: SourceRunCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(
  value: string | undefined,
  sourceRunId: Ulid,
  availableKnownIds: readonly Ulid[],
): SourceRunCursor {
  if (!value) {
    return {
      knownArtifactIds: availableKnownIds,
      knownOffset: 0,
      sourceRunId,
    } satisfies SourceRunCursor;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (cause) {
    throw new TypeError("cursor must be a valid source-run cursor.", { cause });
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("cursor must be a valid source-run cursor.");
  }
  const cursor = decoded as Readonly<Record<string, unknown>>;
  const knownArtifactIds = cursor.knownArtifactIds;
  if (
    cursor.sourceRunId !== sourceRunId ||
    !Array.isArray(knownArtifactIds) ||
    knownArtifactIds.length > availableKnownIds.length ||
    knownArtifactIds.some(
      (artifactId, index) =>
        typeof artifactId !== "string" || artifactId !== availableKnownIds[index],
    ) ||
    !Number.isSafeInteger(cursor.knownOffset) ||
    Number(cursor.knownOffset) < 0 ||
    Number(cursor.knownOffset) > knownArtifactIds.length ||
    (cursor.gsiSortKey !== undefined &&
      (typeof cursor.gsiSortKey !== "string" ||
        !cursor.gsiSortKey.startsWith("ARTIFACT#") ||
        cursor.gsiSortKey.length > 1_024)) ||
    (cursor.gsiSortKey !== undefined && Number(cursor.knownOffset) !== knownArtifactIds.length)
  ) {
    throw new TypeError("cursor does not match this source-run listing.");
  }
  return {
    ...(typeof cursor.gsiSortKey === "string" ? { gsiSortKey: cursor.gsiSortKey } : {}),
    knownArtifactIds: knownArtifactIds as Ulid[],
    knownOffset: Number(cursor.knownOffset),
    sourceRunId,
  } satisfies SourceRunCursor;
}

function bounded(value: string | undefined, maximum: number) {
  if (value === undefined) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function sourceRunArtifact(record: Artifact) {
  return {
    artifactId: record.data.id,
    byteSize: record.data.storage.byteSize,
    contentType: bounded(record.data.storage.contentType, 256),
    createdAt: record.data.createdAt,
    fileName: bounded(record.data.storage.fileName, 240),
    name: bounded(record.data.name, 512),
    runId: record.data.runId,
    status: record.data.status,
    type: bounded(record.data.type, 256),
    visibility: record.data.visibility,
  };
}

function readableArtifact(
  record: PlatformRecord,
  request: Request,
  sourceRunId: Ulid,
): Artifact | undefined {
  if (
    record.itemType !== "artifact" ||
    record.data.organizationId !== request.organizationId ||
    record.data.projectId !== request.projectId ||
    record.data.environmentId !== request.environmentId ||
    record.data.runId !== sourceRunId ||
    logicallyExpired(record.data.retentionExpiresAt) ||
    (record.data.visibility === "private" && record.data.runId !== request.runId)
  ) {
    return undefined;
  }
  return record;
}

async function loadKnownArtifact(
  options: RuntimeArtifactLifecycleOptions,
  request: Request,
  artifactId: Ulid,
) {
  let record: PlatformRecord | undefined;
  try {
    record = await workerPersistence.read(
      options.database,
      "execution",
      {
        pk: key("ORG", request.organizationId, "ENV", request.environmentId),
        sk: key("ARTIFACT", artifactId),
      },
      true,
    );
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
  const artifact = record && readableArtifact(record, request, request.runId);
  if (!artifact) throw new TypeError("A recorded current-run artifact is no longer available.");
  return artifact;
}

async function queryGsiArtifacts(
  options: RuntimeArtifactLifecycleOptions,
  request: Request,
  sourceRunId: Ulid,
  gsiSortKey: string | undefined,
  excludedIds: ReadonlySet<Ulid>,
  needed: number,
) {
  const candidates: Array<{ readonly artifact: Artifact; readonly sortKey: string }> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let scanned = 0;
  while (candidates.length < needed && scanned < MAX_SOURCE_RUN_SCAN_RECORDS) {
    let page;
    try {
      page = await workerPersistence.find(
        options.database,
        "execution",
        {
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", request.organizationId, "RUN", sourceRunId, "ARTIFACTS"),
            ":sk": gsiSortKey ?? "ARTIFACT#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: gsiSortKey
            ? "#pk = :pk AND #sk < :sk"
            : "#pk = :pk AND begins_with(#sk, :sk)",
          Limit: Math.min(100, MAX_SOURCE_RUN_SCAN_RECORDS - scanned),
          ScanIndexForward: false,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        },
        request.signal,
      );
    } catch (cause) {
      throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
    }
    scanned += page.items.length;
    for (const record of page.items) {
      const artifact = readableArtifact(record, request, sourceRunId);
      if (artifact && record.gsi1sk && !excludedIds.has(artifact.data.id)) {
        candidates.push({ artifact, sortKey: record.gsi1sk });
        if (candidates.length >= needed) break;
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  if (exclusiveStartKey && candidates.length < needed) {
    throw new TypeError("Source-run artifact listing exceeded its bounded scan limit.");
  }
  return { candidates, moreRecords: exclusiveStartKey !== undefined };
}

export async function sourceRunArtifactPage(
  options: RuntimeArtifactLifecycleOptions,
  request: Request,
  input: Readonly<Record<string, unknown>>,
) {
  const sourceRunId = ulid(input.sourceRunId, "sourceRunId");
  const limit =
    optionalInteger(input, "limit", { maximum: MAX_SOURCE_RUN_LIMIT, minimum: 1 }) ??
    DEFAULT_SOURCE_RUN_LIMIT;
  const availableKnownIds =
    sourceRunId === request.runId ? (request.recordedArtifactIds ?? []) : [];
  const cursor = decodeCursor(
    optionalString(input, "cursor", 4_096),
    sourceRunId,
    availableKnownIds,
  );
  const knownIds = cursor.knownArtifactIds;
  const values: ReturnType<typeof sourceRunArtifact>[] = [];
  let responseBytes = 64;
  let knownOffset = cursor.knownOffset;
  const add = (artifact: Artifact) => {
    const value = sourceRunArtifact(artifact);
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (responseBytes + bytes > MAX_SOURCE_RUN_RESPONSE_BYTES) return false;
    values.push(value);
    responseBytes += bytes;
    return true;
  };

  if (knownOffset < knownIds.length) {
    const artifacts = await Promise.all(
      knownIds
        .slice(knownOffset, knownOffset + limit)
        .map((artifactId) => loadKnownArtifact(options, request, artifactId)),
    );
    for (const artifact of artifacts) {
      if (values.length >= limit || !add(artifact)) break;
      knownOffset += 1;
    }
  }

  let nextCursor: string | undefined;
  if (knownOffset < knownIds.length || values.length >= limit) {
    nextCursor = encodeCursor({ knownArtifactIds: knownIds, knownOffset, sourceRunId });
  } else {
    const remaining = limit - values.length;
    const { candidates, moreRecords } = await queryGsiArtifacts(
      options,
      request,
      sourceRunId,
      cursor.gsiSortKey,
      new Set(knownIds),
      remaining + 1,
    );
    let lastSortKey: string | undefined;
    let responseBudgetReached = false;
    for (const candidate of candidates.slice(0, remaining)) {
      if (!add(candidate.artifact)) {
        responseBudgetReached = true;
        break;
      }
      lastSortKey = candidate.sortKey;
    }
    if (
      lastSortKey &&
      (responseBudgetReached ||
        candidates.length > remaining ||
        moreRecords ||
        values.length >= limit)
    ) {
      nextCursor = encodeCursor({
        gsiSortKey: lastSortKey,
        knownArtifactIds: knownIds,
        knownOffset,
        sourceRunId,
      });
    }
  }

  return { artifacts: values, ...(nextCursor ? { nextCursor } : {}) };
}

export async function sourceRunArtifacts(
  options: RuntimeArtifactLifecycleOptions,
  request: Request,
) {
  const page = await sourceRunArtifactPage(options, request, toolInput(request.input ?? {}));
  return jsonToolResult({
    fileName: "source-run-artifacts.json",
    label: "Source run artifacts",
    summary: `Found ${page.artifacts.length} artifact(s) for the source run${page.nextCursor ? "; more are available" : ""}.`,
    value: page,
  });
}
