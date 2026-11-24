import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { loadBrainEmbeddingProfile } from "@deployments-ai/brain-runtime";
import {
  activateBrainSearchPlacement,
  canonicalRecordKeys,
  ensureBrainSearchPlacement,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
  Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { migrateBrainSearchPlacement } from "./brain-search-migration.ts";
import { deterministicE2eMemoryId } from "./bootstrap-e2e-memory-search-support.ts";
import { runMain } from "./platform-deploy/process.ts";
import { required } from "./required-environment.ts";

// Activates the credentialed E2E organization's Brain search placement on the
// AWS-native Brain OpenSearch domain, or migrates an active placement whose
// target still names another domain (for example after the domain was replaced).
// The domain is VPC-private, so this only records the placement; the Brain index
// worker prepares the physical index on its first job. Run after
// bootstrap-e2e-memory-search.ts: the Brain target reuses the platform-approved
// embedding profile of the organization's active memory target.

function e2eBrainSearchTarget(input: {
  readonly embeddingProfileId: typeof Ulid.Type;
  readonly openSearchEndpoint: string;
  readonly organizationId: typeof Ulid.Type;
  readonly region: string;
}) {
  // Target and component IDs are deterministic per domain, so a re-run is idempotent and a
  // migration to a replacement domain gets the new target ID the placement requires.
  const domain = new URL(input.openSearchEndpoint).host;
  return {
    components: (["dense", "entity", "exact", "lexical"] as const).map((kind) => ({
      componentId: deterministicE2eMemoryId(input.organizationId, `brain-search-${kind}:${domain}`),
      kind,
    })),
    embeddingProfileId: input.embeddingProfileId,
    location: {
      openSearchEndpoint: input.openSearchEndpoint,
      openSearchIndex: `brain-${input.organizationId.toLowerCase()}-v1`,
      region: input.region,
    },
    providerId: "aws-native" as const,
    schemaGeneration: 1,
    targetId: deterministicE2eMemoryId(input.organizationId, `brain-search-target:${domain}`),
  };
}

async function main() {
  const organizationId = Schema.decodeUnknownSync(Ulid)(
    required("DEPLOYMENTS_E2E_ORGANIZATION_ID"),
  );
  const actorPrincipalId = Schema.decodeUnknownSync(Ulid)(required("DEPLOYMENTS_E2E_PRINCIPAL_ID"));
  const region = required("AWS_REGION");
  const baseClient = new DynamoDBClient({ region });
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(),
  );
  try {
    const placement = await ensureBrainSearchPlacement({
      database,
      now: new Date().toISOString(),
      organizationId,
    });
    if (placement.data.phase !== "active" && placement.data.phase !== "unconfigured") {
      throw new Error(
        `Credentialed E2E Brain search placement is ${placement.data.phase}; finish its migration before running E2E.`,
      );
    }
    const memoryPlacement = await database.getRecord(
      "control",
      canonicalRecordKeys(
        { data: { organizationId }, itemType: "memory-search-placement" },
        "control",
      ),
      true,
    );
    if (
      memoryPlacement?.itemType !== "memory-search-placement" ||
      memoryPlacement.data.phase !== "active" ||
      !memoryPlacement.data.readTarget
    ) {
      throw new Error("The credentialed E2E memory search placement must be active first.");
    }
    const target = e2eBrainSearchTarget({
      embeddingProfileId: memoryPlacement.data.readTarget.embeddingProfileId,
      openSearchEndpoint: required("DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT"),
      organizationId,
      region,
    });
    const profile = await loadBrainEmbeddingProfile(database, target.embeddingProfileId);
    if (
      profile.data.distanceMetric !== "cosine" ||
      profile.data.processingBoundary !== "platform-approved"
    ) {
      throw new Error("The credentialed E2E embedding profile cannot serve Brain search.");
    }
    const ids = makeIdGenerator();
    const generateId = async () => ids.generate();
    if (placement.data.phase === "active") {
      const result = await migrateBrainSearchPlacement({
        actorPrincipalId,
        database,
        generateId,
        now: () => new Date().toISOString(),
        organizationId,
        target,
      });
      console.log(
        result.outcome === "migrated"
          ? "Credentialed E2E Brain search placement migrated to the configured domain."
          : "Credentialed E2E Brain search placement is active.",
      );
      return;
    }
    await activateBrainSearchPlacement({
      actor: { principalId: actorPrincipalId, type: "principal" },
      database,
      eventId: await generateId(),
      now: new Date().toISOString(),
      organizationId,
      target,
    });
    console.log("Credentialed E2E Brain search placement is active.");
  } finally {
    baseClient.destroy();
  }
}

if (import.meta.main) runMain(main);
