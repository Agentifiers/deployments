import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { modelGatewayGenerationPort } from "@deployments-ai/agent-runtime";
import {
  makeBrainSearchProviderRegistry,
  makePlatformBrainQueryRuntime,
} from "@deployments-ai/brain-runtime";
import { createEventBridgeTimerProvider, type TimerProvider } from "@deployments-ai/automations";
import {
  readBrowserScreenshotConfigFromEnv,
  type BrowserScreenshotConfig,
} from "@deployments-ai/browser-screenshot";
import {
  makeCredentialVault,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  makeIdGenerator,
  makeOrganizationCapacity,
  makeOrganizationDataBoundaryReader,
  makeOrganizationEgressAllowlistReader,
  makeSandboxWorkspacePersistence,
  makeStandingTenantLimitResolver,
  parseBrainUploadQuotas,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import {
  lambdaModelTokenIssuer,
  makeModelGateway,
  modelGatewayRouteDefaultsFromEnv,
  parseModelOperatorGrantsJson,
  type ModelGatewayCredentials,
} from "@deployments-ai/model-gateway";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { runtimeMemoryPlatform } from "@deployments-ai/memory-runtime";
import type { BrainMemoryProvenance } from "@deployments-ai/memory";
import { createRemoteMcpClient } from "@deployments-ai/mcp-client";
import {
  createSandboxProviderFromEnv,
  makeSandboxManager,
  resolveSandboxProviderConfigFromEnv,
  resolveSandboxUsageCostPolicyFromEnv,
  type SandboxProvider,
} from "@deployments-ai/sandbox-hosts";
import {
  FIRECRAWL_ENV_KEYS,
  readSelfHostedWebToolsConfig,
  type SelfHostedWebToolsConfig,
} from "@deployments-ai/web-tools";
import {
  DEFAULT_DURABLE_STREAM_TTL_SECONDS,
  appendThreadStreamEvents,
  createDurableStreamsClientTransport,
} from "@deployments-ai/streaming";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import { Effect } from "effect";
import { failureChain } from "./failure-log.ts";
import { createTenantLimitMetrics } from "./tenant-limit-metrics.ts";
import {
  createS3RuntimeArtifactLoader,
  createS3RuntimeArtifactPublicationRetrier,
  createS3RuntimeArtifactRecorder,
} from "./artifacts.ts";
import { createS3RunInputArtifactLoader } from "./input-artifacts.ts";
import { createDynamoRuntimeProviderMutationClaimStore } from "./provider-mutation-claims.ts";
import { createCallbackWorkspaceFileReader } from "./callback-workspace-files.ts";
import { createDynamoRuntimeToolResolvers } from "./dynamodb-runtime-tools.ts";
import { createDynamoExtensionToolResolver } from "./dynamodb-extension-tools.ts";
import { createDynamoRuntimeMcp } from "./dynamodb-runtime-mcp.ts";
import { createDynamoRuntimeVendorMcp } from "./dynamodb-runtime-vendor-mcp.ts";
import { appBuiltinOptions } from "./app-runtime-ports.ts";
import { createLambdaOAuthRefreshInvoker } from "./oauth-refresh-runtime.ts";
import { createRuntimeToolService } from "./runtime-tools.ts";
import { createRuntimeHttpCallbackDispatchPersistence } from "./runtime-http-callback-dispatch.ts";
import { createRuntimeMemoryRecall } from "./memory-runtime.ts";
import { createRuntimePlatformBuiltinExecutors } from "./platform-builtin-executors.ts";
import { createBrainPublicationPreparer } from "./brain/publication.ts";
import { createBrainDocumentEvidenceLoader } from "./brain/document-evidence-loader.ts";
import {
  authorizeRuntimeBrainProvenance,
  createRuntimeBrainRecall,
} from "./brain/active-recall.ts";
import { createRuntimeArtifactHandoffProviderInputPreparer } from "./artifact-handoff-provider-input.ts";
import {
  createS3MessageBodyDeleter,
  createS3MessageBodyReader,
  createS3MessageBodyWriter,
} from "./s3.ts";
import {
  createSqsAgentRunQueueEnqueue,
  createSqsQueueRetry,
  createSqsQueueVisibilityExtension,
} from "./sqs.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";
import { parseLegacyArtifactBuckets } from "./artifact-buckets.ts";
import { createClientToolExpirationScheduler } from "./client-tool-expiration.ts";
import { teamsConnectorClient } from "@deployments-ai/channel-adapters/teams";
import { slackAgentStreamClient } from "./slack-agent-stream.ts";
import { createS3ThreadSandboxSnapshotStore } from "./thread-sandbox/snapshot-store.ts";
import { makeThreadSandboxWorkspace } from "./thread-sandbox/workspace.ts";
import { sandboxLeaseLimit } from "./sandbox-lease-limit.ts";
import { createHostedCodeSecretReader } from "./hosted-code/secrets.ts";
import { createS3BrainContentUploader } from "./brain/content-upload.ts";
import { createCompletedRunMemoryFlushEnqueuer } from "./completed-run-memory-flush.ts";
import {
  agentRunModelGatewayCredentials,
  inRunBrainModelCredentials,
  makeAgentRunModelTokenRegistry,
} from "./agent-run-model-tokens.ts";
import { makeRuntimeRunLogRegistry } from "./runtime-log-emitter.ts";
import {
  agentWorkerProcessId,
  brainSearchProviderConfigFromEnv,
  positiveInteger,
  requiredEnv,
  runtimeToolAvailable,
  secretString,
  WORKER_ENV,
} from "./worker-env.ts";
import { createWorkerCredentialReaders } from "./worker-credential-readers.ts";

export interface AgentRunWorkerRuntimeOptions {
  readonly browserConfig?: BrowserScreenshotConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly loadMemoryPlatform?: typeof runtimeMemoryPlatform;
  readonly sandboxProvider?: SandboxProvider;
  readonly secretsManager?: SecretsManagerClient;
  readonly timerProvider?: TimerProvider;
  readonly webConfig?: SelfHostedWebToolsConfig;
}

export async function createAgentRunWorkerDependencies(
  options: AgentRunWorkerRuntimeOptions = {},
): Promise<AgentRunWorkerDependencies> {
  const env = options.env ?? process.env;
  const dynamoClient = new DynamoDBClient({});
  const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const database = makeDynamoDatabase(documentClient, tableNamesFromEnvironment(env));
  const tenantLimits = makeStandingTenantLimitResolver({
    database,
    installDefaults: parseInstallDefaultEntitlements(env),
    onLoadError: (organizationId, cause) =>
      console.warn("Organization limits could not be loaded; enforcing cached or default limits.", {
        failure: failureChain(cause),
        organizationId,
      }),
    ttlMs: 30_000,
  });
  const tenantLimitMetrics = createTenantLimitMetrics({ client: new CloudWatchClient({}) });
  const secretsManager = options.secretsManager ?? new SecretsManagerClient({});
  const firecrawlApiKeySecretArn = env[WORKER_ENV.firecrawlApiKeySecretArn]?.trim();
  const firecrawlJobTicketSecretArn = env[WORKER_ENV.firecrawlJobTicketSecretArn]?.trim();
  const modelGrantsParameterArn = env[WORKER_ENV.modelGrantsParameterArn]?.trim();
  const durableStreamsAuthToken = await secretString(
    secretsManager,
    requiredEnv(WORKER_ENV.durableStreamsAuthSecretArn, env),
    "Durable Streams auth token",
  );
  const idGenerator = makeIdGenerator();
  const generateId = async () => idGenerator.generate();
  const queueUrl = requiredEnv(WORKER_ENV.queueUrl, env);
  const visibilityTimeoutSeconds = positiveInteger(
    requiredEnv(WORKER_ENV.queueVisibilitySeconds, env),
    WORKER_ENV.queueVisibilitySeconds,
  );
  const artifactBucket = requiredEnv(WORKER_ENV.artifactBucket, env);
  const legacyArtifactBuckets = parseLegacyArtifactBuckets(
    env[WORKER_ENV.legacyArtifactBuckets],
    WORKER_ENV.legacyArtifactBuckets,
  );
  const artifactKmsKeyArn = requiredEnv(WORKER_ENV.artifactKmsKeyArn, env);
  const artifactS3 = new S3Client({});
  const enqueueRun = createSqsAgentRunQueueEnqueue({ queueUrl });
  const credentialVault = makeCredentialVault({
    documentClient,
    kmsClient: new KMSClient({}),
    kmsKeyArn: requiredEnv(WORKER_ENV.credentialKmsKeyArn, env),
    tableName: tableNamesFromEnvironment(env).control,
  });
  const lambdaClient = new LambdaClient({});
  const oauthRefreshFunctionName = env[WORKER_ENV.oauthRefreshFunctionName]?.trim();
  const refreshConnection = oauthRefreshFunctionName
    ? createLambdaOAuthRefreshInvoker({
        client: lambdaClient,
        functionName: oauthRefreshFunctionName,
      })
    : undefined;
  const {
    readChannelCredential,
    readMcpServerCredential,
    readProviderConnectionCredential,
    readToolAdapterCredential,
  } = createWorkerCredentialReaders({ credentialVault, database, generateId });
  const toolResolvers = createDynamoRuntimeToolResolvers({
    database,
    readCredential: readProviderConnectionCredential,
    ...(refreshConnection ? { refreshConnection } : {}),
  });
  const mcpTimeoutMs = env[WORKER_ENV.mcpRequestTimeoutMs]?.trim()
    ? positiveInteger(env[WORKER_ENV.mcpRequestTimeoutMs]!.trim(), WORKER_ENV.mcpRequestTimeoutMs)
    : undefined;
  const mcpClient = createRemoteMcpClient();
  const runtimeVendorMcp = createDynamoRuntimeVendorMcp({
    client: mcpClient,
    database,
    readCredential: readProviderConnectionCredential,
    ...(refreshConnection ? { refreshConnection } : {}),
    ...(mcpTimeoutMs ? { timeoutMs: mcpTimeoutMs } : {}),
  });
  const runtimeMcp = createDynamoRuntimeMcp({
    client: mcpClient,
    database,
    readCredential: readMcpServerCredential,
    ...(mcpTimeoutMs ? { timeoutMs: mcpTimeoutMs } : {}),
  });
  const loadMemoryPlatform = options.loadMemoryPlatform ?? runtimeMemoryPlatform;
  const enqueueMemoryFlush = createCompletedRunMemoryFlushEnqueuer(loadMemoryPlatform);
  const runModelTokens = makeAgentRunModelTokenRegistry();
  const runtimeLogs = makeRuntimeRunLogRegistry();
  const modelGatewayBaseUrl = requiredEnv(WORKER_ENV.modelGatewayBaseUrl, env);
  const routeDefaults = modelGatewayRouteDefaultsFromEnv(env);
  const gatewayWith = (credentials: ModelGatewayCredentials) =>
    makeModelGateway({ baseUrl: modelGatewayBaseUrl, credentials, ...routeDefaults });
  // Agent generations authenticate with run tokens for the claim this worker holds; a run's brain
  // queries use the worker's service token bound to that same claim.
  const runGateway = gatewayWith(
    agentRunModelGatewayCredentials({
      issue: lambdaModelTokenIssuer(
        lambdaClient,
        requiredEnv(WORKER_ENV.modelGatewayRunTokenIssuer, env),
      ),
      registry: runModelTokens,
    }),
  );
  const brainCredentials = inRunBrainModelCredentials({
    issue: lambdaModelTokenIssuer(
      lambdaClient,
      requiredEnv(WORKER_ENV.modelGatewayTokenIssuer, env),
    ),
    registry: runModelTokens,
  });
  const durableTransport = createDurableStreamsClientTransport({
    allowInsecurePrivateHttp: true,
    authToken: durableStreamsAuthToken,
    baseUrl: requiredEnv(WORKER_ENV.durableStreamsBaseUrl, env),
    createIfMissing: true,
    ttlSeconds: DEFAULT_DURABLE_STREAM_TTL_SECONDS,
  });
  const workerId = agentWorkerProcessId(env);
  const appendThreadEvent: NonNullable<AgentRunWorkerDependencies["appendThreadEvent"]> = async (
    event,
    signal,
  ) => {
    await appendThreadStreamEvents({
      events: [event],
      producerId: workerId,
      producerType: "worker",
      ...(signal ? { signal } : {}),
      scope: event,
      transport: durableTransport,
    });
  };
  const loadBrowserConfig = () => {
    if (options.browserConfig) return options.browserConfig;
    try {
      return Effect.runSync(readBrowserScreenshotConfigFromEnv(env));
    } catch (cause) {
      throw new TypeError("Browser screenshot runtime is not configured.", { cause });
    }
  };
  let webConfigPromise: Promise<SelfHostedWebToolsConfig> | undefined;
  const loadWebConfig = async () => {
    if (options.webConfig) return options.webConfig;
    if (!webConfigPromise) {
      webConfigPromise = Promise.all([
        firecrawlApiKeySecretArn
          ? secretString(secretsManager, firecrawlApiKeySecretArn, "Firecrawl API key")
          : Promise.resolve(undefined),
        firecrawlJobTicketSecretArn
          ? secretString(secretsManager, firecrawlJobTicketSecretArn, "Firecrawl job-ticket secret")
          : Promise.resolve(undefined),
      ])
        .then(([firecrawlApiKey, firecrawlJobTicketSecret]) =>
          readSelfHostedWebToolsConfig({
            ...env,
            ...(firecrawlApiKey ? { [FIRECRAWL_ENV_KEYS.apiKey[0]]: firecrawlApiKey } : {}),
            ...(firecrawlJobTicketSecret
              ? { [FIRECRAWL_ENV_KEYS.jobTicketSecret[0]]: firecrawlJobTicketSecret }
              : {}),
          }),
        )
        .catch((cause: unknown) => {
          webConfigPromise = undefined;
          throw new TypeError("Self-hosted web tools are not configured.", { cause });
        });
    }
    return webConfigPromise;
  };
  const timerProvider =
    options.timerProvider ??
    createEventBridgeTimerProvider({
      deadLetterArn: requiredEnv(WORKER_ENV.automationFailureQueueArn, env),
      groupName: requiredEnv(WORKER_ENV.schedulerGroup, env),
      heartbeatTargetArn: requiredEnv(WORKER_ENV.heartbeatFireArn, env),
      roleArn: requiredEnv(WORKER_ENV.schedulerRoleArn, env),
      scheduleTargetArn: requiredEnv(WORKER_ENV.scheduleFireArn, env),
    });
  const brainRepository = makeBrainDynamoRepository(database, parseBrainUploadQuotas(env));
  const brainProviders = makeBrainSearchProviderRegistry({
    config: brainSearchProviderConfigFromEnv(env),
    database,
  });
  const brainQueryRuntime = async (runId: string) =>
    makePlatformBrainQueryRuntime({
      ...(env[WORKER_ENV.brainAnswerModel]?.trim()
        ? { answerModelId: env[WORKER_ENV.brainAnswerModel]!.trim() }
        : {}),
      contentBucket: artifactBucket,
      legacyContentBuckets: legacyArtifactBuckets,
      database,
      gateway: async () => gatewayWith(brainCredentials(runId)),
      providers: brainProviders,
      repository: brainRepository,
      s3: artifactS3,
    });
  const brainRecall = createRuntimeBrainRecall({
    database,
    loadQueryRuntime: brainQueryRuntime,
    repository: brainRepository,
  });
  const brainProvenanceEvidence = (provenance: BrainMemoryProvenance) =>
    provenance.map((citation) => ({
      ...citation,
      coordinates: citation.coordinates ?? { end: 0, kind: "utf8-byte" as const, start: 0 },
      excerpt: "",
      score: 1,
      sensitivity: "internal" as const,
    }));
  const loadBrainDocumentEvidence = createBrainDocumentEvidenceLoader({
    bucket: artifactBucket,
    legacyBuckets: legacyArtifactBuckets,
    repository: brainRepository,
    s3: artifactS3,
  });
  const recordArtifact = createS3RuntimeArtifactRecorder({
    appendThreadEvent,
    bucket: artifactBucket,
    client: artifactS3,
    database,
    kmsKeyId: artifactKmsKeyArn,
  });
  const sandboxProvider = options.sandboxProvider ?? createSandboxProviderFromEnv(env);
  const sandboxControlPort = resolveSandboxProviderConfigFromEnv(env).lambdaMicrovm?.controlPort;
  const sandboxManager = makeSandboxManager(sandboxProvider, database, idGenerator, {
    costPolicy: resolveSandboxUsageCostPolicyFromEnv(env),
    onSandboxCapacityRejected: ({ requestingRunId, ...rejection }) =>
      tenantLimitMetrics.record({
        metric: "SandboxCapacityRejected",
        ...rejection,
        ...(requestingRunId ? { runId: requestingRunId } : {}),
      }),
    onStaleCapacityRecovered: ({ requestingRunId, ...recovery }) =>
      tenantLimitMetrics.record({
        metric: "StaleCapacityRecovered",
        ...recovery,
        ...(requestingRunId ? { runId: requestingRunId } : {}),
      }),
    organizationSandboxLimit: sandboxLeaseLimit(
      database,
      async (organizationId) => (await tenantLimits.limitsFor(organizationId)).activeSandboxes,
    ),
  });
  const threadSandbox = makeThreadSandboxWorkspace({
    generateId,
    manager: sandboxManager,
    persistence: makeSandboxWorkspacePersistence(database),
    providerName: sandboxProvider.name,
    snapshots: createS3ThreadSandboxSnapshotStore({
      bucket: artifactBucket,
      client: artifactS3,
      kmsKeyId: artifactKmsKeyArn,
    }),
  });
  const dataBoundaries = makeOrganizationDataBoundaryReader(database);
  const builtinExecutors = createRuntimePlatformBuiltinExecutors({
    appendThreadEvent,
    ...appBuiltinOptions(env, { database, generateId: idGenerator.generate, s3: artifactS3 }),
    artifactBucket,
    artifactKmsKeyId: artifactKmsKeyArn,
    legacyArtifactBuckets,
    artifactS3,
    authorizeDerivedBrainMemory: async ({ brainProvenance, request }) =>
      authorizeRuntimeBrainProvenance({
        citations: brainProvenance,
        database,
        repository: brainRepository,
        request,
      }),
    database,
    dataBoundaries,
    enqueueRun,
    generateId,
    loadMemoryPlatform,
    loadBrainDocumentEvidence,
    loadBrowserConfig,
    loadWebConfig,
    readHostedCodeSecrets: createHostedCodeSecretReader({ credentialVault, database, generateId }),
    runtimeLogs,
    sandboxManager,
    sandboxProviderName: sandboxProvider.name,
    ...(sandboxControlPort === undefined ? {} : { sandboxControlPort }),
    threadSandbox,
    brainRepository,
    loadBrainQueryRuntime: brainQueryRuntime,
    uploadBrainContent: createS3BrainContentUploader({
      artifactBucket,
      artifactKmsKeyArn,
      artifactS3,
    }),
    timerProvider,
  });
  const runtimeTools = createRuntimeToolService({
    builtinExecutors,
    dataBoundaries,
    egressAllowlists: makeOrganizationEgressAllowlistReader(database),
    generateId,
    isToolAvailable: (toolName) => runtimeToolAvailable(env, toolName),
    mutationClaims: createDynamoRuntimeProviderMutationClaimStore(database),
    readCallbackWorkspaceFiles: createCallbackWorkspaceFileReader({
      manager: sandboxManager,
      threadSandbox,
    }),
    persistHttpCallbackDispatch: createRuntimeHttpCallbackDispatchPersistence({
      database,
      generateId,
    }),
    prepareProviderInput: createRuntimeArtifactHandoffProviderInputPreparer({
      artifactBucket,
      artifactS3,
      database,
      generateId,
      legacyArtifactBuckets,
    }),
    resolveExtensionToolDefinition: createDynamoExtensionToolResolver(database, {
      readCredential: readToolAdapterCredential,
    }),
    ...runtimeMcp,
    ...runtimeVendorMcp,
    ...toolResolvers,
  });

  return {
    appendThreadEvent,
    createExecutionInputArtifactLoader: () =>
      createS3RunInputArtifactLoader({
        bucket: artifactBucket,
        client: artifactS3,
        database,
        legacyBuckets: legacyArtifactBuckets,
      }),
    database,
    deleteMessageBody: createS3MessageBodyDeleter({
      bucket: artifactBucket,
      legacyBuckets: legacyArtifactBuckets,
    }),
    enqueueMemoryFlush,
    enqueueRun,
    extendQueueVisibility: createSqsQueueVisibilityExtension({
      queueUrl,
      visibilityTimeoutSeconds,
    }),
    generateId,
    loadModelOperatorGrants: async () =>
      modelGrantsParameterArn
        ? parseModelOperatorGrantsJson(await loadAwsSecretString(modelGrantsParameterArn))
        : [],
    organizationCapacity: makeOrganizationCapacity(database),
    queueMaxReceiveCount: positiveInteger(
      requiredEnv(WORKER_ENV.queueMaxReceiveCount, env),
      WORKER_ENV.queueMaxReceiveCount,
    ),
    prepareBrainPublication: createBrainPublicationPreparer({
      database,
      recordArtifact,
      repository: brainRepository,
    }),
    readChannelCredential,
    readMessageBody: createS3MessageBodyReader({
      bucket: artifactBucket,
      legacyBuckets: legacyArtifactBuckets,
    }),
    retryQueueMessage: createSqsQueueRetry({ queueUrl }),
    scheduleClientToolExpiration: createClientToolExpirationScheduler({ env }),
    runModelTokens,
    runtimeLogs,
    runtime: {
      generateAssistantMessage: modelGatewayGenerationPort(async () => runGateway),
      loadArtifact: createS3RuntimeArtifactLoader({
        bucket: artifactBucket,
        database,
        legacyBuckets: legacyArtifactBuckets,
      }),
      recallBrain: brainRecall.recall,
      recallMemory: createRuntimeMemoryRecall(
        loadMemoryPlatform,
        async ({ brainProvenance, request }) =>
          (
            await brainRecall.revalidate({
              ...request,
              evidence: brainProvenanceEvidence(brainProvenance),
            })
          ).length === brainProvenance.length,
      ),
      recordArtifact,
      retryArtifactPublication: createS3RuntimeArtifactPublicationRetrier({
        appendThreadEvent,
        database,
      }),
      revalidateBrainEvidence: brainRecall.revalidate,
      sandboxProvider,
      ...runtimeTools,
    },
    slackAgentStream: slackAgentStreamClient,
    teamsAgentStream: teamsConnectorClient(),
    threadSandbox,
    tenantLimitMetrics,
    tenantLimits,
    workerId,
    writeMessageBody: createS3MessageBodyWriter({
      bucket: artifactBucket,
      kmsKeyId: artifactKmsKeyArn,
    }),
  };
}

let dependenciesPromise: Promise<AgentRunWorkerDependencies> | undefined;

export async function cachedAgentRunWorkerDependencies(
  create: () => Promise<AgentRunWorkerDependencies> = createAgentRunWorkerDependencies,
) {
  const pending = (dependenciesPromise ??= create());
  try {
    return await pending;
  } catch (cause) {
    if (dependenciesPromise === pending) dependenciesPromise = undefined;
    throw cause;
  }
}
