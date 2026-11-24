import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import type { RunStatus } from "../records/conversations.ts";
import type { ExecutionPurpose } from "../records/execution-bindings.ts";
import type { PlatformRecord } from "../records/index.ts";

type RunRecord = Extract<PlatformRecord, { readonly itemType: "run" }>;
type RunLocatorRecord = Extract<PlatformRecord, { readonly itemType: "run-locator" }>;

/**
 * Run locators carry no `status` or update time, so the generic control `gsi2` environment
 * projection already orders them by creation time: `ENV#<environmentId>` /
 * `RUN-LOCATOR#all#<createdAt>#<runId>`. Cursors are bound to this sort-key prefix.
 */
export const RUN_FEED_SORT_PREFIX = `${key("RUN-LOCATOR", "all")}#`;
/** Index pages one feed read evaluates before returning a short page with a continuation key. */
export const MAX_RUN_FEED_PAGES = 10;
/** Sorts after every run identifier so an inclusive upper bound keeps runs created at that instant. */
const RUN_FEED_UPPER_SENTINEL = "~";

export interface RunFeedScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface RunFeedFilters {
  readonly agentReleaseId?: string | undefined;
  /** Inclusive canonical UTC millisecond timestamp. */
  readonly createdAfter?: string | undefined;
  /** Inclusive canonical UTC millisecond timestamp. */
  readonly createdBefore?: string | undefined;
  readonly executionPurpose?: ExecutionPurpose | undefined;
  readonly status?: RunStatus | undefined;
  readonly threadId?: string | undefined;
}

export interface RunFeedPageRequest {
  readonly exclusiveStartKey?: Readonly<Record<string, unknown>> | undefined;
  readonly filters: RunFeedFilters;
  /** Maximum runs to return, from 1 to 100. */
  readonly limit: number;
}

export interface RunFeedPage {
  /** Present while older feed entries remain; pass it back as `exclusiveStartKey`. */
  readonly lastEvaluatedKey?: Record<string, unknown>;
  /** Newest first by creation time, then run identifier. */
  readonly runs: readonly RunRecord[];
}

interface RunFeedEntry {
  readonly agentReleaseId?: string | undefined;
  readonly createdAt: string;
  readonly environmentId: string;
  readonly executionPurpose: ExecutionPurpose;
  readonly organizationId: string;
  readonly projectId: string;
  readonly status: RunStatus;
  readonly threadId: string;
}

export function runFeedPartition(environmentId: string) {
  return key("ENV", environmentId);
}

/**
 * Applies the caller's tenant scope and feed filters. Locators are matched before the run read and,
 * because the index is eventually consistent, every candidate run is matched again afterwards.
 */
function feedEntryMatches(entry: RunFeedEntry, scope: RunFeedScope, filters: RunFeedFilters) {
  return (
    entry.organizationId === scope.organizationId &&
    entry.projectId === scope.projectId &&
    entry.environmentId === scope.environmentId &&
    (filters.status === undefined || entry.status === filters.status) &&
    (filters.agentReleaseId === undefined || entry.agentReleaseId === filters.agentReleaseId) &&
    (filters.executionPurpose === undefined ||
      entry.executionPurpose === filters.executionPurpose) &&
    (filters.createdAfter === undefined || entry.createdAt >= filters.createdAfter) &&
    (filters.createdBefore === undefined || entry.createdAt <= filters.createdBefore) &&
    (filters.threadId === undefined || entry.threadId === filters.threadId)
  );
}

/**
 * Environment-wide run listing across deployments and execution bindings, newest first. Locators
 * written before they mirrored run status, purpose, and thread are not listed (no backfill).
 */
export function makeRunFeedPersistence(database: DynamoDatabaseService) {
  return {
    async listEnvironmentRuns(
      scope: RunFeedScope,
      request: RunFeedPageRequest,
    ): Promise<RunFeedPage> {
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new RangeError("Run feed limit must be an integer from 1 to 100.");
      }
      const { filters } = request;
      const values = {
        ":lower": filters.createdAfter
          ? key("RUN-LOCATOR", "all", filters.createdAfter)
          : RUN_FEED_SORT_PREFIX,
        ":pk": runFeedPartition(scope.environmentId),
        ":upper": `${
          filters.createdBefore
            ? key("RUN-LOCATOR", "all", filters.createdBefore)
            : key("RUN-LOCATOR", "all")
        }#${RUN_FEED_UPPER_SENTINEL}`,
      };
      const locators: RunLocatorRecord[] = [];
      let exclusiveStartKey = request.exclusiveStartKey;
      let evaluatedPages = 0;
      do {
        const page = await database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: { ...exclusiveStartKey } } : {}),
          ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
          ExpressionAttributeValues: values,
          IndexName: "gsi2",
          KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
          Limit: request.limit - locators.length,
          ScanIndexForward: false,
        });
        for (const record of page.items) {
          if (record.itemType !== "run-locator") continue;
          const { executionPurpose, runStatus, threadId } = record.data;
          if (
            executionPurpose !== undefined &&
            runStatus !== undefined &&
            threadId !== undefined &&
            feedEntryMatches(
              { ...record.data, executionPurpose, status: runStatus, threadId },
              scope,
              filters,
            )
          ) {
            locators.push(record);
          }
        }
        exclusiveStartKey = page.lastEvaluatedKey;
        evaluatedPages += 1;
      } while (
        locators.length < request.limit &&
        exclusiveStartKey &&
        evaluatedPages < MAX_RUN_FEED_PAGES
      );
      const candidates = await Promise.all(
        locators.map(async (locator) => {
          const record = await database.getRecord("execution", {
            pk: locator.data.runPk,
            sk: locator.data.runSk,
          });
          return record?.itemType === "run" &&
            record.data.id === locator.data.id &&
            feedEntryMatches(
              { ...record.data, executionPurpose: record.data.executionPurpose ?? "customer" },
              scope,
              filters,
            )
            ? record
            : undefined;
        }),
      );
      return {
        runs: candidates.filter((run): run is RunRecord => run !== undefined),
        ...(exclusiveStartKey ? { lastEvaluatedKey: exclusiveStartKey } : {}),
      };
    },
  };
}
