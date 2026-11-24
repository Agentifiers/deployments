import { BrainAskResponse } from "@deployments-ai/api-contract/brains";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { PlatformApiError } from "../errors.ts";
import {
  chosenBrains,
  citationKey,
  joinClaims,
  parseQuerySearch,
  searchNotEnabled,
} from "./query.ts";

const decodeAnswer = Schema.decodeUnknownSync(BrainAskResponse);

const cite = (chunkId: string) => ({
  brainId: "01K0000000000000000000000A",
  chunkId,
  coordinates: { end: 10, kind: "utf8-byte", start: 0 },
  documentId: "01K0000000000000000000000B",
  documentVersionId: "01K0000000000000000000000C",
  renditionId: "01K0000000000000000000000D",
  sourceId: "01K0000000000000000000000E",
});

const KEY_PREFIX =
  "01K0000000000000000000000A:01K0000000000000000000000B:01K0000000000000000000000C:01K0000000000000000000000D";

const answer = decodeAnswer({
  claims: [
    { citationIds: [`${KEY_PREFIX}:c2`, `${KEY_PREFIX}:c1`], text: "Keys rotate weekly." },
    { citationIds: [`${KEY_PREFIX}:gone`], text: "Rotation is automatic." },
  ],
  gaps: [],
  queryAttemptId: "01K0000000000000000000000F",
  usedCitations: [cite("c1"), cite("c2")],
});

describe("citationKey", () => {
  test("joins brain, document, version, rendition, and chunk, leaving out the source", () => {
    expect(answer.usedCitations.map(citationKey)).toEqual([`${KEY_PREFIX}:c1`, `${KEY_PREFIX}:c2`]);
  });
});

describe("joinClaims", () => {
  test("numbers used citations in order and keeps the IDs no used citation matches", () => {
    expect(
      joinClaims(answer).map(({ citations, text, unresolved }) => ({
        numbers: citations.map(({ citation, number }) => [number, citation.chunkId]),
        text,
        unresolved,
      })),
    ).toEqual([
      {
        numbers: [
          [2, "c2"],
          [1, "c1"],
        ],
        text: "Keys rotate weekly.",
        unresolved: [],
      },
      { numbers: [], text: "Rotation is automatic.", unresolved: [`${KEY_PREFIX}:gone`] },
    ]);
  });
});

describe("chosenBrains", () => {
  test("counts only the chosen Brains the loaded list shows", () => {
    const loaded = new Map([
      ["01K0000000000000000000000A", "Handbook"],
      ["01K0000000000000000000000B", "Runbooks"],
    ]);
    expect(
      chosenBrains(
        ["01K0000000000000000000000B", "01K0000000000000000000000Z", "not-a-brain"],
        loaded,
      ),
    ).toEqual(["01K0000000000000000000000B"]);
    expect(chosenBrains(["01K0000000000000000000000Z"], loaded)).toEqual([]);
  });
});

describe("parseQuerySearch", () => {
  test("keeps a string brainId and overrides anything else with undefined", () => {
    const parsed = [{ brainId: "01K0000000000000000000000A" }, { brainId: 123 }, {}].map(
      parseQuerySearch,
    );
    expect(parsed.every((search) => Object.hasOwn(search, "brainId"))).toBe(true);
    expect(parsed).toStrictEqual([
      { brainId: "01K0000000000000000000000A" },
      { brainId: undefined },
      { brainId: undefined },
    ]);
  });
});

describe("searchNotEnabled", () => {
  test("only a bare 500 from search or ask reads as search not enabled", () => {
    const failure = (operation: string, status: number, code = "internal_error") =>
      new PlatformApiError(operation, { code, status, title: "failed" });
    expect(
      [
        failure("searchBrains", 500),
        failure("askBrains", 500),
        failure("searchBrains", 500, "brain_search_unavailable"),
        failure("searchBrains", 404),
        failure("recordBrainFeedback", 500),
        new Error("offline"),
      ].map(searchNotEnabled),
    ).toEqual([true, true, false, false, false, false]);
  });
});
