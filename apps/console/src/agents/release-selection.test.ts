import { describe, expect, test } from "bun:test";
import { DRAFT, parseReleaseSearch, resolveComparison } from "./release-selection.ts";

const LATEST = "01ARZ3NDEKTSV4RRFFQ69G6009";
const OLDER = "01ARZ3NDEKTSV4RRFFQ69G600A";
const FOREIGN = "01ARZ3NDEKTSV4RRFFQ69G6007";

describe("parseReleaseSearch", () => {
  test("keeps release IDs and the draft marker, dropping malformed values", () => {
    expect(
      parseReleaseSearch({ baseline: OLDER, candidate: DRAFT, release: "nope", extra: 1 }),
    ).toEqual({ baseline: OLDER, candidate: DRAFT });
  });

  test("the draft has no release details", () => {
    expect(parseReleaseSearch({ release: DRAFT })).toEqual({});
  });
});

describe("resolveComparison", () => {
  test("defaults to the latest release against the draft", () => {
    expect(resolveComparison([LATEST, OLDER], {})).toEqual({
      baseline: LATEST,
      candidate: DRAFT,
    });
  });

  test("keeps a chosen pair, the draft included on either side", () => {
    expect(resolveComparison([LATEST, OLDER], { baseline: DRAFT, candidate: OLDER })).toEqual({
      baseline: DRAFT,
      candidate: OLDER,
    });
  });

  test("falls back when a chosen release belongs to another agent", () => {
    expect(resolveComparison([LATEST, OLDER], { baseline: FOREIGN, candidate: OLDER })).toEqual({
      baseline: LATEST,
      candidate: OLDER,
    });
  });

  test("has nothing to compare before the first release", () => {
    expect(resolveComparison([], { baseline: DRAFT })).toBeUndefined();
  });
});
