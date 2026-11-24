import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  brainOpenSearchTransport,
  makeBrainSearchProviderRegistry,
} from "@deployments-ai/brain-runtime";
import type { BrainSearchProviderRegistry } from "@deployments-ai/brains";
import {
  getBrainSearchPlacement,
  key,
  makeDynamoDatabase,
  tableNamesFromEnvironment,
  Ulid,
  apiPersistence,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { requiredEnvironment } from "../lambda-environment.ts";
import { dropErasedOrganizationBrainIndex } from "./erased-search-index-drop.ts";
import type { BrainSearchErasureResult } from "./search-erasure.ts";

const BrainSearchErasureInput = Schema.Struct({
  brainId: Schema.optional(Ulid),
  erasureGeneration: Schema.optional(Schema.Number.pipe(Schema.check(Schema.isInt()))),
  operationId: Ulid,
  organizationId: Ulid,
}).pipe(
  Schema.check(
    Schema.makeFilter((input) =>
      (input.brainId === undefined) === (input.erasureGeneration === undefined)
        ? undefined
        : "Brain-scoped search erasure requires its fence generation.",
    ),
  ),
);

const DropErasedOrganizationSearchIndex = Schema.Struct({
  action: Schema.Literal("drop-erased-organization-search-index"),
  index: Schema.String,
  organizationId: Ulid,
});

export function brainSearchProviderRegistry(
  database: DynamoDatabaseService,
  environment: NodeJS.ProcessEnv = process.env,
): BrainSearchProviderRegistry {
  const openSearchEndpoint = environment.DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT?.trim();
  return makeBrainSearchProviderRegistry({
    config: openSearchEndpoint ? { aws: { openSearchEndpoint } } : {},
    database,
  });
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function eraseBrainSearchOrganization(
  input: typeof BrainSearchErasureInput.Type,
  database: DynamoDatabaseService,
  registry: BrainSearchProviderRegistry,
): Promise<BrainSearchErasureResult> {
  const placement = await getBrainSearchPlacement(database, input.organizationId);
  if (input.brainId) {
    const brain = await apiPersistence.read(
      database,
      "control",
      {
        pk: key("ORG", input.organizationId),
        sk: key("BRAIN", input.brainId),
      },
      true,
    );
    if (
      brain?.itemType !== "brain" ||
      brain.data.status !== "erasing" ||
      brain.data.version !== input.erasureGeneration
    ) {
      throw new Error("Brain search erasure lost its generation-bound write fence.");
    }
  }
  if (!placement || placement.data.phase === "unconfigured") {
    return {
      receipt: {
        ...(input.brainId ? { brainId: input.brainId } : {}),
        ...(input.erasureGeneration !== undefined
          ? { erasureGeneration: input.erasureGeneration }
          : {}),
        operationId: input.operationId,
        targets: [],
      },
      status: "complete",
    };
  }
  const target =
    placement.data.phase === "active" ? placement.data.writeTarget : placement.data.candidateTarget;
  if (!target) throw new Error("Brain search placement has no purgeable target.");

  let cursor: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = await apiPersistence.find(database, "control", {
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      ExpressionAttributeValues: {
        ":partition": key("BRAIN-SEARCH-TARGET", target.targetId),
      },
      IndexName: "gsi2",
      KeyConditionExpression: "gsi2pk = :partition",
      Limit: 100,
    });
    const observedAt = new Date().toISOString();
    if (
      page.items.some((record) => {
        if (
          record.itemType !== "brain-provider-mutation-claim" ||
          (input.brainId && record.data.brainId !== input.brainId)
        ) {
          return false;
        }
        return input.brainId
          ? record.data.status === "active" &&
              record.data.leaseExpiresAt !== undefined &&
              record.data.leaseExpiresAt > observedAt
          : record.data.status === "active" || record.data.status === "unknown";
      })
    ) {
      return { reason: "provider_mutations_draining", status: "pending" };
    }
    cursor = page.lastEvaluatedKey;
  } while (cursor);

  const provider = await registry.resolve({
    embeddingProfileId: target.embeddingProfileId,
    location: target.location,
    providerId: target.providerId,
    schemaGeneration: target.schemaGeneration,
    targetId: target.targetId,
  });
  const purge = input.brainId
    ? await provider.purgeBrain({
        brainId: input.brainId,
        organizationId: input.organizationId,
      })
    : await provider.purgeOrganization({ organizationId: input.organizationId });
  if (purge.receipt.absenceVerified !== true) {
    throw new Error("Brain search provider did not return verified absence.");
  }
  const componentReceipts = target.components.map((component) => {
    const store = "opensearch" as const;
    const evidence = {
      componentId: component.componentId,
      generationId: target.targetId,
      providerReceipt: {
        absenceVerified: true as const,
        receiptDigest: digest({ component, purge: purge.receipt, store }),
        store,
      },
    };
    return evidence;
  });
  return {
    receipt: {
      operationId: input.operationId,
      ...(input.brainId ? { brainId: input.brainId } : {}),
      ...(input.erasureGeneration !== undefined
        ? { erasureGeneration: input.erasureGeneration }
        : {}),
      targets: [
        {
          componentReceipts,
          providerId: target.providerId,
          targetDigest: digest({
            location: target.location,
            providerId: target.providerId,
            schemaGeneration: target.schemaGeneration,
            targetId: target.targetId,
          }),
        },
      ],
    },
    status: "complete",
  };
}

export async function handler(input: unknown) {
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(process.env),
  );
  if (typeof input === "object" && input !== null && "action" in input) {
    const { index, organizationId } = Schema.decodeUnknownSync(DropErasedOrganizationSearchIndex)(
      input,
    );
    const endpoint = requiredEnvironment(process.env, "DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT");
    return dropErasedOrganizationBrainIndex({
      database,
      index,
      openSearch: brainOpenSearchTransport({
        approvedEndpoint: endpoint,
        endpoint,
        region: requiredEnvironment(process.env, "AWS_REGION"),
      }),
      organizationId,
    });
  }
  return eraseBrainSearchOrganization(
    Schema.decodeUnknownSync(BrainSearchErasureInput)(input),
    database,
    brainSearchProviderRegistry(database),
  );
}
