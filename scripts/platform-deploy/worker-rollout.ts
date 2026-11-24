/* eslint-disable no-await-in-loop -- rollout polling is sequential by design. */
import { type CommandRunner, log } from "./process.ts";
import type { TerraformOutputs } from "./terraform.ts";

const pollIntervalMs = 15_000;
// New tasks start, then old tasks drain for up to the 120 s ECS stop timeout.
const pollAttempts = 80;

/** ECS service identifiers OpenTofu exports for the agent worker. */
export interface WorkerService {
  readonly clusterArn: string;
  readonly serviceName: string;
  readonly taskDefinitionArn: string;
}

export interface EcsDeployment {
  readonly rolloutState?: string;
  readonly rolloutStateReason?: string;
  readonly status: string;
  readonly taskDefinition: string;
}

export type RolloutProgress =
  | { readonly state: "completed" }
  | { readonly state: "in-progress" }
  | { readonly reason: string; readonly state: "failed" };

function requiredField(value: object, field: string) {
  const nested: unknown = Reflect.get(value, field);
  if (typeof nested !== "string" || !nested) {
    throw new Error(`OpenTofu output agent_runtime_worker.${field} is empty.`);
  }
  return nested;
}

/** Reads the worker service from the applied root, or undefined when the agent runtime is disabled. */
export function agentWorkerService(outputs: TerraformOutputs): WorkerService | undefined {
  const value = outputs.agent_runtime_worker;
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") {
    throw new TypeError("OpenTofu output agent_runtime_worker is not an object.");
  }
  return {
    clusterArn: requiredField(value, "cluster_arn"),
    serviceName: requiredField(value, "service_name"),
    taskDefinitionArn: requiredField(value, "task_definition_arn"),
  };
}

/**
 * Classifies the service rollout toward `taskDefinitionArn`. A circuit-breaker
 * rollback leaves a stable service on the previous revision, so the primary
 * deployment's revision is what distinguishes success from a rolled-back release.
 */
export function rolloutProgress(
  deployments: readonly EcsDeployment[],
  taskDefinitionArn: string,
): RolloutProgress {
  const primary = deployments.find((deployment) => deployment.status === "PRIMARY");
  if (!primary) return { reason: "the service has no primary deployment", state: "failed" };
  if (primary.taskDefinition !== taskDefinitionArn) {
    return {
      reason: `the primary deployment runs ${primary.taskDefinition}, not ${taskDefinitionArn}`,
      state: "failed",
    };
  }
  if (primary.rolloutState === "FAILED") {
    return { reason: primary.rolloutStateReason ?? "rollout failed", state: "failed" };
  }
  return primary.rolloutState === "COMPLETED" ? { state: "completed" } : { state: "in-progress" };
}

function decodeDeployments(output: string): EcsDeployment[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new TypeError("ECS describe-services returned no deployments.");
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object") {
      throw new TypeError("ECS describe-services returned an invalid deployment.");
    }
    const status: unknown = Reflect.get(entry, "status");
    const taskDefinition: unknown = Reflect.get(entry, "taskDefinition");
    const rolloutState: unknown = Reflect.get(entry, "rolloutState");
    const rolloutStateReason: unknown = Reflect.get(entry, "rolloutStateReason");
    if (typeof status !== "string" || typeof taskDefinition !== "string") {
      throw new TypeError("ECS describe-services returned an incomplete deployment.");
    }
    return {
      status,
      taskDefinition,
      ...(typeof rolloutState === "string" ? { rolloutState } : {}),
      ...(typeof rolloutStateReason === "string" ? { rolloutStateReason } : {}),
    };
  });
}

/** Waits until the worker service runs the applied task definition, failing on rollback. */
export async function verifyWorkerRollout(input: {
  readonly retryDelayMs?: number;
  readonly run: CommandRunner;
  readonly service: WorkerService;
}) {
  const { service } = input;
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const output = await input.run([
      "aws",
      "ecs",
      "describe-services",
      "--cluster",
      service.clusterArn,
      "--services",
      service.serviceName,
      "--query",
      "services[0].deployments",
      "--output",
      "json",
    ]);
    const progress = rolloutProgress(decodeDeployments(output), service.taskDefinitionArn);
    if (progress.state === "completed") {
      log(`${service.serviceName} rollout completed on ${service.taskDefinitionArn}`);
      return;
    }
    if (progress.state === "failed") {
      throw new Error(`${service.serviceName} rollout failed: ${progress.reason}.`);
    }
    if (attempt < pollAttempts) await Bun.sleep(input.retryDelayMs ?? pollIntervalMs);
  }
  throw new Error(`${service.serviceName} rollout did not complete within the deploy window.`);
}
