import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  type LambdaMicrovmsClientConfig,
  type Logging,
} from "@aws-sdk/client-lambda-microvms";
import type {
  ObservabilitySourceContext,
  SandboxExecutionTargetKind,
  Ulid,
} from "@deployments-ai/db";

export { MAX_SANDBOX_RESERVED_MEMORY_MIB, MAX_SANDBOX_RESERVED_VCPU } from "@deployments-ai/db";

export type SandboxProviderName = "aws_lambda_microvm";
export type SandboxIsolationMode = "run-ephemeral" | "thread-persistent";
export type SandboxLeaseStatus =
  | "checkpointing"
  | "creating"
  | "destroyed"
  | "error"
  | "ready"
  | "releasing"
  | "resuming"
  | "suspended";

export interface SandboxLease {
  readonly accessPolicyRef?: string;
  readonly checkpointRef?: string;
  readonly environmentId: Ulid;
  /** Deployment id for customer runs; execution binding id for preview/evaluation runs. */
  readonly executionTargetId: Ulid;
  readonly executionTargetKind: SandboxExecutionTargetKind;
  readonly externalSandboxId: string;
  readonly imageRef?: string;
  readonly isolationMode: SandboxIsolationMode;
  readonly leaseExpiresAt?: number;
  readonly organizationId: Ulid;
  readonly poolKey?: string;
  readonly projectId: Ulid;
  readonly provider: SandboxProviderName;
  readonly providerRouteKey?: string;
  readonly region?: string;
  readonly reservedMemoryMiB?: number;
  readonly reservedVcpu?: number;
  readonly runId?: Ulid;
  readonly status: SandboxLeaseStatus;
  readonly workspaceId?: Ulid;
}

export interface CreateSandboxInput {
  readonly accessPolicyRef?: string;
  readonly allocationId?: Ulid;
  readonly environmentId: Ulid;
  readonly executionTargetId: Ulid;
  readonly executionTargetKind: SandboxExecutionTargetKind;
  readonly expectedAllocationFingerprint?: string;
  readonly imageRef?: string;
  readonly isolationMode: SandboxIsolationMode;
  readonly minMemoryMiB?: number;
  readonly minVcpu?: number;
  readonly observability?: ObservabilitySourceContext;
  readonly organizationId: Ulid;
  readonly poolKey?: string;
  readonly preferredRegion?: string;
  readonly projectId: Ulid;
  readonly runId?: Ulid;
  readonly signal?: AbortSignal;
  readonly workspaceId?: Ulid;
}

export interface ResumeSandboxInput {
  readonly lease: SandboxLease;
  readonly onMutationDispatch?: () => void;
  readonly requestedAt?: number;
  readonly signal?: AbortSignal;
}

