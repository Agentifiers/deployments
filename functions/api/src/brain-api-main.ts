import { S3Client } from "@aws-sdk/client-s3";
import {
  makeBrainSearchProviderRegistry,
  makePlatformBrainQueryRuntime,
  type BrainSearchProviderRuntimeConfig,
} from "@deployments-ai/brain-runtime";
import {
  makeBrainDynamoRepository,
  makeIdGenerator,
  parseBrainUploadQuotas,
} from "@deployments-ai/db";
import { API_ENV, createApiLambdaHandler, makeApiIdempotency } from "./api-lambda-foundation.ts";
import { createBrainApi } from "./brain/api.ts";
import { makeS3BrainContentUploader } from "./brain/content-upload.ts";
import { createHostedBrainMcp } from "./brain/mcp.ts";
import { BRAIN_MODEL_GATEWAY_ENV, makeBrainModelGateway } from "./brain/model-gateway.ts";
import { makeBrainApiService } from "./brain/service.ts";
import { optionalPair, optionalStringArray, requiredEnvironment } from "./lambda-environment.ts";

const BRAIN_API_ENV = {
  answerModel: "DEPLOYMENTS_AI_BRAIN_ANSWER_MODEL",
  legacyArtifactBuckets: "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
  openSearchEndpoint: "DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT",
} as const;

export const handler = createApiLambdaHandler((foundation, environment) => {
  const { authenticate, database, recordApiCredentialUsage } = foundation;
  const s3 = new S3Client({});
  const brainIds = makeIdGenerator();
  const brainRepository = makeBrainDynamoRepository(database, parseBrainUploadQuotas(environment));
  const brainModelGateway = optionalPair(
    environment,
    BRAIN_MODEL_GATEWAY_ENV.baseUrl,
    BRAIN_MODEL_GATEWAY_ENV.tokenIssuer,
  );
  const brainOpenSearchEndpoint = environment[BRAIN_API_ENV.openSearchEndpoint]?.trim();
  const brainProviderConfig: BrainSearchProviderRuntimeConfig = brainOpenSearchEndpoint
    ? { aws: { openSearchEndpoint: brainOpenSearchEndpoint } }
    : {};
  const brainQueryRuntime = brainModelGateway
    ? makePlatformBrainQueryRuntime({
        ...(environment[BRAIN_API_ENV.answerModel]?.trim()
          ? { answerModelId: environment[BRAIN_API_ENV.answerModel]!.trim() }
          : {}),
        contentBucket: requiredEnvironment(environment, API_ENV.artifactBucket),
        legacyContentBuckets: optionalStringArray(environment, BRAIN_API_ENV.legacyArtifactBuckets),
        database,
        gateway: makeBrainModelGateway({
          baseUrl: brainModelGateway[0],
          environment,
          tokenIssuer: brainModelGateway[1],
        }),
        onAnswerRejected: (event) => console.warn("Brain answer rejected.", event),
        providers: makeBrainSearchProviderRegistry({
          config: brainProviderConfig,
          database,
        }),
        repository: brainRepository,
        s3,
      })
    : undefined;
  const brainFetch = createBrainApi({
    authenticate,
    idempotency: makeApiIdempotency({ database, environment }).idempotency,
    recordApiCredentialUsage,
    service: makeBrainApiService({
      contentBucket: requiredEnvironment(environment, API_ENV.artifactBucket),
      contentKmsKeyArn: requiredEnvironment(environment, API_ENV.artifactKmsKeyArn),
      contentUploader: makeS3BrainContentUploader(s3),
      database,
      generateId: async () => brainIds.generate(),
      repository: brainRepository,
      ...(brainQueryRuntime ? { brainQueryRuntime } : {}),
    }),
  });
  const brainMcpFetch = createHostedBrainMcp(brainFetch);
  return async (request: Request) => (await brainMcpFetch(request)) ?? brainFetch(request);
});
