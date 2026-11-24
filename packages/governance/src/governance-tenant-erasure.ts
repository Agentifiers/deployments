import type {
  ErasableTenantRecord,
  ErasureFence,
  TenantErasurePageQuery,
  TenantErasureProgress,
  TenantInventoryLocatorKey,
} from "@deployments-ai/db";
import { hashChain, sha256 } from "./canonical.ts";
import { memorySearchErasureSummary } from "./governance-memory-search-erasure.ts";
import {
  eraseObservability,
  observabilityErasureSummary,
} from "./governance-observability-erasure.ts";
import type { GovernanceServiceContext } from "./service.ts";
import {
  blobReferences,
  completedErasureOperation,
  deleteTenantBlobs,
  deleteTenantErasureObjectPrefixes,
  isActive,
  sortTenantRecords,
} from "./service.ts";
import {
  GovernanceError,
  type GovernanceObjectReference,
  type GovernanceOperation,
  type RetentionCleanup,
  type TenantRecord,
} from "./types.ts";

const DEFAULT_ERASURE_INVOCATION_MILLISECONDS = 10 * 60 * 1_000;

/** Waits that leave a tenant erasure pending for the next dispatch instead of failing it. */
export const ACKNOWLEDGED_ERASURE_WAITS: Readonly<Record<string, true>> = {
  brain_search_drain_pending: true,
  memory_search_drain_pending: true,
  memory_search_purge_pending: true,
  observability_erasure_pending: true,
  tenant_app_provisioning_pending: true,
  tenant_erasure_continuing: true,
  tenant_governance_busy: true,
};

const SURVEYED_ITEM_TYPES: Readonly<Record<string, true>> = {
  app: true,
  "brain-upload-lease": true,
  run: true,
};

type DeletePhase = Extract<TenantErasureProgress, { readonly phase: "delete" }>;

export function isActiveBrainUploadLease(record: TenantRecord["record"], now: Date) {
  return (
    record.itemType === "brain-upload-lease" &&
    record.data.status === "active" &&
    Date.parse(record.data.expiresAt) > now.getTime()
  );
}

function continuing(): never {
  throw new GovernanceError(
    "tenant_erasure_continuing",
    "Tenant erasure checkpointed its progress and continues in the next invocation.",
  );
}

function appErasureUnavailable() {
  return new GovernanceError(
    "tenant_app_erasure_unavailable",
    "Tenant erasure found agent-built apps but cannot erase their databases.",
  );
}

function recordKey({ record, table }: TenantRecord) {
  return `${table}\u0000${record.pk}\u0000${record.sk}`;
}

/**
 * Runs a tenant erasure in invocation-sized steps. Under the erasure fence it surveys the
 * inventory for active work, purges search, then deletes the inventory page by page in passes
 * until a pass changes nothing, and last deletes the audit events its receipt hashes. Progress
 * lives on the operation, so a later invocation resumes where a timeout or crash stopped it.
 */
