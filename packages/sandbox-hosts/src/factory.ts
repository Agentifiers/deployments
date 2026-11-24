import { createLambdaMicrovmProvider } from "./lambda-microvm.ts";
import {
  DEFAULT_SANDBOX_PROVIDER_MODE,
  type LambdaMicrovmProviderConfig,
  type SandboxProvider,
  type SandboxProviderFactoryConfig,
  type SandboxProviderFactoryEnv,
  type SandboxProviderMode,
  type SandboxUsageCostPolicy,
} from "./types.ts";

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

export function resolveSandboxProviderMode(
  mode: string | undefined,
  fallback: SandboxProviderMode = DEFAULT_SANDBOX_PROVIDER_MODE,
): SandboxProviderMode {
  const normalized = mode?.trim().toLowerCase().replace(/[-.]/gu, "_");
  if (!normalized) return fallback;
  if (["aws_lambda_microvm", "lambda", "lambda_microvm"].includes(normalized)) {
    return "lambda_microvm";
  }
  if (["disabled", "none", "off"].includes(normalized)) return "disabled";
  throw new Error(`Unknown sandbox provider mode: ${mode}`);
}

function readFirstEnv(env: SandboxProviderFactoryEnv, names: readonly string[]) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readFirstEnvOptionalBoolean(
  env: SandboxProviderFactoryEnv,
  names: readonly string[],
): boolean | undefined {
  const value = readFirstEnv(env, names)?.toLowerCase();
  if (value === undefined) return undefined;
  if (["1", "on", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${names[0]} must be a boolean value.`);
}

function readFirstEnvInteger(env: SandboxProviderFactoryEnv, names: readonly string[]) {
  const value = readFirstEnv(env, names);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${names[0]} must be a positive integer.`);
  }
  return parsed;
}

