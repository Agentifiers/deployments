import { describe, expect, it } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import { ModelTokenIssuanceError, type ModelTokenRequest } from "@deployments-ai/model-gateway";
import { admitMemoryFlushModel, memoryFlushModelBudget } from "./flush-model.ts";

const tenancy = {
  agentId: "01ARZ3NDEKTSV4RRFFQ69G5FAC" as Ulid,
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9" as Ulid,
  scope: {
    environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ulid,
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5" as Ulid,
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6" as Ulid,
    workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8" as Ulid,
  },
};

describe("memory flush model admission", () => {
  it("asks the memory issuer for the flush model under the run's environment", async () => {
    const requests: ModelTokenRequest[] = [];
    const admission = await admitMemoryFlushModel(
      " openrouter/anthropic/claude-haiku-4.5 ",
      tenancy,
      async (request) => {
        requests.push(request);
        return { expiresAt: 1, models: ["openrouter/anthropic/claude-haiku-4.5"], token: "t" };
      },
    );

    expect(admission).toEqual({ admitted: true });
    expect(requests).toEqual([
      {
        context: {
          agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
          environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FA9",
          workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
        },
        kind: "service",
        models: ["openrouter/anthropic/claude-haiku-4.5"],
      },
    ]);
  });

  it("reports a policy refusal and rethrows every other issuer failure", async () => {
    expect(
      await admitMemoryFlushModel("openrouter/anthropic/claude-haiku-4.5", tenancy, async () => {
        throw new ModelTokenIssuanceError(
          "model_not_admitted",
          "Environment policy does not allow openrouter/anthropic/claude-haiku-4.5.",
        );
      }),
    ).toEqual({
      admitted: false,
      reason: "Environment policy does not allow openrouter/anthropic/claude-haiku-4.5.",
    });
    expect(
      await admitMemoryFlushModel("openai/gpt-5.2", tenancy, async () => {
        throw new ModelTokenIssuanceError(
          "model_outside_data_boundary",
          "openai/gpt-5.2 is outside the data boundary.",
        );
      }),
    ).toEqual({ admitted: false, reason: "openai/gpt-5.2 is outside the data boundary." });
    const failure = await admitMemoryFlushModel(
      "openrouter/anthropic/claude-haiku-4.5",
      tenancy,
      async () => {
        throw new ModelTokenIssuanceError("issuer_failed", "Token issuer failed (Unhandled).");
      },
    ).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      code: "issuer_failed",
      message: "Token issuer failed (Unhandled).",
    });
  });
});

describe("memory generation budgets", () => {
  it("keeps checkpoint capacity independent of the chat reply reserve", () => {
    const shortReplies = memoryFlushModelBudget("openrouter/example/private-checkpoint", {
      modelInputTokenBudget: 32_512,
      modelOutputTokenReserve: 256,
    });
    const longReplies = memoryFlushModelBudget("openrouter/example/private-checkpoint", {
      modelInputTokenBudget: 28_672,
      modelOutputTokenReserve: 4_096,
    });

    expect(shortReplies).toEqual(longReplies);
    expect(shortReplies.maximumOutputTokens).toBe(4_096);
    expect(shortReplies.promptInputTokenBudget).toBeGreaterThan(0);
    expect(shortReplies.promptInputTokenBudget + shortReplies.maximumOutputTokens).toBeLessThan(
      32_768,
    );
  });

  it("honors a known provider output ceiling below the memory allowance", () => {
    const budget = memoryFlushModelBudget("openrouter/example/short-output", {
      modelCatalog: {
        "openrouter/example/short-output": {
          contextWindowTokens: 32_768,
          maximumOutputTokens: 512,
          pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
        },
      },
    });
    expect(budget.maximumOutputTokens).toBe(512);
    expect(budget.promptInputTokenBudget + budget.maximumOutputTokens).toBeLessThan(32_768);
  });
});
