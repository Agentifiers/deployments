import {
  dropBrainIndex,
  isBrainOrganizationIndex,
  type BrainOpenSearchTransport,
} from "@deployments-ai/brains";
import {
  readOrganizationErasureRemnants,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";

export type ErasedSearchIndexDropRefusal =
  | "not-organization-index"
  | "organization-exists"
  | "search-placement-exists";

export type ErasedSearchIndexDropResult =
  | {
      readonly index: string;
      readonly outcome: "refused";
      readonly reason: ErasedSearchIndexDropRefusal;
    }
  | { readonly index: string; readonly outcome: "already-absent" | "dropped" };

/**
 * Drops a Brain index that an erasure finished before erasure dropped indexes itself. Only the
 * organization's own index name passes, and only once the organization record and both search
 * placements are gone.
 */
export async function dropErasedOrganizationBrainIndex(input: {
  readonly database: DynamoDatabaseService;
  readonly index: string;
  readonly openSearch: BrainOpenSearchTransport;
  readonly organizationId: Ulid;
}): Promise<ErasedSearchIndexDropResult> {
  const { index, organizationId } = input;
  const refused = (reason: ErasedSearchIndexDropRefusal) =>
    ({ index, outcome: "refused", reason }) as const;
  if (!isBrainOrganizationIndex(organizationId, index)) return refused("not-organization-index");
  const remnants = await readOrganizationErasureRemnants(input.database, organizationId);
  if (remnants.organizationExists) return refused("organization-exists");
  if (remnants.searchPlacementExists) return refused("search-placement-exists");
  return { index, outcome: await dropBrainIndex(input.openSearch, index) };
}
