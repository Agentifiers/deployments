import { describe, expect, test } from "bun:test";
import {
  absorbPages,
  drainRuns,
  initialRunMerge,
  isMergeDone,
  pendingRequests,
  type MergeableRun,
} from "./run-merge.ts";

const run = (id: string, status: string, updatedAt: string): MergeableRun => ({
  id,
  status,
  updatedAt: `2026-10-0${updatedAt}T00:00:00.000Z`,
});

describe("run merge", () => {
  test("requests every deployment's first page once, without duplicates", () => {
    const state = initialRunMerge(["a", "b", "a"]);
    expect(pendingRequests(state)).toEqual([
      { cursor: undefined, deploymentId: "a" },
      { cursor: undefined, deploymentId: "b" },
    ]);
    expect(drainRuns(state, 10).runs).toEqual([]);
    expect(isMergeDone(state)).toBe(false);
  });

  test("interleaves streams in index order: status descending, then newest update", () => {
    let state = initialRunMerge(["a", "b"]);
    state = absorbPages(state, [
      {
        deploymentId: "a",
        nextCursor: undefined,
        runs: [run("a1", "running", "3"), run("a2", "completed", "5"), run("a3", "completed", "1")],
      },
      {
        deploymentId: "b",
        nextCursor: undefined,
        runs: [run("b1", "waiting-for-tool", "1"), run("b2", "completed", "4")],
      },
    ]);
    const { runs, state: next } = drainRuns(state, 10);
    expect(runs.map((entry) => entry.id)).toEqual(["b1", "a1", "a2", "b2", "a3"]);
    expect(isMergeDone(next)).toBe(true);
  });

  test("stops before a run another stream's unread page could precede", () => {
    let state = initialRunMerge(["a", "b"]);
    state = absorbPages(state, [
      { deploymentId: "a", nextCursor: undefined, runs: [run("a1", "completed", "2")] },
      { deploymentId: "b", nextCursor: "b-2", runs: [run("b1", "completed", "3")] },
    ]);
    const first = drainRuns(state, 10);
    expect(first.runs.map((entry) => entry.id)).toEqual(["b1"]);
    expect(pendingRequests(first.state)).toEqual([{ cursor: "b-2", deploymentId: "b" }]);

    const refilled = absorbPages(first.state, [
      { deploymentId: "b", nextCursor: undefined, runs: [run("b2", "completed", "1")] },
    ]);
    expect(drainRuns(refilled, 10).runs.map((entry) => entry.id)).toEqual(["a1", "b2"]);
  });

  test("keeps following a filtered stream through empty pages that carry a cursor", () => {
    let state = initialRunMerge(["a"]);
    state = absorbPages(state, [{ deploymentId: "a", nextCursor: "a-2", runs: [] }]);
    expect(pendingRequests(state)).toEqual([{ cursor: "a-2", deploymentId: "a" }]);
    expect(isMergeDone(state)).toBe(false);
    state = absorbPages(state, [{ deploymentId: "a", nextCursor: undefined, runs: [] }]);
    expect(pendingRequests(state)).toEqual([]);
    expect(isMergeDone(state)).toBe(true);
  });

  test("emits at most the limit and keeps the rest buffered without rereading", () => {
    let state = initialRunMerge(["a"]);
    state = absorbPages(state, [
      {
        deploymentId: "a",
        nextCursor: "a-2",
        runs: [run("a1", "failed", "3"), run("a2", "failed", "2"), run("a3", "failed", "1")],
      },
    ]);
    const first = drainRuns(state, 2);
    expect(first.runs.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    expect(pendingRequests(first.state)).toEqual([]);
    expect(drainRuns(first.state, 2).runs.map((entry) => entry.id)).toEqual(["a3"]);
    // The input state is not mutated, so a page parameter can be replayed.
    expect(state.streams[0]?.buffer).toHaveLength(3);
  });
});
