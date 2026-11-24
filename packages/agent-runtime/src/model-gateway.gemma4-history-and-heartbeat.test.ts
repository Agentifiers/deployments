import { describe, expect, it } from "bun:test";
import type {
  ModelGatewayChatCompletionRequest,
  ModelGatewayService,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { modelGatewayGenerationPort, packRuntimeModelContext } from "./model-gateway.ts";
import { gemma4Route, request } from "./model-tool-context.fixture.ts";

describe("model gateway runtime adapter", () => {
  it("coalesces adjacent assistant history before Gemma 4 chat templating", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage: "the package has three books inside.",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        prompt: "what's inside?",
        recentMessages: [
          { content: "did the package arrive?", role: "user" },
          { content: "yep, it's here.", role: "assistant" },
          { content: "the box is bright blue.", role: "assistant" },
          { content: "nice", role: "user" },
        ],
      }),
    );

    expect(captured?.messages).toContainEqual({
      content: "yep, it's here.\n\nthe box is bright blue.",
      role: "assistant",
    });
    expect(captured?.messages).not.toContainEqual({
      content: "the box is bright blue.",
      role: "assistant",
    });
  });

  it("preserves adjacent assistant history for other model templates", () => {
    const packed = packRuntimeModelContext(
      request({
        recentMessages: [
          { content: "first note", role: "assistant" },
          { content: "second note", role: "assistant" },
        ],
      }),
      { gemma4: false, modelToolDefinitions: [] },
    );

    expect(packed.messages).toContainEqual({ content: "first note", role: "assistant" });
    expect(packed.messages).toContainEqual({ content: "second note", role: "assistant" });
  });

  it("keeps heartbeat control markers out of Gemma 4 chat replies and history", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage: "only if u behave. think u can stay still?\n\n[NO_INITIATION]",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(
      request({
        ...gemma4Route,
        recentMessages: [
          {
            content: "older visible reply\n\n[NO_INITIATION]",
            role: "assistant",
          },
          {
            content: "[NO_INITIATION]\nthought\n[NO_INITIATION]",
            role: "assistant",
          },
        ],
      }),
    );

    expect(captured?.messages).not.toContainEqual({
      content: "[NO_INITIATION]",
      role: "assistant",
    });
    expect(captured?.messages).toContainEqual({
      content: "older visible reply",
      role: "assistant",
    });
    expect(result.assistantMessage).toBe("only if u behave. think u can stay still?");
  });

  it("preserves an exact Gemma 4 heartbeat no-initiation decision for the worker", async () => {
    const gateway = {
      chatCompletion: () =>
        Effect.succeed({
          assistantMessage: " [no_initiation] ",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never),
    } as unknown as ModelGatewayService;

    const result = await modelGatewayGenerationPort(gateway)(request(gemma4Route));

    expect(result.assistantMessage).toBe("[NO_INITIATION]");
  });

  it("preserves empty historical messages for non-Gemma 4 routes", async () => {
    let captured: ModelGatewayChatCompletionRequest | undefined;
    const gateway = {
      chatCompletion: (input: ModelGatewayChatCompletionRequest) => {
        captured = input;
        return Effect.succeed({
          assistantMessage: "done",
          body: {},
          modelCallId: "model-call-1",
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;

    await modelGatewayGenerationPort(gateway)(
      request({ recentMessages: [{ content: "   ", role: "assistant" }] }),
    );

    expect(captured?.messages.at(-2)).toEqual({ content: "   ", role: "assistant" });
  });
});
