import type { PlatformRecord, TableName } from "../records/index.ts";
import type {
  ConversationErasureState,
  GovernanceOperationKind,
  TenantErasureProgress,
} from "../records/governance.ts";

export type { GovernanceOperationKind, TenantErasureProgress } from "../records/governance.ts";

export const RETENTION_CLASSES = [
  "threads",
  "messages",
  "runs",
  "artifacts",
  "events",
  "audit",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export type RetentionPolicy = Readonly<Record<RetentionClass, number>>;
export type RetentionPolicyPatch = Readonly<Partial<Record<RetentionClass, number | undefined>>>;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  artifacts: 365,
  audit: 2_555,
  events: 365,
  messages: 365,
  runs: 365,
  threads: 365,
});

/**
 * Item types DynamoDB TTL expires instead of governance retention deletes. Every put of one carries
 * `ttl` at its retention timestamp plus its organization's class period when it was written, and
 * so does its inventory locator.
 */
export const RETENTION_TTL_CLASS_BY_ITEM_TYPE = {
  "brain-query-attempt": "runs",
  "brain-retrieval": "runs",
  "memory-recall-attempt": "runs",
  "memory-retrieval": "runs",
  "semantic-event": "events",
} as const satisfies Partial<Record<PlatformRecord["itemType"], RetentionClass>>;

export function expiresByRetentionTtl(
  itemType: string,
): itemType is keyof typeof RETENTION_TTL_CLASS_BY_ITEM_TYPE {
  return Object.hasOwn(RETENTION_TTL_CLASS_BY_ITEM_TYPE, itemType);
}

/**
 * Time past a record's retention deadline at which its item TTL falls: the most a TTL'd record
 * outlives its deadline. It covers the daily retention sweep, which today deletes a record up to a
 * day late, plus the time a restamp needs to raise TTLs after a period gets longer.
 */
export const RETENTION_TTL_GRACE_SECONDS = 48 * 3_600;

/**
 * How long after a lengthening commits its restamp starts. Every write that read the earlier
 * policy has committed by then, since none outlives a 900 s Lambda invocation.
 */
export const RETENTION_RESTAMP_START_DELAY_MILLISECONDS = 15 * 60_000;

/**
 * A pending raise of an organization's item TTLs to its current policy. `soonest` raises only
 * TTLs falling within `RETENTION_TTL_GRACE_SECONDS`; `all` then raises the rest.
 */
export interface RetentionRestamp {
  readonly createdAt: string;
  readonly cursor?: string | undefined;
  readonly dueAt: string;
  readonly organizationId: string;
  readonly phase: "all" | "soonest";
  readonly policyVersion: number;
  readonly updatedAt: string;
  readonly version: number;
}

export interface RetentionRestampPage {
  readonly cursor?: string | undefined;
  readonly restamped: number;
}

export interface RetentionRestampStore {
  readonly getRetentionRestamp: (organizationId: string) => Promise<RetentionRestamp | undefined>;
  /** Writes `restamp` if the stored one is still at `previousVersion` and its policy; false if not. */
  readonly putRetentionRestamp: (
    restamp: RetentionRestamp,
    previousVersion: number,
  ) => Promise<boolean>;
  readonly deleteRetentionRestamp: (restamp: RetentionRestamp) => Promise<boolean>;
  /**
   * Raises to `policy` the item TTL of one inventory page's records and their locators, only where
   * that is later than the stored TTL, and when `expiringBefore` is set only TTLs before it.
   */
  readonly restampRetentionTtlPage: (
    organizationId: string,
    input: {
      readonly cursor?: string | undefined;
      readonly expiringBefore?: number | undefined;
      readonly policy: RetentionPolicy;
    },
  ) => Promise<RetentionRestampPage>;
}

export interface GovernanceObjectReference {
  readonly bucket: string;
  readonly etag?: string;
  readonly key: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly versionId: string;
}

export type GovernanceOperationStatus = "canceled" | "completed" | "failed" | "pending" | "running";

export interface GovernanceOperation {
  readonly archive?: GovernanceObjectReference;
  readonly auditRetainedUntil?: string;
  readonly auditSignature?: string;
  readonly auditSignatureKeyId?: string;
  readonly auditSignaturePublicKey?: string;
  readonly brainSearchErasureReceipt?: Readonly<Record<string, unknown>>;
  readonly canonicalDeletedAt?: string;
  readonly completedAt?: string;
  readonly conversationErasure?: ConversationErasureState;
  readonly createdAt: string;
  readonly dispatchReadyAt?: string;
  readonly erasureAuditRootHash?: string;
  readonly erasureProgress?: TenantErasureProgress;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly expiresAt?: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: GovernanceOperationKind;
  readonly leaseExpiresAt?: string;
  readonly memorySearchErasureReceipt?: Readonly<Record<string, unknown>>;
  readonly observabilityErasureProgress?: Readonly<Record<string, unknown>>;
  readonly observabilityErasureReceipt?: Readonly<Record<string, unknown>>;
  readonly organizationId: string;
  readonly output?: GovernanceObjectReference;
  readonly requestedByPrincipalId: string;
  readonly startedAt?: string;
  readonly status: GovernanceOperationStatus;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
  readonly version: number;
}

