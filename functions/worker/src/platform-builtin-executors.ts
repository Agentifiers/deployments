import type { S3Client } from "@aws-sdk/client-s3";
import type { TimerProvider } from "@deployments-ai/automations";
import type { ConversationQueueEnqueue } from "@deployments-ai/conversations";
import {
  makeBrainDynamoRepository,
  type DynamoDatabaseService,
  type OrganizationDataBoundaryReader,
  type Ulid,
} from "@deployments-ai/db";
import type { MemoryPlatform } from "@deployments-ai/memory";
import type {
  Brain,
  BrainBlobReference,
  BrainQueryRuntime,
  BrainRepository,
} from "@deployments-ai/brains";
import type { ThreadStreamEvent } from "@deployments-ai/streaming";
import type { BrowserScreenshotConfig } from "@deployments-ai/browser-screenshot";
import type { SelfHostedWebToolsConfig } from "@deployments-ai/web-tools";
import type { SandboxManagerService, SandboxProviderName } from "@deployments-ai/sandbox-hosts";
import { platformToolAdapterDefinitions } from "@deployments-ai/tools";
import { createRuntimeAppBuiltinExecutors, type AppRuntimeServices } from "./app-runtime-tools.ts";
import { createRuntimeAgentDelegationBuiltinExecutors } from "./agent-delegation-runtime-tools.ts";
import { createRuntimeAgentRegistryBuiltinExecutors } from "./agent-registry-runtime-tools.ts";
import { createRuntimeArtifactBuilderBuiltinExecutors } from "./artifact-builder-runtime-tools.ts";
import { createRuntimeArtifactLifecycleBuiltinExecutors } from "./artifact-lifecycle-runtime-tools.ts";
import { createRuntimeAttachmentBuiltinExecutors } from "./attachment-runtime-tools.ts";
import { createRuntimeBrowserBuiltinExecutors } from "./browser-runtime-tools.ts";
import { createRuntimeCodeBuiltinExecutors } from "./code-runtime-tools.ts";
import { createRuntimeComputerBuiltinExecutors } from "./computer-runtime-tools.ts";
import {
  createRuntimeHostedCodeExecutor,
  type RuntimeHostedCodeExecutorOptions,
} from "./hosted-code/executor.ts";
import { createRuntimeBrainBuiltinExecutors, type BrainDocumentEvidence } from "./brain/runtime.ts";
import { createRuntimeManagedSkillBuiltinExecutors } from "./managed-skill-runtime-tools.ts";
import { createRuntimeMemoryBuiltinExecutors } from "./memory-runtime.ts";
import { executionPlan, HOSTED_CODE_EXECUTOR_KEY } from "./runtime-tool-planning.ts";
import type { RuntimeRunLogRegistry } from "./runtime-log-emitter.ts";
import { createRuntimeSandboxFileBuiltinExecutors } from "./sandbox-file-runtime-tools.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { createRuntimeScheduleBuiltinExecutors } from "./schedule-runtime-tools.ts";
import { createRuntimeWebBuiltinExecutors } from "./web-runtime-tools.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";

export interface RuntimePlatformBuiltinOptions {
  readonly authorizeDerivedBrainMemory?: Parameters<typeof createRuntimeMemoryBuiltinExecutors>[1];
  readonly appendThreadEvent?: (event: ThreadStreamEvent) => Promise<void>;
  readonly apps?: AppRuntimeServices;
  readonly artifactBucket: string;
  /** KMS key for worker-written artifact-bucket objects such as browser session evidence. */
  readonly artifactKmsKeyId: string;
  readonly legacyArtifactBuckets?: readonly string[];
  readonly artifactS3: Pick<S3Client, "send">;
  readonly database: DynamoDatabaseService;
  readonly dataBoundaries: OrganizationDataBoundaryReader;
  readonly enqueueRun: ConversationQueueEnqueue;
  readonly generateId: () => Promise<Ulid>;
  readonly loadMemoryPlatform: () => Promise<MemoryPlatform>;
  readonly loadBrainQueryRuntime?: (runId: string) => Promise<BrainQueryRuntime>;
  readonly loadBrainDocumentEvidence?: (input: {
    readonly brain: Brain;
    readonly documentId: string;
    readonly maxBytes: number;
    readonly startByte: number;
  }) => Promise<BrainDocumentEvidence>;
  readonly brainRepository?: BrainRepository;
  readonly uploadBrainContent?: (input: {
    readonly brainId: string;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly contentType: string;
    readonly objectKey: string;
    readonly organizationId: string;
    readonly signal?: AbortSignal;
  }) => Promise<BrainBlobReference>;
  readonly loadBrowserConfig: () => BrowserScreenshotConfig;
  /** Audited credential-vault read of a hosted code tool's declared secrets. */
  readonly readHostedCodeSecrets: RuntimeHostedCodeExecutorOptions["readSecrets"];
  readonly runtimeLogs?: RuntimeRunLogRegistry;
  readonly sandboxManager: SandboxManagerService;
  readonly sandboxProviderName: SandboxProviderName;
  /** Guest control-server port of the configured Lambda MicroVM provider, when set explicitly. */
  readonly sandboxControlPort?: number;
  /** Absent when the worker has no thread-persistent sandbox backing; those calls then fail. */
  readonly threadSandbox?: ThreadSandboxWorkspace;
  readonly loadWebConfig: () => Promise<SelfHostedWebToolsConfig> | SelfHostedWebToolsConfig;
  readonly timerProvider: TimerProvider;
}

function mergeExecutorMaps(
  maps: readonly Readonly<Record<string, ExecuteRuntimeBuiltinTool>>[],
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const executors: Record<string, ExecuteRuntimeBuiltinTool> = {};
  for (const map of maps) {
    for (const [key, executor] of Object.entries(map)) {
      if (executors[key]) throw new Error(`Duplicate runtime built-in executor ${key}.`);
      executors[key] = executor;
    }
  }
  return Object.freeze(executors);
}