function readFirstEnvPositiveNumber(env: SandboxProviderFactoryEnv, names: readonly string[]) {
  const value = readFirstEnv(env, names);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${names[0]} must be a positive finite number.`);
  }
  return parsed;
}

function readFirstEnvCsv(env: SandboxProviderFactoryEnv, names: readonly string[]) {
  return (
    readFirstEnv(env, names)
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

function hasLambdaMicrovmConfig(
  config: Partial<LambdaMicrovmProviderConfig> | undefined,
): config is LambdaMicrovmProviderConfig {
  return typeof config?.imageIdentifier === "string" && config.imageIdentifier.trim() !== "";
}

export function resolveSandboxProviderConfigFromEnv(
  env: SandboxProviderFactoryEnv = process.env,
): SandboxProviderFactoryConfig {
  const lambdaMicrovm: Partial<Mutable<LambdaMicrovmProviderConfig>> = {};
  const region = readFirstEnv(env, ["AWS_REGION"]);
  if (region) lambdaMicrovm.region = region;
  const imageIdentifier = readFirstEnv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_IDENTIFIER",
    "AGENT_WORKER_LAMBDA_MICROVM_IMAGE_IDENTIFIER",
    "LAMBDA_MICROVM_IMAGE_IDENTIFIER",
  ]);
  if (imageIdentifier) lambdaMicrovm.imageIdentifier = imageIdentifier;
  const imageVersion = readFirstEnv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VERSION",
    "AGENT_WORKER_LAMBDA_MICROVM_IMAGE_VERSION",
    "LAMBDA_MICROVM_IMAGE_VERSION",
  ]);
  if (imageVersion) lambdaMicrovm.imageVersion = imageVersion;
  const executionRoleArn = readFirstEnv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
    "AGENT_WORKER_LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
    "LAMBDA_MICROVM_EXECUTION_ROLE_ARN",
  ]);
  if (executionRoleArn) lambdaMicrovm.executionRoleArn = executionRoleArn;
  const logGroup = readFirstEnv(env, ["DEPLOYMENTS_AI_LAMBDA_MICROVM_LOG_GROUP"]);
  if (logGroup) lambdaMicrovm.logging = { cloudWatch: { logGroup } };
  const reconciliationTarget = readFirstEnv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_RECONCILIATION_TARGET",
    "AGENT_WORKER_LAMBDA_MICROVM_RECONCILIATION_TARGET",
    "LAMBDA_MICROVM_RECONCILIATION_TARGET",
  ]);
  if (reconciliationTarget) lambdaMicrovm.reconciliationTarget = reconciliationTarget;
  const ingressNetworkConnectors = readFirstEnvCsv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_INGRESS_CONNECTORS",
    "AGENT_WORKER_LAMBDA_MICROVM_INGRESS_CONNECTORS",
    "LAMBDA_MICROVM_INGRESS_CONNECTORS",
  ]);
  if (ingressNetworkConnectors.length > 0)
    lambdaMicrovm.ingressNetworkConnectors = ingressNetworkConnectors;
  const egressNetworkConnectors = readFirstEnvCsv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_EGRESS_CONNECTORS",
    "AGENT_WORKER_LAMBDA_MICROVM_EGRESS_CONNECTORS",
    "LAMBDA_MICROVM_EGRESS_CONNECTORS",
  ]);
  if (egressNetworkConnectors.length > 0)
    lambdaMicrovm.egressNetworkConnectors = egressNetworkConnectors;

  const integerOptions = [
    [
      "imageMemoryMiB",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_MEMORY_MIB",
        "AGENT_WORKER_LAMBDA_MICROVM_IMAGE_MEMORY_MIB",
        "LAMBDA_MICROVM_IMAGE_MEMORY_MIB",
      ],
    ],
    [
      "maximumDurationInSeconds",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_MAX_DURATION_SECONDS",
        "AGENT_WORKER_LAMBDA_MICROVM_MAX_DURATION_SECONDS",
        "LAMBDA_MICROVM_MAX_DURATION_SECONDS",
      ],
    ],
    [
      "controlPort",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_CONTROL_PORT",
        "AGENT_WORKER_LAMBDA_MICROVM_CONTROL_PORT",
        "LAMBDA_MICROVM_CONTROL_PORT",
      ],
    ],
    [
      "authTokenTtlMinutes",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES",
        "AGENT_WORKER_LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES",
        "LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES",
      ],
    ],
    [
      "readinessTimeoutMs",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_READINESS_TIMEOUT_MS",
        "AGENT_WORKER_LAMBDA_MICROVM_READINESS_TIMEOUT_MS",
        "LAMBDA_MICROVM_READINESS_TIMEOUT_MS",
      ],
    ],
    [
      "readinessIntervalMs",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_READINESS_INTERVAL_MS",
        "AGENT_WORKER_LAMBDA_MICROVM_READINESS_INTERVAL_MS",
        "LAMBDA_MICROVM_READINESS_INTERVAL_MS",
      ],
    ],
    [
      "requestTimeoutMs",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_REQUEST_TIMEOUT_MS",
        "AGENT_WORKER_LAMBDA_MICROVM_REQUEST_TIMEOUT_MS",
        "LAMBDA_MICROVM_REQUEST_TIMEOUT_MS",
      ],
    ],
    [
      "suspensionTimeoutMs",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_SUSPENSION_TIMEOUT_MS",
        "AGENT_WORKER_LAMBDA_MICROVM_SUSPENSION_TIMEOUT_MS",
        "LAMBDA_MICROVM_SUSPENSION_TIMEOUT_MS",
      ],
    ],
    [
      "suspensionIntervalMs",
      [
        "DEPLOYMENTS_AI_LAMBDA_MICROVM_SUSPENSION_INTERVAL_MS",
        "AGENT_WORKER_LAMBDA_MICROVM_SUSPENSION_INTERVAL_MS",
        "LAMBDA_MICROVM_SUSPENSION_INTERVAL_MS",
      ],
    ],
  ] as const;
  for (const [field, names] of integerOptions) {
    const value = readFirstEnvInteger(env, names);
    if (value !== undefined) lambdaMicrovm[field] = value;
  }
  const imageVcpu = readFirstEnvPositiveNumber(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_IMAGE_VCPU",
    "AGENT_WORKER_LAMBDA_MICROVM_IMAGE_VCPU",
    "LAMBDA_MICROVM_IMAGE_VCPU",
  ]);
  if (imageVcpu !== undefined) lambdaMicrovm.imageVcpu = imageVcpu;

  const controlPathPrefix = readFirstEnv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_CONTROL_PATH_PREFIX",
    "AGENT_WORKER_LAMBDA_MICROVM_CONTROL_PATH_PREFIX",
    "LAMBDA_MICROVM_CONTROL_PATH_PREFIX",
  ]);
  if (controlPathPrefix) lambdaMicrovm.controlPathPrefix = controlPathPrefix;
  const readinessPath = readFirstEnv(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_READINESS_PATH",
    "AGENT_WORKER_LAMBDA_MICROVM_READINESS_PATH",
    "LAMBDA_MICROVM_READINESS_PATH",
  ]);
  if (readinessPath) lambdaMicrovm.readinessPath = readinessPath;

  const idleMaxSeconds = readFirstEnvInteger(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_IDLE_MAX_SECONDS",
    "AGENT_WORKER_LAMBDA_MICROVM_IDLE_MAX_SECONDS",
    "LAMBDA_MICROVM_IDLE_MAX_SECONDS",
  ]);
  const suspendedDurationSeconds = readFirstEnvInteger(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_SUSPENDED_DURATION_SECONDS",
    "AGENT_WORKER_LAMBDA_MICROVM_SUSPENDED_DURATION_SECONDS",
    "LAMBDA_MICROVM_SUSPENDED_DURATION_SECONDS",
  ]);
  const autoResumeEnabled = readFirstEnvOptionalBoolean(env, [
    "DEPLOYMENTS_AI_LAMBDA_MICROVM_AUTO_RESUME",
    "AGENT_WORKER_LAMBDA_MICROVM_AUTO_RESUME",
    "LAMBDA_MICROVM_AUTO_RESUME",
  ]);
  if (idleMaxSeconds || suspendedDurationSeconds || autoResumeEnabled !== undefined) {
    throw new Error(
      "Automatic Lambda MicroVM idle transitions are unsupported until lifecycle reconciliation is enabled.",
    );
  }

  const mode = readFirstEnv(env, [
    "DEPLOYMENTS_AI_SANDBOX_PROVIDER_MODE",
    "DEPLOYMENTS_AI_SANDBOX_PROVIDER",
    "AGENT_WORKER_SANDBOX_PROVIDER",
    "AGENT_SANDBOX_PROVIDER",
    "SANDBOX_PROVIDER_MODE",
  ]);
  return {
    lambdaMicrovm,
    ...(mode ? { mode } : {}),
  };
}

function failingProvider(name: SandboxProvider["name"], reason: string): SandboxProvider {
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    name,
    checkpoint: fail,
    create: fail,
    destroy: fail,
    download: fail,
    exec: fail,
    resume: fail,
    upload: fail,
  };
}

export function createSandboxProvider(config: SandboxProviderFactoryConfig = {}): SandboxProvider {
  const mode = resolveSandboxProviderMode(config.mode);
  if (mode === "disabled") {
    return failingProvider(
      "aws_lambda_microvm",
      config.disabledReason ?? "sandbox provider is disabled",
    );
  }
  return hasLambdaMicrovmConfig(config.lambdaMicrovm)
    ? createLambdaMicrovmProvider(config.lambdaMicrovm)
    : failingProvider("aws_lambda_microvm", "Lambda MicroVM provider is not configured");
}

export function createSandboxProviderFromEnv(env: SandboxProviderFactoryEnv = process.env) {
  return createSandboxProvider(resolveSandboxProviderConfigFromEnv(env));
}

export const SANDBOX_USAGE_COST_POLICY_ENV = "DEPLOYMENTS_AI_SANDBOX_USAGE_COST_POLICY";

const SANDBOX_USAGE_COST_POLICY_RATES: readonly (keyof SandboxUsageCostPolicy)[] = [
  "baseHourUsdMicros",
  "memoryGiBHourUsdMicros",
  "vcpuHourUsdMicros",
];

function isSandboxUsageCostPolicyRate(name: string): name is keyof SandboxUsageCostPolicy {
  return (SANDBOX_USAGE_COST_POLICY_RATES as readonly string[]).includes(name);
}

/** An install that sets no policy leaves sandbox usage unpriced. */
export function resolveSandboxUsageCostPolicyFromEnv(
  env: SandboxProviderFactoryEnv = process.env,
): SandboxUsageCostPolicy | undefined {
  const encoded = env[SANDBOX_USAGE_COST_POLICY_ENV]?.trim();
  if (!encoded) return undefined;
  const invalid = new Error(
    `${SANDBOX_USAGE_COST_POLICY_ENV} must be a JSON object of USD-micro hourly rates named ${SANDBOX_USAGE_COST_POLICY_RATES.join(", ")}.`,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw invalid;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw invalid;
  const policy: { -readonly [Rate in keyof SandboxUsageCostPolicy]: number } = {};
  for (const [name, rate] of Object.entries(decoded)) {
    if (!isSandboxUsageCostPolicyRate(name) || typeof rate !== "number") throw invalid;
    policy[name] = rate;
  }
  return policy;
}
