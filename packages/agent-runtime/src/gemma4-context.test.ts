import { describe, expect, it } from "bun:test";
import type { OpenAiCompatibleChatCompletionMessage } from "@deployments-ai/model-gateway";
import { gemma4ChatTemplateMessages } from "./gemma4-context.ts";

describe("Gemma 4 chat-template context", () => {
  it("coalesces a run of plain assistant messages without mutating the source", () => {
    const messages: readonly OpenAiCompatibleChatCompletionMessage[] = [
      { content: "instructions", role: "system" },
      { content: "hello", role: "user" },
      { content: "first note", role: "assistant" },
      { content: "second note", role: "assistant" },
      { content: "third note", role: "assistant" },
      { content: "thanks", role: "user" },
    ];

    expect(gemma4ChatTemplateMessages(messages)).toEqual([
      { content: "instructions", role: "system" },
      { content: "hello", role: "user" },
      { content: "first note\n\nsecond note\n\nthird note", role: "assistant" },
      { content: "thanks", role: "user" },
    ]);
    expect(messages).toHaveLength(6);
  });

  it("does not merge across tool-bearing assistant messages", () => {
    const toolMessage: OpenAiCompatibleChatCompletionMessage = {
      content: "",
      role: "assistant",
      tool_calls: [
        {
          function: { arguments: "{}", name: "lookup" },
          id: "call-1",
          type: "function",
        },
      ],
    };

    expect(
      gemma4ChatTemplateMessages([
        { content: "before", role: "assistant" },
        toolMessage,
        { content: "after", role: "assistant" },
      ]),
    ).toEqual([
      { content: "before", role: "assistant" },
      toolMessage,
      { content: "after", role: "assistant" },
    ]);
  });
});