export interface ExecInput {
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly lease: SandboxLease;
  readonly onMutationDispatch?: () => void;
  /**
   * When `"none"`, the command must run with no network access (fresh network namespace with no
   * interfaces up). Providers that cannot enforce this MUST reject the exec with
   * `SandboxNetworkIsolationUnavailableError` (fail closed) rather than run the command with
   * network. Omitted keeps the sandbox's default egress.
   */
  readonly network?: "none";
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface AsyncExecHandle {
  readonly lease: SandboxLease;
  readonly operationId: string;
}

export interface UploadInput {
  readonly content: Uint8Array | ReadableStream<Uint8Array>;
  readonly lease: SandboxLease;
  readonly onMutationDispatch?: () => void;
  readonly path: string;
  readonly signal?: AbortSignal;
}

export interface DownloadInput {
  readonly lease: SandboxLease;
  readonly path: string;
  readonly signal?: AbortSignal;
}

export interface CheckpointInput {
  readonly label?: string;
  readonly lease: SandboxLease;
  readonly requestedAt?: number;
  readonly signal?: AbortSignal;
}

export interface CheckpointRef {
  readonly checkpointRef: string;
  readonly createdAt: number;
  readonly provider: SandboxProviderName;
}

export interface CheckpointReconciliation {
  readonly checkpoint?: CheckpointRef;
  readonly lease: SandboxLease;
}

export interface DestroyInput {
  readonly lease: SandboxLease;
  readonly signal?: AbortSignal;
}

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly allocationFingerprint?: (input: CreateSandboxInput) => string;
  readonly automaticAllocationReconciliation?: boolean;
  readonly checkpoint: (input: CheckpointInput) => Promise<CheckpointRef>;
  readonly create: (input: CreateSandboxInput) => Promise<SandboxLease>;
  readonly destroy: (input: DestroyInput) => Promise<void>;
  readonly download: (input: DownloadInput) => Promise<ReadableStream<Uint8Array>>;
  readonly exec: (input: ExecInput) => Promise<ExecResult | AsyncExecHandle>;
  readonly provisioningReservation?: (input: CreateSandboxInput) => {
    readonly reservedMemoryMiB: number;
    readonly reservedVcpu: number;
  };
  readonly providerRouteKeyForLease?: (lease: SandboxLease) => string | undefined;
  readonly reconcileCheckpoint?: (input: CheckpointInput) => Promise<CheckpointReconciliation>;
  readonly reconcileResume?: (input: ResumeSandboxInput) => Promise<SandboxLease>;
  readonly resume: (input: ResumeSandboxInput) => Promise<SandboxLease>;
  readonly upload: (input: UploadInput) => Promise<void>;
  readonly validateReadyLease?: (
    lease: SandboxLease,
    signal?: AbortSignal,
  ) => Promise<SandboxLease>;
  readonly validateLeaseRoute?: (lease: SandboxLease) => void;
}

export class SandboxAllocationCleanupError extends Error {
  readonly allocationError: unknown;
  readonly cleanupError: unknown;
  readonly lease: SandboxLease;

  constructor(options: {
    readonly allocationError: unknown;
    readonly cleanupError: unknown;
    readonly lease: SandboxLease;
  }) {
    super("Sandbox allocation failed and provider cleanup did not complete", {
      cause: options.cleanupError,
    });
    this.name = "SandboxAllocationCleanupError";
    this.allocationError = options.allocationError;
    this.cleanupError = options.cleanupError;
    this.lease = options.lease;
  }
}

export class SandboxAllocationLeaseError extends Error {
  readonly allocationError: unknown;
  readonly cleanupCompletedAt: number | undefined;
  readonly identityVerified: boolean;
  readonly lease: SandboxLease;

  constructor(options: {
    readonly allocationError: unknown;
    readonly cleanupCompletedAt?: number;
    readonly identityVerified?: boolean;
    readonly lease: SandboxLease;
  }) {
    super("Sandbox allocation returned an invalid lease with a known provider identity", {
      cause: options.allocationError,
    });
    this.name = "SandboxAllocationLeaseError";
    this.allocationError = options.allocationError;
    this.cleanupCompletedAt = options.cleanupCompletedAt;
    this.identityVerified = options.identityVerified ?? true;
    this.lease = options.lease;
  }
}

export class SandboxAllocationUnknownError extends Error {
  readonly allocationError: unknown;
  readonly allocationToken: string;
  readonly automaticReconciliation: boolean;

  constructor(options: {
    readonly allocationError: unknown;
    readonly allocationToken: string;
    readonly automaticReconciliation?: boolean;
  }) {
    super("Sandbox allocation outcome is unknown", {
      cause: options.allocationError,
    });
    this.name = "SandboxAllocationUnknownError";
    this.allocationError = options.allocationError;
    this.allocationToken = options.allocationToken;
    this.automaticReconciliation = options.automaticReconciliation ?? true;
  }
}

export class SandboxResumeUnknownError extends Error {
  constructor(cause: unknown) {
    super("Sandbox resume may have reached running state", { cause });
    this.name = "SandboxResumeUnknownError";
  }
}

export class SandboxCheckpointUnknownError extends Error {
  constructor(cause: unknown) {
    super("Sandbox checkpoint may have reached suspended state", { cause });
    this.name = "SandboxCheckpointUnknownError";
  }
}

export class SandboxDestroyUnknownError extends Error {
  constructor(cause: unknown) {
    super("Sandbox destroy may have completed", { cause });
    this.name = "SandboxDestroyUnknownError";
  }
}

