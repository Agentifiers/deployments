import { organizationGateCheck, type TransactionOperation, type Ulid } from "@deployments-ai/db";
import { memorySearchPlacementResolver } from "./provider.ts";
import { MemoryPlatformError, type MemoryPlatformDependencies } from "./platform-types.ts";

export async function prepareSearchRoutingFence(
  dependencies: MemoryPlatformDependencies,
  organizationId: Ulid,
) {
  const durableRouting = dependencies.searchRoutingResolver ?? dependencies.searchPlacementResolver;
  const resolvePlacement = durableRouting ?? memorySearchPlacementResolver(dependencies);
  const placement = await resolvePlacement(organizationId);
  const operations: TransactionOperation[] = durableRouting
    ? (() => {
        if (
          placement.placementVersion === undefined ||
          placement.fenceVersion === undefined ||
          placement.fenceEpoch === undefined
        ) {
          throw new MemoryPlatformError(
            503,
            "memory_search_routing_incomplete",
            "Memory search placement or mutation fence is incomplete.",
          );
        }
        return [
          organizationGateCheck(organizationId, {
            generation: placement.placementGeneration,
            kind: "memory-search-placement",
            version: placement.placementVersion,
          }),
          organizationGateCheck(organizationId, {
            epoch: placement.fenceEpoch,
            kind: "memory-search-mutation-fence-open",
            version: placement.fenceVersion,
          }),
          ...[...placement.writes, ...(placement.candidate ? [placement.candidate] : [])].map(
            (provider) =>
              organizationGateCheck(organizationId, {
                kind: "memory-provider-gate-open",
                targetId: provider.target.targetId,
              }),
          ),
        ];
      })()
    : [];
  return { operations, placement };
}
