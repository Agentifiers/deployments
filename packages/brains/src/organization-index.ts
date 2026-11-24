import type { BrainOpenSearchTransport } from "./aws-native-search.ts";

/**
 * True only for the organization's own Brain index name. OpenSearch reads `*` and `,` in a DELETE
 * path as several indexes, so nothing looser than the exact name may reach a drop.
 */
export function isBrainOrganizationIndex(organizationId: string, index: string) {
  const prefix = `brain-${organizationId.toLowerCase()}-v`;
  return index.startsWith(prefix) && /^\d+$/.test(index.slice(prefix.length));
}

/** True when OpenSearch answered that the index does not exist. */
export function isBrainIndexNotFound(cause: unknown) {
  return (
    cause instanceof Error &&
    "status" in cause &&
    cause.status === 404 &&
    "type" in cause &&
    cause.type === "index_not_found_exception"
  );
}

/** Deletes one index. An index that is already gone counts as dropped. */
export async function dropBrainIndex(
  openSearch: BrainOpenSearchTransport,
  index: string,
): Promise<"already-absent" | "dropped"> {
  let response: unknown;
  try {
    response = await openSearch.request({
      method: "DELETE",
      path: `/${encodeURIComponent(index)}`,
    });
  } catch (cause) {
    if (isBrainIndexNotFound(cause)) return "already-absent";
    throw cause;
  }
  if (
    !response ||
    typeof response !== "object" ||
    !("acknowledged" in response) ||
    response.acknowledged !== true
  ) {
    throw new Error(`OpenSearch did not acknowledge the deletion of ${index}.`);
  }
  return "dropped";
}
