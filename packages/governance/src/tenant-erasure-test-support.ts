import type { GovernanceStore, TenantRecord } from "./types.ts";

/**
 * The erasure listing and deletes over an in-memory store: one page holds every record, and
 * deletes go through the fake's own `deleteTenantRecords` before leaving every list it keeps.
 */
export function fakeTenantErasure(
  records: TenantRecord[],
  legacyRuntimeLeases: TenantRecord[],
  deleteTenantRecords: GovernanceStore["deleteTenantRecords"],
): Pick<
  GovernanceStore,
  "eraseTenantRecords" | "listTenantErasurePage" | "listTenantGovernanceRecords"
> {
  return {
    eraseTenantRecords: async (_fence, items, _staleLocators, retryDeadline) => {
      if (items.length === 0) return;
      await deleteTenantRecords(items, retryDeadline);
      for (const list of [records, legacyRuntimeLeases]) {
        for (const item of items) {
          const index = list.indexOf(item);
          if (index >= 0) list.splice(index, 1);
        }
      }
    },
    listTenantErasurePage: async () => ({ records: [...records], staleLocators: [] }),
    listTenantGovernanceRecords: async () =>
      records.filter(
        (item) =>
          item.record.itemType === "governance-operation" ||
          item.record.itemType === "immutable-audit-export",
      ),
  };
}
