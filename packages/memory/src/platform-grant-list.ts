import { key, type Ulid, memoryPersistence } from "@deployments-ai/db";
import * as Shared from "./platform-shared.ts";
import * as Types from "./platform-types.ts";

export function makeMemoryPlatformGrantList(runtime: Shared.MemoryPlatformRuntime) {
  const { database } = runtime;

  async function listMemorySpaceGrants(
    scope: Types.MemoryPlatformScope,
    input: {
      readonly agentDefinitionId?: Ulid;
      readonly consistent?: boolean;
      readonly includeRevoked?: boolean;
    } = {},
  ) {
    let grants: Types.MemorySpaceGrant[];
    if (input.agentDefinitionId && !input.consistent) {
      grants = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      const prefix = input.includeRevoked
        ? `${key("MEMORY-SPACE-GRANT")}#`
        : `${key("MEMORY-SPACE-GRANT", "active")}#`;
      do {
        const result = await memoryPersistence.find(database, "control", {
          ExpressionAttributeValues: {
            ":pk": key(
              "ENV",
              scope.environmentId,
              "AGENT",
              input.agentDefinitionId,
              "MEMORY-SPACE-GRANTS",
            ),
            ":prefix": prefix,
          },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk AND begins_with(gsi1sk, :prefix)",
          Limit: Shared.MAX_LIMIT,
          ScanIndexForward: false,
        });
        const projected = result.items.filter(
          (value): value is Types.MemorySpaceGrant => value.itemType === "memory-space-grant",
        );
        const canonical = await Promise.all(
          projected.map((grant) =>
            Shared.loadRecord(
              database,
              "control",
              { pk: grant.pk, sk: grant.sk },
              "memory-space-grant",
            ),
          ),
        );
        grants.push(...canonical.filter((grant): grant is Types.MemorySpaceGrant => !!grant));
        exclusiveStartKey = result.lastEvaluatedKey;
      } while (exclusiveStartKey);
    } else {
      grants = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await memoryPersistence.find(database, "control", {
          ConsistentRead: true,
          ExpressionAttributeValues: {
            ":pk": key("ORG", scope.organizationId, "ENV", scope.environmentId),
            ":prefix": `${key("MEMORY-SPACE-GRANT")}#`,
          },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          Limit: Shared.MAX_LIMIT,
        });
        grants.push(
          ...result.items.filter(
            (value): value is Types.MemorySpaceGrant => value.itemType === "memory-space-grant",
          ),
        );
        exclusiveStartKey = result.lastEvaluatedKey;
      } while (exclusiveStartKey);
    }
    return grants.filter(
      (grant) =>
        Shared.scopeMatches(grant, scope) &&
        (input.includeRevoked || !grant.data.revokedAt) &&
        (!input.agentDefinitionId || grant.data.agentDefinitionId === input.agentDefinitionId),
    );
  }

  return { listMemorySpaceGrants };
}

export type MemoryPlatformGrantList = ReturnType<typeof makeMemoryPlatformGrantList>;
