import {
  MemoryPolicyRecord,
  MemorySpaceRecord,
  Keys,
  makeUniqueClaimRecord,
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
export function makeMemoryPlatformSpaces(
  runtime: Shared.MemoryPlatformRuntime & MemoryPlatformCore,
) {
  const {
    cursorCodec,
    database,
    generateId,
    now,
    idempotencyReplay,
    completedIdempotency,
    idempotencyOperation,
    eventFor,
    requiredSpace,
    requiredMutableSpace,
    loadPoliciesStrong,
    preparedSearchRoutingFence,
  } = runtime;

  async function createMemorySpace(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly description?: string;
      readonly idempotencyKey?: string;
      readonly kind?: Types.MemorySpace["data"]["kind"];
      readonly name: string;
      readonly retentionDays?: number;
      readonly workspaceId?: Ulid;
    },
  ) {
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    Shared.requireWorkspaceMatch(scope, input.workspaceId, "Memory space workspaceId");
    const workspaceId = input.workspaceId ?? scope.workspaceId;
    const kind = input.kind ?? (workspaceId ? "workspace" : "organization");
    if (kind === "workspace" && !workspaceId) {
      throw new Types.MemoryPlatformError(
        400,
        "workspace_required",
        "Workspace memory spaces require workspaceId.",
      );
    }
    if (kind !== "workspace" && workspaceId) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_scope",
        "Only workspace memory spaces may include workspaceId.",
      );
    }
    const retentionDays = input.retentionDays;
    if (
      retentionDays !== undefined &&
      (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650)
    ) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_retention",
        "retentionDays must be an integer between 1 and 3650.",
      );
    }
    const normalized = {
      ...(input.description?.trim()
        ? {
            description: Shared.requireText(input.description, "Description", 2_000),
          }
        : {}),
      kind,
      name: Shared.requireText(input.name, "Memory space name", 160),
      ...(retentionDays === undefined ? {} : { retentionDays }),
      ...(workspaceId ? { workspaceId } : {}),
    };
    const idempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      operation: "memory-space.create",
      ...normalized,
    });
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) return requiredSpace(scope, replay[0]);
    const space = Shared.record(
      MemorySpaceRecord,
      withCanonicalRecordKeys({
        data: {
          createdAt: timestamp,
          ...normalized,
          environmentId: scope.environmentId,
          id: await generateId(),
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          status: "active" as const,
          updatedAt: timestamp,
          version: 0,
        },
        itemType: "memory-space" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: space.data.id,
      aggregateType: "memory-space",
      aggregateVersion: 1,
      eventType: "memory-space.created",
      payload: { kind: space.data.kind, status: space.data.status },
      scope,
    });
    const operations: TransactionOperation[] = [{ kind: "put", record: space }];
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [space.data.id],
            scope,
            timestamp: timestampDate,
          }),
        ),
      );
    }
    try {
      await transactWithSemanticEvents(database, operations, [event]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) return requiredSpace(scope, concurrentReplay[0]);
      throw cause;
    }
    return space;
  }

  async function listMemorySpaces(
    scope: Types.MemoryPlatformScope,
    input: { readonly limit?: number } = {},
  ) {
    const spaces = await Shared.queryEnvironmentRecords<Types.MemorySpace>({
      database,
      environmentId: scope.environmentId,
      filter: (space) => Shared.scopeMatches(space, scope),
      itemType: "memory-space",
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      table: "control",
    });
    return spaces;
  }

  async function archiveMemorySpaceOnce(
    scope: Types.MemoryPlatformScope,
    memorySpaceId: Ulid,
    input: { readonly idempotencyKey?: string } = {},
  ) {
    const previous = await requiredMutableSpace(scope, memorySpaceId);
    const idempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      memorySpaceId,
      operation: "memory-space.archive",
    });
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) return requiredSpace(scope, replay[0]);
    const timestampDate = now();
    let archived = previous;
    if (previous.data.status === "archived") {
      if (!idempotencyKey) return previous;
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
              ":itemType": "memory-space",
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
        if (concurrentReplay?.[0]) return requiredSpace(scope, concurrentReplay[0]);
        throw cause;
      }
      return previous;
    }
    const timestamp = Shared.iso(timestampDate);
    archived = Shared.record(
      MemorySpaceRecord,
      withCanonicalRecordKeys({
        itemType: "memory-space" as const,
        data: {
          ...previous.data,
          status: "archived" as const,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
      }),
    );
    const event = await eventFor({
      aggregateId: archived.data.id,
      aggregateType: "memory-space",
      aggregateVersion: archived.data.version + 1,
      eventType: "memory-space.archived",
      payload: {
        status: archived.data.status,
        ...(archived.data.workspaceId ? { workspaceId: archived.data.workspaceId } : {}),
      },
      scope,
    });
    const { operations: routingOperations } = await preparedSearchRoutingFence(
      scope.organizationId,
    );
    const operations: TransactionOperation[] = [
      ...routingOperations,
      { kind: "put", previousRecord: previous, record: archived },
    ];
    if (idempotencyKey) {
      operations.push(
        idempotencyOperation(
          completedIdempotency({
            commandHash: expectedCommandHash,
            idempotencyKey,
            resourceIds: [archived.data.id],
            scope,
            timestamp: timestampDate,
          }),
        ),
      );
    }
    try {
      await transactWithSemanticEvents(database, operations, [event]);
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) return requiredSpace(scope, concurrentReplay[0]);
      throw cause;
    }
    return archived;
  }

  async function upsertPolicyOnce(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly activeRecallEnabled?: boolean;
      readonly activeRecallRolloutPercent?: number;
      readonly createOnly?: boolean;
      readonly id?: Ulid;
      readonly idempotencyKey?: string;
      readonly processingConfig?: Readonly<Record<string, unknown>>;
      readonly retentionDays?: number;
      readonly scope?: Types.MemoryPolicy["data"]["scope"];
      readonly sensitivityMode?: Types.MemoryPolicy["data"]["sensitivityMode"];
      readonly workspaceId?: Ulid;
    },
    retryCount = 0,
  ): Promise<Types.MemoryPolicy> {
    Shared.requireWorkspaceMatch(scope, input.workspaceId, "Memory policy workspaceId");
    if (
      input.activeRecallRolloutPercent !== undefined &&
      (!Number.isFinite(input.activeRecallRolloutPercent) ||
        input.activeRecallRolloutPercent < 0 ||
        input.activeRecallRolloutPercent > 100)
    ) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_rollout",
        "activeRecallRolloutPercent must be between 0 and 100.",
      );
    }
    if (
      input.retentionDays !== undefined &&
      (!Number.isSafeInteger(input.retentionDays) ||
        input.retentionDays < 1 ||
        input.retentionDays > 3_650)
    ) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_retention",
        "retentionDays must be an integer between 1 and 3650.",
      );
    }
    let previous = input.id
      ? await Shared.loadRecord(
          database,
          "control",
          Shared.memoryPolicyKey(scope, input.id),
          "memory-policy",
        )
      : undefined;
    if (previous && !Shared.mutationScopeMatches(previous, scope)) {
      throw new Types.MemoryPlatformError(
        404,
        "memory_policy_not_found",
        "Memory policy was not found.",
      );
    }
    if (input.id && !previous) {
      throw new Types.MemoryPlatformError(
        404,
        "memory_policy_not_found",
        "Memory policy was not found.",
      );
    }
    const policyScope = input.scope ?? previous?.data.scope ?? "environment";
    const workspaceId =
      policyScope === "workspace"
        ? (input.workspaceId ?? previous?.data.workspaceId ?? scope.workspaceId)
        : undefined;
    if (policyScope === "workspace" && !workspaceId) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_scope",
        "Workspace memory policies require workspaceId.",
      );
    }
    if (
      previous &&
      (previous.data.scope !== policyScope || previous.data.workspaceId !== workspaceId)
    ) {
      throw new Types.MemoryPlatformError(
        409,
        "memory_policy_scope_immutable",
        "Memory policy scope cannot be changed after creation.",
      );
    }
    if (scope.exactWorkspaceMutations && scope.workspaceId && policyScope !== "workspace") {
      throw new Types.MemoryPlatformError(
        403,
        "workspace_scope_conflict",
        "Workspace-scoped credentials cannot mutate broader memory policies.",
      );
    }
    if (!input.id) {
      const matching = (await loadPoliciesStrong(scope))
        .filter(
          (policy) =>
            Shared.mutationScopeMatches(policy, scope) &&
            policy.data.scope === policyScope &&
            policy.data.workspaceId === workspaceId,
        )
        .sort(
          (left, right) =>
            right.data.updatedAt.localeCompare(left.data.updatedAt) ||
            right.data.id.localeCompare(left.data.id),
        );
      const [claimRequirement] = matching[0] ? uniqueClaimRequirements(matching[0]) : [];
      const existingClaim = claimRequirement
        ? await Shared.loadRecord(
            database,
            "control",
            Keys.control.uniqueClaim(claimRequirement.namespace, claimRequirement.value),
            "unique-claim",
          )
        : undefined;
      previous =
        matching.find((policy) => policy.data.id === existingClaim?.data.ownerId) ?? matching[0];
    }
    const policyId = previous?.data.id ?? input.id ?? (await generateId());
    const rollout = Math.max(
      0,
      Math.min(
        100,
        Math.trunc(
          input.activeRecallRolloutPercent ?? previous?.data.activeRecallRolloutPercent ?? 100,
        ),
      ),
    );
    const retentionDays = input.retentionDays ?? previous?.data.retentionDays;
    const processingConfig = input.processingConfig ?? previous?.data.processingConfig;
    if (processingConfig !== undefined) {
      let processingConfigBytes: number;
      try {
        processingConfigBytes = new TextEncoder().encode(
          JSON.stringify(processingConfig),
        ).byteLength;
      } catch {
        throw new Types.MemoryPlatformError(
          400,
          "invalid_processing_config",
          "Memory policy processingConfig must be JSON serializable.",
        );
      }
      if (processingConfigBytes > Shared.MAX_POLICY_PROCESSING_CONFIG_BYTES) {
        throw new Types.MemoryPlatformError(
          400,
          "invalid_processing_config",
          `Memory policy processingConfig must not exceed ${Shared.MAX_POLICY_PROCESSING_CONFIG_BYTES} UTF-8 bytes.`,
        );
      }
    }
    const normalized = {
      activeRecallEnabled: input.activeRecallEnabled ?? previous?.data.activeRecallEnabled ?? false,
      activeRecallRolloutPercent: rollout,
      ...(input.id ? { id: input.id } : {}),
      ...(processingConfig ? { processingConfig } : {}),
      ...(retentionDays === undefined ? {} : { retentionDays }),
      scope: policyScope,
      sensitivityMode: input.sensitivityMode ?? previous?.data.sensitivityMode ?? "standard",
      ...(workspaceId ? { workspaceId } : {}),
    };
    const idempotencyKey = input.idempotencyKey?.trim();
    const expectedCommandHash = Shared.commandHash({
      ...(input.createOnly ? { createOnly: true } : {}),
      operation: "memory-policy.upsert",
      ...normalized,
    });
    const replay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
    if (replay?.[0]) {
      const replayed = await Shared.loadRecord(
        database,
        "control",
        Shared.memoryPolicyKey(scope, replay[0]),
        "memory-policy",
      );
      if (replayed && Shared.scopeMatches(replayed, scope)) return replayed;
    }
    if (input.createOnly && previous) {
      throw new Types.MemoryPlatformError(
        409,
        "memory_policy_exists",
        "A memory policy already exists for the requested scope.",
      );
    }
    const timestampDate = now();
    const timestamp = Shared.iso(timestampDate);
    const next = Shared.record(
      MemoryPolicyRecord,
      withCanonicalRecordKeys({
        data: {
          ...normalized,
          createdAt: previous?.data.createdAt ?? timestamp,
          environmentId: scope.environmentId,
          id: policyId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          updatedAt: timestamp,
          version: (previous?.data.version ?? -1) + 1,
        },
        itemType: "memory-policy" as const,
      }),
    );
    const event = await eventFor({
      aggregateId: next.data.id,
      aggregateType: "memory-policy",
      aggregateVersion: next.data.version + 1,
      eventType: previous ? "memory-policy.updated" : "memory-policy.created",
      payload: {
        activeRecallEnabled: next.data.activeRecallEnabled,
        sensitivityMode: next.data.sensitivityMode,
        ...(next.data.workspaceId ? { workspaceId: next.data.workspaceId } : {}),
      },
      scope,
    });
    const ownerPolicies = await loadPoliciesStrong(Shared.memoryOwnedScope(scope, workspaceId));
    const reconcileEvent = Shared.reconciledPolicyChanged(
      Shared.effectivePolicyAmong(ownerPolicies, workspaceId),
      Shared.effectivePolicyAmong(
        [next, ...ownerPolicies.filter((policy) => policy.data.id !== next.data.id)],
        workspaceId,
      ),
    )
      ? await eventFor({
          aggregateId: await generateId(),
          aggregateType: "memory-reconciliation",
          aggregateVersion: 1,
          eventType: "memory.reconcile.requested",
          payload: workspaceId ? { workspaceId } : {},
          scope,
        })
      : undefined;
    const [claimRequirement] = uniqueClaimRequirements(next);
    const existingClaim = claimRequirement
      ? await Shared.loadRecord(
          database,
          "control",
          Keys.control.uniqueClaim(claimRequirement.namespace, claimRequirement.value),
          "unique-claim",
        )
      : undefined;
    const { operations: routingOperations } = await preparedSearchRoutingFence(
      scope.organizationId,
    );
    const operations: TransactionOperation[] = [
      ...routingOperations,
      {
        kind: "put",
        ...(previous ? { previousRecord: previous } : {}),
        record: next,
      },
    ];
    if (claimRequirement && !existingClaim) {
      operations.push({
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: makeUniqueClaimRecord(claimRequirement, timestamp) as Types.UniqueClaim,
      });
    }
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
    try {
      await transactWithSemanticEvents(
        database,
        operations,
        reconcileEvent ? [event, reconcileEvent] : [event],
      );
    } catch (cause) {
      const concurrentReplay = await idempotencyReplay(scope, idempotencyKey, expectedCommandHash);
      if (concurrentReplay?.[0]) {
        const replayed = await Shared.loadRecord(
          database,
          "control",
          Shared.memoryPolicyKey(scope, concurrentReplay[0]),
          "memory-policy",
        );
        if (replayed && Shared.scopeMatches(replayed, scope)) return replayed;
      }
      if (claimRequirement) {
        const claimed = await Shared.loadRecord(
          database,
          "control",
          Keys.control.uniqueClaim(claimRequirement.namespace, claimRequirement.value),
          "unique-claim",
        );
        if (claimed?.data.ownerItemType === "memory-policy") {
          const winningPolicy = await Shared.loadRecord(
            database,
            "control",
            { pk: claimed.data.ownerPk, sk: claimed.data.ownerSk },
            "memory-policy",
          );
          if (winningPolicy && Shared.mutationScopeMatches(winningPolicy, scope)) {
            if (input.createOnly) {
              throw new Types.MemoryPlatformError(
                409,
                "memory_policy_exists",
                "A memory policy already exists for the requested scope.",
              );
            }
            if (retryCount >= 3) {
              throw new Types.MemoryPlatformError(
                409,
                "memory_policy_conflict",
                "Memory policy changed concurrently; retry the request.",
              );
            }
            const { idempotencyKey: _retryIdempotencyKey, ...retryInput } = input;
            const applied: Types.MemoryPolicy = await upsertPolicyOnce(
              scope,
              { ...retryInput, id: winningPolicy.data.id },
              retryCount + 1,
            );
            if (idempotencyKey) {
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
                      ":itemType": "memory-policy",
                      ":version": applied.data.version,
                    },
                    key: { pk: applied.pk, sk: applied.sk },
                    kind: "condition-check",
                    table: "control",
                  },
                  idempotencyOperation(
                    completedIdempotency({
                      commandHash: expectedCommandHash,
                      idempotencyKey,
                      resourceIds: [applied.data.id],
                      scope,
                      timestamp: now(),
                    }),
                  ),
                ]);
              } catch (idempotencyCause) {
                const winnerReplay = await idempotencyReplay(
                  scope,
                  idempotencyKey,
                  expectedCommandHash,
                );
                if (!winnerReplay?.includes(applied.data.id)) throw idempotencyCause;
              }
            }
            return applied;
          }
        }
      }
      throw cause;
    }
    return next;
  }

  async function listPolicies(scope: Types.MemoryPlatformScope) {
    const policies = await Shared.queryEnvironmentRecords<Types.MemoryPolicy>({
      database,
      environmentId: scope.environmentId,
      filter: (policy) => Shared.scopeMatches(policy, scope),
      itemType: "memory-policy",
      limit: Shared.MAX_LIMIT,
      table: "control",
    });
    return policies;
  }

  async function listPoliciesPage(
    scope: Types.MemoryPlatformScope,
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ) {
    return Shared.queryEnvironmentRecordPage<Types.MemoryPolicy>({
      ...input,
      cursorCodec,
      database,
      environmentId: scope.environmentId,
      filter: (policy) => Shared.scopeMatches(policy, scope),
      itemType: "memory-policy",
      table: "control",
    });
  }

  function archiveMemorySpace(
    scope: Types.MemoryPlatformScope,
    memorySpaceId: Ulid,
    input: { readonly idempotencyKey?: string } = {},
  ) {
    return Shared.retryDatabaseWriteConflicts(() =>
      archiveMemorySpaceOnce(scope, memorySpaceId, input),
    );
  }

  function upsertPolicy(
    scope: Types.MemoryPlatformScope,
    input: Parameters<typeof upsertPolicyOnce>[1],
  ) {
    return Shared.retryDatabaseWriteConflicts(() => upsertPolicyOnce(scope, input));
  }

  return {
    createMemorySpace,
    listMemorySpaces,
    archiveMemorySpace,
    upsertPolicy,
    listPolicies,
    listPoliciesPage,
  };
}

export type MemoryPlatformSpaces = ReturnType<typeof makeMemoryPlatformSpaces>;
