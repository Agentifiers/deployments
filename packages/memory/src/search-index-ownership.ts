import {
  canonicalRecordKeys,
  memoryPersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { AWS_NATIVE_MEMORY_INDEX_PREFIX, awsNativeTargetLocation } from "./aws-native-contracts.ts";
import { physicalLocationHash } from "./control-plane-physical-ownership.ts";
import type { MemorySearchTarget } from "./provider.ts";

export type KeptIndexReason =
  | "not-memory-index"
  | "foreign-endpoint"
  | "no-exclusive-owner"
  | "owned-by-another-organization"
  | "not-organization-index";

export interface KeptIndex {
  readonly index: string;
  readonly reason: KeptIndexReason;
}

export type MemorySearchIndexOwnership =
  | { readonly kind: "owned"; readonly index: string; readonly target: MemorySearchTarget }
  | ({ readonly kind: "kept" } & KeptIndex);

/**
 * True only for the organization's own memory index name. OpenSearch reads `*` and `,` in a DELETE
 * path as several indexes, so nothing looser than the exact name may reach a drop.
 */
export function isMemoryOrganizationIndex(organizationId: string, index: string) {
  const prefix = `${AWS_NATIVE_MEMORY_INDEX_PREFIX}${organizationId.toLowerCase()}-v`;
  return index.startsWith(prefix) && /^\d+$/u.test(index.slice(prefix.length));
}

async function physicalOwner(
  database: DynamoDatabaseService,
  componentKind: "dense" | "lexical",
  location: MemorySearchTarget["location"],
) {
  const value = await memoryPersistence.read(
    database,
    "control",
    canonicalRecordKeys(
      {
        data: { physicalLocationHash: physicalLocationHash(componentKind, location) },
        itemType: "memory-search-physical-owner",
      },
      "control",
    ),
    true,
  );
  return value?.itemType === "memory-search-physical-owner"
    ? (value as Extract<PlatformRecord, { readonly itemType: "memory-search-physical-owner" }>)
    : undefined;
}

/**
 * Owned only when the organization alone holds the index: a memory index on the approved domain
 * whose dense owner names this organization and one of the targets at that location exactly once,
 * and whose lexical owner, if any, names no other organization. The name must also be exactly the
 * organization's own, because OpenSearch reads `*` and `,` in a DELETE path as several indexes.
 */
export async function memorySearchIndexOwnership(input: {
  readonly approvedOrigin: string;
  readonly database: DynamoDatabaseService;
  readonly organizationId: Ulid;
  readonly targets: readonly [MemorySearchTarget, ...MemorySearchTarget[]];
}): Promise<MemorySearchIndexOwnership> {
  const [first] = input.targets;
  const { openSearchEndpoint, openSearchIndex: index } = awsNativeTargetLocation(first);
  if (!index.startsWith(AWS_NATIVE_MEMORY_INDEX_PREFIX)) {
    return { index, kind: "kept", reason: "not-memory-index" };
  }
  if (new URL(openSearchEndpoint).origin !== input.approvedOrigin) {
    return { index, kind: "kept", reason: "foreign-endpoint" };
  }
  const [dense, lexical] = await Promise.all(
    (["dense", "lexical"] as const).map((componentKind) =>
      physicalOwner(input.database, componentKind, first.location),
    ),
  );
  if (
    [dense, lexical].some((owner) => owner && owner.data.organizationId !== input.organizationId)
  ) {
    return { index, kind: "kept", reason: "owned-by-another-organization" };
  }
  const target = input.targets.find((candidate) => candidate.targetId === dense?.data.targetId);
  if (!target || dense?.data.referenceCount !== 1) {
    return { index, kind: "kept", reason: "no-exclusive-owner" };
  }
  if (!isMemoryOrganizationIndex(input.organizationId, index)) {
    return { index, kind: "kept", reason: "not-organization-index" };
  }
  return { index, kind: "owned", target };
}