export interface GovernanceOperationListQuery {
  /** Opaque cursor returned by a previous page of the same organization's history. */
  readonly cursor?: string;
  readonly kind?: GovernanceOperationKind;
  readonly limit: number;
  readonly organizationId: string;
  readonly status?: GovernanceOperationStatus;
}

export interface GovernanceOperationPage {
  readonly cursor?: string;
  readonly items: readonly GovernanceOperation[];
}

export interface TenantRecord {
  readonly record: PlatformRecord;
  readonly table: TableName;
}

export interface TenantRecordPage {
  readonly cursor?: string;
  readonly items: readonly TenantRecord[];
}

/** Locator fields a selective inventory read decides on before reading the canonical record. */
export interface TenantRecordLocator {
  /** Absent on locators written before object digests existed: may name any object. */
  readonly recordObjectDigests?: readonly string[] | undefined;
  readonly recordItemType: string;
  readonly recordPk: string;
  readonly recordSk: string;
  readonly recordTable: TableName;
  readonly recordTimestamp?: string | undefined;
  readonly recordTtl?: number | undefined;
}

/**
 * Chooses which inventory locators to resolve and how. `consistent` strongly reads the record;
 * `eventual` reads it eventually consistently and strongly re-reads it only when the eventual
 * copy does not resolve; `undefined` skips the record. The locator page itself is always
 * strongly read.
 */
export interface TenantRecordSelection {
  readonly select: (locator: TenantRecordLocator) => "consistent" | "eventual" | undefined;
}

export interface TenantInventoryLocatorKey {
  readonly pk: string;
  readonly sk: string;
}

/**
 * A record a tenant erasure deletes. `locators` are the inventory locators its listing found,
 * deleted with it; absent, every locator the record's keys define is deleted. `dependents` are
 * the existing records its own transaction deletes with it: its unique claims and run locator.
 */
export interface ErasableTenantRecord extends TenantRecord {
  readonly dependents?: readonly TenantRecord[];
  readonly locators?: readonly TenantInventoryLocatorKey[];
}

/**
 * One page of a fenced erasure listing. A locator whose item TTL has passed is skipped: DynamoDB
 * removes it and its record. `staleLocators` name records that are gone or past their TTL.
 */
export interface TenantErasurePage {
  readonly cursor?: string;
  readonly records: readonly ErasableTenantRecord[];
  readonly staleLocators: readonly TenantInventoryLocatorKey[];
}

/**
 * `through` bounds a listing to a page listed before: it stops after that page's end cursor, or
 * at the end of the inventory when `through.cursor` is absent.
 */
export interface TenantErasurePageQuery {
  readonly cursor?: string;
  readonly through?: { readonly cursor?: string };
}

/**
 * Brain-scoped view of the governance tenant inventory: the canonical records whose data names
 * one Brain (see `governanceBrainIds`), read through the Brain inventory index instead of the
 * whole organization inventory.
 */
export interface BrainTenantInventory {
  readonly listBrainRecords: (
    organizationId: string,
    brainId: string,
    cursor?: string,
  ) => Promise<TenantRecordPage>;
}

export interface RetentionCleanupReference {
  readonly bucket: string;
  readonly deleteAllVersions: boolean;
  readonly key: string;
  readonly versionId?: string | undefined;
}

export interface RetentionCleanup {
  readonly createdAt: string;
  readonly id: string;
  readonly notBefore?: string | undefined;
  readonly organizationId: string;
  readonly references: readonly RetentionCleanupReference[];
  readonly sourceItemType: string;
  readonly sourcePk: string;
  readonly sourceResourceId?: string | undefined;
  readonly sourceSk: string;
  readonly sourceTable: TableName;
  readonly threadIds?: readonly string[] | undefined;
}

export interface ErasureFence {
  readonly createdAt: string;
  readonly leaseExpiresAt?: string;
  readonly operationId: string;
  readonly organizationId: string;
}

export interface ErasureMemorySearchSummary {
  readonly backupsExpireBy: string;
}

export interface ErasureObservabilitySummary {
  readonly backupsExpireBy: string;
  readonly clickhouseRowsDeleted: number;
  readonly icebergRowsDeleted: number;
  readonly physicalRemovalBy: string;
}

export interface ErasureReceipt {
  readonly auditRootHash: string;
  readonly completedAt: string;
  readonly id: string;
  readonly memorySearch?: ErasureMemorySearchSummary;
  readonly observability?: ErasureObservabilitySummary;
  readonly organizationHash: string;
  readonly recordsDeleted: number;
  readonly requestedByPrincipalHash: string;
}

export interface StoredRetentionPolicy extends RetentionPolicy {
  readonly createdAt: string;
  readonly organizationId: string;
  readonly updatedAt: string;
  readonly updatedByPrincipalId: string;
  readonly version: number;
}

