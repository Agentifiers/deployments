import { Timestamp } from "@deployments-ai/api-contract/primitives";
import { ArtifactContentType } from "@deployments-ai/api-contract/runtime";
import {
  ARTIFACT_INDEX_SORT_PREFIX,
  artifactEnvironmentPartition,
  artifactRunPartition,
  key,
  makeArtifactIndexPersistence,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { artifactReadable, artifactRetentionExpired, type Artifact } from "./artifact-storage.ts";
import { runtimeListCursor } from "./request-validation.ts";
import {
  RuntimeApiError,
  id,
  loadRunById,
  loadThread,
  publicArtifact,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

const MAX_ARTIFACT_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_LIST_PAGES = 10;
const MAX_ARTIFACT_TYPE_CHARACTERS = 100;
const CURSOR_VERSION = 2;

/** `GET /v1/artifacts` filters, validated. `contentType` is a media type or a `type/*` family. */
export interface ArtifactListQuery {
  readonly contentType?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly runId?: Ulid;
  readonly threadId?: Ulid;
  readonly type?: string;
}

const MEDIA_FAMILY = /^[\w!#$&^_.+-]+\/\*$/u;
const decodeTimestamp = Schema.decodeUnknownOption(Timestamp);
const decodeContentType = Schema.decodeUnknownOption(ArtifactContentType);

function optionalTimestamp(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  const decoded = decodeTimestamp(value);
  if (decoded._tag === "None") {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      `${name} must be a canonical UTC millisecond timestamp.`,
    );
  }
  return decoded.value;
}

function optionalContentType(value: string | undefined) {
  if (value === undefined) return undefined;
  if (MEDIA_FAMILY.test(value) || decodeContentType(value)._tag === "Some") {
    return value.toLowerCase();
  }
  throw new RuntimeApiError(
    400,
    "invalid_artifact_content_type",
    "contentType must be a media type such as text/csv or a family such as image/*.",
  );
}

function optionalType(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value || value !== value.trim() || Array.from(value).length > MAX_ARTIFACT_TYPE_CHARACTERS) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      `type must be 1 to ${MAX_ARTIFACT_TYPE_CHARACTERS} characters without surrounding whitespace.`,
    );
  }
  return value;
}

export function artifactListQuery(
  parameters: Readonly<Record<string, string | undefined>>,
): ArtifactListQuery {
  const contentType = optionalContentType(parameters.contentType);
  const createdAfter = optionalTimestamp(parameters.createdAfter, "createdAfter");
  const createdBefore = optionalTimestamp(parameters.createdBefore, "createdBefore");
  const type = optionalType(parameters.type);
  if (createdAfter && createdBefore && createdAfter > createdBefore) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "createdAfter must not follow createdBefore.",
    );
  }
  return {
    ...(contentType ? { contentType } : {}),
    ...(createdAfter ? { createdAfter } : {}),
    ...(createdBefore ? { createdBefore } : {}),
    ...(parameters.runId ? { runId: id(parameters.runId, "runId") } : {}),
    ...(parameters.threadId ? { threadId: id(parameters.threadId, "threadId") } : {}),
    ...(type ? { type } : {}),
  };
}

function mediaTypeEssence(value: string) {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

/** Whether a stored media type falls under a filter's media type or `type/*` family. */
export function contentTypeMatches(stored: string, filter: string) {
  const essence = mediaTypeEssence(stored);
  return filter.endsWith("/*")
    ? essence.startsWith(filter.slice(0, -1))
    : essence === mediaTypeEssence(filter);
}

/**
 * Filters every index may not apply exactly. The environment index bounds the creation window, but
 * artifacts stored before it sorted by creation sit outside the window order, so it is checked here.
 */
function attributesMatch(record: Artifact, query: ArtifactListQuery) {
  const { contentType, createdAt } = { ...record.data.storage, ...record.data };
  return (
    (query.type === undefined || record.data.type === query.type) &&
    (query.contentType === undefined || contentTypeMatches(contentType, query.contentType)) &&
    (query.createdAfter === undefined || createdAt >= query.createdAfter) &&
    (query.createdBefore === undefined || createdAt <= query.createdBefore)
  );
}

type IndexName = "gsi1" | "gsi2";

function indexOf(query: ArtifactListQuery): IndexName {
  return query.runId ? "gsi1" : "gsi2";
}

function cursorOf(record: Artifact, query: ArtifactListQuery) {
  const index = indexOf(query);
  const position = {
    [`${index}pk`]: record[`${index}pk`],
    [`${index}sk`]: record[`${index}sk`],
    pk: record.pk,
    sk: record.sk,
  };
  if (Object.values(position).some((value) => typeof value !== "string" || !value)) {
    throw new RuntimeApiError(
      500,
      "invalid_pagination_record",
      "Artifact is missing its pagination keys.",
    );
  }
  return Buffer.from(
    JSON.stringify({ key: position, query, version: CURSOR_VERSION }),
    "utf8",
  ).toString("base64url");
}

/** Decodes a cursor only for the filters, index, and partition that produced it. */
function cursorPosition(
  cursor: string,
  query: ArtifactListQuery,
  principal: RuntimeApiPrincipal,
): Readonly<Record<string, string>> {
  const index = indexOf(query);
  const partition = query.runId
    ? artifactRunPartition(principal.scope.organizationId, query.runId)
    : artifactEnvironmentPartition(principal.scope.environmentId);
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error();
    const entries = decoded as Readonly<Record<string, unknown>>;
    if (
      Object.keys(entries).toSorted().join(",") !== "key,query,version" ||
      entries.version !== CURSOR_VERSION ||
      JSON.stringify(entries.query) !== JSON.stringify(query)
    ) {
      throw new Error();
    }
    const position = entries.key as Readonly<Record<string, unknown>>;
    const names = [`${index}pk`, `${index}sk`, "pk", "sk"];
    if (
      !position ||
      typeof position !== "object" ||
      Object.keys(position).toSorted().join(",") !== names.toSorted().join(",") ||
      Object.values(position).some((value) => typeof value !== "string" || !value) ||
      position[`${index}pk`] !== partition ||
      !String(position[`${index}sk`]).startsWith(ARTIFACT_INDEX_SORT_PREFIX) ||
      position.pk !==
        key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId)
    ) {
      throw new Error();
    }
    return position as Readonly<Record<string, string>>;
  } catch {
    throw new RuntimeApiError(400, "invalid_cursor", "cursor is invalid.");
  }
}

