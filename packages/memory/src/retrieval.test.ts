import { describe, expect, test } from "bun:test";
import { memoryFixture } from "./test-fixtures.ts";
import {
  denseSearchCandidateLimit,
  lexicalSearchCandidateLimit,
} from "./memory-search-retrieval.ts";
import {
  adjustedCandidateScore,
  lexicalQueryEligible,
  memoryRetrievalConfig,
  reciprocalRankFusion,
  rankAndSelectMemories,
  type MemoryCandidate,
  type SelectableMemoryCandidate,
} from "./retrieval.ts";

function source(id: string, candidateSource: MemoryCandidate["source"], rank: number) {
  return {
    row: {
      contentHash: id,
      dist: rank / 10,
      id,
      memorySpaceId: "space",
      memoryVersion: 0,
      scopeKey: "scope",
      searchKey: "search",
    },
    source: candidateSource,
    sourceRank: rank,
  } satisfies MemoryCandidate;
}

describe("memory retrieval", () => {
  test("uses a provider page hint without constraining the requested result count", () => {
    expect(denseSearchCandidateLimit(10, 50, 30)).toBe(30);
    expect(denseSearchCandidateLimit(50, 50, 30)).toBe(50);
    expect(denseSearchCandidateLimit(10, 50, undefined)).toBe(50);
  });

  test("keeps lexical candidates at least as large as the requested result count", () => {
    expect(lexicalSearchCandidateLimit(24, 24)).toBe(24);
    expect(lexicalSearchCandidateLimit(94, 50)).toBe(94);
  });

  test("reserves an overall active-recall budget for each external phase", () => {
    expect(memoryRetrievalConfig(undefined, "active-recall")).toMatchObject({
      deadlineMs: 11_100,
      phaseDeadlineMs: 1_500,
      rerankDeadlineMs: 2_000,
      searchDeadlineMs: 3_000,
    });
  });

  test("uses purpose overrides and top-level budgets", () => {
    expect(
      memoryRetrievalConfig(
        {
          memoryRetrieval: {
            candidateK: 70,
            contextTokenBudget: 3_000,
            deadlineMs: 9_000,
            phaseDeadlineMs: 3_000,
            persistenceDeadlineMs: 4_000,
            purposes: { search: { candidateK: 20 } },
            rerankCandidateK: 30,
            rerankDeadlineMs: 7_000,
            rerankMaxOutputTokens: 900,
            rerankPromptBytes: 80_000,
            searchDeadlineMs: 6_000,
            strategy: "hybrid-rerank-v1",
          },
        },
        "search",
      ),
    ).toMatchObject({
      candidateK: 20,
      contextTokenBudget: 3_000,
      deadlineMs: 9_000,
      phaseDeadlineMs: 3_000,
      persistenceDeadlineMs: 4_000,
      rerankCandidateK: 30,
      rerankDeadlineMs: 7_000,
      rerankMaxOutputTokens: 900,
      rerankPromptBytes: 80_000,
      searchDeadlineMs: 6_000,
      strategy: "hybrid-rerank-v1",
    });
  });

  test("turns the full-context cap off under an explicit budget unless the cap is set too", () => {
    const resolved = (memoryRetrieval: Record<string, unknown>) => {
      const config = memoryRetrievalConfig({ memoryRetrieval }, "active-recall");
      return [config.contextTokenBudget, config.fullContextTokenCap];
    };
    expect(resolved({})).toEqual([4_000, 7_000]);
    expect(resolved({ contextTokenBudget: 32_000 })).toEqual([32_000, 0]);
    expect(resolved({ purposes: { "active-recall": { contextTokenBudget: 1_200 } } })).toEqual([
      1_200, 0,
    ]);
    expect(resolved({ contextTokenBudget: 1_200, fullContextTokenCap: 5_000 })).toEqual([
      1_200, 5_000,
    ]);
    expect(resolved({ fullContextTokenCap: 50_000 })).toEqual([4_000, 7_000]);
    expect(resolved({ contextTokenBudget: "many", fullContextTokenCap: -1 })).toEqual([
      4_000, 7_000,
    ]);
  });

  test("never takes search off ranked results", () => {
    const cap = (memoryRetrieval: Record<string, unknown>) =>
      memoryRetrievalConfig({ memoryRetrieval }, "search").fullContextTokenCap;
    expect(cap({ fullContextTokenCap: 5_000 })).toBe(0);
    expect(cap({ purposes: { search: { fullContextTokenCap: 5_000 } } })).toBe(0);
  });

  test("keeps a same-target strategy configured for shadowing", () => {
    expect(
      memoryRetrievalConfig(
        {
          memoryRetrieval: {
            shadowRolloutPercent: 100,
            shadowStrategy: "hybrid-rrf-v1",
            strategy: "hybrid-rrf-v1",
          },
        },
        "search",
      ),
    ).toMatchObject({
      shadowRolloutPercent: 100,
      shadowStrategy: "hybrid-rrf-v1",
      strategy: "hybrid-rrf-v1",
    });
  });

  test("fuses independent source rankings globally", () => {
    const fused = reciprocalRankFusion([
      [source("dense-only", "dense", 1), source("shared", "dense", 2)],
      [source("shared", "lexical", 1), source("lexical-only", "lexical", 2)],
    ]);
    expect(fused[0]).toMatchObject({
      id: "shared",
      sourceRanks: { dense: 2, lexical: 1 },
      sourceScores: { dense: 0.2, lexical: 0.1 },
    });
  });

  test("keeps a strong dense result ahead of low-ranked cross-source overlap", () => {
    const dense = [
      source("z-answer", "dense", 1),
      ...Array.from({ length: 8 }, (_, index) => source(`dense-${index}`, "dense", index + 2)),
      source("a-overlap", "dense", 10),
    ];
    const lexical = [
      ...Array.from({ length: 9 }, (_, index) => source(`lexical-${index}`, "lexical", index + 1)),
      source("a-overlap", "lexical", 10),
    ];

    const fused = reciprocalRankFusion([dense, lexical], {
      k: 5,
      sourceWeights: { dense: 2, lexical: 1 },
    });

    expect(fused[0]?.id).toBe("z-answer");
    expect(fused[0]?.fusedScore).toBeFinite();
    expect(fused.findIndex((candidate) => candidate.id === "a-overlap")).toBeGreaterThan(0);
  });

  test("keeps dense order while enforcing the context token budget", () => {
    const candidates = ["first", "second"].map((id, index) => {
      const memory = memoryFixture({ body: id.repeat(40), id: id.padEnd(26, "0") as never });
      return {
        fusedRank: index + 1,
        fusedScore: 1 - index / 10,
        id: memory.data.id,
        memory,
        row: {
          contentHash: memory.data.contentHash,
          id: memory.data.id,
          memorySpaceId: memory.data.memorySpaceId,
          memoryVersion: memory.data.version,
          scopeKey: "scope",
          searchKey: memory.data.searchKey,
        },
        score: 1 - index / 10,
        sourceRanks: { dense: index + 1 },
        sourceScores: { dense: index / 10 },
      } satisfies SelectableMemoryCandidate;
    });
    const selected = rankAndSelectMemories({
      candidates,
      contextTokenBudget: 50,
      strategy: "dense-v1",
      topK: 2,
    });
    expect(selected.selected.map((candidate) => candidate.id)).toEqual([candidates[0]!.id]);
  });

  test("keeps candidates with a shared prefix when their full content differs", () => {
    const prefix = Array.from({ length: 24 }, (_, index) => `shared-${index}`).join(" ");
    const candidate = (id: string, body: string, score: number) => {
      const memory = memoryFixture({ body, id: id as never });
      return {
        fusedRank: 1,
        fusedScore: score,
        id: memory.data.id,
        memory,
        row: {
          contentHash: memory.data.contentHash,
          id: memory.data.id,
          memorySpaceId: memory.data.memorySpaceId,
          memoryVersion: memory.data.version,
          scopeKey: "scope",
          searchKey: memory.data.searchKey,
        },
        score,
        sourceRanks: { lexical: 1 },
        sourceScores: { lexical: score },
      } satisfies SelectableMemoryCandidate;
    };
    const first = candidate(
      "01ARZ3NDEKTSV4RRFFQ69G5FD1",
      `${prefix} deploy to the primary region.`,
      1,
    );
    const second = candidate(
      "01ARZ3NDEKTSV4RRFFQ69G5FD2",
      `${prefix} do not deploy to the primary region.`,
      0.9,
    );
    const duplicate = candidate(
      "01ARZ3NDEKTSV4RRFFQ69G5FD3",
      `${prefix.toUpperCase()} deploy to the primary region!`,
      0.8,
    );

    const selected = rankAndSelectMemories({
      candidates: [first, second, duplicate],
      contextTokenBudget: 1_000,
      strategy: "hybrid-rrf-v1",
      topK: 3,
    });

    expect(selected.selected.map((candidate) => candidate.id)).toEqual([first.id, second.id]);
    expect(selected.duplicateCount).toBe(1);
  });

  test("omits governed queries from lexical and shadow traffic", () => {
    expect(lexicalQueryEligible("deployment marker api:v2")).toBe(true);
    expect(lexicalQueryEligible("api_key=secret-value-12345")).toBe(false);
    expect(lexicalQueryEligible("x".repeat(1_025))).toBe(false);
  });

  test("keeps bounded policy signals from overturning a high-confidence exact result", () => {
    const now = new Date("2026-07-21T18:00:00.000Z");
    const exactMemory = memoryFixture({
      importance: 0,
      sourceQuality: 0,
      updatedAt: "2024-07-21T18:00:00.000Z",
    });
    const freshMemory = memoryFixture({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FC1" as never,
      importance: 1,
      sourceQuality: 1,
      updatedAt: now.toISOString(),
    });
    const exactCandidate = reciprocalRankFusion([
      [source(exactMemory.data.id, "memory-id", 1)],
    ])[0]!;
    const freshCandidate = reciprocalRankFusion([[source(freshMemory.data.id, "dense", 100)]])[0]!;

    expect(adjustedCandidateScore(exactCandidate, exactMemory, now, -1)).toBeGreaterThan(
      adjustedCandidateScore(freshCandidate, freshMemory, now, 1),
    );
  });
});
