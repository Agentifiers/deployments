import {
  MemorySpaceGrantRecord,
  Keys,
  makeUniqueClaimRecord,
  memorySpaceGrantClaimNamespace,
  memorySpaceGrantClaimValue,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";
import type { MemoryPlatformCore } from "./platform-core.ts";
import type { MemoryPlatformSpaces } from "./platform-spaces.ts";
import type { MemoryPlatformGrantList } from "./platform-grant-list.ts";
export function makeMemoryPlatformGrants(
  runtime: Shared.MemoryPlatformRuntime &
    MemoryPlatformCore &
    MemoryPlatformSpaces &
    MemoryPlatformGrantList,
) {
  const {
    database,
    generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    requiredMutableSpace,
    listMemorySpaceGrants,
  } = runtime;

  async function grantMemorySpace(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly agentDefinitionId: Ulid;
      readonly idempotencyKey?: string;
      readonly memorySpaceId: Ulid;
      readonly permission: Types.MemorySpaceGrant["data"]["permission"];
    },
  ) {
    const space = await requiredMutableSpace(scope, input.memorySpaceId);
    if (space.data.status !== "active") {
      throw new Types.MemoryPlatformError(
        409,
        "memory_space_archived",
        "Memory space is archived.",
      );
    }
    const idempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      agentDefinitionId: input.agentDefinitionId,
      memorySpaceId: input.memorySpaceId,
      operation: "memory-space-grant.create",
      permission: input.permission,
    });
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) {
      const replayed = await Shared.loadRecord(
        database,
        "control",
        Shared.memoryGrantKey(scope, replay[0]),
        "memory-space-grant",
      );
      if (replayed && Shared.scopeMatches(replayed, scope)) return replayed;
    }
    const existing = (
      await listMemorySpaceGrants(scope, {
        agentDefinitionId: input.agentDefinitionId,
      })
    ).find((grant) => grant.data.memorySpaceId === input.memorySpaceId);
    if (existing) {
      return setMemorySpaceGrantPermission(
        scope,
        existing,
        input.permission,
        idempotencyKey,
        expectedCommandHash,
      );
    }
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const grant = Shared.record(
      MemorySpaceGrantRecord,
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: input.agentDefinitionId,
          createdAt: timestamp,
          environmentId: scope.environmentId,
          ...(scope.principalId ? { grantedByPrincipalId: scope.principalId } : {}),
          id: await generateId(),
          memorySpaceId: input.memorySpaceId,
          organizationId: scope.organizationId,
          permission: input.permission,
          projectId: scope.projectId,
          updatedAt: timestamp,
          version: 0,
          ...(space.data.workspaceId ? { workspaceId: space.data.workspaceId } : {}),
        },
        itemType: "memory-space-grant" as const,
      }),
    );
    const [claimRequirement] = uniqueClaimRequirements(grant);
    if (!claimRequirement) {
      throw new Types.MemoryPlatformError(
        500,
        "memory_space_grant_claim_missing",
        "Memory space grant uniqueness is not registered.",
      );
    }
    const claim = makeUniqueClaimRecord(claimRequirement, timestamp) as Types.UniqueClaim;
    const operations: TransactionOperation[] = [
      Shared.activeMemorySpaceCondition(space),
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: grant,
      },
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: claim,
      },
    ];
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [grant.data.id],
            scope,
            timestamp: timestampDate,
          }),
        ),
      );
    }
    const event = await eventFor({
      aggregateId: grant.data.id,
      aggregateType: "memory-space-grant",
      aggregateVersion: 1,
      eventType: "memory-space-grant.created",
      payload: {
        agentDefinitionId: grant.data.agentDefinitionId,
        memorySpaceId: grant.data.memorySpaceId,
        permission: grant.data.permission,
      },
      scope,
    });
    try {
      await transactWithSemanticEvents(database, operations, [event]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) {
        const replayed = await Shared.loadRecord(
          database,
          "control",
          Shared.memoryGrantKey(scope, concurrentReplay[0]),
          "memory-space-grant",
        );
        if (replayed && Shared.scopeMatches(replayed, scope)) return replayed;
      }
      const claimed = await Shared.loadRecord(
        database,
        "control",
        Keys.control.uniqueClaim(
          memorySpaceGrantClaimNamespace(scope.environmentId),
          memorySpaceGrantClaimValue(input.agentDefinitionId, input.memorySpaceId),
        ),
        "unique-claim",
      );
      if (claimed?.data.ownerItemType === "memory-space-grant") {
        const existingGrant = await Shared.loadRecord(
          database,
          "control",
          { pk: claimed.data.ownerPk, sk: claimed.data.ownerSk },
          "memory-space-grant",
        );
        if (
          existingGrant &&
          !existingGrant.data.revokedAt &&
          Shared.scopeMatches(existingGrant, scope)
        ) {
          return setMemorySpaceGrantPermission(
            scope,
            existingGrant,
            input.permission,
            idempotencyKey,
            expectedCommandHash,
          );
        }
      }
      throw cause;
    }
    return grant;
  }

  async function requiredMemorySpaceGrant(scope: Types.MemoryPlatformScope, grantId: Ulid) {
    const grant = await Shared.loadRecord(
      database,
      "control",
      Shared.memoryGrantKey(scope, grantId),
      "memory-space-grant",
    );
    if (!grant || !Shared.mutationScopeMatches(grant, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "memory_space_grant_not_found",
        "Memory space grant was not found.",
      );
    }
    return grant;
  }

  async function updateMemorySpaceGrant(
    scope: Types.MemoryPlatformScope,
    grantId: Ulid,
    input: {
      readonly idempotencyKey?: string;
      readonly permission: Types.MemorySpaceGrant["data"]["permission"];
    },
  ) {
    const previous = await requiredMemorySpaceGrant(scope, grantId);
    const idempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      grantId,
      operation: "memory-space-grant.update",
      permission: input.permission,
    });
    return setMemorySpaceGrantPermission(
      scope,
      previous,
      input.permission,
      idempotencyKey,
      expectedCommandHash,
    );
  }

  async function setMemorySpaceGrantPermission(
    scope: Types.MemoryPlatformScope,
    previous: Types.MemorySpaceGrant,
    permission: Types.MemorySpaceGrant["data"]["permission"],
    idempotencyKey: string | undefined,
    expectedCommandHash: string,
  ) {
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) return requiredMemorySpaceGrant(scope, replay[0]);
    if (previous.data.revokedAt) {
      throw new Types.MemoryPlatformError(
        409,
        "memory_space_grant_revoked",
        "Revoked memory space grants cannot be updated.",
      );
    }
    if (previous.data.permission === permission) {
      if (idempotencyKey) {
        const timestampDate = now();
        try {
          await memoryPersistence.commit(database, [
            {
              conditionExpression: "#data.#version = :version AND #itemType = :itemType",
              expressionAttributeNames: {
                "#data": "data",
                "#itemType": "itemType",
                "#version": "version",
              },
              expressionAttributeValues: {
                ":itemType": "memory-space-grant",
                ":version": previous.data.version,
              },
              key: { pk: previous.pk, sk: previous.sk },
              kind: "condition-check",
              table: "control",
            },
            idempotencyOperation(
              completedIdempotency({
                commandHash: expectedCommandHash,
                idempotencyKey,
                resourceIds: [previous.data.id],
                scope,
                timestamp: timestampDate,
              }),
            ),
          ]);
        } catch (cause) {
          const concurrentReplay = await idempotencyReplay(
            scope,
            idempotencyKey,
            expectedCommandHash,
          );
          if (concurrentReplay?.[0]) return requiredMemorySpaceGrant(scope, concurrentReplay[0]);
          throw cause;
        }
      }
      return previous;
    }
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const next = Shared.record(
      MemorySpaceGrantRecord,
      withCanonicalRecordKeys({
        data: {
          ...previous.data,
          permission,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
        itemType: "memory-space-grant" as const,
      }),
    );
    const operations: TransactionOperation[] = [
      { kind: "put", previousRecord: previous, record: next },
    ];
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [next.data.id],
            scope,
            timestamp: timestampDate,
          }),
        ),
      );
    }
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-space-grant",
      aggregateVersion: next.data.version + 1,
      eventType: "memory-space-grant.updated",
      payload: { permission: next.data.permission },
      scope,
    });
    try {
      await transactWithSemanticEvents(database, operations, [event]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) return requiredMemorySpaceGrant(scope, concurrentReplay[0]);
      throw cause;
    }
    return next;
  }

  async function revokeMemorySpaceGrant(
    scope: Types.MemoryPlatformScope,
    grantId: Ulid,
    input: { readonly idempotencyKey?: string } = {},
  ) {
    const previous = await requiredMemorySpaceGrant(scope, grantId);
    const idempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      grantId,
      operation: "memory-space-grant.revoke",
    });
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) return requiredMemorySpaceGrant(scope, replay[0]);
    if (previous.data.revokedAt) {
      if (!idempotencyKey) return previous;
      const timestampDate = now();
      try {
        await memoryPersistence.commit(database, [
          {
            conditionExpression: "#data.#version = :version AND #itemType = :itemType",
            expressionAttributeNames: {
              "#data": "data",
              "#itemType": "itemType",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":itemType": "memory-space-grant",
              ":version": previous.data.version,
            },
            key: { pk: previous.pk, sk: previous.sk },
            kind: "condition-check",
            table: "control",
          },
          idempotencyOperation(
            completedIdempotency({
              commandHash: expectedCommandHash,
              idempotencyKey,
              resourceIds: [previous.data.id],
              scope,
              timestamp: timestampDate,
            }),
          ),
        ]);
      } catch (cause) {
        const concurrentReplay = await idempotencyReplay(
          scope,
          idempotencyKey,
          expectedCommandHash,
        );
        if (concurrentReplay?.[0]) return requiredMemorySpaceGrant(scope, concurrentReplay[0]);
        throw cause;
      }
      return previous;
    }
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const next = Shared.record(
      MemorySpaceGrantRecord,
      withCanonicalRecordKeys({
        data: {
          ...previous.data,
          revokedAt: timestamp,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
        itemType: "memory-space-grant" as const,
      }),
    );
    const [claimRequirement] = uniqueClaimRequirements(previous);
    if (!claimRequirement) {
      throw new Types.MemoryPlatformError(
        409,
        "memory_space_grant_claim_missing",
        "Active memory space grant uniqueness claim is missing.",
      );
    }
    const claim = makeUniqueClaimRecord(
      claimRequirement,
      previous.data.createdAt,
    ) as Types.UniqueClaim;
    const operations: TransactionOperation[] = [
      { kind: "put", previousRecord: previous, record: next },
      { kind: "delete", record: claim },
    ];
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [next.data.id],
            scope,
            timestamp: timestampDate,
          }),
        ),
      );
    }
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-space-grant",
      aggregateVersion: next.data.version + 1,
      eventType: "memory-space-grant.revoked",
      payload: { revoked: true },
      scope,
    });
    try {
      await transactWithSemanticEvents(database, operations, [event]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) return requiredMemorySpaceGrant(scope, concurrentReplay[0]);
      throw cause;
    }
    return next;
  }

  return {
    grantMemorySpace,
    requiredMemorySpaceGrant,
    updateMemorySpaceGrant,
    setMemorySpaceGrantPermission,
    revokeMemorySpaceGrant,
  };
}

export type MemoryPlatformGrants = ReturnType<typeof makeMemoryPlatformGrants>;
