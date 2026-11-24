import { runConversationErasure } from "./governance-conversation-erasure.ts";
import { makeGovernanceAuditExport } from "./governance-audit-export.ts";
import { makeGovernanceTenantExport } from "./governance-tenant-export.ts";
import { runTenantErasure } from "./governance-tenant-erasure.ts";
import type { GovernanceServiceContext } from "./service.ts";
import { OPERATION_LEASE_MILLISECONDS, allTenantRecords } from "./service.ts";
import { GovernanceError, type GovernanceObjectReference } from "./types.ts";

export { isActiveBrainUploadLease } from "./governance-tenant-erasure.ts";

export function makeGovernanceOperationRunner(
  context: GovernanceServiceContext & {
    readonly auditExport: ReturnType<typeof makeGovernanceAuditExport>;
    readonly tenantExport: ReturnType<typeof makeGovernanceTenantExport>;
  },
) {
  const { auditExport, getOperation, now, options, tenantExport } = context;
  return async (organizationId: string, operationId: string) => {
    const pending = await getOperation(organizationId, operationId);
    if (!pending)
      throw new GovernanceError("operation_not_found", "Governance operation not found.");
    if (pending.status === "completed") return pending;
    const observedAt = now();
    const activeLease =
      pending.status === "running" &&
      pending.leaseExpiresAt !== undefined &&
      Date.parse(pending.leaseExpiresAt) > observedAt.getTime();
    if (
      activeLease ||
      (pending.status !== "pending" && pending.status !== "failed" && pending.status !== "running")
    ) {
      throw new GovernanceError(
        "operation_not_runnable",
        "Governance operation is already running.",
      );
    }
    const claimedAt = observedAt.toISOString();
    const leaseExpiresAt = new Date(
      observedAt.getTime() + OPERATION_LEASE_MILLISECONDS,
    ).toISOString();
    const {
      error: _previousError,
      leaseExpiresAt: _previousLeaseExpiresAt,
      ...pendingWithoutError
    } = pending;
    let current = await options.store.claimOperation(
      {
        ...pendingWithoutError,
        leaseExpiresAt,
        startedAt: pending.startedAt ?? claimedAt,
        status: "running",
        updatedAt: claimedAt,
        version: pending.version + 1,
      },
      pending.version,
    );
    if (current.kind === "thread-erasure" || current.kind === "end-user-erasure") {
      return runConversationErasure({ now, options }, current);
    }
    if (current.kind === "tenant-erasure") {
      return runTenantErasure({ now, options }, current, claimedAt, leaseExpiresAt);
    }
    const snapshotFence = {
      createdAt: claimedAt,
      operationId: current.id,
      organizationId,
    };
    let snapshotFenceHeld = true;
    const releaseSnapshotFence = async () => {
      if (!snapshotFenceHeld) return;
      await options.store.releaseErasureFence(snapshotFence);
      snapshotFenceHeld = false;
    };
    try {
      const hasDurableExportSnapshot =
        (current.kind === "tenant-export" && current.output !== undefined) ||
        (current.kind === "audit-export" && current.archive !== undefined);
      const records = hasDurableExportSnapshot
        ? []
        : await allTenantRecords(options, organizationId);
      const snapshotLegacyRuntimeLeases = records.filter(
        (item) =>
          item.record.itemType === "runtime-lease" && item.record.data.organizationId === undefined,
      );
      if (snapshotLegacyRuntimeLeases.length > 0) {
        await options.store.scopeLegacyRuntimeLeases(
          organizationId,
          snapshotLegacyRuntimeLeases,
          current.id,
        );
      }
      const checkpoint = (updated: typeof current) => {
        current = updated;
      };
      const result: {
        archive?: GovernanceObjectReference;
        object?: GovernanceObjectReference;
        summary: Record<string, unknown>;
      } =
        current.kind === "tenant-export"
          ? await tenantExport(
              current,
              records.filter(
                (item) =>
                  item.record.itemType !== "erasure-fence" &&
                  (item.record.itemType !== "governance-operation" ||
                    item.record.data.id !== current.id),
              ),
              checkpoint,
              releaseSnapshotFence,
            )
          : await auditExport(current, records, checkpoint, releaseSnapshotFence);
      const completedAt = now().toISOString();
      const { leaseExpiresAt: _leaseExpiresAt, ...currentWithoutLease } = current;
      current = await options.store.updateOperation(
        {
          ...currentWithoutLease,
          ...(result.archive ? { archive: result.archive } : {}),
          completedAt,
          ...(result.object ? { output: result.object } : {}),
          status: "completed",
          summary: result.summary,
          updatedAt: completedAt,
          version: current.version + 1,
        },
        current.version,
      );
      return current;
    } catch (cause) {
      let failure = cause;
      try {
        await releaseSnapshotFence();
      } catch (releaseCause) {
        failure = releaseCause;
      }
      const { leaseExpiresAt: _leaseExpiresAt, ...currentWithoutLease } = current;
      await options.store.updateOperation(
        {
          ...currentWithoutLease,
          error: {
            code: failure instanceof GovernanceError ? failure.code : "governance_operation_failed",
            message: failure instanceof Error ? failure.message : String(failure),
          },
          status: "failed",
          updatedAt: now().toISOString(),
          version: current.version + 1,
        },
        current.version,
      );
      throw failure;
    }
  };
}
