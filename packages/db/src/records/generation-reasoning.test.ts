import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { GenerationReasoningDetails, GenerationReasoningRecord } from "./generation-reasoning.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);

const CLAUDE_DETAILS = [
  {
    format: "anthropic-claude-v1",
    index: 0,
    signature: "c2lnbmF0dXJl",
    text: "Look up the order first.",
    type: "reasoning.text",
  },
];

function record(reasoningDetails: unknown) {
  return withCanonicalRecordKeys({
    data: {
      createdAt: "2026-10-12T08:00:00.000Z",
      environmentId: id("1"),
      modelCallIndex: 3,
      organizationId: id("2"),
      producerAttemptId: "run:execution:1:assistant:3:run-attempt:0:fallback:0",
      producerModelId: "openrouter/anthropic/claude-opus-5.5",
      projectId: id("3"),
      reasoningDetails,
      runId: id("4"),
      threadId: id("5"),
    },
    itemType: "generation-reasoning" as const,
  });
}

const decodeRecord = Schema.decodeUnknownSync(GenerationReasoningRecord);
const isDetails = Schema.is(GenerationReasoningDetails);

describe("generation reasoning record", () => {
  test("keys a generation's reasoning by run and zero-padded model call index", () => {
    const decoded = decodeRecord(record(CLAUDE_DETAILS));

    expect(decoded.pk).toBe("ORG#01ARZ3NDEKTSV4RRFFQ69G0002#RUN#01ARZ3NDEKTSV4RRFFQ69G0004");
    expect(decoded.sk).toBe("GENERATION-REASONING#0000000000000003");
    expect(Object.keys(decoded).sort()).toEqual(["data", "itemType", "pk", "sk"]);
  });

  test("keeps provider reasoning fields exactly as given", () => {
    const details: GenerationReasoningDetails = [
      { text: "Check stock.", type: "reasoning.text" },
      {
        data: "ZW5j",
        format: "google-gemini-v1",
        id: "mt0003000",
        index: 0,
        type: "reasoning.encrypted",
      },
      { format: "openai-responses-v1", index: 1, summary: null, type: "reasoning.summary" },
    ];

    expect(decodeRecord(record(details)).data.reasoningDetails).toEqual(details);
  });

  test("rejects a generation without reasoning", () => {
    expect(() => decodeRecord(record([]))).toThrow(
      'Missing key\n  at ["data"]["reasoningDetails"][0]',
    );
  });

  test("rejects a reasoning detail without a string reasoning type", () => {
    for (const detail of [{ text: "a" }, { text: "a", type: 7 }, { text: "a", type: "text" }]) {
      expect(() => decodeRecord(record([detail]))).toThrow(
        "Reasoning details require a string type that starts with reasoning.",
      );
    }
  });

  test("accepts reasoning up to 64 KiB of JSON and rejects one byte more", () => {
    const atLimit: GenerationReasoningDetails = [
      { type: "reasoning.text", text: "x".repeat(65_499) },
    ];
    const overLimit = [{ type: "reasoning.text", text: "x".repeat(65_500) }];

    expect(isDetails(atLimit)).toBe(true);
    expect(isDetails(overLimit)).toBe(false);
    expect(decodeRecord(record(atLimit)).data.reasoningDetails).toEqual(atLimit);
    expect(() => decodeRecord(record(overLimit))).toThrow(
      "Generation reasoning must not exceed 65536 bytes of JSON.",
    );
  });
});
