import { describe, expect, test } from "bun:test";
import { composeKnowledgeContext, planKnowledgeRetrieval } from "./retrieval-routing.ts";

describe("memory and Brain retrieval planning", () => {
  test("requires Brain evidence for citations and high-risk conclusions", () => {
    expect(
      planKnowledgeRetrieval({
        authorizedBrainCount: 1,
        hasMemory: true,
        mode: "memory-first",
        query: "Cite the current legal basis for this decision.",
      }),
    ).toMatchObject({ brainRequired: true, route: "both" });
  });

  test("uses memory for preferences without inventing institutional evidence", () => {
    expect(
      planKnowledgeRetrieval({
        authorizedBrainCount: 2,
        hasMemory: true,
        mode: "memory-first",
        query: "Use my preferred writing style.",
      }),
    ).toMatchObject({
      brainRequired: false,
      route: "memory",
      unmetEvidenceRequirement: false,
    });
  });

  test("escalates unreliable memory to an authorized Brain", () => {
    expect(
      planKnowledgeRetrieval({
        authorizedBrainCount: 1,
        hasMemory: true,
        memoryConfidence: 0.2,
        mode: "memory-first",
        query: "What was the process?",
      }),
    ).toMatchObject({ route: "both" });
  });

  test("reports an unmet evidence requirement instead of answering from memory", () => {
    expect(
      planKnowledgeRetrieval({
        authorizedBrainCount: 0,
        hasMemory: true,
        mode: "hybrid",
        query: "Give me citations for the security conclusion.",
      }),
    ).toMatchObject({
      brainRequired: true,
      route: "neither",
      unmetEvidenceRequirement: true,
    });
  });

  test("keeps memory and source-grounded evidence in separate context blocks", () => {
    const context = composeKnowledgeContext({
      brainEvidence: "[C1] The approved source.",
      memory: "The user prefers terse answers.",
    });
    expect(context).toContain("<memory_context>");
    expect(context).toContain('<brain_evidence source_grounded="true">');
    expect(context.indexOf("</memory_context>")).toBeLessThan(context.indexOf("<brain_evidence"));
  });
});