function assertActivePlatformToolsExecutable(
  executors: Readonly<Record<string, ExecuteRuntimeBuiltinTool>>,
) {
  const failures: string[] = [];
  for (const definition of platformToolAdapterDefinitions) {
    if (definition.status !== "active") continue;
    try {
      if (
        !definition.inputSchema ||
        typeof definition.inputSchema !== "object" ||
        Array.isArray(definition.inputSchema) ||
        (definition.inputSchema as Readonly<Record<string, unknown>>).type !== "object"
      ) {
        throw new Error(
          `Active platform tool ${definition.toolName} requires a code-owned object input schema.`,
        );
      }
      executionPlan(definition, executors);
    } catch (cause) {
      failures.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Active platform tools are not executable:\n${failures.join("\n")}`);
  }
}

export function createRuntimePlatformBuiltinExecutors(
  options: RuntimePlatformBuiltinOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const executors = mergeExecutorMaps([
    createRuntimeBrainBuiltinExecutors({
      database: options.database,
      generateId: options.generateId,
      loadQueryRuntime:
        options.loadBrainQueryRuntime ??
        (() => Promise.reject(new Error("Brain query runtime is not configured."))),
      ...(options.loadBrainDocumentEvidence
        ? { loadDocumentEvidence: options.loadBrainDocumentEvidence }
        : {}),
      repository: options.brainRepository ?? makeBrainDynamoRepository(options.database),
      ...(options.uploadBrainContent ? { uploadContent: options.uploadBrainContent } : {}),
    }),
    createRuntimeMemoryBuiltinExecutors(
      options.loadMemoryPlatform,
      options.authorizeDerivedBrainMemory,
    ),
    createRuntimeAgentDelegationBuiltinExecutors({
      ...(options.appendThreadEvent ? { appendThreadEvent: options.appendThreadEvent } : {}),
      database: options.database,
      enqueueRun: options.enqueueRun,
      generateId: options.generateId,
    }),
    createRuntimeAgentRegistryBuiltinExecutors(options.database),
    createRuntimeArtifactBuilderBuiltinExecutors({
      artifactBucket: options.artifactBucket,
      ...(options.legacyArtifactBuckets
        ? { legacyArtifactBuckets: options.legacyArtifactBuckets }
        : {}),
      artifactS3: options.artifactS3,
      database: options.database,
      dataBoundaries: options.dataBoundaries,
    }),
    createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: options.artifactBucket,
      ...(options.legacyArtifactBuckets
        ? { legacyArtifactBuckets: options.legacyArtifactBuckets }
        : {}),
      artifactS3: options.artifactS3,
      database: options.database,
      generateId: options.generateId,
    }),
    createRuntimeAttachmentBuiltinExecutors({
      bucket: options.artifactBucket,
      database: options.database,
      ...(options.legacyArtifactBuckets ? { legacyBuckets: options.legacyArtifactBuckets } : {}),
      s3: options.artifactS3,
    }),
    createRuntimeBrowserBuiltinExecutors({
      artifactBucket: options.artifactBucket,
      artifactKmsKeyId: options.artifactKmsKeyId,
      artifactS3: options.artifactS3,
      database: options.database,
      loadScreenshotConfig: options.loadBrowserConfig,
      manager: options.sandboxManager,
      providerName: options.sandboxProviderName,
      ...(options.sandboxControlPort !== undefined
        ? { sandboxControlPort: options.sandboxControlPort }
        : {}),
      ...(options.threadSandbox ? { threadSandbox: options.threadSandbox } : {}),
    }),
    createRuntimeAppBuiltinExecutors({
      manager: options.sandboxManager,
      ...(options.apps ? { services: options.apps } : {}),
      ...(options.threadSandbox ? { threadSandbox: options.threadSandbox } : {}),
    }),
    createRuntimeCodeBuiltinExecutors({
      manager: options.sandboxManager,
      providerName: options.sandboxProviderName,
      ...(options.threadSandbox ? { threadSandbox: options.threadSandbox } : {}),
    }),
    {
      [HOSTED_CODE_EXECUTOR_KEY]: createRuntimeHostedCodeExecutor({
        artifactBuckets: [options.artifactBucket, ...(options.legacyArtifactBuckets ?? [])],
        artifactS3: options.artifactS3,
        manager: options.sandboxManager,
        providerName: options.sandboxProviderName,
        readSecrets: options.readHostedCodeSecrets,
        ...(options.runtimeLogs ? { runtimeLogs: options.runtimeLogs } : {}),
      }),
    },
    createRuntimeSandboxFileBuiltinExecutors({
      manager: options.sandboxManager,
      ...(options.threadSandbox ? { threadSandbox: options.threadSandbox } : {}),
    }),
    createRuntimeComputerBuiltinExecutors({
      manager: options.sandboxManager,
      ...(options.threadSandbox ? { threadSandbox: options.threadSandbox } : {}),
    }),
    createRuntimeManagedSkillBuiltinExecutors(options.database),
    createRuntimeScheduleBuiltinExecutors({
      database: options.database,
      generateId: options.generateId,
      timerProvider: options.timerProvider,
    }),
    createRuntimeWebBuiltinExecutors({
      artifactBucket: options.artifactBucket,
      ...(options.legacyArtifactBuckets
        ? { legacyArtifactBuckets: options.legacyArtifactBuckets }
        : {}),
      artifactS3: options.artifactS3,
      database: options.database,
      loadConfig: options.loadWebConfig,
    }),
  ]);
  assertActivePlatformToolsExecutable(executors);
  return executors;
}
