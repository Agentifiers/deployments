import { describe, expect, it } from "bun:test";
import { memoryContentHash } from "./governance.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { fixedNow, memoryDatabase } from "./platform-indexing-test-fixtures.ts";

describe("health-flagged memory recall", () => {
  it("recalls a memory a person approved in review but not one nobody reviewed", async () => {
    const { database, put } = memoryDatabase();
    const search = fakeMemorySearchProvider();
    const platform = makeMemoryPlatform({
      database,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
      now: () => fixedNow,
      searchProvider: search.provider,
    });
    const scope = {
      environmentId: ids.environment,
      organizationId: ids.organization,
      projectId: ids.project,
      workspaceId: ids.workspace,
    };
    const space = await platform.createMemorySpace(scope, {
      kind: "workspace",
      name: "Health review",
      workspaceId: ids.workspace,
    });
    const reviewed = "Ava has physical therapy every Thursday at noon.";
    const imported = await platform.importMemories(scope, {
      items: [{ content: reviewed, scope: "workspace", workspaceId: ids.workspace }],
      memorySpaceId: space.data.id,
    });
    const [review] = await platform.listReviewItems(scope, { status: "open" });
    expect(review?.data.reason).toBe(
      "Possible health-related personal data requires review before recall.",
    );
    const approved = await platform.resolveReview(scope, {
      decision: "approve",
      memoryId: imported.imported[0]!.data.id,
      reviewId: review!.data.id,
    });
    const reviewedIndex = await platform.processIndexJob(scope, {
      idempotencyKey: `${approved.memory.data.id}:1:${fixedNow.getTime() * 1_000 + 1}:update`,
      memoryId: approved.memory.data.id,
    });

    const unreviewed = "Ben has physical therapy every Thursday at noon.";
    const autoApproved = memoryFixture({
      body: unreviewed,
      contentHash: memoryContentHash(unreviewed),
      id: ids.memory2,
      memorySpaceId: space.data.id,
      sensitivity: "restricted",
      source: "flush",
    });
    put("control", autoApproved);
    const job = await platform.enqueueIndexJob({
      memory: autoApproved,
      scope,
      synchronizationGeneration: 7,
    });
    const unreviewedIndex = await platform.processIndexJob(scope, {
      idempotencyKey: job.data.idempotencyKey,
      memoryId: autoApproved.data.id,
    });

    const recalled = await platform.search(scope, {
      memorySpaceIds: [space.data.id],
      query: "Who has physical therapy on Thursday?",
      searchKeys: [`workspace:${ids.workspace}`],
    });

    expect([reviewedIndex.data.skipReason, unreviewedIndex.data.skipReason]).toEqual([
      undefined,
      "unsafe-index-content",
    ]);
    expect(recalled.results.map((result) => result.memory.data.body)).toEqual([reviewed]);
  });
});
