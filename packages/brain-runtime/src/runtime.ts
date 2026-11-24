import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  makeBrainQueryRuntime,
  makeS3BrainRenditionHydrator,
  type BrainQueryPlacementResolver,
  type BrainQueryRuntime,
  type BrainRepository,
  type BrainSearchProviderRegistry,
  type BrainSearchTarget,
} from "@deployments-ai/brains";
import { getBrainSearchPlacement, type DynamoDatabaseService } from "@deployments-ai/db";
import { makeBrainAnswerModel } from "./answer-model.ts";
import { makeBrainQueryEmbeddingPort } from "./embedding.ts";
import { makeDynamoBrainQueryTelemetry } from "./telemetry.ts";
import { brainModelUsageRecorder } from "./usage-identity.ts";
import type { BrainModelGateway } from "./gateway-loader.ts";

export function makeApprovedBrainRenditionGetObject(input: {
  readonly contentBucket: string;
  readonly legacyContentBuckets?: readonly string[];
  readonly s3: Pick<S3Client, "send">;
}) {
  return async (
    request: {
      readonly Bucket: string;
      readonly Key: string;
      readonly Range?: string;
      readonly VersionId: string;
    },
    options: { readonly abortSignal?: AbortSignal },
  ) => {
    if (
      (request.Bucket !== input.contentBucket &&
        !input.legacyContentBuckets?.includes(request.Bucket)) ||
      !request.Key.startsWith("organizations/")
    ) {
      throw new TypeError("Brain rendition points outside the approved content boundary.");
    }
    return input.s3.send(new GetObjectCommand(request), options);
  };
}

export function makeDynamoBrainQueryPlacementResolver(input: {
  readonly database: DynamoDatabaseService;
  readonly providers: BrainSearchProviderRegistry;
}): BrainQueryPlacementResolver {
  return {
    async resolve(organizationId) {
      const placement = await getBrainSearchPlacement(input.database, organizationId);
      if (
        !placement ||
        placement.data.phase !== "active" ||
        !placement.data.readTarget ||
        !placement.data.writeTarget ||
        placement.data.readTarget.targetId !== placement.data.writeTarget.targetId
      ) {
        throw new Error("Brain search has no active organization placement.");
      }
      const target: BrainSearchTarget = {
        embeddingProfileId: placement.data.readTarget.embeddingProfileId,
        location: placement.data.readTarget.location,
        providerId: placement.data.readTarget.providerId,
        schemaGeneration: placement.data.readTarget.schemaGeneration,
        targetId: placement.data.readTarget.targetId,
      };
      const provider = await input.providers.resolve(target);
      const readiness = await provider.inspect({ organizationId });
      if (
        !readiness.ready ||
        !provider.capabilities.hybrid ||
        readiness.components.some((component) => !component.ready)
      ) {
        throw new Error("Brain search placement is not hybrid-ready.");
      }
      return { placementGeneration: placement.data.generation, provider, target };
    },
  };
}

export function makePlatformBrainQueryRuntime(input: {
  readonly answerModelId?: string;
  readonly contentBucket: string;
  readonly legacyContentBuckets?: readonly string[];
  readonly database: DynamoDatabaseService;
  readonly gateway: BrainModelGateway;
  readonly onAnswerRejected?: Parameters<typeof makeBrainQueryRuntime>[0]["onAnswerRejected"];
  readonly providers: BrainSearchProviderRegistry;
  readonly repository: BrainRepository;
  readonly s3: Pick<S3Client, "send">;
  readonly telemetry?: Parameters<typeof makeBrainQueryRuntime>[0]["telemetry"];
}): BrainQueryRuntime {
  const recordUsage = brainModelUsageRecorder(input.database);
  return makeBrainQueryRuntime({
    answerModel: makeBrainAnswerModel({
      gateway: input.gateway,
      recordUsage,
      ...(input.answerModelId ? { modelId: input.answerModelId } : {}),
    }),
    embeddings: makeBrainQueryEmbeddingPort({
      database: input.database,
      gateway: input.gateway,
      recordUsage,
    }),
    hydrator: makeS3BrainRenditionHydrator({
      getObject: makeApprovedBrainRenditionGetObject(input),
    }),
    ...(input.onAnswerRejected ? { onAnswerRejected: input.onAnswerRejected } : {}),
    placement: makeDynamoBrainQueryPlacementResolver({
      database: input.database,
      providers: input.providers,
    }),
    repository: input.repository,
    telemetry: input.telemetry ?? makeDynamoBrainQueryTelemetry({ database: input.database }),
  });
}
