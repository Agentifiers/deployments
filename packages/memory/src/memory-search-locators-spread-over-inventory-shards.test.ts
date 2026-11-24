import { prepareDynamoTransactionOperations, tableForItemType } from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { fixedNow, memoryDatabase } from "./platform-indexing-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids } from "./test-fixtures.ts";

const inventoryPartition = `ORG#${ids.organization}#GOVERNANCE-INVENTORY`;
const inventoryShard = new RegExp(`^control ${inventoryPartition}#SHARD#(0\\d|1[0-5]) `, "u");

describe("memory search writes", () => {
  it("writes one inventory locator per stored record, each on a shard", async () => {
    const { database, transactions } = memoryDatabase();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: fakeMemorySearchProvider().provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Recall",
      workspaceId: ids.workspace,
    });
    const imported = await platform.importMemories(scope, {
      items: ["Ava likes green tea.", "Ava runs on Tuesdays.", "Ava lives in Lisbon."].map(
        (content) => ({ content, scope: "workspace" as const, workspaceId: ids.workspace }),
      ),
      memorySpaceId: space.data.id,
    });
    const reviews = await platform.listReviewItems(scope, { status: "open" });
    for (const memory of imported.imported) {
      const review = reviews.find((item) => item.data.memoryId === memory.data.id);
      const current = review
        ? (
            await platform.resolveReview(scope, {
              decision: "approve",
              memoryId: memory.data.id,
              reviewId: review.data.id,
            })
          ).memory
        : memory;
      await platform.processIndexJob(scope, {
        idempotencyKey: `${current.data.id}:${current.data.version}:${fixedNow.getTime() * 1_000 + 1}:update`,
        memoryId: current.data.id,
      });
    }

    const searchMark = transactions.length;
    const recalled = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "What does Ava do?",
      searchKeys: [`workspace:${ids.workspace}`],
    });
    const sent = await Promise.all(
      transactions
        .slice(searchMark)
        .map(async (operations) =>
          (await prepareDynamoTransactionOperations(operations)).map((operation) =>
            operation.kind === "condition-check"
              ? `${operation.table} ${operation.key.pk} ${operation.key.sk}`
              : `${tableForItemType(operation.record.itemType)} ${operation.record.pk} ${operation.record.sk}`,
          ),
        ),
    );

    expect(recalled.results).toHaveLength(3);
    expect(
      sent.map((keys) => ({
        inventoryShards: keys.filter((key) => inventoryShard.test(key)).length,
        items: keys.length,
        legacyInventory: keys.filter((key) => key.startsWith(`control ${inventoryPartition} `))
          .length,
      })),
    ).toEqual([{ inventoryShards: 4, items: 9, legacyInventory: 0 }]);
  });
});
