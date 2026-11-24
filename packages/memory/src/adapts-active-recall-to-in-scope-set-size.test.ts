import { describe, expect, it } from "bun:test";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import { fixedNow, memoryDatabase } from "./platform-indexing-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids } from "./test-fixtures.ts";

const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};

interface SeededMemory {
  readonly content: string;
  readonly validFrom: string;
}

// `tokens` is the platform estimate of ceil(UTF-8 bytes / 4); each note is exactly that size.
function note(label: string, tokens: number, validFrom: string): SeededMemory {
  return { content: `${label}.`.padEnd(tokens * 4, " x"), validFrom };
}

function day(index: number) {
  return new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
}

async function activeRecall(
  memories: readonly SeededMemory[],
  options: {
    readonly processingConfig?: Readonly<Record<string, unknown>>;
    readonly topK?: number;
  } = {},
) {
  const { database } = memoryDatabase();
  const search = fakeMemorySearchProvider();
  const platform = makeMemoryPlatform({
    database,
    embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
    now: () => fixedNow,
    searchProvider: {
      ...search.provider,
      query: async (input) => (await search.provider.query(input)).slice(0, input.topK),
      readiness: async () => ({
        denseReady: true,
        lexicalReady: true,
        reference: "test",
        ready: true,
        schemaReady: true,
      }),
    },
  });
  const space = await platform.createMemorySpace(scope, {
    kind: "workspace",
    name: "Recall",
    workspaceId: ids.workspace,
  });
  await platform.upsertPolicy(scope, {
    activeRecallEnabled: true,
    ...(options.processingConfig ? { processingConfig: options.processingConfig } : {}),
  });
  const imported = await platform.importMemories(scope, {
    items: memories.map((memory) => ({
      ...memory,
      scope: "workspace" as const,
      workspaceId: ids.workspace,
    })),
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
  const recalled = await platform.search(scope, {
    memorySpaceIds: [space.data.id],
    purpose: "active-recall",
    query: "What happened this year?",
    runId: ids.run,
    searchKeys: [`workspace:${ids.workspace}`],
    threadId: ids.thread,
    ...(options.topK === undefined ? {} : { topK: options.topK }),
  });
  return {
    contextTokens: recalled.attempt.data.contextTokens,
    duplicateCount: recalled.attempt.data.duplicateCount,
    labels: recalled.results.map((result) => result.memory.data.body!.split(".")[0]),
    retrievals: recalled.retrievals.length,
    selectionMode: recalled.attempt.data.selectionMode,
  };
}

describe("active recall selection", () => {
  it("returns a small in-scope set whole and oldest first", async () => {
    expect(
      await activeRecall([
        note("March", 50, day(60)),
        note("January", 50, day(0)),
        note("February", 50, day(31)),
      ]),
    ).toEqual({
      contextTokens: 150,
      duplicateCount: 0,
      labels: ["January", "February", "March"],
      retrievals: 3,
      selectionMode: "whole-set",
    });
  });

  it("suppresses duplicates in a whole-set recall as ranked recall does, and counts them", async () => {
    const memories = [
      { content: "Moved to Lisbon in March.", validFrom: day(60) },
      { content: "Started a new job in January.", validFrom: day(0) },
      { content: "started a new job in january", validFrom: day(10) },
    ];
    expect(
      await activeRecall(memories, {
        processingConfig: {
          memoryRetrieval: { purposes: { "active-recall": { strategy: "hybrid-rrf-v1" } } },
        },
      }),
    ).toEqual({
      contextTokens: 15,
      duplicateCount: 1,
      labels: ["Started a new job in January", "Moved to Lisbon in March"],
      retrievals: 2,
      selectionMode: "whole-set",
    });
    expect(await activeRecall(memories)).toEqual({
      contextTokens: 22,
      duplicateCount: 0,
      labels: [
        "Started a new job in January",
        "started a new job in january",
        "Moved to Lisbon in March",
      ],
      retrievals: 3,
      selectionMode: "whole-set",
    });
  });

  it("includes a whole set above the 4,000-token budget up to the 7,000-token cap", async () => {
    expect(
      await activeRecall([
        note("Third", 1_750, day(2)),
        note("First", 1_750, day(0)),
        note("Fourth", 1_750, day(3)),
        note("Second", 1_750, day(1)),
      ]),
    ).toEqual({
      contextTokens: 7_000,
      duplicateCount: 0,
      labels: ["First", "Second", "Third", "Fourth"],
      retrievals: 4,
      selectionMode: "whole-set",
    });
  });

  it("ranks and budgets a set larger than the cap", async () => {
    expect(
      await activeRecall([
        note("Fourth", 1_500, day(3)),
        note("Second", 1_500, day(1)),
        note("Third", 1_500, day(2)),
        note("First", 1_500, day(0)),
        note("Fifth", 1_500, day(4)),
      ]),
    ).toEqual({
      contextTokens: 3_000,
      duplicateCount: 0,
      labels: ["Fourth", "Second"],
      retrievals: 2,
      selectionMode: "ranked",
    });
  });

  it("ranks a set of more than 32 memories to the default limit", async () => {
    const memories = Array.from({ length: 40 }, (_, index) =>
      note(`Note ${index}`, 20, day(40 - index)),
    );
    const recalled = await activeRecall(memories);
    expect(recalled.labels).toHaveLength(32);
    expect(recalled.labels.slice(0, 3)).toEqual(["Note 0", "Note 1", "Note 2"]);
    expect(recalled.labels.at(-1)).toBe("Note 31");
    expect(recalled.contextTokens).toBe(640);
  });

  it("keeps a caller's topK as the limit on a whole-set recall", async () => {
    expect(
      await activeRecall(
        [note("Third", 50, day(2)), note("First", 50, day(0)), note("Second", 50, day(1))],
        { topK: 2 },
      ),
    ).toEqual({
      contextTokens: 100,
      duplicateCount: 0,
      labels: ["Third", "First"],
      retrievals: 2,
      selectionMode: "ranked",
    });
  });

  it("takes a whole set of at most 32 memories when the caller's topK is higher", async () => {
    const notes = (count: number) =>
      Array.from({ length: count }, (_, index) => note(`Note ${index}`, 20, day(index)));
    const recalled = async (count: number) => {
      const { contextTokens, retrievals, selectionMode } = await activeRecall(notes(count), {
        topK: 40,
      });
      return { contextTokens, retrievals, selectionMode };
    };
    expect([await recalled(32), await recalled(33)]).toEqual([
      { contextTokens: 640, retrievals: 32, selectionMode: "whole-set" },
      { contextTokens: 660, retrievals: 33, selectionMode: "ranked" },
    ]);
  });

  it("keeps an explicitly configured budget on ranked recall", async () => {
    expect(
      await activeRecall(
        [note("Third", 500, day(2)), note("First", 500, day(0)), note("Second", 500, day(1))],
        {
          processingConfig: {
            memoryRetrieval: { purposes: { "active-recall": { contextTokenBudget: 1_200 } } },
          },
        },
      ),
    ).toEqual({
      contextTokens: 1_000,
      duplicateCount: 0,
      labels: ["Third", "First"],
      retrievals: 2,
      selectionMode: "ranked",
    });
  });

  it("lets the policy lower or disable the full-context cap but not raise it past 7,000", async () => {
    const large = [
      note("Third", 1_750, day(2)),
      note("First", 1_750, day(0)),
      note("Fifth", 1_750, day(4)),
      note("Second", 1_750, day(1)),
      note("Fourth", 1_750, day(3)),
    ];
    expect(
      await activeRecall(large, {
        processingConfig: { memoryRetrieval: { fullContextTokenCap: 10_000 } },
      }),
    ).toEqual({
      contextTokens: 3_500,
      duplicateCount: 0,
      labels: ["Third", "First"],
      retrievals: 2,
      selectionMode: "ranked",
    });
    expect(
      await activeRecall(
        [note("Third", 500, day(2)), note("First", 500, day(0)), note("Second", 500, day(1))],
        { processingConfig: { memoryRetrieval: { fullContextTokenCap: 1_000 } } },
      ),
    ).toEqual({
      contextTokens: 1_500,
      duplicateCount: 0,
      labels: ["Third", "First", "Second"],
      retrievals: 3,
      selectionMode: "ranked",
    });
    expect(
      await activeRecall(
        [note("Third", 50, day(2)), note("First", 50, day(0)), note("Second", 50, day(1))],
        {
          processingConfig: {
            memoryRetrieval: { purposes: { "active-recall": { fullContextTokenCap: 0 } } },
          },
        },
      ),
    ).toEqual({
      contextTokens: 150,
      duplicateCount: 0,
      labels: ["Third", "First", "Second"],
      retrievals: 3,
      selectionMode: "ranked",
    });
  });
});
