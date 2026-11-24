import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  composeManifestAdmission,
  DatabaseError,
  makeDynamoDatabase,
  makeIdGenerator,
  makeManifestModelAdmission,
  makeModelIdAdmission,
  PersistenceError,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import {
  lambdaModelTokenIssuer,
  makeModelGateway,
  modelGatewayRouteDefaultsFromEnv,
  modelGatewayServiceCredentials,
  parseModelOperatorGrantsJson,
  type ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { makeManifestToolBoundaryAdmission } from "@deployments-ai/tools";
import { parseEvaluationQueueMessage } from "@deployments-ai/observability/evaluators";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { createHash } from "node:crypto";
import { parseLegacyArtifactBuckets } from "./artifact-buckets.ts";
import { makeEvaluationExecutionPort } from "./evaluation-execution.ts";
import { makeGatewayJudgePort } from "./evaluation-judge.ts";
import {
  createSqsEvaluationQueueSender,
  type EvaluationJudgeTenant,
  type EvaluationArtifactReader,
  type EvaluationArtifactWriter,
  type EvaluationWorkerDependencies,
} from "./evaluation-ports.ts";
import { processEvaluationMessage } from "./evaluation-processor.ts";
import { MAX_EVALUATION_OUTPUT_BYTES } from "./evaluation-scoring.ts";
import { createS3MessageBodyReader, readBoundedS3BodyBytes } from "./s3.ts";

const EVALUATION_WORKER_ENV = {
  agentRunQueueUrl: "DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL",
  artifactBucket: "DEPLOYMENTS_AI_ARTIFACT_BUCKET",
  artifactKmsKeyArn: "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN",
  evaluationQueueUrl: "DEPLOYMENTS_AI_EVALUATION_QUEUE_URL",
  legacyArtifactBuckets: "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
  modelGatewayBaseUrl: "DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL",
  modelGatewayTokenIssuer: "DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER",
  modelGrantsParameterArn: "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN",
} as const;

/** Case material objects are small canonical JSON documents. */
const MAX_CASE_MATERIAL_BYTES = 1_048_576;
/** Judge gateways are kept per tenant environment so their tokens are reused across scores. */
const MAX_JUDGE_GATEWAYS = 64;

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** Artifact bucket access: bounded case-material and message-body reads, SSE-KMS report writes. */
function createS3EvaluationArtifacts(options: {
  readonly bucket: string;
  readonly kmsKeyArn: string;
  readonly legacyBuckets?: readonly string[];
  readonly client?: Pick<S3Client, "send">;
}): EvaluationArtifactReader & EvaluationArtifactWriter {
  const client = options.client ?? new S3Client({});
  const readMessageBody = createS3MessageBodyReader({
    bucket: options.bucket,
    client,
    maxBodyBytes: MAX_EVALUATION_OUTPUT_BYTES,
    ...(options.legacyBuckets ? { legacyBuckets: options.legacyBuckets } : {}),
  });
  return {
    async putReport(input) {
      const bytes = new TextEncoder().encode(input.body);
      const digest = createHash("sha256").update(bytes);
      const sha256 = digest.copy().digest("hex");
      const response = await client.send(
        new PutObjectCommand({
          Body: bytes,
          Bucket: options.bucket,
          ChecksumSHA256: digest.digest("base64"),
          ContentLength: bytes.byteLength,
          ContentType: input.contentType,
          Key: input.key,
          SSEKMSKeyId: options.kmsKeyArn,
          ServerSideEncryption: "aws:kms",
        }),
      );
      return {
        bucket: options.bucket,
        byteSize: bytes.byteLength,
        contentType: input.contentType,
        key: input.key,
        sha256,
        ...(response.ETag ? { etag: response.ETag } : {}),
        ...(response.VersionId ? { versionId: response.VersionId } : {}),
      };
    },

    async readCaseMaterial(reference) {
      if (reference.bucket !== options.bucket) {
        throw new Error("Dataset case material references an unexpected bucket.");
      }
      if (
        !Number.isSafeInteger(reference.byteSize) ||
        reference.byteSize < 0 ||
        reference.byteSize > MAX_CASE_MATERIAL_BYTES
      ) {
        throw new Error("Dataset case material size is out of bounds.");
      }
      const response = await client.send(
        new GetObjectCommand({
          Bucket: reference.bucket,
          Key: reference.key,
          ...(reference.versionId ? { VersionId: reference.versionId } : {}),
        }),
      );
      return readBoundedS3BodyBytes(response.Body, reference.byteSize, response.ContentLength);
    },

    readMessageBody: (message) => readMessageBody(message),
  };
}

async function createEvaluationWorkerDependencies(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EvaluationWorkerDependencies> {
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(env),
  );
  const modelGrantsParameterArn = env[EVALUATION_WORKER_ENV.modelGrantsParameterArn]?.trim();
  const loadModelOperatorGrants = async () =>
    modelGrantsParameterArn
      ? parseModelOperatorGrantsJson(await loadAwsSecretString(modelGrantsParameterArn))
      : [];
  const baseUrl = requiredEnv(env, EVALUATION_WORKER_ENV.modelGatewayBaseUrl);
  const issue = lambdaModelTokenIssuer(
    new LambdaClient({}),
    requiredEnv(env, EVALUATION_WORKER_ENV.modelGatewayTokenIssuer),
  );
  const routeDefaults = modelGatewayRouteDefaultsFromEnv(env);
  // The evaluations issuer admits tenant judge models against the evaluated environment's policy
  // and operator grants, so each judge token carries that environment.
  const judgeGateways = new Map<string, ModelGatewayService>();
  const loadJudgeGateway = async (tenant: EvaluationJudgeTenant) => {
    const key = `${tenant.organizationId}/${tenant.projectId}/${tenant.environmentId}`;
    let gateway = judgeGateways.get(key);
    if (!gateway) {
      gateway = makeModelGateway({
        baseUrl,
        credentials: modelGatewayServiceCredentials({
          context: () => ({
            environmentId: tenant.environmentId,
            organizationId: tenant.organizationId,
            projectId: tenant.projectId,
          }),
          issue,
        }),
        ...routeDefaults,
      });
      if (judgeGateways.size >= MAX_JUDGE_GATEWAYS) judgeGateways.clear();
      judgeGateways.set(key, gateway);
    }
    return gateway;
  };
  const idGenerator = makeIdGenerator();
  const legacyBuckets = parseLegacyArtifactBuckets(
    env[EVALUATION_WORKER_ENV.legacyArtifactBuckets],
    EVALUATION_WORKER_ENV.legacyArtifactBuckets,
  );
  return {
    admitJudgeModel: makeModelIdAdmission(database, loadModelOperatorGrants),
    artifacts: createS3EvaluationArtifacts({
      bucket: requiredEnv(env, EVALUATION_WORKER_ENV.artifactBucket),
      kmsKeyArn: requiredEnv(env, EVALUATION_WORKER_ENV.artifactKmsKeyArn),
      legacyBuckets,
    }),
    database,
    execution: makeEvaluationExecutionPort({
      admitManifest: composeManifestAdmission(
        makeManifestModelAdmission(database, loadModelOperatorGrants),
        makeManifestToolBoundaryAdmission({ database }),
      ),
      agentRunQueueUrl: requiredEnv(env, EVALUATION_WORKER_ENV.agentRunQueueUrl),
      database,
    }),
    generateId: async () => idGenerator.generate(),
    judgeFor: (context) => makeGatewayJudgePort(loadJudgeGateway, context),
    now: () => new Date(),
    queue: createSqsEvaluationQueueSender({
      queueUrl: requiredEnv(env, EVALUATION_WORKER_ENV.evaluationQueueUrl),
    }),
  };
}

interface EvaluationQueueRecord {
  readonly messageId: string;
  readonly body: string;
}

/**
 * Diagnostic fields for a failed queue message: error class plus persistence/database metadata.
 * Messages of record-decode failures and of other errors can echo record or payload content, so
 * they are never logged.
 */
export function evaluationFailureLogFields(cause: unknown): Readonly<Record<string, string>> {
  if (cause instanceof PersistenceError) {
    return {
      code: cause.code,
      error: cause.name,
      kind: cause.kind,
      ...(cause.code === "invalid_evaluation_record" ? {} : { message: cause.message }),
    };
  }
  if (cause instanceof DatabaseError) {
    return {
      error: cause.name,
      operation: cause.operation,
      table: cause.table,
      ...(cause.reason ? { reason: cause.reason } : {}),
      ...(cause.cause instanceof Error ? { causeName: cause.cause.name } : {}),
    };
  }
  return { error: cause instanceof Error ? cause.name : "UnknownError" };
}

export interface EvaluationQueueEvent {
  readonly Records?: readonly EvaluationQueueRecord[];
}

/**
 * Processes a FIFO batch in order. After the first failure, every later record is reported as
 * failed too, so SQS redelivers them in order (and eventually dead-letters a poison message).
 * Known terminal outcomes are written to records by the handlers and never thrown.
 */
export async function handleEvaluationQueueEvent(
  event: EvaluationQueueEvent,
  dependencies: EvaluationWorkerDependencies,
) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    if (failures.length > 0) {
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await processEvaluationMessage(dependencies, parseEvaluationQueueMessage(record.body));
    } catch (cause) {
      console.error("Evaluation queue message failed.", {
        ...evaluationFailureLogFields(cause),
        messageId: record.messageId,
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

let dependencies: Promise<EvaluationWorkerDependencies> | undefined;

export async function handler(event: EvaluationQueueEvent) {
  const pending = (dependencies ??= createEvaluationWorkerDependencies());
  try {
    return await handleEvaluationQueueEvent(event, await pending);
  } catch (cause) {
    if (dependencies === pending) dependencies = undefined;
    throw cause;
  }
}
