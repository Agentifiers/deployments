import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";

type ArtifactRecord = Extract<PlatformRecord, { readonly itemType: "artifact" }>;

/**
 * Artifacts carry two index entries. The environment index (`gsi2`) orders every artifact of an
 * environment by creation time: `ENV#<environmentId>` / `ARTIFACT#<createdAt>#<artifactId>`. The run
 * index (`gsi1`) groups a run's artifacts by status and update time:
 * `ORG#<organizationId>#RUN#<runId>#ARTIFACTS` / `ARTIFACT#<status>#<updatedAt>#<artifactId>`.
 */
export const ARTIFACT_INDEX_SORT_PREFIX = `${key("ARTIFACT")}#`;
/** Index pages one artifact list read evaluates before it returns a short page. */
export const ARTIFACT_INDEX_PAGE_LIMIT = 100;
/** Sorts after every artifact identifier, so an inclusive upper bound keeps that instant. */
const UPPER_SENTINEL = "~";

export function artifactEnvironmentPartition(environmentId: string) {
  return key("ENV", environmentId);
}

export function artifactRunPartition(organizationId: string, runId: string) {
  return key("ORG", organizationId, "RUN", runId, "ARTIFACTS");
}

/**
 * Inclusive environment index bounds for a creation window. Artifacts stored before the creation
 * index sort by status (`ARTIFACT#available#…`) after every timestamp until the
 * `artifact-creation-index` deploy migration rewrites them, so an open upper bound still reads
 * them and a `createdBefore` bound leaves them out.
 */
function environmentSortBounds(window: ArtifactCreationWindow) {
  return {
    lower: window.createdAfter ? key("ARTIFACT", window.createdAfter) : ARTIFACT_INDEX_SORT_PREFIX,
    upper: window.createdBefore
      ? `${key("ARTIFACT", window.createdBefore)}#${UPPER_SENTINEL}`
      : `${ARTIFACT_INDEX_SORT_PREFIX}${UPPER_SENTINEL}`,
  };
}

export interface ArtifactCreationWindow {
  /** Inclusive canonical UTC millisecond timestamp. */
  readonly createdAfter?: string | undefined;
  /** Inclusive canonical UTC millisecond timestamp. */
  readonly createdBefore?: string | undefined;
}

export interface ArtifactIndexPageRequest {
  readonly exclusiveStartKey?: Readonly<Record<string, unknown>> | undefined;
}

export interface ArtifactIndexPage {
  /** Present while older index entries remain; pass it back as `exclusiveStartKey`. */
  readonly lastEvaluatedKey?: Record<string, unknown>;
  readonly artifacts: readonly ArtifactRecord[];
}

function artifactsOf(items: readonly PlatformRecord[]) {
  return items.filter((record): record is ArtifactRecord => record.itemType === "artifact");
}

/**
 * Reads the artifact indexes one page at a time. Index entries are eventually consistent and carry
 * no tenant check, so callers match scope, readability, and retention on every returned record.
 */
export function makeArtifactIndexPersistence(database: DynamoDatabaseService) {
  return {
    /** The environment's artifacts, newest first by creation time. */
    async environmentPage(
      environmentId: string,
      window: ArtifactCreationWindow,
      request: ArtifactIndexPageRequest,
    ): Promise<ArtifactIndexPage> {
      const { lower, upper } = environmentSortBounds(window);
      const page = await database.queryRecords("execution", {
        ...(request.exclusiveStartKey
          ? { ExclusiveStartKey: { ...request.exclusiveStartKey } }
          : {}),
        ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
        ExpressionAttributeValues: {
          ":lower": lower,
          ":pk": artifactEnvironmentPartition(environmentId),
          ":upper": upper,
        },
        IndexName: "gsi2",
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :lower AND :upper",
        Limit: ARTIFACT_INDEX_PAGE_LIMIT,
        ScanIndexForward: false,
      });
      return {
        artifacts: artifactsOf(page.items),
        ...(page.lastEvaluatedKey ? { lastEvaluatedKey: page.lastEvaluatedKey } : {}),
      };
    },

    /** One run's artifacts, most recently updated first within each status. */
    async runPage(
      organizationId: string,
      runId: string,
      request: ArtifactIndexPageRequest,
    ): Promise<ArtifactIndexPage> {
      const page = await database.queryRecords("execution", {
        ...(request.exclusiveStartKey
          ? { ExclusiveStartKey: { ...request.exclusiveStartKey } }
          : {}),
        ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
        ExpressionAttributeValues: {
          ":pk": artifactRunPartition(organizationId, runId),
          ":prefix": ARTIFACT_INDEX_SORT_PREFIX,
        },
        IndexName: "gsi1",
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        Limit: ARTIFACT_INDEX_PAGE_LIMIT,
        ScanIndexForward: false,
      });
      return {
        artifacts: artifactsOf(page.items),
        ...(page.lastEvaluatedKey ? { lastEvaluatedKey: page.lastEvaluatedKey } : {}),
      };
    },
  };
}
