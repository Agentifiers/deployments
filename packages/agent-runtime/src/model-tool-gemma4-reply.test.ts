import { describe, expect, it } from "bun:test";
import type { ModelGatewayService } from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { gemma4AssistantText } from "./gemma4-output.ts";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import { id, request } from "./model-tool-context.fixture.ts";

const gemma4Route = {
  modelId: "openrouter/example/custom-gemma4",
  modelInputTokenBudget: 8_192,
  modelOutputTokenReserve: 512,
  modelToolProtocol: "gemma4",
} as const;

describe("model gateway runtime adapter Gemma 4 replies", () => {
  it.each(["thought", "thought:"])(
    "removes the post-tool %s control line without losing the reply",
    async (controlLine) => {
      const gateway = {
        chatCompletion: () =>
          Effect.succeed({
            assistantMessage: `${controlLine}\ngot it. i'll buzz you in a bit.`,
            body: {},
            modelCallId: "model-call-1",
            route: {},
          } as never),
      } as unknown as ModelGatewayService;

      const result = await modelGatewayGenerationPort(gateway)(
        request({
          completedToolCalls: [
            {
              effect: "write",
              idempotencyKey: `${id("7")}:model-tool:0:0`,
              input: { delayMinutes: 2, name: "check in", prompt: "Check in with Rowan." },
              inputSummary: "Create a reminder.",
              outputSummary: "Created one-shot reminder.",
              policyAction: "allow",
              policyReason: "Allowed.",
              requiredScopes: [],
              toolCallId: id("21"),
              toolName: "agent.schedule.remind",
            },
          ],
          ...gemma4Route,
          modelToolCallSlots: [
            {
              idempotencyKey: `${id("7")}:model-tool:0:0`,
              modelCallIndex: 0,
              toolCallIndex: 0,
            },
          ],
          tools: [
            {
              effect: "write",
              inputSchema: {
                additionalProperties: false,
                properties: {
                  delayMinutes: { type: "integer" },
                  name: { type: "string" },
                  prompt: { type: "string" },
                },
                required: ["delayMinutes", "name", "prompt"],
                type: "object",
              },
              requiredScopes: [],
              toolName: "agent.schedule.remind",
            },
          ],
        }),
      );

      expect(result.assistantMessage).toBe("got it. i'll buzz you in a bit.");
    },
  );

  it("removes the final-channel marker without losing the reply", () => {
    expect(gemma4AssistantText("<channel|>Done! I'll be waiting. 😉", undefined, true)).toBe(
      "Done! I'll be waiting. 😉",
    );
  });

  it.each(["The account is active.", "We should keep the deployment token out of the reply."])(
    "does not expose an unclassified post-tool thought block: %s",
    (reply) => {
      expect(gemma4AssistantText(`thought\n${reply}`, undefined, true)).toBe("");
    },
  );

  it("replaces unrecognized post-side-effect thought content with a safe acknowledgment", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage:
            "thought\nSure. I need to inspect the user's private data before replying.",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        completedToolCalls: [
          {
            effect: "write",
            idempotencyKey: `${id("7")}:model-tool:0:0`,
            input: { delayMinutes: 2, name: "check in", prompt: "Check in with the user." },
            inputSummary: "Create a reminder.",
            outputSummary: "Created one-shot reminder.",
            policyAction: "allow",
            policyReason: "Allowed.",
            requiredScopes: [],
            toolCallId: id("21"),
            toolName: "agent.schedule.remind",
          },
        ],
        ...gemma4Route,
        modelToolCallSlots: [
          {
            idempotencyKey: `${id("7")}:model-tool:0:0`,
            modelCallIndex: 0,
            toolCallIndex: 0,
          },
        ],
        tools: [
          {
            effect: "write",
            inputSchema: {
              additionalProperties: false,
              properties: {
                delayMinutes: { type: "integer" },
                name: { type: "string" },
                prompt: { type: "string" },
              },
              required: ["delayMinutes", "name", "prompt"],
              type: "object",
            },
            requiredScopes: [],
            toolName: "agent.schedule.remind",
          },
        ],
      }),
    );

    expect(result.assistantMessage).toBe("got it");
    expect(result.toolCalls).toBeUndefined();
  });
});
