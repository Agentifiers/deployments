import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  listGovernedOrganizationIds,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { optionalStringArray } from "../lambda-environment.ts";
import { maintainBrainContent } from "./content-maintenance.ts";
import { detectBrainDocumentDuplicates } from "./duplicate-maintenance.ts";

const tableNames = tableNamesFromEnvironment(process.env);
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const database = makeDynamoDatabase(documentClient, tableNames);
const ids = makeIdGenerator();
const repository = makeBrainDynamoRepository(database);
const s3 = new S3Client({});

export async function handler() {
  const bucket = process.env.DEPLOYMENTS_AI_ARTIFACT_BUCKET?.trim();
  if (!bucket) throw new Error("DEPLOYMENTS_AI_ARTIFACT_BUCKET is required.");
  const now = new Date();
  const content = await maintainBrainContent({
    bucket,
    database,
    generateId: async () => ids.generate(),
    legacyBuckets: optionalStringArray(process.env, "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON"),
    now,
    s3,
  });
  let duplicateGroups = 0;
  let duplicateReviewsCreated = 0;
  for (const organizationId of await listGovernedOrganizationIds(documentClient, tableNames)) {
    let cursor: string | undefined;
    do {
      const page = await repository.listByOrganization(organizationId, {
        ...(cursor ? { cursor } : {}),
        limit: 100,
        status: "active",
      });
      for (const brain of page.items) {
        const result = await detectBrainDocumentDuplicates({
          brain,
          database,
          generateId: async () => ids.generate(),
          now: now.toISOString(),
          repository,
        });
        duplicateGroups += result.groups;
        duplicateReviewsCreated += result.reviewsCreated;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  console.info(
    JSON.stringify({
      _aws: {
        CloudWatchMetrics: [
          {
            Dimensions: [[]],
            Metrics: [
              { Name: "DuplicateGroups", Unit: "Count" },
              { Name: "DuplicateReviewsCreated", Unit: "Count" },
            ],
            Namespace: "DeploymentsAI/Brain",
          },
        ],
        Timestamp: now.getTime(),
      },
      DuplicateGroups: duplicateGroups,
      DuplicateReviewsCreated: duplicateReviewsCreated,
    }),
  );
  return { ...content, duplicateGroups, duplicateReviewsCreated };
}