export class SandboxDataPlaneUnknownError extends Error {
  readonly operation: "exec" | "upload";

  constructor(operation: "exec" | "upload", cause: unknown) {
    super(`Sandbox ${operation} outcome is unknown`, { cause });
    this.name = "SandboxDataPlaneUnknownError";
    this.operation = operation;
  }
}

/**
 * The provider could not run the command with network isolation, so the command did not run.
 * Deterministic: retrying on the same sandbox image cannot succeed.
 */
export class SandboxNetworkIsolationUnavailableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "SandboxNetworkIsolationUnavailableError";
  }
}

export type SandboxFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export type SandboxProviderMode = "disabled" | "lambda_microvm";

export interface SandboxProviderFactoryEnv {
  readonly [key: string]: string | undefined;
}

export interface SandboxProviderFactoryConfig {
  readonly disabledReason?: string;
  readonly lambdaMicrovm?: Partial<LambdaMicrovmProviderConfig>;
  readonly mode?: string;
}

type LambdaMicrovmCommand =
  | CreateMicrovmAuthTokenCommand
  | GetMicrovmCommand
  | ResumeMicrovmCommand
  | RunMicrovmCommand
  | SuspendMicrovmCommand
  | TerminateMicrovmCommand;

export interface LambdaMicrovmCommandSender {
  readonly send: (
    command: LambdaMicrovmCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ) => Promise<unknown>;
}

export interface LambdaMicrovmIdlePolicy {
  readonly autoResumeEnabled: boolean;
  readonly maxIdleDurationSeconds: number;
  readonly suspendedDurationSeconds: number;
}

export interface LambdaMicrovmProviderConfig {
  readonly allocationReconciliationAttempts?: number;
  readonly authTokenTtlMinutes?: number;
  readonly client?: LambdaMicrovmCommandSender;
  readonly clientConfig?: LambdaMicrovmsClientConfig;
  readonly controlPathPrefix?: string;
  readonly controlPort?: number;
  readonly egressNetworkConnectors?: string[];
  readonly executionRoleArn?: string;
  readonly fetch?: SandboxFetch;
  readonly idlePolicy?: LambdaMicrovmIdlePolicy;
  readonly imageIdentifier: string;
  readonly imageMemoryMiB?: number;
  readonly imageVersion?: string;
  readonly imageVcpu?: number;
  readonly ingressNetworkConnectors?: string[];
  readonly logging?: Logging;
  readonly maximumDurationInSeconds?: number;
  readonly now?: () => number;
  readonly readinessIntervalMs?: number;
  readonly readinessPath?: string;
  readonly readinessTimeoutMs?: number;
  readonly reconciliationTarget?: string;
  readonly region?: string;
  readonly requestTimeoutMs?: number;
  readonly runHookPayload?: string | ((input: CreateSandboxInput) => string | undefined);
  readonly suspensionIntervalMs?: number;
  readonly suspensionTimeoutMs?: number;
}

export interface SandboxUsageCostPolicy {
  readonly baseHourUsdMicros?: number;
  readonly memoryGiBHourUsdMicros?: number;
  readonly vcpuHourUsdMicros?: number;
}

export const DEFAULT_SANDBOX_RESERVED_VCPU = 1;
export const DEFAULT_SANDBOX_RESERVED_MEMORY_MIB = 2_048;
export const DEFAULT_LAMBDA_MICROVM_CONTROL_PORT = 8_080;
export const DEFAULT_LAMBDA_MICROVM_AUTH_TOKEN_TTL_MINUTES = 15;
export const DEFAULT_LAMBDA_MICROVM_MAX_DURATION_SECONDS = 28_800;
export const DEFAULT_LAMBDA_MICROVM_READINESS_TIMEOUT_MS = 60_000;
export const DEFAULT_LAMBDA_MICROVM_READINESS_INTERVAL_MS = 1_000;
export const DEFAULT_LAMBDA_MICROVM_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_LAMBDA_MICROVM_SUSPENSION_TIMEOUT_MS = 60_000;
export const DEFAULT_LAMBDA_MICROVM_SUSPENSION_INTERVAL_MS = 1_000;
export const DEFAULT_SANDBOX_AWS_REGION = "us-east-2";
export const DEFAULT_SANDBOX_PROVIDER_MODE: SandboxProviderMode = "lambda_microvm";

