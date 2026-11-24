import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  listDispatchableGovernanceOperations,
  listGovernedOrganizationIds,
  makeAppPersistence,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  makeIdGenerator,
  makeKmsIdempotencyResponseProtector,
  makeOrganizationHoldReader,
  tableNamesFromEnvironment,
  Ulid,
  type OrganizationHoldReader,
} from "@deployments-ai/db";
import {
  createGovernanceService,
  makeRetentionRestampRunner,
  GovernanceError,
  type GovernanceOperation,
  type GovernanceService,
} from "@deployments-ai/governance";
import {
  makeKmsGovernanceSigner,
  makeS3GovernanceObjectStore,
} from "@deployments-ai/governance/aws";
import {
  admitConsistently,
  type OrganizationActivity,
} from "@deployments-ai/organization-admission";
import { Schema } from "effect";
import { governanceAppPorts } from "./app-governance.ts";
import { backgroundWorkSuspended } from "./background-standing.ts";
import { appsRuntimeFromEnvironment, lambdaAppsDatabase } from "./apps-database-client.ts";
import { makeConversationErasurePorts } from "./conversation-erasure-ports.ts";
import { errorLogFields } from "./error-log-fields.ts";
import { optionalStringArray, requiredEnvironment } from "./lambda-environment.ts";
import { makeMemorySearchErasureInvoker } from "./memory-search-erasure.ts";
import { makeBrainSearchErasureInvoker } from "./brain/search-erasure.ts";
import { makeObservabilityErasureInvoker } from "./observability-erasure.ts";

const GovernanceOperationQueueMessage = Schema.Struct({
  operationId: Schema.String,
  organizationId: Schema.String,
});
const GovernanceRetentionQueueMessage = Schema.Struct({
  kind: Schema.Literals(["retention", "retention-restamp"]),
  organizationId: Schema.String,
});
const GovernanceQueueMessage = Schema.Union([
  GovernanceOperationQueueMessage,
  GovernanceRetentionQueueMessage,
]);
type RetentionRestampRunner = ReturnType<typeof makeRetentionRestampRunner>;

interface SqsRecord {
  readonly body: string;
  readonly messageId: string;
}

interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

interface RetentionSweepEvent {
  readonly kind: "retention-sweep";
}

interface OperationDispatchSweepEvent {
  readonly kind: "operation-dispatch-sweep";
}

const GOVERNANCE_WORKER_ENV = {
  agentEmailBucket: "DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET",
  legacyAgentEmailBuckets: "DEPLOYMENTS_AI_LEGACY_AGENT_EMAIL_BUCKETS_JSON",
  artifactBucket: "DEPLOYMENTS_AI_ARTIFACT_BUCKET",
  artifactKmsKeyArn: "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN",
  legacyArtifactBuckets: "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
  governanceBucket: "DEPLOYMENTS_AI_GOVERNANCE_BUCKET",
  legacyGovernanceBuckets: "DEPLOYMENTS_AI_LEGACY_GOVERNANCE_BUCKETS_JSON",
  governanceQueueUrl: "DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL",
  governanceSigningKeyArn: "DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN",
  idempotencyKmsKeyArn: "DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN",
  observabilityQuarantineBucket: "DEPLOYMENTS_AI_OBSERVABILITY_QUARANTINE_BUCKET",
} as const;

function createGovernanceWorkerRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const tables = tableNamesFromEnvironment(environment);
  const ids = makeIdGenerator();
  const agentEmailBucket = requiredEnvironment(environment, GOVERNANCE_WORKER_ENV.agentEmailBucket);
  const artifactBucket = requiredEnvironment(environment, GOVERNANCE_WORKER_ENV.artifactBucket);
  const legacyAgentEmailBucketNames = optionalStringArray(
    environment,
    GOVERNANCE_WORKER_ENV.legacyAgentEmailBuckets,
  );
  const legacyArtifactBucketNames = optionalStringArray(
    environment,
    GOVERNANCE_WORKER_ENV.legacyArtifactBuckets,
  );
  const governanceBucket = requiredEnvironment(environment, GOVERNANCE_WORKER_ENV.governanceBucket);
  const legacyGovernanceBucketNames = optionalStringArray(
    environment,
    GOVERNANCE_WORKER_ENV.legacyGovernanceBuckets,
  );
  const observabilityQuarantineBucket =
    environment[GOVERNANCE_WORKER_ENV.observabilityQuarantineBucket]?.trim() || undefined;
  const governanceQueueUrl = requiredEnvironment(
    environment,
    GOVERNANCE_WORKER_ENV.governanceQueueUrl,
  );
  const kms = new KMSClient({});
  const purgeObservability = makeObservabilityErasureInvoker(environment);
  const appsRuntime = appsRuntimeFromEnvironment(environment);
  const idempotencyResponseProtector = makeKmsIdempotencyResponseProtector({
    kmsClient: kms,
    kmsKeyArn: requiredEnvironment(environment, GOVERNANCE_WORKER_ENV.idempotencyKmsKeyArn),
  });
  const store = makeDynamoGovernanceStore(documentClient, tables, {
    idempotencyResponseProtector,
    requireTenantInventoryReady: true,
  });
  const service = createGovernanceService({
    allowedObjectBuckets: [
      agentEmailBucket,
      ...legacyAgentEmailBucketNames,
      artifactBucket,
      ...legacyArtifactBucketNames,
      governanceBucket,
      ...legacyGovernanceBucketNames,
      ...(observabilityQuarantineBucket ? [observabilityQuarantineBucket] : []),
      ...(appsRuntime ? [appsRuntime.bucket] : []),
    ],
    ...(appsRuntime
      ? governanceAppPorts({
          apps: makeAppPersistence({
            database: makeDynamoDatabase(documentClient, tables),
            generateId: ids.generate,
            now: () => new Date(),
          }),
          appsDatabase: lambdaAppsDatabase({
            client: new LambdaClient({}),
            functionName: appsRuntime.functionName,
          }),
          bucket: appsRuntime.bucket,
        })
      : {}),
    conversationErasure: makeConversationErasurePorts({ documentClient, environment, ids, tables }),
    generateId: async () => ids.generate(),
    objectStore: makeS3GovernanceObjectStore({
      bucket: governanceBucket,
      client: new S3Client({}),
      kmsKeyArn: requiredEnvironment(environment, GOVERNANCE_WORKER_ENV.artifactKmsKeyArn),
    }),
    purgeBrainSearch: makeBrainSearchErasureInvoker(environment),
    purgeMemorySearch: makeMemorySearchErasureInvoker(environment),
    ...(purgeObservability ? { purgeObservability } : {}),
    signer: makeKmsGovernanceSigner({
      client: kms,
      keyId: requiredEnvironment(environment, GOVERNANCE_WORKER_ENV.governanceSigningKeyArn),
      signingAlgorithm: "ECDSA_SHA_256",
    }),
    store,
    tenantErasureObjectPrefixes: [
      { bucket: agentEmailBucket, keyPrefixRoot: "organizations" },
      { bucket: agentEmailBucket, keyPrefixRoot: "raw/organizations" },
      ...legacyAgentEmailBucketNames.flatMap((bucket) => [
        { bucket, keyPrefixRoot: "organizations" },
        { bucket, keyPrefixRoot: "raw/organizations" },
      ]),
      { bucket: artifactBucket, keyPrefixRoot: "organizations" },
      ...legacyArtifactBucketNames.map((bucket) => ({ bucket, keyPrefixRoot: "organizations" })),
      ...(observabilityQuarantineBucket
        ? [
            {
              bucket: observabilityQuarantineBucket,
              keyPrefixRoot: "organizations",
            },
          ]
        : []),
    ],
  });
  return {
    documentClient,
    governanceQueueUrl,
    runRetentionRestamp: makeRetentionRestampRunner({ now: () => new Date(), store }),
    service,
    sqs: new SQSClient({}),
    standing: makeOrganizationHoldReader(makeDynamoDatabase(documentClient, tables)),
    tables,
  };
}

let runtime:
  | {
      readonly documentClient: DynamoDBDocumentClient;
      readonly governanceQueueUrl: string;
      readonly runRetentionRestamp: RetentionRestampRunner;
      readonly service: GovernanceService;
      readonly sqs: SQSClient;
      readonly standing: OrganizationHoldReader;
      readonly tables: ReturnType<typeof tableNamesFromEnvironment>;
    }
  | undefined;

function workerRuntime() {
  return (runtime ??= createGovernanceWorkerRuntime());
}

function isSqsEvent(
  event: OperationDispatchSweepEvent | RetentionSweepEvent | SqsEvent,
): event is SqsEvent {
  return "Records" in event;
}

export function governanceFailureMetric(
  functionName: string,
  failureType: string,
  timestamp = Date.now(),
) {
  return {
    _aws: {
      CloudWatchMetrics: [
        {
          Dimensions: [["FunctionName"]],
          Metrics: [{ Name: "OperationFailures", Unit: "Count" }],
          Namespace: "DeploymentsAI/Governance",
        },
      ],
      Timestamp: timestamp,
    },
    FailureType: failureType,
    FunctionName: functionName,
    OperationFailures: 1,
  };
}

function emitGovernanceFailure(cause: unknown) {
  process.stderr.write(
    `${JSON.stringify(
      governanceFailureMetric(
        process.env.AWS_LAMBDA_FUNCTION_NAME ?? "governance-worker",
        cause instanceof Error ? cause.name : "UnknownError",
      ),
    )}\n`,
  );
}

