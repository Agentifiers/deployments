import { agentRunFifoQueueUrl } from "./sqs.ts";
import { requiredEnv, WORKER_ENV } from "./worker-env.ts";

const MAX_AGENT_WORKER_CONCURRENT_RUNS = 64;
const DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS = 100;
/** ECS kills a Fargate task at most 120 s after SIGTERM; aborted runs still need time to persist. */
const MAX_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS = 110;

export interface AgentWorkerServiceConfig {
  readonly drainTimeoutMs: number;
  readonly maxConcurrentRuns: number;
  /** Absent when no metric namespace is configured (local development). */
  readonly metrics?: { readonly namespace: string; readonly serviceName: string };
  readonly queueUrl: string;
}

function boundedInteger(name: string, value: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}.`);
  }
  return parsed;
}

/** Reads the agent-worker host settings; throws a descriptive error for any invalid value. */
export function agentWorkerServiceConfig(env: NodeJS.ProcessEnv): AgentWorkerServiceConfig {
  const queueUrl = agentRunFifoQueueUrl(requiredEnv(WORKER_ENV.queueUrl, env));
  const maxConcurrentRuns = boundedInteger(
    WORKER_ENV.agentWorkerMaxConcurrentRuns,
    requiredEnv(WORKER_ENV.agentWorkerMaxConcurrentRuns, env),
    MAX_AGENT_WORKER_CONCURRENT_RUNS,
  );
  const drainTimeout = env[WORKER_ENV.agentWorkerDrainTimeoutSeconds]?.trim();
  const drainTimeoutSeconds = drainTimeout
    ? boundedInteger(
        WORKER_ENV.agentWorkerDrainTimeoutSeconds,
        drainTimeout,
        MAX_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS,
      )
    : DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS;
  const namespace = env[WORKER_ENV.agentWorkerMetricNamespace]?.trim();
  return {
    drainTimeoutMs: drainTimeoutSeconds * 1_000,
    maxConcurrentRuns,
    ...(namespace
      ? {
          metrics: {
            namespace,
            serviceName: requiredEnv(WORKER_ENV.agentWorkerServiceName, env),
          },
        }
      : {}),
    queueUrl,
  };
}
