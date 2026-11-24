import {
  acquireUniqueClaim,
  defaultWorkspaceMemorySpaceClaimNamespace,
  Keys,
  makeUniqueClaimRecord,
  MemorySpaceRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import type { MemoryPlatformGrantList } from "./platform-grant-list.ts";
import type { MemoryPlatformGrants } from "./platform-grants.ts";
import type { MemoryPlatformRun } from "./platform-run.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";

/**
 * Sets up workspace memory the first time a workspace-memory agent finishes a run in a workspace:
 * the workspace's default space, a read-write grant on it for the run's agent, and a workspace
 * policy with active recall on. Each step leaves what an administrator configured alone: a read
 * grant on a space of the workspace, an archived default space, a revoked grant on it, and any
 * policy that already applies to the workspace.
 */
export function makeMemoryPlatformDefaultWorkspaceMemory(
  runtime: Shared.MemoryPlatformRuntime &
    MemoryPlatformCore &
    MemoryPlatformSpaces &
    MemoryPlatformGrantList &
    MemoryPlatformGrants &
    MemoryPlatformRun,
) {
  const {
    database,
    effectivePolicy,
    eventFor,
    generateId,
    grantMemorySpace,
    listMemorySpaceGrants,
    memoryAccessForResolvedRun,
    now,
    upsertPolicy,
  } = runtime;

  async function claimedDefaultSpace(scope: Types.MemoryPlatformScope, workspaceId: Ulid) {
    const claim = await Shared.loadRecord(
      database,
      "control",
      Keys.control.uniqueClaim(
        defaultWorkspaceMemorySpaceClaimNamespace(scope.environmentId),
        workspaceId,
      ),
      "unique-claim",
    );
    if (claim?.data.ownerItemType !== "memory-space") return undefined;
    return Shared.loadRecord(
      database,
      "control",
      { pk: claim.data.ownerPk, sk: claim.data.ownerSk },
      "memory-space",
    );
  }

  async function defaultSpace(scope: Types.MemoryPlatformScope, workspaceId: Ulid) {
    const existing = await claimedDefaultSpace(scope, workspaceId);
    if (existing) return existing;
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const space = Shared.record(
      MemorySpaceRecord,
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          description: "Created for agents that use workspace memory in this workspace.",
          environmentId: scope.environmentId,
          id: await generateId(),
          isDefault: true,
          kind: "workspace" as const,
          name: "Workspace memory",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          status: "active" as const,
          updatedAt: timestamp,
          version: 0,
          workspaceId,
        },
        itemType: "memory-space" as const,
      }),
    );
    const [claimRequirement] = uniqueClaimRequirements(space);
    const event = await eventFor({
      aggregateId: space.data.id,
      aggregateType: "memory-space",
      aggregateVersion: 1,
      eventType: "memory-space.created",
      payload: { kind: space.data.kind, status: space.data.status },
      scope,
    });
    try {
      await transactWithSemanticEvents(
        database,
        [
          { kind: "put", record: space },
          acquireUniqueClaim(
            makeUniqueClaimRecord(claimRequirement!, timestamp) as Types.UniqueClaim,
          ),
        ],
        [event],
      );
    } catch (cause) {
      // A concurrent run of the same workspace created it first.
      const winner = await claimedDefaultSpace(scope, workspaceId);
      if (winner) return winner;
      throw cause;
    }
    return space;
  }

  /** Returns whether the run's agent now holds a writable workspace space for its workspace. */
  async function provisionDefaultWorkspaceMemory(scope: Types.MemoryPlatformScope, run: Types.Run) {
    const workspaceId = run.data.workspaceId;
    if (!workspaceId) return false;
    const workspaceScope = Shared.memoryOwnedScope(scope, workspaceId);
    const access = await memoryAccessForResolvedRun(workspaceScope, run, "workspace");
    if (!Shared.writableMemorySpaceForScope(access, "workspace")) {
      // A read grant on a space of this workspace means an administrator chose read-only access.
      if (access.readMemorySpaces.some((space) => space.workspaceId === workspaceId)) return false;
      const space = await defaultSpace(workspaceScope, workspaceId);
      if (space.data.status !== "active") return false;
      const grants = await listMemorySpaceGrants(workspaceScope, {
        agentDefinitionId: access.agentDefinitionId,
        consistent: true,
        includeRevoked: true,
      });
      if (grants.some((grant) => grant.data.memorySpaceId === space.data.id)) return false;
      await grantMemorySpace(workspaceScope, {
        agentDefinitionId: access.agentDefinitionId,
        memorySpaceId: space.data.id,
        permission: "read-write",
      });
    }
    if (!(await effectivePolicy(workspaceScope))) {
      await upsertPolicy(workspaceScope, {
        activeRecallEnabled: true,
        createOnly: true,
        scope: "workspace",
        workspaceId,
      }).catch((cause: unknown) => {
        if (
          !(cause instanceof Types.MemoryPlatformError && cause.code === "memory_policy_exists")
        ) {
          throw cause;
        }
      });
    }
    return true;
  }

  return { provisionDefaultWorkspaceMemory };
}
