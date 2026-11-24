import { KMSClient } from "@aws-sdk/client-kms";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  governanceOperationDispatchCompletion,
  makeDynamoGovernanceStore,
  makeIdGenerator,
} from "@deployments-ai/db";
import { createGovernanceService } from "@deployments-ai/governance";
import {
  makeKmsGovernanceSigner,
  makeS3GovernanceObjectStore,
} from "@deployments-ai/governance/aws";
import { API_ENV, createApiLambdaHandler, makeApiIdempotency } from "./api-lambda-foundation.ts";
import { makeBrainSearchErasureInvoker } from "./brain/search-erasure.ts";
import { createGovernanceApiHandler } from "./governance-api.ts";
import { optionalStringArray, requiredEnvironment } from "./lambda-environment.ts";
import { makeMemorySearchErasureInvoker } from "./memory-search-erasure.ts";

const GOVERNANCE_API_ENV = {
  bucket: "DEPLOYMENTS_AI_GOVERNANCE_BUCKET",
  legacyBuckets: "DEPLOYMENTS_AI_LEGACY_GOVERNANCE_BUCKETS_JSON",
  memoryErasureFunctionName: "DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME",
  queueUrl: "DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL",
  signingKeyArn: "DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN",
} as const;

const GOVERNANCE_ENVIRONMENT_NAMES = [
  API_ENV.artifactKmsKeyArn,
  GOVERNANCE_API_ENV.bucket,
  GOVERNANCE_API_ENV.queueUrl,
  GOVERNANCE_API_ENV.signingKeyArn,
  GOVERNANCE_API_ENV.memoryErasureFunctionName,
] as const;

export function governanceConfigurationEnabled(environment: NodeJS.ProcessEnv) {
  const configured = GOVERNANCE_ENVIRONMENT_NAMES.filter(
    (name) => environment[name]?.trim() !== undefined && environment[name]!.trim().length > 0,
  );
  if (configured.length === 0) return false;
  if (configured.length !== GOVERNANCE_ENVIRONMENT_NAMES.length) {
    throw new Error(
      `${GOVERNANCE_ENVIRONMENT_NAMES.join(", ")} must be configured together to enable governance routes.`,
    );
  }
  return true;
}

export const handler = createApiLambdaHandler(
  (foundation, environment) => {
    const { authenticate, database, documentClient, tableNames } = foundation;
    const { idempotency, responseProtector } = makeApiIdempotency({ database, environment });
    const s3 = new S3Client({});
    const queue = new SQSClient({});
    const ids = makeIdGenerator();
    const governanceBucket = requiredEnvironment(environment, GOVERNANCE_API_ENV.bucket);
    const governance = createGovernanceService({
      allowedObjectBuckets: [
        governanceBucket,
        ...optionalStringArray(environment, GOVERNANCE_API_ENV.legacyBuckets),
      ],
      generateId: async () => ids.generate(),
      objectStore: makeS3GovernanceObjectStore({
        bucket: governanceBucket,
        client: s3,
        kmsKeyArn: requiredEnvironment(environment, API_ENV.artifactKmsKeyArn),
      }),
      purgeMemorySearch: makeMemorySearchErasureInvoker(environment),
      purgeBrainSearch: makeBrainSearchErasureInvoker(environment),
      signer: makeKmsGovernanceSigner({
        client: new KMSClient({}),
        keyId: requiredEnvironment(environment, GOVERNANCE_API_ENV.signingKeyArn),
        signingAlgorithm: "ECDSA_SHA_256",
      }),
      store: makeDynamoGovernanceStore(documentClient, tableNames, {
        idempotencyResponseProtector: responseProtector,
      }),
    });
    return createGovernanceApiHandler({
      authenticate,
      createDownloadUrl: async (reference) => {
        const expiresIn = 300;
        return {
          expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
          url: await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: reference.bucket,
              Key: reference.key,
              VersionId: reference.versionId,
            }),
            { expiresIn },
          ),
        };
      },
      dispatchCompletion: (operation, operatorAccessGrantId) =>
        governanceOperationDispatchCompletion(
          operation,
          new Date().toISOString(),
          ids.generate(),
          operatorAccessGrantId,
        ),
      enqueue: async (message) => {
        await queue.send(
          new SendMessageCommand({
            MessageBody: JSON.stringify(message),
            QueueUrl: requiredEnvironment(environment, GOVERNANCE_API_ENV.queueUrl),
          }),
        );
      },
      idempotency,
      service: governance,
    });
  },
  { enabled: governanceConfigurationEnabled },
);
