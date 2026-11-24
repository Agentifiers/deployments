import { LambdaMicrovmsClient, type RunMicrovmRequest } from "@aws-sdk/client-lambda-microvms";
import { createHash, randomUUID } from "node:crypto";
import {
  lambdaClientToken,
  lambdaMicrovmImageRef,
  lambdaMicrovmNetworkConnectors,
  lambdaRunHookPayload,
  normalizeControlPathPrefix,
  readLambdaRecord,
} from "./wire.ts";
import {
  DEFAULT_LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES,
  DEFAULT_LAMBDA_MICROVM_CONTROL_PORT,
  DEFAULT_LAMBDA_MICROVM_MAX_DURATION_SECONDS,
  DEFAULT_LAMBDA_MICROVM_READINESS_INTERVAL_MS,
  DEFAULT_LAMBDA_MICROVM_READINESS_TIMEOUT_MS,
  DEFAULT_LAMBDA_MICROVM_REQUEST_TIMEOUT_MS,
  DEFAULT_LAMBDA_MICROVM_SUSPENSION_INTERVAL_MS,
  DEFAULT_LAMBDA_MICROVM_SUSPENSION_TIMEOUT_MS,
  DEFAULT_SANDBOX_RESERVED_MEMORY_MIB,
  DEFAULT_SANDBOX_RESERVED_VCPU,
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  MAX_SANDBOX_RESERVED_VCPU,
  type CreateSandboxInput,
  type LambdaMicrovmProviderConfig,
  SandboxNetworkIsolationUnavailableError,
} from "../types.ts";

export class LambdaMicrovmControlResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LambdaMicrovmControlResponseError";
    this.status = status;
  }
}

export function lambdaControlMutationOutcomeIsDeterministic(error: unknown) {
  return (
    error instanceof LambdaMicrovmControlResponseError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  );
}

/**
 * Maps the guest's answer to an isolated exec: 404 means its control server predates
 * `/exec-isolated`, 422 means it could not create the network namespace. Either way the command
 * provably did not run. Other failures keep their existing (possibly unknown) outcome.
 */
export function lambdaIsolatedExecRefusal(error: unknown): unknown {
  if (!(error instanceof LambdaMicrovmControlResponseError)) return error;
  if (error.status === 404) {
    return new SandboxNetworkIsolationUnavailableError(
      "The sandbox image predates isolated exec; republish the Lambda MicroVM image.",
      { cause: error },
    );
  }
  if (error.status === 422) {
    return new SandboxNetworkIsolationUnavailableError(
      "The sandbox could not create a network namespace for the command.",
      { cause: error },
    );
  }
  return error;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

function staticAwsConfigValue(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  if (!value || typeof value !== "object") return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.url instanceof URL) return record.url.toString();
  if (typeof record.hostname !== "string" || typeof record.protocol !== "string") {
    return undefined;
  }
  return canonicalJsonValue({
    hostname: record.hostname,
    path: typeof record.path === "string" ? record.path : undefined,
    port: typeof record.port === "number" ? record.port : undefined,
    protocol: record.protocol,
  });
}

function normalizeReadinessPath(path: string | undefined) {
  const trimmed = path?.trim() ?? "/health";
  if (!trimmed) throw new Error("Lambda MicroVM readinessPath is required");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function awsArnScope(value: string | undefined) {
  if (!value?.startsWith("arn:")) return undefined;
  const [arn, partition, _service, region, accountId] = value.split(":", 6);
  if (arn !== "arn" || !partition || !accountId) return undefined;
  return { accountId, partition, ...(region ? { region } : {}) };
}

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function isResourceNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Readonly<Record<string, unknown>>;
  const name = record.name ?? record.Code ?? record.code ?? record.__type;
  return typeof name === "string" && name.includes("ResourceNotFound");
}

export function isDeterministicClientError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Readonly<Record<string, unknown>>;
  const metadata = record.$metadata;
  const statusCode =
    metadata && typeof metadata === "object"
      ? (metadata as Readonly<Record<string, unknown>>).httpStatusCode
      : undefined;
  if (statusCode === 408 || record.$retryable) return false;
  return (
    record.$fault === "client" ||
    (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500)
  );
}

export function isStateConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const metadata = (error as Readonly<Record<string, unknown>>).$metadata;
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    (metadata as Readonly<Record<string, unknown>>).httpStatusCode === 409
  );
}

export function readRunTiming(value: unknown) {
  const record = readLambdaRecord(value, "runMicrovm");
  if (!(record.startedAt instanceof Date) || !Number.isFinite(record.startedAt.getTime())) {
    throw new Error("Invalid Lambda MicroVM runMicrovm.startedAt response");
  }
  if (
    !Number.isSafeInteger(record.maximumDurationInSeconds) ||
    (record.maximumDurationInSeconds as number) < 1 ||
    (record.maximumDurationInSeconds as number) > DEFAULT_LAMBDA_MICROVM_MAX_DURATION_SECONDS
  ) {
    throw new Error("Invalid Lambda MicroVM runMicrovm.maximumDurationInSeconds response");
  }
  return {
    leaseExpiresAt:
      record.startedAt.getTime() + (record.maximumDurationInSeconds as number) * 1_000,
  };
}