export const DEFAULT_LAMBDA_MICROVM_NETWORK_CONNECTORS = new Set([
  "HTTP_INGRESS",
  "INTERNET_EGRESS",
]);

export const SANDBOX_RESOURCE_PROFILES = {
  heavy: { minMemoryMiB: 4_096, minVcpu: 2 },
  light: { minMemoryMiB: 1_024, minVcpu: 1 },
  standard: {
    minMemoryMiB: DEFAULT_SANDBOX_RESERVED_MEMORY_MIB,
    minVcpu: DEFAULT_SANDBOX_RESERVED_VCPU,
  },
} as const;

export type SandboxResourceProfile = keyof typeof SANDBOX_RESOURCE_PROFILES;
export const DEFAULT_SANDBOX_RESOURCE_PROFILE: SandboxResourceProfile = "light";
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export function resolveSandboxResourceProfile(
  profile: string | undefined,
  fallback: SandboxResourceProfile = DEFAULT_SANDBOX_RESOURCE_PROFILE,
): SandboxResourceProfile {
  if (!profile) return fallback;
  const normalized = profile.trim().toLowerCase();
  if (Object.hasOwn(SANDBOX_RESOURCE_PROFILES, normalized)) {
    return normalized as SandboxResourceProfile;
  }
  throw new Error(`Unknown sandbox resource profile: ${profile}`);
}

export function isValidEpochMilliseconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -MAX_DATE_MILLISECONDS &&
    value <= MAX_DATE_MILLISECONDS
  );
}

function readRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`Invalid sandbox ${context} response`);
  return value as Record<string, unknown>;
}

function readString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid sandbox ${context} response`);
  return value;
}

function readNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid sandbox ${context} response`);
  }
  return value;
}

function readEpochMilliseconds(value: unknown, context: string): number {
  if (!isValidEpochMilliseconds(value)) {
    throw new Error(`Invalid sandbox ${context} response`);
  }
  return value;
}

function readSandboxProvider(value: unknown, context: string): SandboxProviderName {
  if (value === "aws_lambda_microvm") return value;
  throw new Error(`Invalid sandbox ${context} response`);
}

function readSandboxLeaseStatus(value: unknown, context: string): SandboxLeaseStatus {
  const normalized = readString(value, context).replaceAll("_", "-");
  if (normalized === "in-use") return "ready";
  if (normalized === "failed") return "error";
  if (
    normalized === "checkpointing" ||
    normalized === "creating" ||
    normalized === "destroyed" ||
    normalized === "error" ||
    normalized === "ready" ||
    normalized === "releasing" ||
    normalized === "resuming" ||
    normalized === "suspended"
  ) {
    return normalized;
  }
  throw new Error(`Invalid sandbox ${context} response`);
}

function optionalUlid(value: unknown): Ulid | undefined {
  return typeof value === "string" ? (value as Ulid) : undefined;
}

function readOptionalExecutionTargetKind(value: unknown): SandboxExecutionTargetKind | undefined {
  if (value === undefined) return undefined;
  if (value === "agent-deployment" || value === "execution-binding") return value;
  throw new Error("Invalid sandbox lease.executionTargetKind response");
}

