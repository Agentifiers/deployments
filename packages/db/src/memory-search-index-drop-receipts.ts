import { Schema } from "effect";
import type { DynamoDatabaseService } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import { Keys } from "./keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "./records/index.ts";
import { MemorySearchIndexDropReceiptRecord } from "./records/memory-search.ts";
import { isDatabaseWriteConflict } from "./transaction-conditions.ts";

export type MemorySearchIndexDropReceipt = Extract<
  PlatformRecord,
  { readonly itemType: "memory-search-index-drop-receipt" }
>;

export type MemorySearchIndexDrop = Omit<
  MemorySearchIndexDropReceipt["data"],
  "createdAt" | "updatedAt" | "version"
>;

export async function readMemorySearchIndexDropReceipt(
  database: DynamoDatabaseService,
  organizationId: Ulid,
): Promise<MemorySearchIndexDropReceipt | undefined> {
  const record = await database.getRecord(
    "control",
    Keys.control.memorySearchIndexDropReceipt(organizationId),
    true,
  );
  return record?.itemType === "memory-search-index-drop-receipt" ? record : undefined;
}

/**
 * Creates the organization's receipt. When a receipt already exists, from an earlier or a
 * concurrent drop, returns the stored one unchanged.
 */
export async function recordMemorySearchIndexDrop(
  database: DynamoDatabaseService,
  drop: MemorySearchIndexDrop,
): Promise<MemorySearchIndexDropReceipt> {
  const record = Schema.decodeUnknownSync(MemorySearchIndexDropReceiptRecord)(
    withCanonicalRecordKeys({
      data: { ...drop, createdAt: drop.droppedAt, updatedAt: drop.droppedAt, version: 0 },
      itemType: "memory-search-index-drop-receipt" as const,
    }),
  );
  try {
    await database.transactWrite([{ kind: "put", record }]);
    return record;
  } catch (cause) {
    if (!isDatabaseWriteConflict(cause)) throw cause;
    const stored = await readMemorySearchIndexDropReceipt(database, drop.organizationId);
    if (!stored) throw cause;
    return stored;
  }
}
