import { describe, expect, it } from "bun:test";

import { chatCompletionResponseShape } from "./responses.ts";

const emptyMessageShape = {
  choiceCount: 1,
  choiceShape: "record",
  contentCharacters: 0,
  contentPartCount: 0,
  messageShape: "record",
  reasoningCarrier: "missing",
  reasoningCharacters: 0,
  reasoningShape: "missing",
  toolCallCount: 0,
  toolCallsShape: "missing",
} as const;

describe("chat completion response diagnostics", () => {
  it("classifies ordinary normalized text without retaining its content", () => {
    const content = "synthetic reply";
    const shape = chatCompletionResponseShape({
      choices: [{ finish_reason: "stop", message: { content } }],
    });

    expect(shape).toEqual({
      normalized: {
        ...emptyMessageShape,
        contentCharacters: content.length,
        contentShape: "text",
      },
      rawResponseShape: "missing",
    });
    expect(JSON.stringify(shape)).not.toContain(content);
  });

  it("distinguishes normalized reasoning-only output from raw structured text", () => {
    const reasoning = "synthetic private rationale";
    const rawText = "synthetic outward candidate";

    expect(
      chatCompletionResponseShape({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: null,
              reasoning_content: reasoning,
              tool_calls: [],
            },
          },
        ],
        extra_fields: {
          raw_response: {
            choices: [
              {
                message: {
                  analysis: "synthetic raw analysis",
                  content: [{ text: rawText, type: "text" }, { type: "image" }],
                  tool_calls: [{ function: { arguments: "{}", name: "synthetic_tool" } }],
                },
              },
            ],
          },
        },
      }),
    ).toEqual({
      normalized: {
        ...emptyMessageShape,
        contentShape: "null",
        reasoningCarrier: "reasoning-content",
        reasoningCharacters: reasoning.length,
        reasoningShape: "text",
        toolCallsShape: "empty",
      },
      raw: {
        ...emptyMessageShape,
        contentCharacters: rawText.length,
        contentPartCount: 2,
        contentShape: "mixed-parts",
        reasoningCarrier: "analysis",
        reasoningCharacters: "synthetic raw analysis".length,
        reasoningShape: "text",
        toolCallCount: 1,
        toolCallsShape: "present",
      },
      rawResponseShape: "record",
    });
  });

  it("classifies JSON-string raw envelopes and unsupported provider shapes", () => {
    expect(
      chatCompletionResponseShape({
        choices: [{ message: { content: { value: "not a supported content shape" } } }],
        extra_fields: {
          raw_response: JSON.stringify({
            choices: [{ message: { content: [], tool_calls: { invalid: true } } }],
          }),
        },
      }),
    ).toEqual({
      normalized: {
        ...emptyMessageShape,
        contentShape: "unsupported",
      },
      raw: {
        ...emptyMessageShape,
        contentShape: "empty-parts",
        toolCallsShape: "unsupported",
      },
      rawResponseShape: "json-record-string",
    });
  });

  it("classifies malformed top-level, choice, message, and raw-envelope shapes", () => {
    expect(chatCompletionResponseShape(null)).toEqual({
      normalized: {
        ...emptyMessageShape,
        choiceCount: 0,
        choiceShape: "missing",
        contentShape: "missing",
        messageShape: "missing",
      },
      rawResponseShape: "missing",
    });
    expect(
      chatCompletionResponseShape({
        choices: [null],
        extra_fields: { raw_response: "not json" },
      }),
    ).toEqual({
      normalized: {
        ...emptyMessageShape,
        choiceShape: "unsupported",
        contentShape: "missing",
        messageShape: "missing",
      },
      rawResponseShape: "invalid-json-string",
    });
    expect(
      chatCompletionResponseShape({
        choices: [{ message: 42 }],
        extra_fields: { raw_response: 42 },
      }),
    ).toEqual({
      normalized: {
        ...emptyMessageShape,
        contentShape: "missing",
        messageShape: "unsupported",
      },
      rawResponseShape: "unsupported",
    });
  });
});