export function readLease(
  value: unknown,
  fallback?: CreateSandboxInput | SandboxLease,
): SandboxLease {
  const record = readRecord(value, "lease");
  const organizationId = optionalUlid(record.organizationId) ?? fallback?.organizationId;
  const projectId = optionalUlid(record.projectId) ?? fallback?.projectId;
  const environmentId = optionalUlid(record.environmentId) ?? fallback?.environmentId;
  const executionTargetId = optionalUlid(record.executionTargetId) ?? fallback?.executionTargetId;
  const executionTargetKind =
    readOptionalExecutionTargetKind(record.executionTargetKind) ?? fallback?.executionTargetKind;
  if (
    !organizationId ||
    !projectId ||
    !environmentId ||
    !executionTargetId ||
    !executionTargetKind
  ) {
    throw new Error("Invalid sandbox lease scope response");
  }

  const rawIsolationMode = record.isolationMode ?? fallback?.isolationMode;
  const isolationMode =
    typeof rawIsolationMode === "string" ? rawIsolationMode.replaceAll("_", "-") : undefined;
  if (isolationMode !== "run-ephemeral" && isolationMode !== "thread-persistent") {
    throw new Error("Invalid sandbox lease.isolationMode response");
  }

  return {
    environmentId,
    executionTargetId,
    executionTargetKind,
    externalSandboxId: readString(record.externalSandboxId, "lease.externalSandboxId"),
    isolationMode,
    organizationId,
    projectId,
    provider: readSandboxProvider(record.provider ?? "aws_lambda_microvm", "lease.provider"),
    status: readSandboxLeaseStatus(record.status, "lease.status"),
    ...(typeof record.accessPolicyRef === "string"
      ? { accessPolicyRef: record.accessPolicyRef }
      : fallback?.accessPolicyRef
        ? { accessPolicyRef: fallback.accessPolicyRef }
        : {}),
    ...(typeof record.checkpointRef === "string" ? { checkpointRef: record.checkpointRef } : {}),
    ...(typeof record.imageRef === "string"
      ? { imageRef: record.imageRef }
      : fallback?.imageRef
        ? { imageRef: fallback.imageRef }
        : {}),
    ...(record.leaseExpiresAt === undefined
      ? {}
      : {
          leaseExpiresAt: readEpochMilliseconds(record.leaseExpiresAt, "lease.leaseExpiresAt"),
        }),
    ...(typeof record.poolKey === "string"
      ? { poolKey: record.poolKey }
      : fallback?.poolKey
        ? { poolKey: fallback.poolKey }
        : {}),
    ...(typeof record.providerRouteKey === "string"
      ? { providerRouteKey: record.providerRouteKey }
      : fallback && "providerRouteKey" in fallback && fallback.providerRouteKey
        ? { providerRouteKey: fallback.providerRouteKey }
        : {}),
    ...(typeof record.region === "string" ? { region: record.region } : {}),
    ...(typeof record.reservedMemoryMiB === "number"
      ? { reservedMemoryMiB: record.reservedMemoryMiB }
      : fallback && "minMemoryMiB" in fallback && fallback.minMemoryMiB
        ? { reservedMemoryMiB: fallback.minMemoryMiB }
        : fallback && "reservedMemoryMiB" in fallback && fallback.reservedMemoryMiB
          ? { reservedMemoryMiB: fallback.reservedMemoryMiB }
          : {}),
    ...(typeof record.reservedVcpu === "number"
      ? { reservedVcpu: record.reservedVcpu }
      : fallback && "minVcpu" in fallback && fallback.minVcpu
        ? { reservedVcpu: fallback.minVcpu }
        : fallback && "reservedVcpu" in fallback && fallback.reservedVcpu
          ? { reservedVcpu: fallback.reservedVcpu }
          : {}),
    ...((optionalUlid(record.runId) ?? fallback?.runId)
      ? { runId: (optionalUlid(record.runId) ?? fallback?.runId) as Ulid }
      : {}),
    ...((optionalUlid(record.workspaceId) ?? fallback?.workspaceId)
      ? {
          workspaceId: (optionalUlid(record.workspaceId) ?? fallback?.workspaceId) as Ulid,
        }
      : {}),
  };
}

export function readExecResponse(
  value: unknown,
  fallbackLease: SandboxLease,
): ExecResult | AsyncExecHandle {
  const record = readRecord(value, "exec");
  if (typeof record.operationId === "string") {
    return {
      lease: record.lease ? readLease(record.lease, fallbackLease) : fallbackLease,
      operationId: record.operationId,
    };
  }
  const durationMs = readNumber(record.durationMs, "exec.durationMs");
  const exitCode = readNumber(record.exitCode, "exec.exitCode");
  if (durationMs < 0 || durationMs > Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid sandbox exec.durationMs response");
  }
  if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
    throw new Error("Invalid sandbox exec.exitCode response");
  }
  return {
    durationMs,
    exitCode,
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    stdout: typeof record.stdout === "string" ? record.stdout : "",
  };
}