export function resolveLambdaMicrovmProviderConfig(config: LambdaMicrovmProviderConfig) {
  if (config.idlePolicy) {
    throw new Error(
      "Lambda MicroVM idlePolicy is unsupported until lifecycle reconciliation is enabled",
    );
  }
  const imageMemoryMiB = config.imageMemoryMiB ?? DEFAULT_SANDBOX_RESERVED_MEMORY_MIB;
  const imageVcpu = config.imageVcpu ?? DEFAULT_SANDBOX_RESERVED_VCPU;
  const supportedCapacity = new Set(["512:0.25", "1024:0.5", "2048:1", "4096:2", "8192:4"]);
  if (
    !Number.isFinite(imageMemoryMiB) ||
    imageMemoryMiB <= 0 ||
    imageMemoryMiB > MAX_SANDBOX_RESERVED_MEMORY_MIB
  ) {
    throw new Error(
      `Lambda MicroVM imageMemoryMiB must be a positive finite number no greater than ${MAX_SANDBOX_RESERVED_MEMORY_MIB}`,
    );
  }
  if (!Number.isFinite(imageVcpu) || imageVcpu <= 0 || imageVcpu > MAX_SANDBOX_RESERVED_VCPU) {
    throw new Error(
      `Lambda MicroVM imageVcpu must be a positive finite number no greater than ${MAX_SANDBOX_RESERVED_VCPU}`,
    );
  }
  if (!supportedCapacity.has(`${imageMemoryMiB}:${imageVcpu}`)) {
    throw new Error("Lambda MicroVM image capacity must be a supported memory/vCPU profile");
  }
  const imageScope = awsArnScope(config.imageIdentifier);
  const executionRoleScope = awsArnScope(config.executionRoleArn);
  if (
    imageScope &&
    executionRoleScope &&
    (imageScope.accountId !== executionRoleScope.accountId ||
      imageScope.partition !== executionRoleScope.partition)
  ) {
    throw new Error("Lambda MicroVM image and execution role must use the same AWS account");
  }
  const configuredRegion = staticAwsConfigValue(config.region ?? config.clientConfig?.region);
  const effectiveRegion =
    (typeof configuredRegion === "string" ? configuredRegion : undefined) ?? imageScope?.region;
  const client =
    config.client ??
    new LambdaMicrovmsClient({
      ...config.clientConfig,
      ...(effectiveRegion ? { region: effectiveRegion } : {}),
    });
  const fetchImpl = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const controlPort = config.controlPort ?? DEFAULT_LAMBDA_MICROVM_CONTROL_PORT;
  const controlPathPrefix = normalizeControlPathPrefix(config.controlPathPrefix);
  const authTokenTtlMinutes =
    config.authTokenTtlMinutes ?? DEFAULT_LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES;
  const authTokenRefreshMarginMs = Math.min(60_000, authTokenTtlMinutes * 6_000);
  if (!Number.isSafeInteger(controlPort) || controlPort < 1 || controlPort > 65_535) {
    throw new Error("Lambda MicroVM controlPort must be an integer from 1 through 65535");
  }
  if (
    !Number.isSafeInteger(authTokenTtlMinutes) ||
    authTokenTtlMinutes < 1 ||
    authTokenTtlMinutes > 60
  ) {
    throw new Error("Lambda MicroVM authTokenTtlMinutes must be an integer from 1 through 60");
  }
  const readinessPath = normalizeReadinessPath(config.readinessPath);
  const readinessTimeoutMs =
    config.readinessTimeoutMs ?? DEFAULT_LAMBDA_MICROVM_READINESS_TIMEOUT_MS;
  const readinessIntervalMs =
    config.readinessIntervalMs ?? DEFAULT_LAMBDA_MICROVM_READINESS_INTERVAL_MS;
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    throw new Error("Lambda MicroVM readinessTimeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(readinessIntervalMs) || readinessIntervalMs <= 0) {
    throw new Error("Lambda MicroVM readinessIntervalMs must be a positive integer");
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_LAMBDA_MICROVM_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Lambda MicroVM requestTimeoutMs must be a positive integer");
  }
  const maximumDurationInSeconds =
    config.maximumDurationInSeconds ?? DEFAULT_LAMBDA_MICROVM_MAX_DURATION_SECONDS;
  if (
    !Number.isSafeInteger(maximumDurationInSeconds) ||
    maximumDurationInSeconds < 1 ||
    maximumDurationInSeconds > DEFAULT_LAMBDA_MICROVM_MAX_DURATION_SECONDS
  ) {
    throw new Error(
      `Lambda MicroVM maximumDurationInSeconds must be an integer from 1 through ${DEFAULT_LAMBDA_MICROVM_MAX_DURATION_SECONDS}`,
    );
  }
  const suspensionTimeoutMs =
    config.suspensionTimeoutMs ?? DEFAULT_LAMBDA_MICROVM_SUSPENSION_TIMEOUT_MS;
  const suspensionIntervalMs =
    config.suspensionIntervalMs ?? DEFAULT_LAMBDA_MICROVM_SUSPENSION_INTERVAL_MS;
  if (!Number.isSafeInteger(suspensionTimeoutMs) || suspensionTimeoutMs <= 0) {
    throw new Error("Lambda MicroVM suspensionTimeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(suspensionIntervalMs) || suspensionIntervalMs <= 0) {
    throw new Error("Lambda MicroVM suspensionIntervalMs must be a positive integer");
  }
  const allocationReconciliationAttempts = config.allocationReconciliationAttempts ?? 3;
  if (
    !Number.isSafeInteger(allocationReconciliationAttempts) ||
    allocationReconciliationAttempts <= 0
  ) {
    throw new Error("Lambda MicroVM allocationReconciliationAttempts must be a positive integer");
  }
  const reconciliationTarget = config.reconciliationTarget?.trim();
  const staticEndpoint = staticAwsConfigValue(config.clientConfig?.endpoint);
  const routeAccountScope = executionRoleScope ?? imageScope;
  const stableAwsTarget =
    !config.client &&
    routeAccountScope &&
    effectiveRegion &&
    typeof config.clientConfig?.endpoint !== "function" &&
    typeof config.clientConfig?.region !== "function"
      ? {
          accountId: routeAccountScope.accountId,
          endpoint: staticEndpoint,
          partition: routeAccountScope.partition,
          region: effectiveRegion,
        }
      : undefined;
  const allocationClientTarget = {
    client: config.client ? "custom" : "sdk",
    endpoint: staticEndpoint,
    region: effectiveRegion ?? configuredRegion,
  };
  const stableRouteTarget = reconciliationTarget ? { reconciliationTarget } : stableAwsTarget;
  const providerRouteKey = createHash("sha256")
    .update(
      JSON.stringify(
        canonicalJsonValue({
          allocationClientTarget,
          controlPathPrefix,
          controlPort,
          ...(stableRouteTarget ? { stableRouteTarget } : { ephemeralInstance: randomUUID() }),
          readinessPath,
        }),
      ),
    )
    .digest("hex");

  function runInputFor(input: CreateSandboxInput): RunMicrovmRequest {
    const configuredImageRef = lambdaMicrovmImageRef(config);
    if (input.imageRef !== undefined && input.imageRef !== configuredImageRef) {
      throw new Error(
        `Lambda MicroVM provider is configured for image ${configuredImageRef}, not ${input.imageRef}`,
      );
    }
    const ingressNetworkConnectors = lambdaMicrovmNetworkConnectors(
      config.ingressNetworkConnectors,
    );
    const egressNetworkConnectors = lambdaMicrovmNetworkConnectors(config.egressNetworkConnectors);
    const runHookPayload = lambdaRunHookPayload(config, input);
    return {
      clientToken: lambdaClientToken(input),
      ...(egressNetworkConnectors ? { egressNetworkConnectors } : {}),
      ...(config.executionRoleArn ? { executionRoleArn: config.executionRoleArn } : {}),
      imageIdentifier: config.imageIdentifier,
      ...(config.imageVersion ? { imageVersion: config.imageVersion } : {}),
      ...(ingressNetworkConnectors ? { ingressNetworkConnectors } : {}),
      ...(config.logging ? { logging: config.logging } : {}),
      maximumDurationInSeconds,
      ...(runHookPayload ? { runHookPayload } : {}),
    };
  }

  function fingerprintFor(runInput: RunMicrovmRequest) {
    return createHash("sha256")
      .update(
        JSON.stringify(
          canonicalJsonValue({
            allocationClientTarget,
            controlPathPrefix,
            controlPort,
            imageMemoryMiB,
            imageVcpu,
            readinessPath,
            reconciliationTarget,
            request: runInput,
          }),
        ),
      )
      .digest("hex");
  }

  return {
    allocationClientTarget,
    allocationFingerprint: (input: CreateSandboxInput) => fingerprintFor(runInputFor(input)),
    allocationReconciliationAttempts,
    authTokenRefreshMarginMs,
    authTokenTtlMinutes,
    client,
    controlPathPrefix,
    controlPort,
    effectiveRegion,
    fetchImpl,
    fingerprintFor,
    imageMemoryMiB,
    imageVcpu,
    maximumDurationInSeconds,
    now,
    providerRouteKey,
    readinessIntervalMs,
    readinessPath,
    readinessTimeoutMs,
    reconciliationTarget,
    requestTimeoutMs,
    runInputFor,
    suspensionIntervalMs,
    suspensionTimeoutMs,
  };
}
