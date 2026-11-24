import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  activateDefaultBrainSearch,
  makeBrainSearchProviderRegistry,
  type DefaultBrainSearchActivation,
  type DefaultBrainSearchConfig,
} from "@deployments-ai/brain-runtime";
import type { BrainSearchProviderRegistry } from "@deployments-ai/brains";
import {
  makeDynamoDatabase,
  makeBrainDynamoRepository,
  makeIdGenerator,
  makePlatformOrganizationDirectory,
  tableNamesFromEnvironment,
  Ulid,
  type BrainIndexBackfillRepository,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { Schema } from "effect";

/**
 * `memory.search-placement.activated` from EventBridge, `{ "organizationId": "..." }` for one
 * organization, or `{ "organizations": "all" }` for one page of every organization on the
 * install (repeat with the returned `nextCursor`).
 */
export type BrainSearchPlacementEvent =
  | { readonly detail: { readonly organizationId?: unknown } }
  | { readonly organizationId?: unknown }
  | { readonly cursor?: string; readonly organizations: "all" };

export interface BrainSearchPlacementInstallResult {
  readonly failed: readonly string[];
  readonly nextCursor?: string;
  readonly results: readonly ({ readonly organizationId: string } & (
    | { readonly outcome: DefaultBrainSearchActivation["outcome"] }
    | { readonly outcome: "failed" }
  ))[];
}

interface Dependencies {
  readonly config: DefaultBrainSearchConfig;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now: () => string;
  readonly providers: BrainSearchProviderRegistry;
  readonly repository: BrainIndexBackfillRepository;
}

export function brainSearchPlacementOrganizationId(
  event: Exclude<BrainSearchPlacementEvent, { readonly organizations: "all" }>,
) {
  const organizationId = "detail" in event ? event.detail.organizationId : event.organizationId;
  return Schema.decodeUnknownSync(Ulid)(organizationId);
}

export function defaultBrainSearchConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DefaultBrainSearchConfig {
  const openSearchEndpoint = environment.DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT?.trim();
  const region = environment.AWS_REGION?.trim();
  if (!openSearchEndpoint || !region) {
    throw new TypeError(
      "DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT and AWS_REGION are required for Brain search activation.",
    );
  }
  return { openSearchEndpoint, region };
}

export async function activateDefaultBrainSearchForInstall(
  dependencies: Dependencies,
  cursor: string | undefined,
): Promise<BrainSearchPlacementInstallResult> {
  const page = await makePlatformOrganizationDirectory(dependencies.database).list({
    ...(cursor ? { cursor } : {}),
    limit: 10,
  });
  const results: BrainSearchPlacementInstallResult["results"][number][] = [];
  for (const organization of page.items) {
    try {
      const activation = await activateDefaultBrainSearch({
        ...dependencies,
        backfillConfigured: false,
        organizationId: Schema.decodeUnknownSync(Ulid)(organization.id),
      });
      results.push({ organizationId: organization.id, outcome: activation.outcome });
    } catch (cause) {
      console.error("Default Brain search activation failed.", {
        errorName: cause instanceof Error ? cause.name : "UnknownError",
        organizationId: organization.id,
      });
      results.push({ organizationId: organization.id, outcome: "failed" });
    }
  }
  return {
    failed: results.flatMap((result) =>
      result.outcome === "failed" ? [result.organizationId] : [],
    ),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    results,
  };
}

export async function handleBrainSearchPlacement(
  event: BrainSearchPlacementEvent,
  dependencies: Dependencies,
) {
  if ("organizations" in event) {
    return activateDefaultBrainSearchForInstall(dependencies, event.cursor);
  }
  const result = await activateDefaultBrainSearch({
    ...dependencies,
    backfillConfigured: true,
    organizationId: brainSearchPlacementOrganizationId(event),
  });
  return { outcome: result.outcome };
}

export async function handler(event: BrainSearchPlacementEvent) {
  const config = defaultBrainSearchConfig(process.env);
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(process.env),
  );
  const ids = makeIdGenerator();
  return handleBrainSearchPlacement(event, {
    config,
    database,
    generateId: async () => ids.generate(),
    now: () => new Date().toISOString(),
    repository: makeBrainDynamoRepository(database),
    providers: makeBrainSearchProviderRegistry({
      config: { aws: { openSearchEndpoint: config.openSearchEndpoint } },
      database,
    }),
  });
}
