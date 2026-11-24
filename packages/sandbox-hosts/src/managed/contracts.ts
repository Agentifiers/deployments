import type {
  DatabaseError,
  DynamoDatabaseService,
  IdGenerationError,
  IdGeneratorService,
  PlatformRecord,
  RecordDecodeError,
} from "@deployments-ai/db";
import { SandboxLeaseRecord } from "@deployments-ai/db";
import { Schema, type Effect } from "effect";
import type {
  AsyncExecHandle,
  CheckpointReconciliation,
  CheckpointRef,
  CreateSandboxInput,
  DownloadInput,
  ExecInput,
  ExecResult,
  SandboxLease,
  SandboxProvider,
  SandboxUsageCostPolicy,
  UploadInput,
} from "../types.ts";

export type SandboxLeaseRecordValue = typeof SandboxLeaseRecord.Type;
export type SandboxMeterEvent = Extract<PlatformRecord, { readonly itemType: "meter-event" }>;

export interface SandboxOperationGuard {
  readonly signal: AbortSignal;
  readonly release: (retain?: boolean) => Promise<void>;
  readonly retain: () => void;
}

export interface ManagedSandbox {
  readonly lease: SandboxLease;
  readonly record: SandboxLeaseRecordValue;
}

export interface ManagedExecInput extends Omit<ExecInput, "lease"> {
  readonly sandbox: ManagedSandbox;
}

export interface ManagedUploadInput extends Omit<UploadInput, "lease"> {
  readonly sandbox: ManagedSandbox;
}

export interface ManagedDownloadInput extends Omit<DownloadInput, "lease"> {
  readonly sandbox: ManagedSandbox;
}

export interface SandboxCapacityRejection {
  readonly inUse: number;
  readonly limit: number;
  readonly organizationId: string;
  readonly requestingRunId?: string;
}

export interface SandboxCapacityRecovery extends SandboxCapacityRejection {
  readonly leaseId: string;
  readonly reason: "destroy-failed" | "lease-expired" | "run-not-running";
}

export interface SandboxManagerConfig {
  readonly costPolicy?: SandboxUsageCostPolicy | undefined;
  readonly now?: () => number;
  readonly onSandboxCapacityRejected: (rejection: SandboxCapacityRejection) => void;
  readonly onStaleCapacityRecovered: (recovery: SandboxCapacityRecovery) => void;
  readonly operationAcquireTimeoutMs?: number;
  readonly operationLeaseMs?: number;
  readonly operationLeaseNow?: () => number;
  readonly organizationSandboxLimit: (organizationId: string) => Promise<number>;
}

export class SandboxCapacityError extends Schema.TaggedErrorClass<SandboxCapacityError>()(
  "SandboxCapacityError",
  {
    inUse: Schema.Number,
    limit: Schema.Number,
    message: Schema.String,
    organizationId: Schema.String,
  },
) {}

export class SandboxOperationError extends Schema.TaggedErrorClass<SandboxOperationError>()(
  "SandboxOperationError",
  {
    cause: Schema.Unknown,
    leaseId: Schema.optional(Schema.String),
    message: Schema.String,
    operation: Schema.String,
    provider: Schema.String,
    successfulResult: Schema.optional(Schema.Unknown),
  },
) {}

export class SandboxRecordError extends Schema.TaggedErrorClass<SandboxRecordError>()(
  "SandboxRecordError",
  {
    cause: Schema.Unknown,
    message: Schema.String,
  },
) {}

export class SandboxPersistenceUnknownError extends Schema.TaggedErrorClass<SandboxPersistenceUnknownError>()(
  "SandboxPersistenceUnknownError",
  {
    cause: Schema.Unknown,
    leaseId: Schema.String,
    message: Schema.String,
    operation: Schema.String,
    provider: Schema.String,
  },
) {}

export type SandboxManagerError =
  | DatabaseError
  | IdGenerationError
  | RecordDecodeError
  | SandboxCapacityError
  | SandboxOperationError
  | SandboxPersistenceUnknownError
  | SandboxRecordError;

export interface SandboxManagerService {
  readonly checkpoint: (
    sandbox: ManagedSandbox,
    label?: string,
  ) => Effect.Effect<ManagedSandbox & { readonly checkpoint: CheckpointRef }, SandboxManagerError>;
  readonly create: (
    input: CreateSandboxInput,
  ) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly destroy: (
    sandbox: ManagedSandbox,
  ) => Effect.Effect<SandboxLeaseRecordValue, SandboxManagerError>;
  readonly download: (
    input: ManagedDownloadInput,
  ) => Effect.Effect<ReadableStream<Uint8Array>, SandboxManagerError>;
  readonly exec: (
    input: ManagedExecInput,
  ) => Effect.Effect<ExecResult | AsyncExecHandle, SandboxManagerError>;
  readonly reconcileCreate: (
    record: SandboxLeaseRecordValue,
  ) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly reconcileCreateWithLease: (
    record: SandboxLeaseRecordValue,
    lease: SandboxLease,
  ) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly reconcileCreateWithCleanup: (
    record: SandboxLeaseRecordValue,
    lease: SandboxLease,
  ) => Effect.Effect<SandboxLeaseRecordValue, SandboxManagerError>;
  readonly reconcileCheckpoint: (
    record: SandboxLeaseRecordValue,
  ) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly reconcileCheckpointWithResult: (
    record: SandboxLeaseRecordValue,
    reconciliation: CheckpointReconciliation,
  ) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly reconcileResume: (
    record: SandboxLeaseRecordValue,
  ) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly reconcileResumeWithLease: (
    record: SandboxLeaseRecordValue,
    lease: SandboxLease,
  ) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly resolveCreateAsNotAllocated: (
    record: SandboxLeaseRecordValue,
    confirmedAbsentAt: number,
  ) => Effect.Effect<SandboxLeaseRecordValue, SandboxManagerError>;
  readonly resume: (sandbox: ManagedSandbox) => Effect.Effect<ManagedSandbox, SandboxManagerError>;
  readonly upload: (input: ManagedUploadInput) => Effect.Effect<void, SandboxManagerError>;
}

export interface ManagerBase {
  readonly config: SandboxManagerConfig;
  readonly database: DynamoDatabaseService;
  readonly ids: IdGeneratorService;
  readonly now: () => number;
  readonly operationAcquireTimeoutMs: number;
  readonly operationLeaseMs: number;
  readonly operationLeaseNow: () => number;
  readonly provider: SandboxProvider;
  readonly providerMutationSignals: WeakSet<AbortSignal>;
}
