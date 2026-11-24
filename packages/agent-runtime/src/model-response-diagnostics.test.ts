import { describe, expect, it } from "bun:test";

import {
  gemma4ResponseDisposition,
  safeResponseInterpretation,
} from "./model-response-diagnostics.ts";

const baseDispositionInput = {
  assistantMessage: "synthetic provider output",
  exhausted: false,
  finalAssistantMessage: "",
  hasProviderToolCalls: false,
  outwardToolCallCount: 0,
  rejectedDisabledTextualToolCall: false,
  rejectedHabitualLaughterEnding: false,
  rejectedProviderToolCalls: false,
  repeatedCompletedSideEffect: false,
  safeCompletedSideEffectAcknowledgement: "",
  startsWithTextualToolCall: false,
  textualToolCall: undefined,
} as const;

describe("model response diagnostics", () => {
  it.each([
    [{ rejectedProviderToolCalls: true }, "rejected-provider-tool-calls"],
    [{ rejectedDisabledTextualToolCall: true }, "rejected-disabled-textual-tool-call"],
    [{ hasProviderToolCalls: true, outwardToolCallCount: 1 }, "accepted-provider-tool-calls"],
    [{ outwardToolCallCount: 1 }, "accepted-textual-tool-call"],
    [
      {
        rejectedHabitualLaughterEnding: true,
        safeCompletedSideEffectAcknowledgement: "got it",
      },
      "rejected-habitual-laughter-ending",
    ],
    [
      {
        repeatedCompletedSideEffect: true,
        safeCompletedSideEffectAcknowledgement: "got it",
      },
      "repeated-side-effect-acknowledgement",
    ],
    [{ safeCompletedSideEffectAcknowledgement: "got it" }, "post-side-effect-acknowledgement"],
    [{ finalAssistantMessage: "[NO_INITIATION]" }, "suppression-marker"],
    [{ finalAssistantMessage: "synthetic visible reply" }, "visible-text"],
    [{ exhausted: true }, "output-exhausted"],
    [{ assistantMessage: "" }, "provider-empty"],
    [{ startsWithTextualToolCall: true }, "textual-tool-call-without-action"],
    [
      { assistantMessage: "<thought>synthetic rationale</thought>" },
      "thought-envelope-without-visible-text",
    ],
    [{ assistantMessage: "<thought>synthetic rationale" }, "unclosed-thought-envelope"],
    [
      { assistantMessage: "<|channel>thought\nsynthetic rationale<channel|>" },
      "thought-channel-without-visible-text",
    ],
    [{ assistantMessage: "<|channel>thought\nsynthetic rationale" }, "unclosed-thought-channel"],
    [{ assistantMessage: "thought:\nsynthetic rationale" }, "leading-thought-control"],
    [{}, "sanitized-without-visible-text"],
  ] as const)("classifies a privacy-safe response disposition: %s", (overrides, expected) => {
    expect(gemma4ResponseDisposition({ ...baseDispositionInput, ...overrides })).toBe(expected);
  });

  it("retains only validated structural response metadata", () => {
    const envelope = {
      choiceCount: 1,
      choiceShape: "record",
      contentCharacters: 19,
      contentPartCount: 0,
      contentShape: "text",
      ignoredContent: "synthetic text that must not survive validation",
      messageShape: "record",
      reasoningCarrier: "missing",
      reasoningCharacters: 0,
      reasoningShape: "missing",
      toolCallCount: 0,
      toolCallsShape: "missing",
    };

    expect(
      safeResponseInterpretation({
        assistantCharacters: 19,
        disposition: "visible-text",
        gatewayResponseShape: {
          normalized: envelope,
          raw: { ...envelope, contentCharacters: 21 },
          rawResponseShape: "record",
        },
        providerAssistantCharacters: 19,
        providerToolCallCount: 0,
      }),
    ).toEqual({
      assistantCharacters: 19,
      disposition: "visible-text",
      gatewayResponseShape: {
        normalized: {
          choiceCount: 1,
          choiceShape: "record",
          contentCharacters: 19,
          contentPartCount: 0,
          contentShape: "text",
          messageShape: "record",
          reasoningCarrier: "missing",
          reasoningCharacters: 0,
          reasoningShape: "missing",
          toolCallCount: 0,
          toolCallsShape: "missing",
        },
        raw: {
          choiceCount: 1,
          choiceShape: "record",
          contentCharacters: 21,
          contentPartCount: 0,
          contentShape: "text",
          messageShape: "record",
          reasoningCarrier: "missing",
          reasoningCharacters: 0,
          reasoningShape: "missing",
          toolCallCount: 0,
          toolCallsShape: "missing",
        },
        rawResponseShape: "record",
      },
      providerAssistantCharacters: 19,
      providerToolCallCount: 0,
    });
  });

  it("retains only valid numerical depth diagnostics and never rejected prose", () => {
    const interpretation = {
      assistantCharacters: 0,
      disposition: "rejected-response-depth",
      providerAssistantCharacters: 42,
      providerToolCallCount: 0,
      responseDepthViolation: {
        wordCount: 2,
        minimumWords: 3,
        maximumWords: 5,
        content: "private rejected response",
      },
    };
    expect(safeResponseInterpretation(interpretation)).toEqual({
      ...interpretation,
      responseDepthViolation: { wordCount: 2, minimumWords: 3, maximumWords: 5 },
    });
    for (const responseDepthViolation of [
      { wordCount: -1, minimumWords: 3, maximumWords: 5 },
      { wordCount: "2", minimumWords: 3, maximumWords: 5 },
      { wordCount: 2.5, minimumWords: 3, maximumWords: 5 },
      { wordCount: 4, minimumWords: 3, maximumWords: 5 },
      { wordCount: 2, minimumWords: 0, maximumWords: 5 },
      { wordCount: 2, minimumWords: 6, maximumWords: 5 },
      { wordCount: 2, minimumWords: 3, maximumWords: 8193 },
      { wordCount: Number.POSITIVE_INFINITY, minimumWords: 3, maximumWords: 5 },
    ]) {
      expect(
        safeResponseInterpretation({ ...interpretation, responseDepthViolation }),
      ).toBeUndefined();
    }
  });

  it.each([
    { gatewayResponseShape: { normalized: {}, rawResponseShape: "record" } },
    {
      gatewayResponseShape: {
        normalized: {
          choiceCount: 1,
          choiceShape: "invented",
          contentCharacters: 0,
          contentPartCount: 0,
          contentShape: "missing",
          messageShape: "missing",
          reasoningCarrier: "missing",
          reasoningCharacters: 0,
          reasoningShape: "missing",
          toolCallCount: 0,
          toolCallsShape: "missing",
        },
        rawResponseShape: "record",
      },
    },
  ])("rejects malformed structural response metadata", (overrides) => {
    expect(
      safeResponseInterpretation({
        assistantCharacters: 0,
        disposition: "provider-empty",
        providerAssistantCharacters: 0,
        providerToolCallCount: 0,
        ...overrides,
      }),
    ).toBeUndefined();
  });
});