export interface ImmutableAuditExportManifest {
  readonly algorithm: "sha256-chain-v1";
  readonly archive: GovernanceObjectReference;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly firstEventAt?: string;
  readonly id: string;
  readonly lastEventAt?: string;
  readonly object: GovernanceObjectReference;
  readonly organizationId: string;
  readonly recordCount: number;
  readonly retainedUntil: string;
  readonly rootHash: string;
  readonly signature: string;
  readonly signatureKeyId: string;
  readonly signaturePublicKey: string;
}

export interface GovernanceStore {
  readonly appendImmutableAuditExport: (
    manifest: ImmutableAuditExportManifest,
    operation: GovernanceOperation,
    observedAt: string,
  ) => Promise<void>;
  readonly beginErasure: (fence: ErasureFence) => Promise<void>;
  readonly cancelOperationForErasure: (
    operation: GovernanceOperation,
    previousVersion: number,
    erasureOperationId: string,
  ) => Promise<GovernanceOperation>;
  readonly claimOperation: (
    operation: GovernanceOperation,
    previousVersion: number,
  ) => Promise<GovernanceOperation>;
  /** `operatorAccessGrantId` marks the request audit when an administrator acted under access. */
  readonly createOperation: (
    operation: GovernanceOperation,
    operatorAccessGrantId?: string,
  ) => Promise<GovernanceOperation>;
  readonly deleteTenantRecords: (
    records: readonly TenantRecord[],
    retryDeadline: string,
  ) => Promise<void>;
  readonly completeRetentionCleanup: (cleanup: RetentionCleanup) => Promise<void>;
  /**
   * Deletes records under the erasure fence `fence` holds: each ordinary record with plain batch
   * deletes, then the locators the listing found for it and `staleLocators`, so a crash leaves
   * locators behind, never an unlisted record. Unique-claim owners, runs, and organization-gate
   * sources keep one transaction each with their claims, run locator, or gate lanes.
   */
  readonly eraseTenantRecords: (
    fence: ErasureFence,
    records: readonly ErasableTenantRecord[],
    staleLocators: readonly TenantInventoryLocatorKey[],
    retryDeadline: string,
  ) => Promise<void>;
  readonly finalizeErasure: (
    operation: GovernanceOperation,
    receipt: ErasureReceipt,
    previousVersion: number,
  ) => Promise<void>;
  readonly getErasureReceipt: (operationId: string) => Promise<ErasureReceipt | undefined>;
  readonly getOperation: (
    organizationId: string,
    operationId: string,
  ) => Promise<GovernanceOperation | undefined>;
  readonly organizationExists: (organizationId: string) => Promise<boolean>;
  readonly getRetentionPolicy: (
    organizationId: string,
  ) => Promise<StoredRetentionPolicy | undefined>;
  /** Eventually consistent, newest-first operation history for one organization. */
  readonly listOperations: (
    query: GovernanceOperationListQuery,
  ) => Promise<GovernanceOperationPage>;
  /** One page of the organization inventory as an erasure under its fence deletes it. */
  readonly listTenantErasurePage: (
    organizationId: string,
    query: TenantErasurePageQuery,
  ) => Promise<TenantErasurePage>;
  /** Strongly reads the organization's governance operations and immutable audit exports. */
  readonly listTenantGovernanceRecords: (
    organizationId: string,
  ) => Promise<readonly TenantRecord[]>;
  /** One inventory page; every record resolves strongly unless `selection` says otherwise. */
  readonly listTenantRecords: (
    organizationId: string,
    cursor?: string,
    selection?: TenantRecordSelection,
  ) => Promise<TenantRecordPage>;
  readonly listLegacyRuntimeLeases: (
    resourceIds: readonly string[],
  ) => Promise<readonly TenantRecord[]>;
  readonly listLegacyPrincipalIdempotency: (
    organizationId: string,
  ) => Promise<readonly TenantRecord[]>;
  readonly scopeLegacyRuntimeLeases: (
    organizationId: string,
    leases: readonly TenantRecord[],
    fenceOperationId: string,
  ) => Promise<void>;
  /** Also writes `restamp`, replacing any pending one, when the policy lengthens a TTL'd class. */
  readonly putRetentionPolicy: (
    policy: StoredRetentionPolicy,
    previousVersion?: number,
    restamp?: RetentionRestamp,
    operatorAccessGrantId?: string,
  ) => Promise<void>;
  readonly stageRetentionCleanup: (
    item: TenantRecord,
    cleanup: RetentionCleanup,
    fenceOperationId?: string,
  ) => Promise<boolean>;
  readonly releaseErasureFence: (fence: ErasureFence) => Promise<void>;
  readonly stageErasureRetentionCleanup: (
    item: TenantRecord,
    cleanup: RetentionCleanup,
    erasureOperationId: string,
  ) => Promise<void>;
  readonly updateOperation: (
    operation: GovernanceOperation,
    previousVersion: number,
  ) => Promise<GovernanceOperation>;
}

export class GovernanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}
