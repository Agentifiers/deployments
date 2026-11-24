import { Schema } from "effect";
import { activeOrganizationCondition } from "./brains/authorization-conditions.ts";
import type { DynamoDatabaseService, TransactionOperation } from "./client-types.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import {
  MemorySearchMutationFenceRecord,
  MemorySearchPlacementRecord,
} from "./records/memory-search.ts";

export type MemorySearchPlacement = typeof MemorySearchPlacementRecord.Type;

function envelopeRecords(organizationId: string, now: string) {
  const placement = Schema.decodeUnknownSync(MemorySearchPlacementRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now,
        generation: 0,
        organizationId,
        phase: "unconfigured" as const,
        updatedAt: now,
        version: 0,
        writeTargets: [],
      },
      itemType: "memory-search-placement" as const,
    }),
  );
  const fence = Schema.decodeUnknownSync(MemorySearchMutationFenceRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now,
        epoch: 0,
        organizationId,
        status: "open" as const,
        updatedAt: now,
        version: 0,
      },
      itemType: "memory-search-mutation-fence" as const,
    }),
  );
  return { fence, placement };
}

async function existing<
  ItemType extends "memory-search-mutation-fence" | "memory-search-placement",
>(
  database: DynamoDatabaseService,
  record: { readonly itemType: ItemType; readonly pk: string; readonly sk: string },
) {
  const value = await database.getRecord("control", { pk: record.pk, sk: record.sk }, true);
  return value?.itemType === record.itemType ? value : undefined;
}

/**
 * Returns the organization's memory search placement, creating the unconfigured placement and
 * open mutation fence that organization creation writes when an active organization predates them.
 */
export async function ensureMemorySearchPlacement(input: {
  readonly database: DynamoDatabaseService;
  readonly now: string;
  readonly organizationId: string;
}): Promise<MemorySearchPlacement> {
  const { fence, placement } = envelopeRecords(input.organizationId, input.now);
  const current = await existing(input.database, placement);
  if (current?.itemType === "memory-search-placement") return current;
  const operations: TransactionOperation[] = [
    activeOrganizationCondition(input.organizationId),
    { kind: "put", record: placement },
  ];
  if (!(await existing(input.database, fence))) operations.push({ kind: "put", record: fence });
  try {
    await input.database.transactWrite(operations);
  } catch (cause) {
    const reconciled = await existing(input.database, placement);
    if (reconciled?.itemType === "memory-search-placement") return reconciled;
    throw cause;
  }
  return placement;
}