export function retentionQueueBatches(organizationIds: readonly string[]) {
  const batches: { Id: string; MessageBody: string }[][] = [];
  for (let offset = 0; offset < organizationIds.length; offset += 10) {
    batches.push(
      organizationIds.slice(offset, offset + 10).map((organizationId, index) => ({
        Id: String(offset + index),
        MessageBody: JSON.stringify({ kind: "retention", organizationId }),
      })),
    );
  }
  return batches;
}

export function operationQueueBatches(
  operations: readonly (
    | { readonly operationId: string; readonly organizationId: string }
    | { readonly kind: "retention-restamp"; readonly organizationId: string }
  )[],
) {
  const batches: { Id: string; MessageBody: string }[][] = [];
  for (let offset = 0; offset < operations.length; offset += 10) {
    batches.push(
      operations.slice(offset, offset + 10).map((operation, index) => ({
        Id: String(offset + index),
        MessageBody: JSON.stringify(operation),
      })),
    );
  }
  return batches;
}

/**
 * The standing each operation kind needs to run; `undefined` runs under any hold. A tenant erasure
 * needs what its route needs, so a hold placed after the request still stops it.
 */
const OPERATION_STANDING = {
  "audit-export": undefined,
  "end-user-erasure": undefined,
  "tenant-erasure": "api.erase",
  "tenant-export": undefined,
  "thread-erasure": undefined,
} as const satisfies Record<GovernanceOperation["kind"], OrganizationActivity | undefined>;

const decodeUlid = Schema.decodeUnknownSync(Ulid);

/**
 * Retention waits while the organization is suspended and runs at the next daily sweep after
 * release. An operation its standing refuses stays as it was, so the dispatch sweep sends it again
 * and it runs once the refusing hold is released. A retention TTL restamp only preserves records
 * longer, so it runs under any hold.
 */
export async function processGovernanceQueueMessage(
  service: GovernanceService,
  message: typeof GovernanceQueueMessage.Type,
  standing: OrganizationHoldReader,
  runRetentionRestamp: RetentionRestampRunner,
) {
  if ("kind" in message) {
    if (message.kind === "retention-restamp") {
      await runRetentionRestamp(message.organizationId);
      return;
    }
    if (await backgroundWorkSuspended(standing, message.organizationId)) return;
    await service.runRetention(message.organizationId);
    return;
  }
  const operation = await service.getOperation(message.organizationId, message.operationId);
  const activity = operation && OPERATION_STANDING[operation.kind];
  if (activity) {
    const { decision } = await admitConsistently({
      activity,
      organizationId: decodeUlid(message.organizationId),
      standing,
    });
    if (decision.kind === "suspended") return;
  }
  try {
    await service.runOperation(message.organizationId, message.operationId);
  } catch (cause) {
    if (cause instanceof GovernanceError && cause.code === "operation_not_runnable") {
      return;
    }
    if (
      cause instanceof GovernanceError &&
      cause.code === "operation_not_found" &&
      !(await service.organizationExists(message.organizationId))
    ) {
      return;
    }
    throw cause;
  }
}

export async function processGovernanceQueueRecords(
  service: GovernanceService,
  records: readonly SqsRecord[],
  standing: OrganizationHoldReader,
  runRetentionRestamp: RetentionRestampRunner,
) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    let message: typeof GovernanceQueueMessage.Type | undefined;
    try {
      message = Schema.decodeUnknownSync(GovernanceQueueMessage, {
        onExcessProperty: "error",
      })(JSON.parse(record.body));
      await processGovernanceQueueMessage(service, message, standing, runRetentionRestamp);
    } catch (cause) {
      emitGovernanceFailure(cause);
      console.error("Governance queue message failed.", {
        ...errorLogFields(cause),
        ...message,
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export async function handler(event: OperationDispatchSweepEvent | RetentionSweepEvent | SqsEvent) {
  const current = workerRuntime();
  if (!isSqsEvent(event)) {
    const dispatchSweep = event.kind === "operation-dispatch-sweep";
    const operations = dispatchSweep
      ? await listDispatchableGovernanceOperations(current.documentClient, current.tables)
      : [];
    const organizations = dispatchSweep
      ? []
      : await listGovernedOrganizationIds(current.documentClient, current.tables);
    const batches = dispatchSweep
      ? operationQueueBatches(operations)
      : retentionQueueBatches(organizations);
    for (const entries of batches) {
      const sent = await current.sqs.send(
        new SendMessageBatchCommand({
          Entries: entries,
          QueueUrl: current.governanceQueueUrl,
        }),
      );
      if (sent.Failed && sent.Failed.length > 0) {
        throw new Error(
          dispatchSweep
            ? "Failed to enqueue every pending governance operation."
            : "Failed to enqueue every organization retention job.",
        );
      }
    }
    return dispatchSweep
      ? { operationsEnqueued: operations.length }
      : { organizationsEnqueued: organizations.length };
  }

  return processGovernanceQueueRecords(
    current.service,
    event.Records,
    current.standing,
    current.runRetentionRestamp,
  );
}
