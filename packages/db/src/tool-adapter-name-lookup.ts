import type { DynamoDatabaseService } from "./client-types.ts";
import { Keys } from "./keys.ts";
import type { PlatformRecord } from "./records/index.ts";

export interface ToolAdapterLookupScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export type ActiveToolAdapter = Extract<PlatformRecord, { readonly itemType: "tool-adapter" }>;

/**
 * Finds the environment's active tool adapter that holds a tool name, through the name's
 * uniqueness claim, with strongly consistent reads. A claim or adapter that does not match the
 * name and scope exactly resolves to nothing.
 */
export function makeToolAdapterNameLookup(database: DynamoDatabaseService) {
  return async (
    scope: ToolAdapterLookupScope,
    toolName: string,
  ): Promise<ActiveToolAdapter | undefined> => {
    const namespace = `environment:${scope.environmentId}:tool-adapter-name`;
    const claim = await database.getRecord(
      "control",
      Keys.control.uniqueClaim(namespace, toolName),
      true,
    );
    if (
      claim?.itemType !== "unique-claim" ||
      claim.data.namespace !== namespace ||
      claim.data.value !== toolName ||
      claim.data.ownerItemType !== "tool-adapter" ||
      claim.data.ownerTable !== "control"
    ) {
      return undefined;
    }
    const adapter = await database.getRecord(
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      true,
    );
    return adapter?.itemType === "tool-adapter" &&
      adapter.data.id === claim.data.ownerId &&
      adapter.data.name === toolName &&
      adapter.data.organizationId === scope.organizationId &&
      adapter.data.projectId === scope.projectId &&
      adapter.data.environmentId === scope.environmentId &&
      adapter.data.status === "active"
      ? adapter
      : undefined;
  };
}