function pageLimit(value: string | undefined) {
  const limit = value ? Number(value) : 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RuntimeApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  return limit;
}

/**
 * Lists the artifacts the caller can read, newest first. With `runId` the run's artifact index is
 * read; otherwise the environment's, bounded by the creation window. A page can hold fewer than
 * `limit` artifacts and still carry `nextCursor` once it has read its share of index pages.
 */
export async function listArtifacts(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  parameters: Readonly<Record<string, string | undefined>>,
) {
  const query = artifactListQuery(parameters);
  const { runId, threadId } = query;
  const expectedRun = runId ? await loadRunById(dependencies, principal, runId) : undefined;
  if (threadId) await loadThread(dependencies, principal, threadId);
  if (expectedRun && threadId && expectedRun.data.threadId !== threadId) {
    throw new RuntimeApiError(404, "not_found", "Run was not found in the requested thread.");
  }
  const limit = pageLimit(parameters.limit);
  const start = parameters.cursor
    ? cursorPosition(runtimeListCursor(parameters.cursor), query, principal)
    : undefined;
  const persistence = makeArtifactIndexPersistence(dependencies.database);
  const readPage = (exclusiveStartKey: Readonly<Record<string, unknown>> | undefined) =>
    runId
      ? persistence.runPage(principal.scope.organizationId, runId, { exclusiveStartKey })
      : persistence.environmentPage(principal.scope.environmentId, query, { exclusiveStartKey });

  const items: ReturnType<typeof publicArtifact>[] = [];
  let encodedBytes = 0;
  let lastConsumed: Artifact | undefined;
  let pageStart: Readonly<Record<string, unknown>> | undefined = start;
  let physicalPages = 0;
  const listTime = dependencies.now?.() ?? new Date();
  const legacyRunThreadIds = new Map<Ulid, Ulid | undefined>();
  const page = () => ({
    artifacts: items,
    ...(lastConsumed ? { nextCursor: cursorOf(lastConsumed, query) } : {}),
  });
  while (true) {
    const { artifacts, lastEvaluatedKey } = await readPage(pageStart);
    physicalPages += 1;
    if (threadId)
      await resolveLegacyThreads(dependencies, principal, artifacts, legacyRunThreadIds, listTime);
    for (const [index, record] of artifacts.entries()) {
      const candidate = scoped(record, principal);
      if (
        artifactReadable(candidate, principal) &&
        !artifactRetentionExpired(candidate, listTime) &&
        (!runId || candidate.data.runId === runId) &&
        (!threadId || threadOf(candidate, legacyRunThreadIds) === threadId) &&
        attributesMatch(candidate, query)
      ) {
        const projection = publicArtifact(candidate);
        const itemBytes = new TextEncoder().encode(JSON.stringify(projection)).byteLength;
        if (items.length > 0 && encodedBytes + itemBytes > MAX_ARTIFACT_LIST_RESPONSE_BYTES) {
          return page();
        }
        items.push(projection);
        encodedBytes += itemBytes;
      }
      lastConsumed = candidate;
      if (items.length === limit) {
        const hasMore = index < artifacts.length - 1 || lastEvaluatedKey !== undefined;
        return hasMore ? page() : { artifacts: items };
      }
    }
    if (!lastEvaluatedKey) return { artifacts: items };
    if (physicalPages >= MAX_ARTIFACT_LIST_PAGES) return page();
    pageStart = lastEvaluatedKey;
  }
}

/** The thread an artifact belongs to; artifacts stored before they named it take their run's. */
function threadOf(record: Artifact, legacyRunThreadIds: ReadonlyMap<Ulid, Ulid | undefined>) {
  if (record.data.threadId) return record.data.threadId;
  return record.data.runId ? legacyRunThreadIds.get(record.data.runId) : undefined;
}

async function resolveLegacyThreads(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  artifacts: readonly Artifact[],
  legacyRunThreadIds: Map<Ulid, Ulid | undefined>,
  listTime: Date,
) {
  const runIds = new Set(
    artifacts.flatMap((record) =>
      !artifactRetentionExpired(record, listTime) &&
      !record.data.threadId &&
      record.data.runId &&
      !legacyRunThreadIds.has(record.data.runId)
        ? [record.data.runId]
        : [],
    ),
  );
  for (const [runId, threadId] of await Promise.all(
    [...runIds].map(async (runId) => {
      try {
        return [runId, (await loadRunById(dependencies, principal, runId)).data.threadId] as const;
      } catch (cause) {
        if (cause instanceof RuntimeApiError && cause.status === 404)
          return [runId, undefined] as const;
        throw cause;
      }
    }),
  )) {
    legacyRunThreadIds.set(runId, threadId);
  }
}
