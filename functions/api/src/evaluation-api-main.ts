import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  makeEvaluationPersistence,
  makeIdGenerator,
  makeModelIdAdmission,
  makeTenancyPersistence,
} from "@deployments-ai/db";
import {
  API_ENV,
  createApiLambdaHandler,
  freshModelOperatorGrants,
  makeApiIdempotency,
} from "./api-lambda-foundation.ts";
import { createEvaluationApi } from "./evaluations/api.ts";
import {
  makeS3EvaluationArtifactStore,
  makeSqsEvaluationQueue,
} from "./evaluations/aws-adapters.ts";
import { makeEvaluationApiService } from "./evaluations/service.ts";
import { requiredEnvironment } from "./lambda-environment.ts";

const EVALUATION_QUEUE_URL_ENV = "DEPLOYMENTS_AI_EVALUATION_QUEUE_URL";

export const handler = createApiLambdaHandler((foundation, environment) => {
  const { authenticate, database, recordApiCredentialUsage } = foundation;
  const persistence = makeTenancyPersistence({ database });
  const evaluationIds = makeIdGenerator();
  const evaluationQueueUrl = environment[EVALUATION_QUEUE_URL_ENV]?.trim();
  return createEvaluationApi({
    authenticate,
    idempotency: makeApiIdempotency({ database, environment }).idempotency,
    recordApiCredentialUsage,
    resolveEnvironment: async ({ environmentId, identity }) => {
      const resolved = await persistence.environments.get({
        body: undefined,
        id: environmentId,
        identity,
        query: {},
        scope: { environmentId },
      });
      return {
        id: resolved.id,
        organizationId: resolved.organizationId,
        projectId: resolved.projectId,
        status: resolved.status,
      };
    },
    service: makeEvaluationApiService({
      admitJudgeModel: makeModelIdAdmission(database, freshModelOperatorGrants(environment)),
      artifacts: makeS3EvaluationArtifactStore({
        bucket: requiredEnvironment(environment, API_ENV.artifactBucket),
        client: new S3Client({}),
        kmsKeyArn: requiredEnvironment(environment, API_ENV.artifactKmsKeyArn),
      }),
      generateId: async () => evaluationIds.generate(),
      persistence: (scope) => makeEvaluationPersistence(database, scope),
      ...(evaluationQueueUrl
        ? {
            queue: makeSqsEvaluationQueue({
              client: new SQSClient({}),
              queueUrl: evaluationQueueUrl,
            }),
          }
        : {}),
    }),
  });
});
