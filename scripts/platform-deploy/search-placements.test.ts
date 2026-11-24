import { describe, expect, test } from "bun:test";
import {
  activateSearchPlacements,
  searchPlacementFunctions,
  type SearchPlacementPage,
} from "./search-placements.ts";

describe("deploy-time default search activation", () => {
  test("runs memory before Brain and skips runtimes the root does not create", () => {
    expect(
      searchPlacementFunctions({
        search_placement_functions: {
          brain: "brain-search-placement",
          memory: "memory-search-placement",
        },
      }),
    ).toEqual(["memory-search-placement", "brain-search-placement"]);
    expect(
      searchPlacementFunctions({ search_placement_functions: { brain: null, memory: "m" } }),
    ).toEqual(["m"]);
    expect(searchPlacementFunctions({})).toEqual([]);
  });

  test("follows every page of every function", async () => {
    const calls: string[] = [];
    const pages: Record<string, SearchPlacementPage> = {
      "brain:": { failed: [], results: [{ organizationId: "a", outcome: "configured" }] },
      "memory:": {
        failed: [],
        nextCursor: "page-2",
        results: [{ organizationId: "a", outcome: "requested" }],
      },
      "memory:page-2": { failed: [], results: [{ organizationId: "b", outcome: "configured" }] },
    };
    await activateSearchPlacements({
      functions: ["memory", "brain"],
      invoke: async (functionName, payload) => {
        expect(payload.organizations).toBe("all");
        const key = `${functionName}:${payload.cursor ?? ""}`;
        calls.push(key);
        return pages[key]!;
      },
    });
    expect(calls).toEqual(["memory:", "memory:page-2", "brain:"]);
  });

  test("fails the deploy when an organization could not be activated", async () => {
    expect(
      activateSearchPlacements({
        functions: ["memory-search-placement"],
        invoke: async () => ({
          failed: ["01JA0000000000000000000002"],
          results: [{ organizationId: "01JA0000000000000000000002", outcome: "failed" }],
        }),
      }),
    ).rejects.toThrow(
      "memory-search-placement could not activate search for organizations 01JA0000000000000000000002",
    );
  });
});
