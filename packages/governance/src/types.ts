import type {
  AppRecord,
  ConversationErasureStore,
  ErasedThreadRun,
  GovernanceObjectReference,
  GovernanceStore,
} from "@deployments-ai/db";
import type { MemorySearchErasureReceipt } from "./governance-memory-search-erasure.ts";
import type {
  ObservabilityErasureRequest,
  ObservabilityErasureResult,
} from "./governance-observability-erasure.ts";

export {
  DEFAULT_RETENTION_POLICY,
  GovernanceError,
  RETENTION_CLASSES,
  type ErasureFence,
  type ErasureMemorySearchSummary,
  type ErasureObservabilitySummary,
  type ErasureReceipt,
  type GovernanceObjectReference,
  type GovernanceOperation,
  type GovernanceOperationKind,
  type GovernanceOperationListQuery,
  type GovernanceOperationPage,
  type GovernanceOperationStatus,
  type GovernanceStore,
  type ImmutableAuditExportManifest,
  type RetentionClass,
  type RetentionCleanup,
  type RetentionCleanupReference,
  type RetentionPolicy,
  type RetentionPolicyPatch,
  type StoredRetentionPolicy,
  type TenantRecord,
  type TenantRecordPage,
} from "@deployments-ai/db";

export interface GovernanceObjectStore {
  readonly blockWrites: (reference: {
    readonly bucket: string;
    readonly key: string;
  }) => Promise<void>;
  readonly delete: (reference: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId?: string | undefined;
  }) => Promise<void>;
  readonly deleteAllVersions: (reference: {
    readonly bucket: string;
    readonly key: string;
  }) => Promise<void>;
  readonly deleteAllVersionsUnderPrefix?: (reference: {
    readonly bucket: string;
    readonly keyPrefix: string;
  }) => Promise<void>;
  readonly find: (key: string) => Promise<GovernanceObjectReference | undefined>;
  readonly put: (input: {
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly immutable: boolean;
    readonly key: string;
    readonly retainUntil?: string;
    readonly sha256: string;
  }) => Promise<GovernanceObjectReference>;
  readonly read: (reference: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId?: string | undefined;
  }) => Promise<Uint8Array>;
  readonly size: (reference: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId?: string | undefined;
  }) => Promise<number>;
}

export interface GovernanceSigner {
  readonly keyId: string;
  readonly publicKey: () => Promise<string>;
  readonly sign: (digest: Uint8Array) => Promise<string>;
}

export interface ConversationErasureThread {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly threadId: string;
}

export interface ConversationErasurePorts {
  readonly cancelRun: (input: {
    readonly actorId: string;
    readonly run: ErasedThreadRun;
  }) => Promise<void>;
  readonly deleteAutomationTimer: (automationId: string) => Promise<void>;
  readonly deleteThreadStream: (thread: ConversationErasureThread) => Promise<void>;
  readonly purgeThreadMemories: (input: {
    readonly memories: readonly { readonly pk: string; readonly sk: string }[];
    readonly operationId: string;
    readonly organizationId: string;
    readonly threadId: string;
  }) => Promise<void>;
  readonly store: ConversationErasureStore;
}

export interface AppTableObject {
  readonly bucket: string;
  readonly contentType: string;
  readonly key: string;
}

export interface GovernanceServiceOptions {
  readonly allowedObjectBuckets: readonly string[];
  readonly conversationErasure?: ConversationErasurePorts;
  readonly eraseApp?: (input: {
    readonly app: AppRecord;
    readonly operationId: string;
  }) => Promise<void>;
  readonly exportAppTables?: (input: {
    readonly app: AppRecord;
    readonly operationId: string;
  }) => Promise<readonly AppTableObject[]>;
  /**
   * How long one invocation of a tenant erasure keeps working before it checkpoints and leaves
   * the operation pending for the next dispatch; defaults to 10 minutes.
   */
  readonly erasureInvocationMilliseconds?: number;
  readonly generateId: () => Promise<string>;
  readonly now?: () => Date;
  readonly objectStore: GovernanceObjectStore;
  readonly purgeBrainSearch?: (
    organizationId: string,
    operationId: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
  readonly purgeMemorySearch?: (
    organizationId: string,
    operationId: string,
  ) => Promise<MemorySearchErasureReceipt>;
  /** Purges tenant observability facts; omitted when observability is not deployed. */
  readonly purgeObservability?: (
    request: ObservabilityErasureRequest,
  ) => Promise<ObservabilityErasureResult>;
  readonly signer: GovernanceSigner;
  readonly snapshotByteLimit?: number;
  readonly store: GovernanceStore;
  readonly tenantErasureObjectPrefixes?: readonly {
    readonly bucket: string;
    readonly keyPrefixRoot: string;
  }[];
}

export class GovernanceObjectNotFoundError extends Error {
  constructor(
    readonly reference: {
      readonly bucket: string;
      readonly key: string;
      readonly versionId?: string | undefined;
    },
  ) {
    super(`Governance object ${reference.bucket}/${reference.key} was not found.`);
    this.name = "GovernanceObjectNotFoundError";
  }
}
