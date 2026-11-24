import {
  canonicalRecordKeys,
  key,
  memoryPersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { physicalLocationHash } from "./control-plane-physical-ownership.ts";
import { MEMORY_SEARCH_MEMBERSHIP_SHARDS } from "./membership.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { memorySearchTargetIdentity } from "./target-identity.ts";

/** The catalog record types that exist only for one memory index and the targets that used it. */
export const RETIRED_MEMORY_SEARCH_CATALOG_TYPES = [
  "memory-search-component",
  "memory-search-generation",
  "memory-search-generation-target",
  "memory-search-generation-target-shard",
  "memory-search-generation-live-target",
  "memory-search-generation-live-shard",
  "memory-search-physical-owner",
  "memory-search-target-identity",
  "memory-embedding-profile",
] as const;

/** Catalog deletes per transaction, well under DynamoDB's 100 items with erasure's companions. */
export const MEMORY_SEARCH_RETIREMENT_BATCH = 25;

type RetiredType = (typeof RETIRED_MEMORY_SEARCH_CATALOG_TYPES)[number];
type Retired<ItemType extends RetiredType = RetiredType> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export type MemorySearchIndexRetirement =
  | { readonly kind: "retire"; readonly records: readonly Retired[] }
  | {
      readonly kind: "referenced";
      readonly reason: "generation-shared" | "live-reference" | "physical-owner";
    };

export type MemorySearchIndexAddress = {
  readonly openSearchEndpoint: string;
  readonly openSearchIndex: string;
  readonly region: string;
};

function is<ItemType extends RetiredType>(itemType: ItemType) {
  return (record: PlatformRecord): record is Retired<ItemType> => record.itemType === itemType;
}

async function partition(database: DynamoDatabaseService, pk: string) {
  const items: PlatformRecord[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await memoryPersistence.find(database, "control", {
      ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": pk },
      KeyConditionExpression: "pk = :pk",
      ...(start ? { ExclusiveStartKey: start } : {}),
    });
    items.push(...page.items);
    start = page.lastEvaluatedKey;
  } while (start);
  return items;
}

async function strongRecord<ItemType extends RetiredType>(
  database: DynamoDatabaseService,
  itemType: ItemType,
  data: Readonly<Record<string, unknown>>,
) {
  const value = await memoryPersistence.read(
    database,
    "control",
    canonicalRecordKeys({ data, itemType }, "control"),
    true,
  );
  return value && is(itemType)(value) ? value : undefined;
}

function locationHash(location: Readonly<Record<string, unknown>>) {
  try {
    return physicalLocationHash("dense", location);
  } catch {
    return undefined;
  }
}

/**
 * Finds every catalog record that exists only for a dropped memory index: the components and
 * generations that name it, everything in those generations' membership and live partitions, the
 * physical owners of those components, the identities of the targets that `targets` builds from
 * those components, and the organization's own embedding profiles that nothing else uses. The
 * records come generations and profiles last, so a run that stops partway through can still find
 * what is left from the generations.
 *
 * Nothing may still use the index. A live reference or physical owner blocks retirement unless
 * `releaseTargets` is set and it belongs to the organization and one of the targets: erasure
 * removes those in the same commit. A component outside the index that shares a retired generation
 * blocks too.
 */
export async function memorySearchIndexRetirement(args: {
  readonly database: DynamoDatabaseService;
  readonly index: MemorySearchIndexAddress;
  readonly organizationId: Ulid;
  /** Erasure deletes the targets' live references and owners in the same commit. */
  readonly releaseTargets: boolean;
  readonly targets: (
    components: readonly Retired<"memory-search-component">[],
  ) => Promise<readonly MemorySearchTarget[]>;
}): Promise<MemorySearchIndexRetirement> {
  const { database } = args;
  const indexHash = physicalLocationHash("dense", args.index);
  const [allComponents, allGenerations] = await Promise.all([
    partition(database, key("GLOBAL", "memory-search-component")).then((items) =>
      items.filter(is("memory-search-component")),
    ),
    partition(database, key("GLOBAL", "memory-search-generation")).then((items) =>
      items.filter(is("memory-search-generation")),
    ),
  ]);
  const components = allComponents.filter(
    (component) => locationHash(component.data.location) === indexHash,
  );
  const generations = allGenerations.filter(
    (generation) => locationHash(generation.data.location) === indexHash,
  );
  const componentIds = new Set(components.map((component) => component.data.id));
  const generationIds = new Set(generations.map((generation) => generation.data.id));
  if (
    allComponents.some(
      (component) =>
        !componentIds.has(component.data.id) && generationIds.has(component.data.generationId),
    )
  ) {
    return { kind: "referenced", reason: "generation-shared" };
  }
  const targets = await args.targets(components);
  const targetIds = new Set(targets.map((target) => target.targetId));
  const directory = (
    await Promise.all(
      [...generationIds].flatMap((generationId) =>
        Array.from({ length: MEMORY_SEARCH_MEMBERSHIP_SHARDS }, (_, shard) =>
          (["MEMBERSHIP", "LIVE"] as const).map((kind) =>
            partition(database, key("MEMORY-SEARCH-GENERATION", generationId, kind, String(shard))),
          ),
        ).flat(),
      ),
    )
  ).flat();
  const membership = [
    ...directory.filter(is("memory-search-generation-target")),
    ...directory.filter(is("memory-search-generation-target-shard")),
  ];
  const live = directory.filter(is("memory-search-generation-live-target"));
  if (
    !live.every(
      (reference) =>
        args.releaseTargets &&
        reference.data.organizationId === args.organizationId &&
        targetIds.has(reference.data.targetId) &&
        componentIds.has(reference.data.componentId),
    )
  ) {
    return { kind: "referenced", reason: "live-reference" };
  }
  const liveHeads = directory.filter(is("memory-search-generation-live-shard"));

  const ownerHashes = new Set(
    components.flatMap((component) =>
      component.data.componentKind === "namespace"
        ? []
        : [physicalLocationHash(component.data.componentKind, component.data.location)],
    ),
  );
  const owners = (
    await Promise.all(
      [...ownerHashes].map((hash) =>
        strongRecord(database, "memory-search-physical-owner", { physicalLocationHash: hash }),
      ),
    )
  ).filter((owner) => owner !== undefined);
  if (
    owners.some(
      (owner) =>
        owner.data.organizationId !== args.organizationId ||
        !args.releaseTargets ||
        !targetIds.has(owner.data.targetId) ||
        !componentIds.has(owner.data.componentId) ||
        owner.data.referenceCount !== 1,
    )
  ) {
    return { kind: "referenced", reason: "physical-owner" };
  }

  const identities = (
    await Promise.all(
      [...new Map(targets.map((target) => [target.targetId, target])).values()]
        .filter((target) => target.componentIds.every((id) => componentIds.has(id)))
        .map(async (target) => {
          const identity = await strongRecord(database, "memory-search-target-identity", {
            targetId: target.targetId,
          });
          return identity?.data.identityHash === memorySearchTargetIdentity(target)
            ? identity
            : undefined;
        }),
    )
  ).filter((identity) => identity !== undefined);

  // Profiles are found by the route scope that default activation pins to the organization, not
  // through components, so a profile outlives the components that an earlier run retired. Default
  // Brain search reuses the memory target's profile, so the organization's Brain placement keeps
  // it until Brain erasure.
  const brainPlacement = await memoryPersistence.read(
    database,
    "control",
    canonicalRecordKeys(
      { data: { organizationId: args.organizationId }, itemType: "brain-search-placement" },
      "control",
    ),
    true,
  );
  const referencedProfileIds = new Set([
    ...(brainPlacement?.itemType === "brain-search-placement"
      ? [
          brainPlacement.data.readTarget,
          brainPlacement.data.writeTarget,
          brainPlacement.data.candidateTarget,
        ].flatMap((target) => (target ? [target.embeddingProfileId] : []))
      : []),
    ...allComponents.flatMap(({ data }) =>
      !componentIds.has(data.id) && data.embeddingProfileId ? [data.embeddingProfileId] : [],
    ),
  ]);
  const profiles = (await partition(database, key("GLOBAL", "memory-embedding-profile"))).filter(
    (profile): profile is Retired<"memory-embedding-profile"> =>
      profile.itemType === "memory-embedding-profile" &&
      !referencedProfileIds.has(profile.data.id) &&
      routeScopeRef(profile.data.gatewayRoute) === `organization:${args.organizationId}`,
  );

  return {
    kind: "retire",
    records: [
      ...membership,
      ...live,
      ...liveHeads,
      ...owners,
      ...identities,
      ...components,
      ...generations,
      ...profiles,
    ],
  };
}

function routeScopeRef(gatewayRoute: string) {
  try {
    const route: unknown = JSON.parse(gatewayRoute);
    return route && typeof route === "object" && "routeScopeRef" in route
      ? route.routeScopeRef
      : undefined;
  } catch {
    return undefined;
  }
}

export type RetiredCatalogCounts = Record<RetiredType, number>;

/** How many records of each catalog type a retirement removes. */
export function retiredCatalogCounts(records: readonly PlatformRecord[]): RetiredCatalogCounts {
  return Object.fromEntries(
    RETIRED_MEMORY_SEARCH_CATALOG_TYPES.map((itemType) => [
      itemType,
      records.filter((record) => record.itemType === itemType).length,
    ]),
  ) as RetiredCatalogCounts;
}
