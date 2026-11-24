import { describe, expect, it, spyOn } from "bun:test";
import type { MemoryPlatform } from "@deployments-ai/memory";
import type { ModelCatalogRuntimeEntry } from "@deployments-ai/model-gateway";
import { handleMemoryFlushQueue } from "./flush-worker.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};
const catalogModelId = "openrouter/vendor/catalog-only";
const catalogEntry: ModelCatalogRuntimeEntry = {
  contextWindowTokens: 64_000,
  maximumOutputTokens: 2_048,
  pricing: { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.4 },
};

interface SavedFlush {
  checkpoint?: Readonly<Record<string, unknown>>;
  completionModelId?: string | undefined;
}

function checkpointPlatform(saved: SavedFlush) {
  const messages = [
    {
      data: {
        body: "My interview is tomorrow.",
        createdAt: "2026-08-10T18:30:00.000Z",
        role: "user",
        sequence: 0,
      },
    },
    {
      data: {
        body: "I'll check in after it.",
        createdAt: "2026-08-10T18:31:00.000Z",
        role: "assistant",
        sequence: 1,
      },
    },
  ];
  return {
    // A catalog-admitted release pins no explicit context budgets.
    agentReleaseForRun: async () => ({
      data: {
        agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        manifest: { spec: { model: { id: catalogModelId }, runtime: {} } },
      },
    }),
    claimFlush: async () => ({
      data: {
        attempt: 1,
        checkpointMode: "auto",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
        memoryMode: "off",
        modelId: catalogModelId,
        status: "running",
      },
    }),
    completeFlush: async (...args: unknown[]) => {
      saved.completionModelId = args[6] as string | undefined;
    },
    failFlush: async () => undefined,
    findRun: async () => ({
      data: {
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      },
    }),
    latestConversationCheckpoint: async () => undefined,
    messagesForConversationCheckpoint: async () => messages,
    messagesForThread: async () => messages.toReversed(),
    modelTokenQuantityForRun: async () => 0,
    resolveMessageContent: async () => undefined,
    saveConversationCheckpoint: async (
      _scope: unknown,
      input: Readonly<Record<string, unknown>>,
    ) => {
      saved.checkpoint = input;
      return { data: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAE" } };
    },
  } as unknown as MemoryPlatform;
}

const flushEvent = {
  Records: [
    {
      body: JSON.stringify({
        detail: {
          ...scope,
          idempotencyKey: "memory-flush:catalog-run",
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
        },
      }),
      messageId: "message-catalog-checkpoint",
    },
  ],
};

describe("memory flush worker with catalog-admitted models", () => {
  it("sizes and meters a catalog model without explicit budgets from its catalog entry", async () => {
    const saved: { checkpoint?: Readonly<Record<string, unknown>> } = {};
    const requestedCatalogIds: string[][] = [];
    let completionRuntime: unknown;
    const result = await handleMemoryFlushQueue(flushEvent, {
      generateCompletion: async ({ modelRuntime }) => {
        completionRuntime = modelRuntime;
        return JSON.stringify({ checkpoint: "Interview tomorrow; check in after.", memories: [] });
      },
      getModelCatalogEntries: async (modelIds) => {
        requestedCatalogIds.push([...modelIds]);
        return new Map([[catalogModelId, catalogEntry]]);
      },
      platform: checkpointPlatform(saved),
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(requestedCatalogIds).toEqual([[catalogModelId]]);
    expect(completionRuntime).toMatchObject({
      modelCatalog: { [catalogModelId]: catalogEntry },
    });
    expect(saved.checkpoint).toMatchObject({ fromSequence: 0, throughSequence: 1 });
  });

  describe("with a deployment flush model", () => {
    const deploymentModelId = "openrouter/vendor/deployment-flush";
    const catalog: Record<string, ModelCatalogRuntimeEntry> = {
      [catalogModelId]: catalogEntry,
      [deploymentModelId]: catalogEntry,
    };

    async function flushWith(admitted: boolean) {
      const saved: SavedFlush = {};
      const admissions: unknown[][] = [];
      let completionModelId = "";
      const result = await handleMemoryFlushQueue(flushEvent, {
        admitFlushModel: async (modelId, tenancy) => {
          admissions.push([modelId, tenancy]);
          return admitted
            ? { admitted: true }
            : { admitted: false, reason: "Environment policy does not allow it." };
        },
        flushModelId: deploymentModelId,
        generateCompletion: async ({ modelId }) => {
          completionModelId = modelId;
          return JSON.stringify({
            checkpoint: "Interview tomorrow; check in after.",
            memories: [],
          });
        },
        getModelCatalogEntries: async (modelIds) =>
          new Map(modelIds.map((modelId) => [modelId, catalog[modelId]!])),
        platform: checkpointPlatform(saved),
      });
      return { admissions, completionModelId, recorded: saved.completionModelId, result };
    }

    it("runs the flush on it when the run's environment admits it", async () => {
      expect(await flushWith(true)).toEqual({
        admissions: [
          [
            "openrouter/vendor/deployment-flush",
            {
              agentId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
              runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
              scope,
            },
          ],
        ],
        completionModelId: "openrouter/vendor/deployment-flush",
        recorded: "openrouter/vendor/deployment-flush",
        result: { batchItemFailures: [] },
      });
    });

    it("keeps the agent's model and logs why when the environment forbids it", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const flushed = await flushWith(false);
        expect({
          completionModelId: flushed.completionModelId,
          recorded: flushed.recorded,
          result: flushed.result,
        }).toEqual({
          completionModelId: "openrouter/vendor/catalog-only",
          recorded: "openrouter/vendor/catalog-only",
          result: { batchItemFailures: [] },
        });
        expect(warn.mock.calls).toEqual([
          [
            "Memory flush model is not admitted; the flush uses the agent's model.",
            {
              flushId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
              flushModelId: "openrouter/vendor/deployment-flush",
              modelId: "openrouter/vendor/catalog-only",
              reason: "Environment policy does not allow it.",
            },
          ],
        ]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("fails the flush when a non-curated model has neither catalog metadata nor budgets", async () => {
    const saved: { checkpoint?: Readonly<Record<string, unknown>> } = {};
    const result = await handleMemoryFlushQueue(flushEvent, {
      generateCompletion: async () => {
        throw new Error("The model must not be called without context limits.");
      },
      getModelCatalogEntries: async () => new Map(),
      platform: checkpointPlatform(saved),
    });

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-catalog-checkpoint" }],
    });
    expect(saved.checkpoint).toBeUndefined();
  });
});
