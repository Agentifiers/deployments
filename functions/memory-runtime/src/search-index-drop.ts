import {
  holdSlot,
  readMemorySearchIndexDropReceipt,
  recordMemorySearchIndexDrop,
  type DynamoDatabaseService,
  type MemorySearchIndexDropReceipt,
  type PlatformRecord,
  type OrganizationHoldReader,
  type Ulid,
} from "@deployments-ai/db";
import {
  isMissingOpenSearchIndex,
  memorySearchIndexOwnership,
  physicalLocationHash,
  type KeptIndex,
  type MemorySearchTarget,
  type OpenSearchTransport,
} from "@deployments-ai/memory";
import {
  decideSearchIndexDrop,
  type SearchIndexDropRefusal,
} from "@deployments-ai/organization-admission";
import { controlRecord } from "./default-search-placement.ts";

type Receipt = MemorySearchIndexDropReceipt["data"];

export type MemorySearchIndexDropResult =
  | { readonly outcome: "already-dropped"; readonly receipt: Receipt }
  | { readonly outcome: "refused"; readonly reason: SearchIndexDropRefusal }
  | { readonly outcome: "nothing-to-drop"; readonly kept: readonly KeptIndex[] }
  | { readonly outcome: "dropped"; readonly kept: readonly KeptIndex[]; readonly receipt: Receipt };

/** Every distinct physical location the placement reads, writes, or migrates to. */
function placementLocations(
  placement: Extract<PlatformRecord, { readonly itemType: "memory-search-placement" }> | undefined,
) {
  const locations = new Map<string, [MemorySearchTarget, ...MemorySearchTarget[]]>();
  const data = placement?.data;
  for (const target of [data?.readTarget, ...(data?.writeTargets ?? []), data?.candidateTarget]) {
    if (!target) continue;
    const identity = physicalLocationHash("dense", target.location);
    const same = locations.get(identity);
    if (same) same.push(target);
    else locations.set(identity, [target]);
  }
  return [...locations.values()];
}

/**
 * Drops the memory search indexes that a suspended organization alone owns, keeping its rows and
 * its placement. A receipt makes a repeat answer without touching OpenSearch, and a missing index
 * counts as dropped, so a run that stopped between the delete and the receipt converges.
 */
export async function dropDisabledOrganizationSearchIndex(input: {
  readonly approvedEndpoint: string;
  readonly database: DynamoDatabaseService;
  readonly now: () => Date;
  readonly openSearch: (target: MemorySearchTarget) => OpenSearchTransport;
  readonly organizationId: Ulid;
  readonly standing: OrganizationHoldReader;
}): Promise<MemorySearchIndexDropResult> {
  const { database, organizationId } = input;
  const existing = await readMemorySearchIndexDropReceipt(database, organizationId);
  if (existing) return { outcome: "already-dropped", receipt: existing.data };
  const decision = decideSearchIndexDrop(
    await input.standing.read(organizationId, { consistent: true }),
  );
  if (decision.kind === "refused") return { outcome: "refused", reason: decision.reason };
  const placement = await controlRecord(database, "memory-search-placement", { organizationId });
  const approvedOrigin = new URL(input.approvedEndpoint).origin;
  const classified = await Promise.all(
    placementLocations(placement).map((targets) =>
      memorySearchIndexOwnership({ approvedOrigin, database, organizationId, targets }),
    ),
  );
  const kept = classified.flatMap((entry) =>
    entry.kind === "kept" ? [{ index: entry.index, reason: entry.reason }] : [],
  );
  const owned = classified.flatMap((entry) => (entry.kind === "owned" ? [entry] : []));
  const [first, ...rest] = owned;
  if (!first) return { kept, outcome: "nothing-to-drop" };
  for (const { index, target } of owned) {
    try {
      await input.openSearch(target).request({
        method: "DELETE",
        path: `/${encodeURIComponent(index)}`,
      });
    } catch (cause) {
      if (!isMissingOpenSearchIndex(cause)) throw cause;
    }
  }
  const receipt = await recordMemorySearchIndexDrop(database, {
    droppedAt: input.now().toISOString(),
    indexes: [first.index, ...rest.map((entry) => entry.index)],
    operatorHold: {
      id: holdSlot(decision.hold.source, decision.hold.key),
      placedAt: decision.hold.placedAt,
      reason: decision.hold.reason,
    },
    organizationId,
  });
  return { kept, outcome: "dropped", receipt: receipt.data };
}
