import type { DynamoDatabaseService } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import { key } from "./keys.ts";

export interface OrganizationErasureRemnants {
  readonly organizationExists: boolean;
  readonly searchPlacementExists: boolean;
}

/**
 * Reads, with strong consistency, what decides whether an organization is fully erased: its
 * organization record and its memory and Brain search placements.
 */
export async function readOrganizationErasureRemnants(
  database: DynamoDatabaseService,
  organizationId: Ulid,
): Promise<OrganizationErasureRemnants> {
  const [organization, brainPlacement, memoryPlacement] = await Promise.all(
    [
      { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
      { pk: key("ORG", organizationId), sk: key("BRAIN-SEARCH-PLACEMENT", organizationId) },
      { pk: key("ORG", organizationId), sk: key("MEMORY-SEARCH-PLACEMENT", organizationId) },
    ].map((recordKey) => database.getRecord("control", recordKey, true)),
  );
  return {
    organizationExists: organization !== undefined,
    searchPlacementExists: brainPlacement !== undefined || memoryPlacement !== undefined,
  };
}
