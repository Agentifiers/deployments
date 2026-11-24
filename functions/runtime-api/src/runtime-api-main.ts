import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createEventBridgeTimerProvider } from "@deployments-ai/automations";
import { endUserKeyDeriver } from "@deployments-ai/conversations";
import {
  composeManifestAdmission,
  createApiCredentialUsageRecorder,
  makeCredentialVault,
  makeDynamoDatabase,
  makeIdGenerator,
  makeManifestModelAdmission,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { makeLambdaFileTextExtractor } from "@deployments-ai/file-text";
import { makeOrganizationGateFromEnvironment } from "@deployments-ai/organization-admission";
import {
  PLATFORM_JWT_ENV,
  platformJwtOptionsFromEnvironment,
} from "@deployments-ai/identity/platform-jwt";
import { parseModelOperatorGrantsJson } from "@deployments-ai/model-gateway";
import {
  DEFAULT_DURABLE_STREAM_TTL_SECONDS,
  createDurableStreamsClientTransport,
} from "@deployments-ai/streaming";
import { createSqsAgentRunQueueEnqueue } from "@deployments-ai/worker/sqs";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { makeManifestToolBoundaryAdmission } from "@deployments-ai/tools";
import { required } from "./required-environment.ts";
import { createRuntimeApiHandler, type RuntimeApiDependencies } from "./runtime.ts";
import { createRuntimeHumanAuthenticator } from "./runtime-authentication.ts";
import {
  WEBHOOK_DELIVERY_QUEUE_URL_ENV,
  createSqsWebhookDeliveryQueue,
} from "./webhook-runtime.ts";

const RUNTIME_API_ENV = {
  automationFailureQueueArn: "DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN",
  artifactBucket: "DEPLOYMENTS_AI_ARTIFACT_BUCKET",
  legacyArtifactBuckets: "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
  artifactKmsKeyArn: "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN",
  durableAuthSecretArn: "DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN",
  durableBaseUrl: "DEPLOYMENTS_AI_DURABLE_STREAMS_URL",
  documentExtractionFunctionName: "DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME",
  credentialKmsKeyArn: "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN",
  endUserSubjectKeyArn: "DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN",
  heartbeatFireArn: "DEPLOYMENTS_AI_HEARTBEAT_FIRE_LAMBDA_ARN",
  modelGrantsParameterArn: "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN",
  queueUrl: "DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL",
  scheduleFireArn: "DEPLOYMENTS_AI_SCHEDULE_FIRE_LAMBDA_ARN",
  schedulerGroup: "DEPLOYMENTS_AI_SCHEDULER_GROUP",
  schedulerRoleArn: "DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN",
  sessionSecretArn: "DEPLOYMENTS_AI_STREAM_SESSION_SECRET_ARN",
  streamGatewayBaseUrl: "DEPLOYMENTS_AI_STREAM_GATEWAY_BASE_URL",
} as const;

function optionalStringArray(name: string, env: NodeJS.ProcessEnv): readonly string[] {
  const value = env[name]?.trim();
  if (!value) return [];
  const decoded: unknown = JSON.parse(value);
  if (
    !Array.isArray(decoded) ||
    decoded.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${name} must be a JSON array of non-empty strings.`);
  }
  return [...new Set(decoded.map((entry) => entry.trim()))];
}

async function createAwsRuntimeApiDependencies(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeApiDependencies> {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const [durableAuthToken, sessionTokenSecret, endUserSubjectKey] = await Promise.all([
    loadAwsSecretString(required(RUNTIME_API_ENV.durableAuthSecretArn, env)),
    loadAwsSecretString(required(RUNTIME_API_ENV.sessionSecretArn, env)),
    loadAwsSecretString(required(RUNTIME_API_ENV.endUserSubjectKeyArn, env)),
  ]);
  // Preview bindings admit models the operator grants list for the agent. Each admission rereads
  // the grants parameter, so a newly synchronized grant applies without a restart.
  const modelGrantsParameterArn = env[RUNTIME_API_ENV.modelGrantsParameterArn]?.trim();
  const loadModelOperatorGrants = modelGrantsParameterArn
    ? async () => parseModelOperatorGrantsJson(await loadAwsSecretString(modelGrantsParameterArn))
    : undefined;
  const idGenerator = makeIdGenerator();
  const durableBaseUrl = required(RUNTIME_API_ENV.durableBaseUrl, env);
  const tableNames = tableNamesFromEnvironment(env);
  const database = makeDynamoDatabase(documentClient, tableNames);
  // Platform bearer JWTs use the control-plane API's settings; installs without the platform API
  // leave them unset and accept API keys only. A partial configuration fails at startup.
  const platformJwtConfigured = [PLATFORM_JWT_ENV.issuer, PLATFORM_JWT_ENV.audience].some((name) =>
    Boolean(env[name]?.trim()),
  );
  return {
    admitManifest: composeManifestAdmission(
      makeManifestModelAdmission(database, loadModelOperatorGrants),
      makeManifestToolBoundaryAdmission({ database }),
    ),
    artifactBucket: required(RUNTIME_API_ENV.artifactBucket, env),
    legacyArtifactBuckets: optionalStringArray(RUNTIME_API_ENV.legacyArtifactBuckets, env),
    artifactKmsKeyArn: required(RUNTIME_API_ENV.artifactKmsKeyArn, env),
    artifactS3: new S3Client({}),
    ...(platformJwtConfigured
      ? {
          authenticateHuman: createRuntimeHumanAuthenticator({
            database,
            jwt: platformJwtOptionsFromEnvironment(env),
          }),
        }
      : {}),
    credentialVault: makeCredentialVault({
      documentClient,
      kmsClient: new KMSClient({}),
      kmsKeyArn: required(RUNTIME_API_ENV.credentialKmsKeyArn, env),
      tableName: tableNames.control,
    }),
    database,
    fileTextExtractor: makeLambdaFileTextExtractor({
      functionName: required(RUNTIME_API_ENV.documentExtractionFunctionName, env),
      lambda: new LambdaClient({}),
    }),
    durableTransport: createDurableStreamsClientTransport({
      allowInsecurePrivateHttp: true,
      authToken: durableAuthToken,
      baseUrl: durableBaseUrl,
      createIfMissing: true,
      ttlSeconds: DEFAULT_DURABLE_STREAM_TTL_SECONDS,
    }),
    enqueueRun: createSqsAgentRunQueueEnqueue({
      queueUrl: required(RUNTIME_API_ENV.queueUrl, env),
    }),
    endUserSubjects: endUserKeyDeriver(endUserSubjectKey),
    generateId: async () => idGenerator.generate(),
    organizationGate: makeOrganizationGateFromEnvironment({
      client: documentClient,
      database,
      environment: env,
    }),
    recordApiCredentialUsage: createApiCredentialUsageRecorder({ database }),
    sessionTokenSecret,
    streamGatewayBaseUrl: env[RUNTIME_API_ENV.streamGatewayBaseUrl]?.trim() ?? "",
    timerProvider: createEventBridgeTimerProvider({
      deadLetterArn: required(RUNTIME_API_ENV.automationFailureQueueArn, env),
      groupName: required(RUNTIME_API_ENV.schedulerGroup, env),
      heartbeatTargetArn: required(RUNTIME_API_ENV.heartbeatFireArn, env),
      roleArn: required(RUNTIME_API_ENV.schedulerRoleArn, env),
      scheduleTargetArn: required(RUNTIME_API_ENV.scheduleFireArn, env),
    }),
    webhookDeliveryQueue: createSqsWebhookDeliveryQueue(
      new SQSClient({}),
      required(WEBHOOK_DELIVERY_QUEUE_URL_ENV, env),
    ),
  };
}

let handlerPromise: Promise<ReturnType<typeof createRuntimeApiHandler>> | undefined;

export async function cachedRuntimeApiHandler(
  create: () => Promise<RuntimeApiDependencies> = createAwsRuntimeApiDependencies,
) {
  const pending = (handlerPromise ??= create().then(createRuntimeApiHandler));
  try {
    return await pending;
  } catch (cause) {
    if (handlerPromise === pending) handlerPromise = undefined;
    throw cause;
  }
}

export async function handler(event: Parameters<ReturnType<typeof createRuntimeApiHandler>>[0]) {
  return (await cachedRuntimeApiHandler())(event);
}
