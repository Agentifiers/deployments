import type { OpenSearchTransport } from "./aws-native-contracts.ts";
import {
  isOpenSearchIndexNotFound,
  requireNoOpenSearchSnapshotRepositories,
} from "./aws-native-erasure.ts";
import { isMemoryOrganizationIndex } from "./search-index-ownership.ts";

export type MemoryIndexDrop = "already-absent" | "dropped";

/**
 * Deletes the organization's own memory index. An index that is already gone counts as dropped.
 * The snapshot repository check runs first because a dropped index skips the purge's own check,
 * and a manual repository could still hold the organization's documents.
 */
export async function dropMemoryOrganizationIndex(input: {
  readonly index: string;
  readonly openSearch: OpenSearchTransport;
  readonly organizationId: string;
  readonly signal?: AbortSignal;
}): Promise<MemoryIndexDrop> {
  const { index, openSearch, signal } = input;
  if (!isMemoryOrganizationIndex(input.organizationId, index)) {
    throw new TypeError(`${index} is not the organization's own memory index.`);
  }
  requireNoOpenSearchSnapshotRepositories(
    await openSearch.request({
      method: "GET",
      path: "/_snapshot/_all",
      ...(signal ? { signal } : {}),
    }),
  );
  let response: unknown;
  try {
    response = await openSearch.request({
      method: "DELETE",
      path: `/${encodeURIComponent(index)}`,
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (isOpenSearchIndexNotFound(cause)) return "already-absent";
    throw cause;
  }
  if (
    !response ||
    typeof response !== "object" ||
    (response as Readonly<Record<string, unknown>>).acknowledged !== true
  ) {
    throw new Error(`OpenSearch did not acknowledge the deletion of ${index}.`);
  }
  return "dropped";
}