export async function runTenantErasure(
  { now, options }: Pick<GovernanceServiceContext, "now" | "options">,
  claimed: GovernanceOperation,
  claimedAt: string,
  leaseExpiresAt: string,
): Promise<GovernanceOperation> {
  const { store } = options;
  const organizationId = claimed.organizationId;
  const fence: ErasureFence = { createdAt: claimedAt, operationId: claimed.id, organizationId };
  const deadline =
    Date.parse(claimedAt) +
    (options.erasureInvocationMilliseconds ?? DEFAULT_ERASURE_INVOCATION_MILLISECONDS);
  let current = claimed;
  let purgeStarted = false;
  let appErasureStarted = false;
  const checkpoint = async (changes: Partial<GovernanceOperation>) => {
    current = await store.updateOperation(
      { ...current, ...changes, updatedAt: now().toISOString(), version: current.version + 1 },
      current.version,
    );
  };
  const saveProgress = (erasureProgress: TenantErasureProgress) => checkpoint({ erasureProgress });
  const outOfTime = () => now().getTime() >= deadline;

  const survey = async (cursor: string | undefined) => {
    const governance = await store.listTenantGovernanceRecords(organizationId);
    const runningGovernance = governance.flatMap((item) =>
      item.record.itemType === "governance-operation" &&
      item.record.data.id !== current.id &&
      item.record.data.status === "running"
        ? [item.record]
        : [],
    );
    if (
      runningGovernance.some(
        (record) =>
          record.data.leaseExpiresAt !== undefined &&
          Date.parse(record.data.leaseExpiresAt) > now().getTime(),
      )
    ) {
      throw new GovernanceError(
        "tenant_governance_busy",
        "Tenant erasure is waiting for active governance operations to finish.",
      );
    }
    for (const record of runningGovernance) {
      const stale = await store.getOperation(organizationId, record.data.id);
      if (!stale || stale.status !== "running") continue;
      const { leaseExpiresAt: _leaseExpiresAt, ...staleWithoutLease } = stale;
      await store.cancelOperationForErasure(
        {
          ...staleWithoutLease,
          error: {
            code: "operation_canceled_by_erasure",
            message: "The stale governance operation was canceled by tenant erasure.",
          },
          status: "canceled",
          updatedAt: now().toISOString(),
          version: stale.version + 1,
        },
        stale.version,
        current.id,
      );
    }
    const selection = {
      select: (locator: { readonly recordItemType: string }) =>
        SURVEYED_ITEM_TYPES[locator.recordItemType] ? ("consistent" as const) : undefined,
    };
    let next = cursor;
    do {
      if (outOfTime()) {
        await saveProgress({ ...(next ? { cursor: next } : {}), phase: "survey" });
        continuing();
      }
      const page = await store.listTenantRecords(organizationId, next, selection);
      if (page.items.some((item) => item.record.itemType === "run" && isActive(item.record))) {
        const { erasureProgress: _surveyProgress, ...withoutProgress } = current;
        current = await store.updateOperation(
          { ...withoutProgress, updatedAt: now().toISOString(), version: current.version + 1 },
          current.version,
        );
        await store.releaseErasureFence(fence);
        throw new GovernanceError(
          "tenant_has_active_runs",
          "Tenant erasure cannot start while runs are active.",
        );
      }
      if (page.items.some((item) => isActiveBrainUploadLease(item.record, now()))) {
        await saveProgress({ ...(next ? { cursor: next } : {}), phase: "survey" });
        throw new GovernanceError(
          "tenant_brain_uploads_pending",
          "Tenant erasure is waiting for active Brain content streams to terminate.",
        );
      }
      if (!options.eraseApp && page.items.some((item) => item.record.itemType === "app")) {
        throw appErasureUnavailable();
      }
      next = page.cursor;
    } while (next);
    await stageOrphanAuditExports(await store.listTenantGovernanceRecords(organizationId));
    await saveProgress({ pass: 1, passChanged: false, phase: "delete", recordsDeleted: 0 });
  };

  const stageOrphanAuditExports = async (governance: readonly TenantRecord[]) => {
    const manifested = new Set(
      governance.flatMap((item) =>
        item.record.itemType === "immutable-audit-export" ? [item.record.data.id] : [],
      ),
    );
    for (const item of governance) {
      if (item.record.itemType !== "governance-operation") continue;
      const operation = item.record;
      if (operation.data.kind === "tenant-export" && !operation.data.output) {
        const uncheckpointed = await options.objectStore.find(
          `governance/${organizationId}/${operation.data.id}/tenant.jsonl`,
        );
        if (uncheckpointed) await options.objectStore.deleteAllVersions(uncheckpointed);
      }
      if (operation.data.kind !== "audit-export" || manifested.has(operation.data.id)) continue;
      const discovered = await Promise.all(
        ["audit-records.jsonl", "audit-manifest.json"].map((name) =>
          options.objectStore.find(`governance/${organizationId}/${operation.data.id}/${name}`),
        ),
      );
      const references = [
        ...blobReferences(options, organizationId, operation, true),
        ...discovered.filter(
          (reference): reference is GovernanceObjectReference => reference !== undefined,
        ),
      ].filter(
        (reference, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.bucket === reference.bucket &&
              candidate.key === reference.key &&
              candidate.versionId === reference.versionId,
          ) === index,
      );
      if (references.length === 0) continue;
      const cleanup: RetentionCleanup = {
        createdAt: claimedAt,
        id: sha256(`${item.table}\u0000${operation.pk}\u0000${operation.sk}`),
        ...(operation.data.auditRetainedUntil
          ? { notBefore: operation.data.auditRetainedUntil }
          : {}),
        organizationId,
        references: references.map((reference) => ({
          bucket: reference.bucket,
          deleteAllVersions: false,
          key: reference.key,
          ...(reference.versionId ? { versionId: reference.versionId } : {}),
        })),
        sourceItemType: operation.itemType,
        sourcePk: operation.pk,
        sourceSk: operation.sk,
        sourceTable: item.table,
      };
      await store.stageErasureRetentionCleanup(item, cleanup, current.id);
    }
  };

  const purgeSearch = async () => {
    if (!current.memorySearchErasureReceipt && options.purgeMemorySearch) {
      purgeStarted = true;
      await checkpoint({
        memorySearchErasureReceipt: await options.purgeMemorySearch(organizationId, current.id),
      });
    }
    if (!current.brainSearchErasureReceipt && options.purgeBrainSearch) {
      purgeStarted = true;
      await checkpoint({
        brainSearchErasureReceipt: await options.purgeBrainSearch(organizationId, current.id),
      });
    }
  };

  const retained = (item: TenantRecord) =>
    (item.record.itemType === "governance-operation" && item.record.data.id === current.id) ||
    item.record.itemType === "erasure-fence" ||
    item.record.itemType === "organization" ||
    item.record.itemType === "immutable-audit-export" ||
    item.record.itemType === "erasure-receipt" ||
    (item.record.itemType === "retention-cleanup" &&
      item.record.data.sourceItemType === "governance-operation" &&
      item.record.data.notBefore !== undefined &&
      Date.parse(item.record.data.notBefore) > Date.parse(claimedAt) &&
      item.record.data.references.length > 0 &&
      item.record.data.references.every((reference) => !reference.deleteAllVersions));

  let uploadsPending = false;
  const listPage = async (query: TenantErasurePageQuery) => {
    const page = await store.listTenantErasurePage(organizationId, query);
    const targets: ErasableTenantRecord[] = [];
    let appsErased = false;
    for (const item of page.records) {
      if (retained(item) || item.record.itemType === "audit-event") continue;
      if (item.record.itemType === "app") {
        // Erasing an app deletes its record and children and writes its erased event, which a
        // later page or pass lists and deletes.
        if (!options.eraseApp) throw appErasureUnavailable();
        appErasureStarted = true;
        await options.eraseApp({ app: item.record, operationId: current.id });
        appsErased = true;
        continue;
      }
      if (item.record.itemType === "artifact") {
        // Older artifact records used accessUrlExpiresAt for both PUT and GET grants. Waiting on
        // it is conservative and closes the migration window.
        const expiresAt =
          item.record.data.uploadUrlExpiresAt ?? item.record.data.accessUrlExpiresAt;
        if (expiresAt !== undefined && Date.parse(expiresAt) > now().getTime()) {
          for (const reference of blobReferences(options, organizationId, item.record, true)) {
            await options.objectStore.blockWrites(reference);
          }
          uploadsPending = true;
          continue;
        }
      }
      targets.push(item);
    }
    const threadIds = new Set<string>();
    for (const { record } of targets) {
      const data = record.data as Readonly<Record<string, unknown>>;
      if (record.itemType === "thread" && typeof data.id === "string") threadIds.add(data.id);
      if (typeof data.threadId === "string") threadIds.add(data.threadId);
    }
    const leases = threadIds.size > 0 ? await store.listLegacyRuntimeLeases([...threadIds]) : [];
    const counted = new Set(
      [...targets, ...targets.flatMap((item) => item.dependents ?? []), ...leases].map(recordKey),
    );
    return {
      changed: appsErased || counted.size > 0 || page.staleLocators.length > 0,
      count: counted.size,
      cursor: page.cursor,
      leases,
      staleLocators: page.staleLocators,
      targets,
    };
  };

  const deletePage = async ({
    leases,
    staleLocators,
    targets,
  }: {
    readonly leases: readonly TenantRecord[];
    readonly staleLocators: readonly TenantInventoryLocatorKey[];
    readonly targets: readonly ErasableTenantRecord[];
  }) => {
    if (leases.length > 0) await store.eraseTenantRecords(fence, leases, [], leaseExpiresAt);
    await deleteTenantBlobs(options, organizationId, targets);
    if (targets.length > 0 || staleLocators.length > 0) {
      await store.eraseTenantRecords(fence, targets, staleLocators, leaseExpiresAt);
    }
  };

  const deleteInventory = async (start: DeletePhase) => {
    let { pass, passChanged, recordsDeleted } = start;
    const save = (cursor: string | undefined, counted?: { readonly through?: string }) =>
      saveProgress({
        ...(counted ? { counted } : {}),
        ...(cursor ? { cursor } : {}),
        pass,
        passChanged,
        phase: "delete",
        recordsDeleted,
      });
    let cursor = start.cursor;
    let passDone = false;
    if (start.counted) {
      const through = start.counted.through;
      let replay = cursor;
      do {
        const page = await listPage({
          ...(replay ? { cursor: replay } : {}),
          through: through ? { cursor: through } : {},
        });
        await deletePage(page);
        replay = page.cursor;
      } while (replay);
      cursor = through;
      passDone = through === undefined;
    }
    for (;;) {
      while (!passDone) {
        if (outOfTime()) {
          await save(cursor);
          continuing();
        }
        const page = await listPage(cursor ? { cursor } : {});
        if (page.count > 0 || (page.changed && !passChanged)) {
          passChanged = true;
          recordsDeleted += page.count;
          await save(
            cursor,
            page.count > 0 ? (page.cursor ? { through: page.cursor } : {}) : undefined,
          );
        }
        await deletePage(page);
        cursor = page.cursor;
        passDone = cursor === undefined;
      }
      if (!passChanged && !uploadsPending) return recordsDeleted;
      pass += 1;
      passChanged = false;
      passDone = false;
      await save(undefined);
      if (uploadsPending) {
        throw new GovernanceError(
          "tenant_artifact_uploads_pending",
          "Tenant erasure is waiting for outstanding artifact upload URLs to expire.",
        );
      }
    }
  };

  const deleteAuditTrail = async (recordsDeleted: number, counted: boolean) => {
    const audits: ErasableTenantRecord[] = [];
    const staleLocators: TenantInventoryLocatorKey[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listTenantErasurePage(organizationId, cursor ? { cursor } : {});
      audits.push(...page.records.filter((item) => item.record.itemType === "audit-event"));
      staleLocators.push(...page.staleLocators);
      cursor = page.cursor;
    } while (cursor);
    const legacyIdempotency = await store.listLegacyPrincipalIdempotency(organizationId);
    if (!counted) {
      await checkpoint({
        ...(current.erasureAuditRootHash
          ? {}
          : {
              erasureAuditRootHash: hashChain(sortTenantRecords(audits).map(({ record }) => record))
                .rootHash,
            }),
        erasureProgress: {
          phase: "final",
          recordsDeleted: recordsDeleted + audits.length + legacyIdempotency.length,
        },
      });
    }
    await store.eraseTenantRecords(
      fence,
      [...audits, ...legacyIdempotency],
      staleLocators,
      leaseExpiresAt,
    );
  };

  try {
    if (current.canonicalDeletedAt === undefined) {
      await store.beginErasure(fence);
      const progress = current.erasureProgress ?? { phase: "survey" };
      if (progress.phase === "survey") await survey(progress.cursor);
      if (outOfTime()) continuing();
      await purgeSearch();
      const settled = current.erasureProgress!;
      if (settled.phase === "delete") {
        await deleteAuditTrail(await deleteInventory(settled), false);
      } else if (settled.phase === "final") {
        await deleteAuditTrail(settled.recordsDeleted, true);
      }
      await deleteTenantErasureObjectPrefixes(options, organizationId);
      await checkpoint({ canonicalDeletedAt: now().toISOString() });
    }
    await eraseObservability({
      checkpoint: (updated) => {
        current = updated;
      },
      now,
      operation: current,
      purgeObservability: options.purgeObservability,
      store,
    });
    const memorySearch = memorySearchErasureSummary(current);
    const observability = observabilityErasureSummary(current);
    const settled = current.erasureProgress;
    if (current.erasureAuditRootHash === undefined || settled?.phase !== "final") {
      throw new GovernanceError(
        "erasure_checkpoint_incomplete",
        "The tenant erasure evidence checkpoint is incomplete.",
      );
    }
    const receipt = {
      auditRootHash: current.erasureAuditRootHash,
      completedAt: now().toISOString(),
      id: current.id,
      ...(memorySearch ? { memorySearch } : {}),
      ...(observability ? { observability } : {}),
      organizationHash: sha256(current.organizationId),
      recordsDeleted: settled.recordsDeleted + 1,
      requestedByPrincipalHash: sha256(current.requestedByPrincipalId),
    };
    await store.finalizeErasure(current, receipt, current.version);
    return completedErasureOperation(organizationId, receipt, current);
  } catch (failure) {
    const { leaseExpiresAt: _leaseExpiresAt, ...currentWithoutLease } = current;
    const acknowledgedWait =
      failure instanceof GovernanceError && Object.hasOwn(ACKNOWLEDGED_ERASURE_WAITS, failure.code);
    const updated = await store.updateOperation(
      {
        ...currentWithoutLease,
        error: {
          code: failure instanceof GovernanceError ? failure.code : "governance_operation_failed",
          message: failure instanceof Error ? failure.message : String(failure),
        },
        status:
          acknowledgedWait ||
          purgeStarted ||
          appErasureStarted ||
          current.memorySearchErasureReceipt !== undefined ||
          current.brainSearchErasureReceipt !== undefined
            ? "pending"
            : "failed",
        updatedAt: now().toISOString(),
        version: current.version + 1,
      },
      current.version,
    );
    if (acknowledgedWait) return updated;
    throw failure;
  }
}
