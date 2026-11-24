import type { BrainApiRouteName } from "@deployments-ai/api-contract";
import type { Brain, BrainDeploymentMount, BrainGrant, BrainPage } from "@deployments-ai/brains";

/**
 * Public projections of Brain domain values. The HTTP boundary decodes
 * responses strictly, so internal attribution, policy, and denormalized
 * authorization fields must never reach the wire.
 */
function publicBrain(brain: Brain) {
  return {
    createdAt: brain.createdAt,
    id: brain.id,
    kind: brain.kind,
    name: brain.name,
    organizationId: brain.organizationId,
    ...(brain.ownerPrincipalId ? { ownerPrincipalId: brain.ownerPrincipalId } : {}),
    ownershipGeneration: brain.ownershipGeneration,
    schemaVersion: brain.schemaVersion,
    sensitivity: brain.sensitivity,
    slug: brain.slug,
    status: brain.status,
    updatedAt: brain.updatedAt,
    version: brain.version,
  };
}

function publicBrainGrant(grant: BrainGrant) {
  return {
    brainId: grant.brainId,
    createdAt: grant.createdAt,
    id: grant.id,
    organizationId: grant.organizationId,
    ...(grant.ownershipGeneration !== undefined
      ? { ownershipGeneration: grant.ownershipGeneration }
      : {}),
    permission: grant.permission,
    ...(grant.revokedAt ? { revokedAt: grant.revokedAt } : {}),
    status: grant.status,
    target: grant.target,
    updatedAt: grant.updatedAt,
    version: grant.version,
  };
}

function publicBrainMount(mount: BrainDeploymentMount) {
  return {
    agentDefinitionId: mount.agentDefinitionId,
    agentDeploymentId: mount.agentDeploymentId,
    brainId: mount.brainId,
    createdAt: mount.createdAt,
    environmentId: mount.environmentId,
    id: mount.id,
    organizationId: mount.organizationId,
    ...(mount.ownershipGeneration !== undefined
      ? { ownershipGeneration: mount.ownershipGeneration }
      : {}),
    permission: mount.permission,
    projectId: mount.projectId,
    ...(mount.revokedAt ? { revokedAt: mount.revokedAt } : {}),
    status: mount.status,
    updatedAt: mount.updatedAt,
    version: mount.version,
  };
}

function publicPage<Item, Output>(page: BrainPage<Item>, project: (item: Item) => Output) {
  return {
    items: page.items.map(project),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * Projects a Brain service result onto the route's public response shape.
 * Routes whose service result is already public pass through unchanged.
 */
export function publicBrainResponse(routeName: BrainApiRouteName, result: unknown): unknown {
  switch (routeName) {
    case "archiveBrain":
    case "createBrain":
    case "getBrain":
    case "updateBrain":
      return publicBrain(result as Brain);
    case "listBrains":
      return publicPage(result as BrainPage<Brain>, publicBrain);
    case "createBrainGrant":
    case "revokeBrainGrant":
      return publicBrainGrant(result as BrainGrant);
    case "listBrainGrants":
      return publicPage(result as BrainPage<BrainGrant>, publicBrainGrant);
    case "createBrainMount":
    case "revokeBrainMount":
      return publicBrainMount(result as BrainDeploymentMount);
    case "listBrainMounts":
      return publicPage(result as BrainPage<BrainDeploymentMount>, publicBrainMount);
    default:
      return result;
  }
}
