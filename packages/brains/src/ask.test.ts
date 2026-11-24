import { describe, expect, test } from "bun:test";
import { askBrain, type BrainAnswerModel, type BrainAnswerRejectionEvent } from "./ask.ts";
import { BrainAnswerInvalidError } from "./errors.ts";
import type { BrainSearchResult } from "./search.ts";

const evidence: BrainSearchResult = {
  citation: {
    brainId: "brain-1",
    chunkId: "chunk-1",
    coordinates: { end: 12, kind: "unicode-scalar", start: 0 },
    documentId: "document-1",
    documentVersionId: "version-1",
    renditionId: "rendition-1",
    sourceId: "source-1",
  },
  excerpt: "We chose the safe design.",
  score: 0.9,
  sensitivity: "internal",
};

const citationId = "brain-1:document-1:version-1:rendition-1:chunk-1";

describe("Brain cited synthesis", () => {
  test("returns only claims grounded in supplied evidence", async () => {
    const answer = await askBrain({
      authorizeDisclosure: async () => true,
      evidence: [evidence],
      model: {
        synthesize: async () => ({
          claims: [
            {
              citationIds: [citationId],
              text: "The team chose the safe design.",
            },
          ],
          gaps: ["The decision date is not present."],
        }),
      },
      question: "What did we choose?",
      usageOperationId: "operation-1",
    });

    expect(answer.claims).toHaveLength(1);
    expect(answer.usedCitations).toEqual([evidence.citation]);
  });

  test("fails closed when authorization changes after synthesis", async () => {
    expect(
      askBrain({
        authorizeDisclosure: async () => false,
        evidence: [evidence],
        model: {
          synthesize: async () => ({
            claims: [{ citationIds: [citationId], text: "A claim" }],
            gaps: [],
          }),
        },
        question: "question",
        usageOperationId: "operation-1",
      }),
    ).rejects.toThrow("authorization changed");
  });

  test("retries a rejected answer once with recovery framing and returns the valid retry", async () => {
    const recoveries: unknown[] = [];
    const rejections: BrainAnswerRejectionEvent[] = [];
    const answer = await askBrain({
      authorizeDisclosure: async () => true,
      evidence: [evidence],
      model: {
        synthesize: async (request) => {
          recoveries.push(request.recovery);
          return request.recovery
            ? { claims: [{ citationIds: [citationId], text: "A claim" }], gaps: [] }
            : { claims: [{ citationIds: ["fabricated"], text: "A claim" }], gaps: [] };
        },
      },
      onAnswerRejected: (event) => rejections.push(event),
      question: "question",
      usageOperationId: "operation-1",
    });

    expect(recoveries).toEqual([undefined, "same-model-retry"]);
    expect(rejections).toEqual([
      { attempt: 0, final: false, rejection: "citation-outside-context" },
    ]);
    expect(answer.usedCitations).toEqual([evidence.citation]);
  });

  test("fails as an invalid upstream answer after the bounded retry is exhausted", async () => {
    let calls = 0;
    const rejections: BrainAnswerRejectionEvent[] = [];
    const model: BrainAnswerModel = {
      synthesize: async () => {
        calls += 1;
        if (calls === 1) throw new BrainAnswerInvalidError("malformed-json");
        return { claims: [{ citationIds: [], text: "An uncited claim" }], gaps: [] };
      },
    };

    const failure = await askBrain({
      authorizeDisclosure: async () => true,
      evidence: [evidence],
      model,
      onAnswerRejected: (event) => rejections.push(event),
      question: "question",
      usageOperationId: "operation-1",
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(BrainAnswerInvalidError);
    expect(failure).toMatchObject({ code: "brain_answer_invalid", rejection: "uncited-claim" });
    expect(calls).toBe(2);
    expect(rejections).toEqual([
      { attempt: 0, final: false, rejection: "malformed-json" },
      { attempt: 1, final: true, rejection: "uncited-claim" },
    ]);
  });

  test("does not retry model transport failures", async () => {
    let calls = 0;
    expect(
      askBrain({
        authorizeDisclosure: async () => true,
        evidence: [evidence],
        model: {
          synthesize: async () => {
            calls += 1;
            throw new Error("gateway unavailable");
          },
        },
        question: "question",
        usageOperationId: "operation-1",
      }),
    ).rejects.toThrow("gateway unavailable");
    expect(calls).toBe(1);
  });
});
