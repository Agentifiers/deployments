import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { BrainSearchProviderRuntimeConfig } from "@deployments-ai/brain-runtime";
import { OAUTH_REFRESH_FUNCTION_NAME_ENV } from "@deployments-ai/providers";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import {
  APP_TOOL_NAMES,
  COMPUTER_TOOL_NAMES,
  SANDBOX_FILE_TOOL_NAMES,
} from "@deployments-ai/tools";

export const WORKER_ENV = {
  agentWorkerDrainTimeoutSeconds: "DEPLOYMENTS_AI_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS",
  agentWorkerMaxConcurrentRuns: "DEPLOYMENTS_AI_AGENT_WORKER_MAX_CONCURRENT_RUNS",
  agentWorkerMetricNamespace: "DEPLOYMENTS_AI_AGENT_WORKER_METRIC_NAMESPACE",
  agentWorkerServiceName: "DEPLOYMENTS_AI_AGENT_WORKER_SERVICE_NAME",
  automationFailureQueueArn: "DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN",
  appsBucket: "APPS_BUCKET",
  appsDatabaseFunctionName: "APPS_DATABASE_FUNCTION_NAME",
  appsDomain: "APPS_DOMAIN",
  artifactBucket: "DEPLOYMENTS_AI_ARTIFACT_BUCKET",
  artifactKmsKeyArn: "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN",
  legacyArtifactBuckets: "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
  brainAnswerModel: "DEPLOYMENTS_AI_BRAIN_ANSWER_MODEL",
  brainOpenSearchEndpoint: "DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT",
  credentialKmsKeyArn: "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN",
  durableStreamsAuthSecretArn: "DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN",
  durableStreamsBaseUrl: "DEPLOYMENTS_AI_DURABLE_STREAMS_URL",
  firecrawlApiKeySecretArn: "DEPLOYMENTS_AI_FIRECRAWL_API_KEY_SECRET_ARN",
  firecrawlJobTicketSecretArn: "DEPLOYMENTS_AI_FIRECRAWL_JOB_TICKET_SECRET_ARN",
  webToolsEnabled: "DEPLOYMENTS_AI_WEB_TOOLS_ENABLED",
  modelGatewayBaseUrl: "DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL",
  modelGatewayRunTokenIssuer: "DEPLOYMENTS_AI_MODEL_GATEWAY_RUN_TOKEN_ISSUER",
  modelGatewayTokenIssuer: "DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER",
  modelGrantsParameterArn: "DEPLOYMENTS_AI_MODEL_GRANTS_PARAMETER_ARN",
  heartbeatFireArn: "DEPLOYMENTS_AI_HEARTBEAT_FIRE_LAMBDA_ARN",
  mcpRequestTimeoutMs: "DEPLOYMENTS_AI_MCP_REQUEST_TIMEOUT_MS",
  /** Optional; absent makes connections that need an OAuth refresh fail as known failures. */
  oauthRefreshFunctionName: OAUTH_REFRESH_FUNCTION_NAME_ENV,
  sandboxProvider: "DEPLOYMENTS_AI_SANDBOX_PROVIDER",
  queueUrl: "DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL",
  queueMaxReceiveCount: "DEPLOYMENTS_AI_AGENT_RUN_MAX_RECEIVE_COUNT",
  queueVisibilitySeconds: "DEPLOYMENTS_AI_AGENT_RUN_VISIBILITY_TIMEOUT_SECONDS",
  scheduleFireArn: "DEPLOYMENTS_AI_SCHEDULE_FIRE_LAMBDA_ARN",
  schedulerGroup: "DEPLOYMENTS_AI_SCHEDULER_GROUP",
  schedulerRoleArn: "DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN",
} as const;

export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function positiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

/**
 * Per-process worker identity used as claim-owner prefix and Durable Streams producer:
 * `agent-worker:<ECS task id, else hostname>:<uuid>`.
 */
export function agentWorkerProcessId(env: NodeJS.ProcessEnv, host: string = hostname()): string {
  const metadataUri = env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  // Fargate container metadata paths end in `<32-hex task id>-<container suffix>`.
  const container =
    metadataUri && URL.canParse(metadataUri)
      ? new URL(metadataUri).pathname.split("/").filter(Boolean).at(-1)
      : undefined;
  const taskId = container?.match(/^([0-9a-f]{32})-\d+$/u)?.[1] ?? container;
  return `agent-worker:${taskId || host}:${randomUUID()}`;
}

export interface AppsRuntimeConfig {
  readonly bucket: string;
  readonly databaseFunctionName: string;
  readonly domain: string;
}

export function appsRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): AppsRuntimeConfig | undefined {
  const bucket = env[WORKER_ENV.appsBucket]?.trim();
  const databaseFunctionName = env[WORKER_ENV.appsDatabaseFunctionName]?.trim();
  const domain = env[WORKER_ENV.appsDomain]?.trim().toLowerCase();
  if (!bucket && !databaseFunctionName && !domain) return undefined;
  if (!bucket || !databaseFunctionName || !domain) {
    throw new Error(
      `${WORKER_ENV.appsDatabaseFunctionName}, ${WORKER_ENV.appsBucket}, and ${WORKER_ENV.appsDomain} must be set together.`,
    );
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain)) {
    throw new Error(`${WORKER_ENV.appsDomain} must be a DNS name such as apps.example.com.`);
  }
  return { bucket, databaseFunctionName, domain };
}

export function runtimeToolAvailable(
  env: Readonly<Record<string, string | undefined>>,
  toolName: string,
) {
  const webEnabled = env[WORKER_ENV.webToolsEnabled] === "true";
  if (
    toolName.startsWith("browser.") ||
    (SANDBOX_FILE_TOOL_NAMES as readonly string[]).includes(toolName) ||
    (COMPUTER_TOOL_NAMES as readonly string[]).includes(toolName) ||
    toolName === "code.execute"
  ) {
    return env[WORKER_ENV.sandboxProvider]?.trim() === "aws_lambda_microvm";
  }
  if ((APP_TOOL_NAMES as readonly string[]).includes(toolName)) {
    return (
      appsRuntimeConfig(env) !== undefined &&
      (toolName !== "app.release" ||
        env[WORKER_ENV.sandboxProvider]?.trim() === "aws_lambda_microvm")
    );
  }
  if (toolName.startsWith("web.")) return webEnabled;
  return true;
}

export async function secretString(client: SecretsManagerClient, arn: string, label: string) {
  const value = (await loadAwsSecretString(arn, { secretsManager: client })).trim();
  if (!value) throw new Error(`${label} secret did not contain SecretString.`);
  return value;
}

/** Reads Brain search provider configuration. */
export function brainSearchProviderConfigFromEnv(
  env: NodeJS.ProcessEnv,
): BrainSearchProviderRuntimeConfig {
  const openSearchEndpoint = env[WORKER_ENV.brainOpenSearchEndpoint]?.trim();
  return openSearchEndpoint ? { aws: { openSearchEndpoint } } : {};
}
