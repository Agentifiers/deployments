import {
  prepareDynamoTransactionOperations,
  tableForItemType,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { fixedNow, memoryDatabase } from "./platform-indexing-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids } from "./test-fixtures.ts";

const SPACES = 6;
const target = {
  componentIds: [ids.space],
  embeddingProfileId: ids.agent,
  location: { region: "aws-us-east-2" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: ids.toolCall,
};
const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};
const inventoryPartition = `ORG#${ids.organization}#GOVERNANCE-INVENTORY`;
const inventoryShard = new RegExp(`^control ${inventoryPartition}#SHARD#(0\\d|1[0-5]) `, "u");

async function sentItems(operations: readonly TransactionOperation[]) {
  return (await prepareDynamoTransactionOperations(operations)).map((operation) =>
    operation.kind === "condition-check"
      ? { key: `${operation.table} ${operation.key.pk} ${operation.key.sk}`, kind: operation.kind }
      : {
          key: `${tableForItemType(operation.record.itemType)} ${operation.record.pk} ${operation.record.sk}`,
          kind: operation.kind,
        },
  );
}

describe("memory writes in one organization", () => {
  test("imports and approvals in different spaces share no item but one of 32 gate lanes", async () => {
    const { database, transactions } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchRoutingResolver: async () => ({
        fenceEpoch: 7,
        fenceVersion: 3,
        placementGeneration: 5,
        placementPhase: "active",
        placementVersion: 4,
        read: { providerId: target.providerId, target },
        writes: [{ providerId: target.providerId, target }],
      }),
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const spaces: Ulid[] = [];
    for (let index = 0; index < 2 * SPACES; index += 1) {
      spaces.push(
        (await platform.createMemorySpace(scope, { kind: "workspace", name: `Space ${index}` }))
          .data.id,
      );
    }
    const toApprove: Ulid[] = [];
    for (const space of spaces.slice(SPACES)) {
      const imported = await platform.importMemories(scope, {
        items: [
          { content: `Reviewed fact in ${space}.`, scope: "workspace", workspaceId: ids.workspace },
        ],
        memorySpaceId: space,
      });
      toApprove.push(imported.imported[0]!.data.id);
    }

    const importMark = transactions.length;
    for (const space of spaces.slice(0, SPACES)) {
      await platform.importMemories(scope, {
        items: [
          { content: `New fact in ${space}.`, scope: "workspace", workspaceId: ids.workspace },
        ],
        memorySpaceId: space,
      });
    }
    const imports = transactions.slice(importMark);
    const approvalMark = transactions.length;
    const reviews = await platform.listReviewItems(scope, { status: "open" });
    for (const memoryId of toApprove) {
      const review = reviews.find((item) => item.data.memoryId === memoryId)!;
      await platform.resolveReview(scope, {
        decision: "approve",
        memoryId,
        reviewId: review.data.id,
      });
    }
    const approvals = transactions.slice(approvalMark);
    const sent = await Promise.all([...imports, ...approvals].map(sentItems));
    const transactionsByItem = new Map<string, number>();
    for (const items of sent) {
      for (const { key } of new Set(items)) {
        transactionsByItem.set(key, (transactionsByItem.get(key) ?? 0) + 1);
      }
    }

    expect([imports.length, approvals.length]).toEqual([SPACES, SPACES]);
    expect(
      sent.map((items) => ({
        conditionChecks: items.filter(({ kind }) => kind === "condition-check").length,
        inventoryShards: items.filter(({ key }) => inventoryShard.test(key)).length,
        legacyInventory: items.filter(({ key }) => key.startsWith(`control ${inventoryPartition} `))
          .length,
        items: items.length,
      })),
    ).toEqual([
      ...Array.from({ length: SPACES }, () => ({
        conditionChecks: 2,
        inventoryShards: 9,
        legacyInventory: 0,
        items: 20,
      })),
      ...Array.from({ length: SPACES }, () => ({
        conditionChecks: 1,
        inventoryShards: 8,
        legacyInventory: 0,
        items: 17,
      })),
    ]);
    expect(
      sent.map((items) =>
        items
          .filter(({ key }) => key.startsWith(`control ORG#${ids.organization} ORG`))
          .map(({ key }) => key.replace(/#\d\d$/, "#NN")),
      ),
    ).toEqual(
      Array.from({ length: 2 * SPACES }, () => [
        `control ORG#${ids.organization} ORGANIZATION-GATE-LANE#NN`,
      ]),
    );
    expect([...transactionsByItem].filter(([, count]) => count > 1).map(([key]) => key)).toEqual(
      [...transactionsByItem.keys()].filter(
        (key) => key.includes(" ORGANIZATION-GATE-LANE#") && transactionsByItem.get(key)! > 1,
      ),
    );
    expect(
      [...transactionsByItem.keys()].filter((key) =>
        /(ERASURE-FENCE|MEMORY-SEARCH-PLACEMENT|MEMORY-SEARCH-MUTATION-FENCE|MEMORY-PROVIDER-MUTATION-GATE)#/.test(
          key,
        ),
      ),
    ).toEqual([]);
  });
});
