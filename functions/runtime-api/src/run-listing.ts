import { Timestamp } from "@deployments-ai/api-contract/primitives";
import { ExecutionPurpose, RuntimeRunStatus } from "@deployments-ai/api-contract/runtime";
import {
  makeRunFeedPersistence,
  RUN_FEED_SORT_PREFIX,
  runFeedPartition,
  type RunFeedFilters,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { publicRun } from "./public-projections.ts";
import { decodeCursor, encodeCursor, listRuns, pageLimit } from "./runtime-cursors.ts";
import {
  id,
  RuntimeApiError,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

/**
 * Run listing filters shared by `GET /v1/runs` and `POST /v1/runs/search`. Identifiers stay raw
 * strings until `listRunsMatching` validates them.
 */
export interface RunListQuery {
  readonly agentDeploymentId?: string | undefined;
  readonly agentReleaseId?: string | undefined;
  readonly createdAfter?: string | undefined;
  readonly createdBefore?: string | undefined;
  readonly executionBindingId?: string | undefined;
  readonly executionPurpose?: typeof ExecutionPurpose.Type | undefined;
  readonly status?: typeof RuntimeRunStatus.Type | undefined;
  readonly threadId?: string | undefined;
}

type RunListPage = Readonly<Partial<Record<"cursor" | "limit", string | undefined>>>;

const RunListQueryFilters = Schema.Struct({
  createdAfter: Schema.optional(Timestamp),
  createdBefore: Schema.optional(Timestamp),
  executionPurpose: Schema.optional(ExecutionPurpose),
});

/** Validates `GET /v1/runs` query filters with the same rules as the run search body. */
export function runListQuery(
  parameters: Readonly<Record<string, string | undefined>>,
): RunListQuery {
  const { agentDeploymentId, agentReleaseId, executionBindingId, status, threadId } = parameters;
  if (agentDeploymentId !== undefined && executionBindingId !== undefined) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "Provide at most one of agentDeploymentId or executionBindingId.",
    );
  }
  let validStatus: RunListQuery["status"];
  try {
    validStatus = Schema.decodeUnknownSync(Schema.optional(RuntimeRunStatus))(status);
  } catch {
    throw new RuntimeApiError(400, "invalid_status", "status is invalid.");
  }
  let filters: typeof RunListQueryFilters.Type;
  try {
    filters = Schema.decodeUnknownSync(RunListQueryFilters)({
      ...(parameters.createdAfter === undefined ? {} : { createdAfter: parameters.createdAfter }),
      ...(parameters.createdBefore === undefined
        ? {}
        : { createdBefore: parameters.createdBefore }),
      ...(parameters.executionPurpose === undefined
        ? {}
        : { executionPurpose: parameters.executionPurpose }),
    });
  } catch {
    throw new RuntimeApiError(400, "invalid_request", "Run list query is invalid.");
  }
  return {
    ...filters,
    agentDeploymentId,
    agentReleaseId,
    executionBindingId,
    status: validStatus,
    threadId,
  };
}

/**
 * Lists the runs of one agent deployment or execution binding, or with neither every run in the
 * caller's environment newest first.
 */
export async function listRunsMatching(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  page: RunListPage,
  query: RunListQuery,
) {
  const filters = {
    ...(query.agentReleaseId ? { agentReleaseId: id(query.agentReleaseId, "agentReleaseId") } : {}),
    ...(query.createdAfter ? { createdAfter: query.createdAfter } : {}),
    ...(query.createdBefore ? { createdBefore: query.createdBefore } : {}),
    ...(query.executionPurpose ? { executionPurpose: query.executionPurpose } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.threadId ? { threadId: id(query.threadId, "threadId") } : {}),
  };
  if (query.agentDeploymentId !== undefined) {
    return listRuns(dependencies, principal, page, {
      ...filters,
      agentDeploymentId: id(query.agentDeploymentId, "agentDeploymentId"),
    });
  }
  if (query.executionBindingId !== undefined) {
    return listRuns(dependencies, principal, page, {
      ...filters,
      executionBindingId: id(query.executionBindingId, "executionBindingId"),
    });
  }
  return listEnvironmentRuns(dependencies, principal, page, filters);
}

async function listEnvironmentRuns(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  page: RunListPage,
  filters: RunFeedFilters,
) {
  const { environmentId, organizationId, projectId } = principal.scope;
  const cursorBinding = {
    ":pk": runFeedPartition(environmentId),
    ":prefix": RUN_FEED_SORT_PREFIX,
  };
  const cursorContext = {
    agentReleaseId: filters.agentReleaseId ?? null,
    createdAfter: filters.createdAfter ?? null,
    createdBefore: filters.createdBefore ?? null,
    executionPurpose: filters.executionPurpose ?? null,
    organizationId,
    projectId,
    status: filters.status ?? null,
    threadId: filters.threadId ?? null,
  };
  const result = await makeRunFeedPersistence(dependencies.database).listEnvironmentRuns(
    { environmentId, organizationId, projectId },
    {
      exclusiveStartKey: decodeCursor(
        page.cursor,
        dependencies.sessionTokenSecret,
        "gsi2",
        cursorBinding,
        cursorContext,
      ),
      filters,
      limit: pageLimit(page.limit),
    },
  );
  return {
    runs: result.runs.map(publicRun),
    ...(result.lastEvaluatedKey
      ? {
          nextCursor: encodeCursor(
            result.lastEvaluatedKey,
            dependencies.sessionTokenSecret,
            "gsi2",
            cursorBinding,
            cursorContext,
          ),
        }
      : {}),
  };
}
