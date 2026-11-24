import { describe, expect, it } from "bun:test";
import { fixedNow, grantedFlushRun, memoryDatabase } from "./memory-flush-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

describe("configured flush memory review", () => {
  it("auto-approves generated memories only when the flush requests it", async () => {
    const { database, put } = memoryDatabase();
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
    const space = await platform.createMemorySpace(scope, { name: "Trusted agent flush" });
    const run = await grantedFlushRun(platform, put, scope, space.data.id);
    const flush = await platform.enqueueFlush(scope, run, {
      memoryMode: "agent",
      memorySpaceId: space.data.id,
      reviewMode: "auto-approve",
    });

    const claimed = await platform.claimFlush(
      scope,
      run.data.id,
      flush.data.idempotencyKey,
      "test-worker",
    );
    expect(claimed.data.reviewMode).toBe("auto-approve");

    const result = await platform.importFlushCandidates(scope, {
      candidates: [{ content: "Remember a stable companion preference.", scope: "agent" }],
      flushId: flush.data.id,
      memoryMode: "agent",
      memorySpaceId: space.data.id,
      reviewMode: "auto-approve",
      run,
    });

    expect(result.imported[0]?.data.reviewStatus).toBe("approved");
    expect(await platform.listReviewItems(scope, { status: "open" })).toEqual([]);

    const directImport = await platform.importMemories(scope, {
      items: [{ content: "Keep direct imports governed.", scope: "workspace", source: "api" }],
      memorySpaceId: space.data.id,
      reviewMode: "auto-approve",
    });
    expect(directImport.imported[0]?.data.reviewStatus).toBe("pending");
  });
});
