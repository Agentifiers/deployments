import {
  memoryRuntimePersistence,
  readOrganizationErasureRemnants,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import {
  dropMemoryOrganizationIndex,
  isMemoryOrganizationIndex,
  memorySearchIndexRetirement,
  MEMORY_SEARCH_RETIREMENT_BATCH,
  retiredCatalogCounts,
  type MemorySearchIndexRetirement,
  type OpenSearchTransport,
  type RetiredCatalogCounts,
} from "@deployments-ai/memory";
import { controlRecord, defaultMemorySearchCatalog } from "./default-search-placement.ts";

export type ErasedSearchIndexRetirementRefusal =
  | "not-organization-index"
  | "organization-exists"
  | "search-placement-exists"
  | Extract<MemorySearchIndexRetirement, { readonly kind: "referenced" }>["reason"];

export type ErasedSearchIndexRetirementResult =
  | {
      readonly index: string;
      readonly outcome: "refused";
      readonly reason: ErasedSearchIndexRetirementRefusal;
    }
  | {
      readonly index: string;
      readonly indexDrop: "already-absent" | "dropped";
      readonly outcome: "retired";
      readonly retired: RetiredCatalogCounts;
    };

/**
 * Drops the memory index of an organization whose erasure finished before erasure dropped memory
 * indexes, and retires the catalog records that existed only for it. Only the organization's own
 * index name passes, and only once the organization record and its search placements are gone and
 * no placement or physical owner still references the catalog. A repeat finds nothing left.
 */
export async function retireErasedOrganizationSearchIndex(input: {
  readonly approvedEndpoint: string;
  readonly database: DynamoDatabaseService;
  readonly index: string;
  readonly openSearch: OpenSearchTransport;
  readonly organizationId: Ulid;
  readonly region: string;
}): Promise<ErasedSearchIndexRetirementResult> {
  const { database, index, organizationId } = input;
  const refused = (reason: ErasedSearchIndexRetirementRefusal) =>
    ({ index, outcome: "refused", reason }) as const;
  if (!isMemoryOrganizationIndex(organizationId, index)) return refused("not-organization-index");
  const remnants = await readOrganizationErasureRemnants(database, organizationId);
  if (remnants.organizationExists) return refused("organization-exists");
  if (remnants.searchPlacementExists) return refused("search-placement-exists");
  const retirement = await memorySearchIndexRetirement({
    database,
    index: {
      openSearchEndpoint: input.approvedEndpoint,
      openSearchIndex: index,
      region: input.region,
    },
    organizationId,
    releaseTargets: false,
    // Default activation derives the target ID from the organization and the component's catalog;
    // the rest of the target is the component's own.
    targets: async (components) =>
      (
        await Promise.all(
          components.map(async ({ data: component }) => {
            const { openSearchEndpoint, region } = component.location;
            const profile =
              component.embeddingProfileId &&
              (await controlRecord(database, "memory-embedding-profile", {
                id: component.embeddingProfileId,
              }));
            if (!profile || typeof openSearchEndpoint !== "string" || typeof region !== "string") {
              return [];
            }
            const { targetId } = defaultMemorySearchCatalog(organizationId, {
              embeddingDimensions: profile.data.dimensions,
              embeddingModel: profile.data.gatewayModel,
              openSearchEndpoint,
              region,
            }).target;
            return [
              {
                componentIds: [component.id],
                embeddingProfileId: profile.data.id,
                location: component.location,
                providerId: component.providerId,
                schemaGeneration: component.schemaGeneration,
                targetId,
              },
            ];
          }),
        )
      ).flat(),
  });
  if (retirement.kind === "referenced") return refused(retirement.reason);
  const indexDrop = await dropMemoryOrganizationIndex({
    index,
    openSearch: input.openSearch,
    organizationId,
  });
  for (let start = 0; start < retirement.records.length; start += MEMORY_SEARCH_RETIREMENT_BATCH) {
    await memoryRuntimePersistence.commit(
      database,
      retirement.records
        .slice(start, start + MEMORY_SEARCH_RETIREMENT_BATCH)
        .map((record) => ({ kind: "delete" as const, record })),
    );
  }
  return {
    index,
    indexDrop,
    outcome: "retired",
    retired: retiredCatalogCounts(retirement.records),
  };
}
